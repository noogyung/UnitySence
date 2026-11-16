import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type {
  HlslSymbolEntry,
  ShaderPropertyEntry,
  ShaderSymbolIndex,
  UnityProjectContext,
} from '../../../extension/src/contracts/index.ts';
import { UnityVirtualPathResolver } from '../vfs/virtualPathResolver.ts';
import { UnityHlslMacroPrepass } from '../parser/unityHlslMacroPrepass.ts';
import { parseHlslSymbols, type ParsedHlslFile } from './hlslSymbolTable.ts';

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

export class IncludeDependencyGraph {
  private context: UnityProjectContext;
  private resolver: UnityVirtualPathResolver;
  private readonly prepass = new UnityHlslMacroPrepass();
  private readonly diskCache = new Map<string, CacheRecord>();
  private readonly memoryOverrides = new Map<string, { content: string; parsed: ParsedHlslFile }>();
  private readonly reverseDependencies = new Map<string, Set<string>>();
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
    this.reverseIndexBuilt = false;
  }

  public normalizeFilePath(uriOrPath: string): string {
    if (uriOrPath.startsWith('file://')) {
      return path.resolve(fileURLToPath(uriOrPath));
    }
    return path.resolve(uriOrPath);
  }

  public toUri(filePath: string): string {
    return pathToFileURL(path.resolve(filePath)).toString();
  }

  public setOpenDocumentContent(uriOrPath: string, content: string): ParsedHlslFile {
    const norm = this.normalizeFilePath(uriOrPath);
    const uri = uriOrPath.startsWith('file://') ? uriOrPath : this.toUri(norm);
    const parsed = parseHlslSymbols(content, norm, uri, this.prepass);
    this.memoryOverrides.set(norm, { content, parsed });
    this.recordReverseEdges(norm, parsed);
    return parsed;
  }

  public closeOpenDocument(uriOrPath: string): void {
    const norm = this.normalizeFilePath(uriOrPath);
    this.memoryOverrides.delete(norm);
  }

  public invalidateFile(uriOrPath: string): void {
    const norm = this.normalizeFilePath(uriOrPath);
    this.diskCache.delete(norm);
    this.memoryOverrides.delete(norm);
    this.reverseIndexBuilt = false;
  }

  public registerWorkspaceShaderFiles(shaderFilePaths: string[]): void {
    for (const filePath of shaderFilePaths) {
      const parsed = this.getOrParseFile(filePath);
      if (parsed) {
        this.recordReverseEdges(this.normalizeFilePath(filePath), parsed);
      }
    }
    this.reverseIndexBuilt = true;
  }

  private recordReverseEdges(parentNorm: string, parsed: ParsedHlslFile): void {
    if (parentNorm.replace(/\\/g, '/').toLowerCase().includes('/library/packagecache/')) {
      return;
    }
    for (const inc of parsed.includes) {
      const mapped = this.resolver.resolve(inc.rawPath, parentNorm);
      if (mapped.physicalPath) {
        const childNorm = this.normalizeFilePath(mapped.physicalPath);
        let parents = this.reverseDependencies.get(childNorm);
        if (!parents) {
          parents = new Set<string>();
          this.reverseDependencies.set(childNorm, parents);
        }
        parents.add(parentNorm);
      }
    }
  }

  private ensureReverseIndexPopulated(): void {
    if (this.reverseIndexBuilt) return;
    this.reverseIndexBuilt = true;

    const assetsDir = path.join(this.context.projectRoot, 'Assets');
    if (!fs.existsSync(assetsDir)) return;

    const stack = [assetsDir];
    const shaderExts = new Set(['.shader', '.hlsl', '.cginc', '.hlsli', '.compute']);
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
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile() && shaderExts.has(path.extname(entry.name).toLowerCase())) {
          const parsed = this.getOrParseFile(full);
          if (parsed) {
            this.recordReverseEdges(this.normalizeFilePath(full), parsed);
          }
        }
      }
    }
  }

  public findParentIncludeFiles(entryUriOrPath: string): ParsedHlslFile[] {
    const entryNorm = this.normalizeFilePath(entryUriOrPath);
    this.ensureReverseIndexPopulated();

    const parentFiles: ParsedHlslFile[] = [];
    const seenParents = new Set<string>();
    const queue = [entryNorm];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;
      const parents = this.reverseDependencies.get(current);
      if (!parents) continue;
      for (const parentNorm of parents) {
        if (seenParents.has(parentNorm)) continue;
        seenParents.add(parentNorm);
        const parsed = this.getOrParseFile(parentNorm);
        if (parsed) {
          parentFiles.push(parsed);
          queue.push(parentNorm);
        }
      }
    }
    return parentFiles;
  }

  public getOrParseFile(uriOrPath: string): ParsedHlslFile | null {
    const norm = this.normalizeFilePath(uriOrPath);
    const override = this.memoryOverrides.get(norm);
    if (override) {
      return override.parsed;
    }

    if (!fs.existsSync(norm)) {
      return null;
    }

    const st = fs.statSync(norm);
    const cached = this.diskCache.get(norm);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.parsed;
    }

    const content = fs.readFileSync(norm, 'utf8');
    const uri = this.toUri(norm);
    const parsed = parseHlslSymbols(content, norm, uri, this.prepass);
    this.diskCache.set(norm, {
      mtimeMs: st.mtimeMs,
      size: st.size,
      parsed,
    });
    return parsed;
  }

  public collectReachableFiles(entryUriOrPath: string): IncludeGraphWalkResult {
    const entryNorm = this.normalizeFilePath(entryUriOrPath);
    const visited = new Set<string>();
    const files: ParsedHlslFile[] = [];
    const unresolvedIncludes: UnresolvedIncludeDiagnostic[] = [];

    const visit = (filePath: string, collectUnresolved: boolean) => {
      const norm = this.normalizeFilePath(filePath);
      if (visited.has(norm)) return;
      visited.add(norm);

      const parsed = this.getOrParseFile(norm);
      if (!parsed) return;
      files.push(parsed);
      this.recordReverseEdges(norm, parsed);

      for (const inc of parsed.includes) {
        const mapped = this.resolver.resolve(inc.rawPath, norm);
        if (mapped.physicalPath) {
          visit(mapped.physicalPath, collectUnresolved);
        } else if (collectUnresolved) {
          const isInsidePackageCache = norm.replace(/\\/g, '/').toLowerCase().includes('/library/packagecache/');
          if (norm === entryNorm || !isInsidePackageCache) {
            unresolvedIncludes.push({
              includePath: inc.rawPath,
              fromFile: norm,
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

    // Reverse include graph: when inspecting a standalone .hlsl/.cginc/.hlsli header,
    // inherit visible symbols from parent .shader / .hlsl files that #include this header.
    const ext = path.extname(entryNorm).toLowerCase();
    const isHeaderFile = ext === '.hlsl' || ext === '.cginc' || ext === '.hlsli';
    const isInsidePackageCache = entryNorm.replace(/\\/g, '/').toLowerCase().includes('/library/packagecache/');
    if (isHeaderFile && !isInsidePackageCache) {
      const parentFiles = this.findParentIncludeFiles(entryNorm);
      for (const parent of parentFiles) {
        visit(parent.filePath, false);
      }
    }

    return { files, unresolvedIncludes };
  }

  public findSymbolsVisibleFrom(entryUriOrPath: string, symbolName: string): HlslSymbolEntry[] {
    const { files } = this.collectReachableFiles(entryUriOrPath);
    const results: HlslSymbolEntry[] = [];
    for (const file of files) {
      for (const sym of file.symbols) {
        if (sym.name === symbolName) {
          results.push(sym);
        }
      }
    }
    return results;
  }

  public findAllVisibleSymbols(entryUriOrPath: string): HlslSymbolEntry[] {
    const { files } = this.collectReachableFiles(entryUriOrPath);
    const out: HlslSymbolEntry[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      for (const sym of file.symbols) {
        const key = `${sym.uri}:${sym.line}:${sym.kind}:${sym.name}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(sym);
        }
      }
    }
    return out;
  }

  public findStructFields(entryUriOrPath: string, structName: string): HlslSymbolEntry[] {
    const { files } = this.collectReachableFiles(entryUriOrPath);
    for (const file of files) {
      const fields = file.structFieldsByStruct.get(structName);
      if (fields && fields.length > 0) {
        return fields;
      }
    }
    return [];
  }

  public inferVariableType(entryUriOrPath: string, varName: string, line: number): string | null {
    const { files } = this.collectReachableFiles(entryUriOrPath);
    const current = files[0];
    if (current) {
      for (const scope of current.localVarScopes) {
        if (line >= scope.startLine && line <= scope.endLine) {
          const hit = scope.variables.get(varName);
          if (hit) return hit;
        }
      }
    }
    for (const file of files) {
      const sym = file.symbols.find(
        (s) => s.name === varName && (s.kind === 'variable' || s.kind === 'property'),
      );
      if (sym?.returnType) return sym.returnType;
    }
    return null;
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
