import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type {
  HlslSymbolEntry,
  ShaderPropertyEntry,
  ShaderSymbolIndex,
  UnityProjectContext,
} from '../../../extension/src/contracts/index.ts';
import {
  isShaderFilePath,
  isShaderHeaderPath,
  normalizePathKey,
  UnityVirtualPathResolver,
} from '../vfs/virtualPathResolver.ts';
import { UnityHlslMacroPrepass } from '../parser/unityHlslMacroPrepass.ts';
import {
  findBlockIndexAtLine,
  isLineVisibleInPass,
  parseHlslSymbols,
  type ParsedHlslFile,
} from './hlslSymbolTable.ts';

export interface UnresolvedIncludeDiagnostic {
  includePath: string;
  fromFile: string;
  fromUri: string;
  line: number;
  column: number;
  startCol: number;
  endCol: number;
}

export interface IncludeGraphWalkResult {
  files: ParsedHlslFile[];
  unresolvedIncludes: UnresolvedIncludeDiagnostic[];
}

interface CacheRecord {
  mtimeMs: number;
  size: number;
  parsed: ParsedHlslFile;
}

export function extractMemberChainExpression(exprEndSlice: string): string | null {
  let i = exprEndSlice.length - 1;
  while (i >= 0 && /\s/.test(exprEndSlice[i])) i--;
  if (i < 0) return null;

  let pDepth = 0;
  let bDepth = 0;
  const startLimit = 0;
  let start = i;
  while (start >= startLimit) {
    const ch = exprEndSlice[start];
    if (ch === ')') pDepth++;
    else if (ch === '(') {
      if (pDepth === 0) break;
      pDepth--;
    } else if (ch === ']') bDepth++;
    else if (ch === '[') {
      if (bDepth === 0) break;
      bDepth--;
    } else if (pDepth === 0 && bDepth === 0) {
      if (!/[A-Za-z0-9_.]/.test(ch)) {
        break;
      }
    }
    start--;
  }
  const sliced = exprEndSlice.slice(start + 1, i + 1).trim();
  return sliced.length > 0 ? sliced : null;
}

export class IncludeDependencyGraph {
  private context: UnityProjectContext;
  private resolver: UnityVirtualPathResolver;
  private readonly prepass = new UnityHlslMacroPrepass();
  private readonly diskCache = new Map<string, CacheRecord>();
  private readonly memoryOverrides = new Map<string, { content: string; parsed: ParsedHlslFile }>();
  private readonly reverseDependencies = new Map<string, Set<string>>();
  private readonly forwardDependencies = new Map<string, Set<string>>();
  private readonly canonicalPaths = new Map<string, string>();
  private reverseIndexBuilt = false;

  constructor(context: UnityProjectContext) {
    this.context = context;
    this.resolver = new UnityVirtualPathResolver(context);
  }

  public updateContext(newContext: UnityProjectContext): void {
    this.context = newContext;
    this.resolver.updateContext(newContext);
    this.clearCache();
  }

  public getResolver(): UnityVirtualPathResolver {
    return this.resolver;
  }

  public clearCache(): void {
    this.diskCache.clear();
    this.memoryOverrides.clear();
    this.reverseDependencies.clear();
    this.forwardDependencies.clear();
    this.canonicalPaths.clear();
    this.reverseIndexBuilt = false;
  }

  public normalizeFilePath(uriOrPath: string): string {
    if (uriOrPath.startsWith('file://')) {
      try {
        return path.resolve(fileURLToPath(uriOrPath));
      } catch {
        const stripped = uriOrPath.replace(/^file:\/\//i, '');
        const clean = /^\/[A-Za-z]:/.test(stripped) ? stripped.slice(1) : stripped;
        try {
          return path.resolve(decodeURIComponent(clean));
        } catch {
          return path.resolve(clean);
        }
      }
    }
    return path.resolve(uriOrPath);
  }

  private pathKey(uriOrPath: string): string {
    return normalizePathKey(uriOrPath);
  }

  public toUri(filePath: string): string {
    return pathToFileURL(path.resolve(filePath)).toString();
  }

  public setOpenDocumentContent(uriOrPath: string, content: string): ParsedHlslFile {
    const norm = this.normalizeFilePath(uriOrPath);
    const key = this.pathKey(norm);
    this.canonicalPaths.set(key, norm);
    const existing = this.memoryOverrides.get(key);
    if (existing && existing.content === content) {
      return existing.parsed;
    }
    const uri = uriOrPath.startsWith('file://') ? uriOrPath : this.toUri(norm);
    const parsed = parseHlslSymbols(content, norm, uri, this.prepass);
    this.memoryOverrides.set(key, { content, parsed });
    this.recordReverseEdges(norm, parsed);
    return parsed;
  }

  public closeOpenDocument(uriOrPath: string): void {
    const norm = this.normalizeFilePath(uriOrPath);
    const key = this.pathKey(norm);
    this.memoryOverrides.delete(key);
    this.pruneForwardEdges(key);
    const diskParsed = this.getOrParseFile(norm);
    if (diskParsed) {
      this.recordReverseEdges(norm, diskParsed);
    }
  }

  public invalidateFile(uriOrPath: string): void {
    const norm = this.normalizeFilePath(uriOrPath);
    const key = this.pathKey(norm);
    this.diskCache.delete(key);
    this.memoryOverrides.delete(key);
    this.pruneForwardEdges(key);
    this.reverseIndexBuilt = false;
  }

  private registeredWorkspaceFiles: string[] = [];

  public registerWorkspaceShaderFiles(shaderFilePaths: string[]): void {
    this.registeredWorkspaceFiles = shaderFilePaths.map((p) => this.normalizeFilePath(p));
    for (const filePath of shaderFilePaths) {
      const parsed = this.getOrParseFile(filePath);
      if (parsed) {
        this.recordReverseEdges(this.normalizeFilePath(filePath), parsed);
      }
    }
    this.reverseIndexBuilt = true;
  }

  public getWorkspaceShaderFiles(): readonly string[] {
    return this.registeredWorkspaceFiles;
  }

  private pruneForwardEdges(parentKey: string): void {
    const prevChildren = this.forwardDependencies.get(parentKey);
    if (!prevChildren) return;
    for (const childKey of prevChildren) {
      const parents = this.reverseDependencies.get(childKey);
      if (parents) {
        parents.delete(parentKey);
        if (parents.size === 0) {
          this.reverseDependencies.delete(childKey);
        }
      }
    }
    this.forwardDependencies.delete(parentKey);
  }

  private recordReverseEdges(parentNorm: string, parsed: ParsedHlslFile): void {
    const parentKey = this.pathKey(parentNorm);
    this.canonicalPaths.set(parentKey, parentNorm);
    this.pruneForwardEdges(parentKey);

    if (parentNorm.replace(/\\/g, '/').toLowerCase().includes('/library/packagecache/')) {
      return;
    }

    const nextChildren = new Set<string>();
    for (const inc of parsed.includes) {
      const mapped = this.resolver.resolve(inc.rawPath, parentNorm);
      if (mapped.physicalPath) {
        const childNorm = this.normalizeFilePath(mapped.physicalPath);
        const childKey = this.pathKey(childNorm);
        this.canonicalPaths.set(childKey, childNorm);
        nextChildren.add(childKey);
        let parents = this.reverseDependencies.get(childKey);
        if (!parents) {
          parents = new Set<string>();
          this.reverseDependencies.set(childKey, parents);
        }
        parents.add(parentKey);
      }
    }
    if (nextChildren.size > 0) {
      this.forwardDependencies.set(parentKey, nextChildren);
    }
  }

  private ensureReverseIndexPopulated(): void {
    if (this.reverseIndexBuilt) return;
    this.reverseIndexBuilt = true;

    const scanRoots = [
      path.join(this.context.projectRoot, 'Assets'),
      path.join(this.context.projectRoot, 'Packages'),
    ];
    const stack = scanRoots.filter((d) => fs.existsSync(d));
    while (stack.length > 0) {
      const dir = stack.pop();
      if (!dir) continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile() && isShaderFilePath(entry.name)) {
          const parsed = this.getOrParseFile(full);
          if (parsed) {
            this.recordReverseEdges(this.normalizeFilePath(full), parsed);
          }
        }
      }
    }
  }

  public findParentIncludeFiles(entryUriOrPath: string): ParsedHlslFile[] {
    const entryKey = this.pathKey(entryUriOrPath);
    this.ensureReverseIndexPopulated();

    const parentFiles: ParsedHlslFile[] = [];
    const seenParents = new Set<string>();
    const queue = [entryKey];
    while (queue.length > 0) {
      const currentKey = queue.shift();
      if (!currentKey) continue;
      const parents = this.reverseDependencies.get(currentKey);
      if (!parents) continue;
      for (const parentKey of parents) {
        if (seenParents.has(parentKey)) continue;
        seenParents.add(parentKey);
        const parentPath = this.canonicalPaths.get(parentKey) ?? parentKey;
        const parsed = this.getOrParseFile(parentPath);
        if (parsed) {
          parentFiles.push(parsed);
          queue.push(parentKey);
        }
      }
    }
    return parentFiles;
  }

  public getOrParseFile(uriOrPath: string): ParsedHlslFile | null {
    const norm = this.normalizeFilePath(uriOrPath);
    const key = this.pathKey(norm);
    const canon = this.canonicalPaths.get(key) ?? norm;
    if (!this.canonicalPaths.has(key)) {
      this.canonicalPaths.set(key, canon);
    }

    const override = this.memoryOverrides.get(key);
    if (override) {
      return override.parsed;
    }

    if (!fs.existsSync(canon)) {
      return null;
    }

    const st = fs.statSync(canon);
    const cached = this.diskCache.get(key);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.parsed;
    }

    const content = fs.readFileSync(canon, 'utf8');
    const uri = this.toUri(canon);
    const parsed = parseHlslSymbols(content, canon, uri, this.prepass);
    this.diskCache.set(key, {
      mtimeMs: st.mtimeMs,
      size: st.size,
      parsed,
    });
    return parsed;
  }

  public collectReachableFiles(entryUriOrPath: string): IncludeGraphWalkResult {
    const entryNorm = this.normalizeFilePath(entryUriOrPath);
    const entryKey = this.pathKey(entryNorm);
    const visited = new Set<string>();
    const files: ParsedHlslFile[] = [];
    const unresolvedIncludes: UnresolvedIncludeDiagnostic[] = [];

    const visit = (filePath: string, collectUnresolved: boolean) => {
      const norm = this.normalizeFilePath(filePath);
      const key = this.pathKey(norm);
      if (visited.has(key)) return;
      visited.add(key);

      const parsed = this.getOrParseFile(norm);
      if (!parsed) return;
      files.push(parsed);
      this.recordReverseEdges(parsed.filePath, parsed);

      for (const inc of parsed.includes) {
        const mapped = this.resolver.resolve(inc.rawPath, parsed.filePath);
        if (mapped.physicalPath) {
          visit(mapped.physicalPath, collectUnresolved);
        } else if (collectUnresolved) {
          const isInsidePackageCache = norm.replace(/\\/g, '/').toLowerCase().includes('/library/packagecache/');
          if (key === entryKey || !isInsidePackageCache) {
            unresolvedIncludes.push({
              includePath: inc.rawPath,
              fromFile: parsed.filePath,
              fromUri: parsed.uri,
              line: inc.line,
              column: inc.column,
              startCol: inc.pathStartColumn,
              endCol: inc.pathEndColumn,
            });
          }
        }
      }
    };

    visit(entryNorm, true);

    // Reverse include graph: when inspecting a standalone header (.hlsl/.hlsli/.cginc/.cg/.hlslinc/.fxh),
    // inherit visible symbols from parent .shader / .hlsl files that #include this header.
    const isHeaderFile = isShaderHeaderPath(entryNorm);
    const isInsidePackageCache = entryNorm.replace(/\\/g, '/').toLowerCase().includes('/library/packagecache/');
    if (isHeaderFile && !isInsidePackageCache) {
      const parentFiles = this.findParentIncludeFiles(entryNorm);
      for (const parent of parentFiles) {
        visit(parent.filePath, false);
      }
    }

    return { files, unresolvedIncludes };
  }

  private findSymbolsVisibleInWalk(
    files: readonly ParsedHlslFile[],
    symbolName: string,
    cursorLine?: number,
  ): HlslSymbolEntry[] {
    const current = files[0];
    const results: HlslSymbolEntry[] = [];
    const fallbackProps: HlslSymbolEntry[] = [];
    const otherPassHits: HlslSymbolEntry[] = [];

    for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
      const file = files[fileIdx];
      for (const sym of file.symbols) {
        if (sym.name !== symbolName) continue;
        if (sym.kind === 'property') {
          fallbackProps.push(sym);
          continue;
        }
        if (fileIdx === 0 && !isLineVisibleInPass(current?.blocks, sym.line, cursorLine)) {
          otherPassHits.push(sym);
          continue;
        }
        results.push(sym);
      }
    }

    return [...results, ...fallbackProps, ...otherPassHits];
  }

  public findSymbolsVisibleFrom(
    entryUriOrPath: string,
    symbolName: string,
    cursorLine?: number,
  ): HlslSymbolEntry[] {
    const { files } = this.collectReachableFiles(entryUriOrPath);
    return this.findSymbolsVisibleInWalk(files, symbolName, cursorLine);
  }

  public findAllVisibleSymbols(entryUriOrPath: string, cursorLine?: number): HlslSymbolEntry[] {
    const { files } = this.collectReachableFiles(entryUriOrPath);
    const current = files[0];
    const out: HlslSymbolEntry[] = [];
    const seen = new Set<string>();
    for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
      const file = files[fileIdx];
      for (const sym of file.symbols) {
        if (
          fileIdx === 0 &&
          sym.kind !== 'property' &&
          !isLineVisibleInPass(current?.blocks, sym.line, cursorLine)
        ) {
          continue;
        }
        const key = `${sym.uri}:${sym.line}:${sym.kind}:${sym.name}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(sym);
        }
      }
    }
    return out;
  }

  private findStructFieldsInWalk(
    files: readonly ParsedHlslFile[],
    structName: string,
    cursorLine?: number,
  ): HlslSymbolEntry[] {
    const current = files[0];
    if (current && cursorLine !== undefined && current.scopedStructFields) {
      const groups = current.scopedStructFields.get(structName);
      if (groups && groups.length > 0) {
        const cursorBlk = findBlockIndexAtLine(current.blocks, cursorLine);
        if (cursorBlk >= 0) {
          const exact = groups.find((g) => g.blockIndex === cursorBlk);
          if (exact) return exact.fields;
          const includedIndices = current.blocks?.[cursorBlk]?.includeBlockIndices ?? [];
          const shared = groups.find((g) => includedIndices.includes(g.blockIndex));
          if (shared) return shared.fields;
        }
        const unblocked = groups.find((g) => g.blockIndex < 0);
        if (unblocked) return unblocked.fields;

        for (const file of files.slice(1)) {
          const headerFields = file.structFieldsByStruct.get(structName);
          if (headerFields && headerFields.length > 0) {
            return headerFields;
          }
        }
        return groups[0].fields;
      }
    }

    for (const file of files) {
      const fields = file.structFieldsByStruct.get(structName);
      if (fields && fields.length > 0) {
        return fields;
      }
    }
    return [];
  }

  public findStructFields(
    entryUriOrPath: string,
    structName: string,
    cursorLine?: number,
  ): HlslSymbolEntry[] {
    const { files } = this.collectReachableFiles(entryUriOrPath);
    return this.findStructFieldsInWalk(files, structName, cursorLine);
  }

  private inferVariableTypeInWalk(
    files: readonly ParsedHlslFile[],
    varName: string,
    line: number,
  ): string | null {
    const current = files[0];
    if (current) {
      for (const scope of current.localVarScopes) {
        if (line >= scope.startLine && line <= scope.endLine) {
          const decl = scope.declarations.get(varName);
          if (decl && line >= decl.line) return decl.type;
        }
      }
    }
    // Prefer HLSL variables (CBUFFER / globals / macros) over ShaderLab properties
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const sym = file.symbols.find(
        (s) =>
          s.name === varName &&
          s.kind === 'variable' &&
          (i > 0 || isLineVisibleInPass(file.blocks, s.line, line)),
      );
      if (sym?.returnType) return sym.returnType;
    }
    for (const file of files) {
      const propSym = file.symbols.find((s) => s.name === varName && s.kind === 'property');
      if (propSym?.returnType) return propSym.returnType;
    }
    return null;
  }

  public inferVariableType(entryUriOrPath: string, varName: string, line: number): string | null {
    const { files } = this.collectReachableFiles(entryUriOrPath);
    return this.inferVariableTypeInWalk(files, varName, line);
  }

  public resolveExpressionChain(
    entryUriOrPath: string,
    expression: string,
    line: number,
  ): {
    type: string | null;
    field: HlslSymbolEntry | null;
    ownerType: string | null;
    rootSymbol: HlslSymbolEntry | null;
  } {
    const segments = this.splitChainSegments(expression.trim());
    if (segments.length === 0) return { type: null, field: null, ownerType: null, rootSymbol: null };

    const { files } = this.collectReachableFiles(entryUriOrPath);
    let currentType = this.resolveRootSegmentTypeInWalk(files, segments[0], line);
    const rootSymbol = this.resolveRootSymbolInWalk(files, segments[0], line);
    let lastField: HlslSymbolEntry | null = null;
    let ownerType: string | null = null;

    for (let i = 1; i < segments.length; i++) {
      if (!currentType) return { type: null, field: null, ownerType: null, rootSymbol };
      const rawSeg = segments[i].replace(/\[[^\]]*\]/g, '').trim();
      const callMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(.*\)$/.exec(rawSeg);
      const memberName = callMatch ? callMatch[1] : rawSeg;
      if (!memberName) return { type: null, field: null, ownerType: null, rootSymbol };

      const cleanOwner = this.unwrapContainerType(currentType, segments[i].includes('['));
      const fields = this.findStructFieldsInWalk(files, cleanOwner, line);
      const matched = fields.find((f) => f.name === memberName);
      if (matched) {
        ownerType = cleanOwner;
        lastField = matched;
        currentType = matched.returnType ?? null;
        if (currentType && segments[i].includes('[')) {
          currentType = this.unwrapIndexedElementType(currentType);
        }
        continue;
      }

      const swizzleType = this.resolveSwizzleType(cleanOwner, memberName);
      if (swizzleType) {
        ownerType = cleanOwner;
        lastField = null;
        currentType = swizzleType;
        continue;
      }

      const builtinMethodType = this.resolveBuiltinObjectMethodType(cleanOwner, memberName);
      if (builtinMethodType) {
        ownerType = cleanOwner;
        lastField = null;
        currentType = builtinMethodType;
        continue;
      }

      return { type: null, field: null, ownerType: cleanOwner, rootSymbol };
    }

    return { type: currentType, field: lastField, ownerType, rootSymbol };
  }

  private resolveRootSymbolInWalk(
    files: readonly ParsedHlslFile[],
    segment: string,
    line: number,
  ): HlslSymbolEntry | null {
    const trimmed = segment.trim();
    const fnCallMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(.*\)$/.exec(trimmed);
    const targetName = fnCallMatch
      ? fnCallMatch[1]
      : /^([A-Za-z_][A-Za-z0-9_]*)/.exec(trimmed)?.[1];
    if (!targetName) return null;

    if (!fnCallMatch) {
      const current = files[0];
      if (current) {
        for (const scope of current.localVarScopes) {
          if (line >= scope.startLine && line <= scope.endLine) {
            const decl = scope.declarations.get(targetName);
            if (decl && line >= decl.line) {
              return {
                name: targetName,
                kind: 'variable',
                returnType: decl.type,
                signature: decl.signature,
                uri: current.uri,
                line: decl.line,
                column: decl.column,
              };
            }
          }
        }
      }
    }

    const hits = this.findSymbolsVisibleInWalk(files, targetName, line);
    if (fnCallMatch) {
      return hits.find((s) => s.kind === 'function') ?? hits[0] ?? null;
    }
    return hits.find((s) => s.kind === 'variable') ?? hits[0] ?? null;
  }

  private resolveBuiltinObjectMethodType(ownerType: string, methodName: string): string | null {
    if (
      /^(?:Texture|RWTexture)/.test(ownerType) &&
      (methodName === 'Sample' ||
        methodName === 'SampleLevel' ||
        methodName === 'SampleBias' ||
        methodName === 'SampleGrad' ||
        methodName === 'SampleCmp' ||
        methodName === 'SampleCmpLevelZero' ||
        methodName === 'Load')
    ) {
      return methodName.startsWith('SampleCmp') ? 'float' : 'float4';
    }
    if (
      /^(?:StructuredBuffer|RWStructuredBuffer|AppendStructuredBuffer|ConsumeStructuredBuffer|Buffer|RWBuffer)$/.test(
        ownerType,
      ) &&
      methodName === 'Load'
    ) {
      return 'float4';
    }
    return null;
  }

  private splitChainSegments(expr: string): string[] {
    const out: string[] = [];
    let pDepth = 0;
    let bDepth = 0;
    let start = 0;
    for (let i = 0; i < expr.length; i++) {
      const ch = expr[i];
      if (ch === '(') pDepth++;
      else if (ch === ')' && pDepth > 0) pDepth--;
      else if (ch === '[') bDepth++;
      else if (ch === ']' && bDepth > 0) bDepth--;
      else if (ch === '.' && pDepth === 0 && bDepth === 0) {
        const part = expr.slice(start, i).trim();
        if (part) out.push(part);
        start = i + 1;
      }
    }
    const tail = expr.slice(start).trim();
    if (tail) out.push(tail);
    return out;
  }

  private resolveRootSegmentTypeInWalk(
    files: readonly ParsedHlslFile[],
    segment: string,
    line: number,
  ): string | null {
    const hasIndex = segment.includes('[');
    const trimmed = segment.trim();
    const fnCallMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)$/.exec(trimmed);
    if (fnCallMatch) {
      const fnName = fnCallMatch[1];
      const argsBody = fnCallMatch[2];
      const hits = this.findSymbolsVisibleInWalk(files, fnName, line);
      const fn = hits.find((s) => s.kind === 'function' && s.returnType);
      if (fn?.returnType) return fn.returnType;

      if (
        /^(?:SAMPLE_TEXTURE(?:2D|2D_X|2D_ARRAY|3D|CUBE)(?:_LOD|_BIAS|_GRAD)?|LOAD_TEXTURE(?:2D|2D_X|2D_ARRAY|3D)|tex2D)$/i.test(
          fnName,
        )
      ) {
        return 'float4';
      }
      if (/^SAMPLE_TEXTURE(?:2D|2D_X|2D_ARRAY|CUBE)_SHADOW$/i.test(fnName)) {
        return 'float';
      }
      if (/^UNITY_ACCESS_DOTS_INSTANCED_PROP(?:_WITH_DEFAULT)?$/.test(fnName)) {
        const argParts = argsBody.split(',');
        const propIdent =
          argParts.length >= 2 ? /^([A-Za-z_][A-Za-z0-9_]*)/.exec(argParts[1].trim())?.[1] : undefined;
        if (propIdent) {
          const propHits = this.findSymbolsVisibleInWalk(files, propIdent, line);
          const varSym = propHits.find((s) => s.kind === 'variable' && s.returnType);
          if (varSym?.returnType) return varSym.returnType;
        }
        const typeArgMatch = /^([A-Za-z_][A-Za-z0-9_]*)/.exec((argParts[0] ?? '').trim());
        if (
          typeArgMatch &&
          /^(?:float|half|real|min16float|fixed|int|uint|bool)(?:[234](?:x[234])?)?$/.test(
            typeArgMatch[1],
          )
        ) {
          return typeArgMatch[1];
        }
        if (propIdent) {
          const propHits = this.findSymbolsVisibleInWalk(files, propIdent, line);
          const fallbackSym = propHits.find((s) => s.returnType);
          if (fallbackSym?.returnType) return fallbackSym.returnType;
        }
      }
      return null;
    }

    const identMatch = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(trimmed);
    if (!identMatch) return null;
    const rawType = this.inferVariableTypeInWalk(files, identMatch[1], line);
    if (!rawType) return null;
    return hasIndex ? this.unwrapIndexedElementType(rawType) : rawType;
  }

  private unwrapIndexedElementType(typeName: string): string {
    const withoutArrays = typeName.trim().replace(/(?:\[[^\]]*\])+$/, '').trim();
    const generic = /^(?:StructuredBuffer|RWStructuredBuffer|AppendStructuredBuffer|ConsumeStructuredBuffer|Buffer|RWBuffer)<\s*([A-Za-z_][A-Za-z0-9_]*)\s*>$/.exec(
      withoutArrays,
    );
    if (generic) return generic[1];
    return withoutArrays;
  }

  private unwrapContainerType(typeName: string, indexed: boolean): string {
    const base = indexed ? this.unwrapIndexedElementType(typeName) : typeName;
    return base.replace(/<.*>$/, '').replace(/(?:\[[^\]]*\])+$/, '').trim();
  }

  private resolveSwizzleType(ownerType: string, swizzle: string): string | null {
    const vecMatch = /^(float|half|real|min16float|fixed|int|uint|bool)([234])?$/.exec(
      ownerType.trim(),
    );
    if (!vecMatch) return null;
    const scalar = vecMatch[1];
    const dim = vecMatch[2] ? Number(vecMatch[2]) : 1;
    const swizzlePatternByDim: Record<number, RegExp> = {
      1: /^(?:x{1,4}|r{1,4})$/,
      2: /^(?:[xy]{1,4}|[rg]{1,4})$/,
      3: /^(?:[xyz]{1,4}|[rgb]{1,4})$/,
      4: /^(?:[xyzw]{1,4}|[rgba]{1,4})$/,
    };
    if (!swizzlePatternByDim[dim]?.test(swizzle)) return null;
    return swizzle.length === 1 ? scalar : `${scalar}${swizzle.length}`;
  }

  public buildShaderSymbolIndex(entryPaths: string[]): ShaderSymbolIndex {
    const shaderNames = new Set<string>();
    const properties: ShaderPropertyEntry[] = [];
    const symbolsByFile: Record<string, HlslSymbolEntry[]> = {};
    const seenPropKeys = new Set<string>();

    for (const filePath of entryPaths) {
      const walk = this.collectReachableFiles(filePath);
      for (const parsed of walk.files) {
        if (parsed.shaderName) {
          shaderNames.add(parsed.shaderName);
        }
        for (const prop of parsed.properties) {
          const key = `${prop.shaderFile}:${prop.name}`;
          if (!seenPropKeys.has(key)) {
            seenPropKeys.add(key);
            properties.push(prop);
          }
        }
        symbolsByFile[parsed.uri] = parsed.symbols;
      }
    }

    return {
      schemaVersion: 1,
      shaderNames: Array.from(shaderNames),
      properties,
      symbolsByFile,
    };
  }
}
