import * as vscode from 'vscode';
import { blankShaderCommentsPreservingLayout } from '../../../shader-lsp/src/parser/shaderLabVirtualDoc.ts';
import { isShaderFilePath, SHADER_LANGUAGE_IDS } from '../../../shader-lsp/src/vfs/virtualPathResolver.ts';

export interface PragmaDirectiveInfo {
  line: number;
  kind: 'multi_compile' | 'shader_feature';
  keywords: string[];
  variantFactor: number;
}

export interface ShaderBlockVariantSummary {
  anchorLine: number;
  pragmas: PragmaDirectiveInfo[];
  variantCount: number;
}

export interface ShaderVariantAnalysis {
  blocks: ShaderBlockVariantSummary[];
  totalVariants: number;
  allKeywords: string[];
}

export type ResolveIncludeTextResult = string | { text: string; resolvedPath?: string } | undefined;
export type ResolveIncludeTextFn = (includePath: string, fromUri?: string) => ResolveIncludeTextResult;
export type DocResolveIncludeTextFn = (
  docUri: vscode.Uri,
  includePath: string,
  fromUri?: string,
) => ResolveIncludeTextResult;

const SPECIAL_PRAGMA_SHORTCUTS: Record<string, string[]> = {
  multi_compile_fog: ['_', 'FOG_EXP2'],
  multi_compile_instancing: ['_', 'INSTANCING_ON'],
  multi_compile_fwdbase: ['_', 'DIRECTIONAL', 'LIGHTMAP_ON'],
  multi_compile_fwdbase_fullshadows: ['_', 'DIRECTIONAL', 'LIGHTMAP_ON', 'SHADOWS_SCREEN'],
  multi_compile_fwdadd: ['_', 'POINT', 'SPOT'],
  multi_compile_shadowcaster: ['_', 'SHADOWS_DEPTH'],
};

const SHADER_LANG_IDS = new Set<string>(SHADER_LANGUAGE_IDS);

export function isShaderDocument(doc: vscode.TextDocument | undefined): boolean {
  if (!doc) return false;
  if (SHADER_LANG_IDS.has(doc.languageId)) return true;
  return isShaderFilePath(doc.fileName);
}

export function parsePragmaDirectiveLine(rawLine: string, lineNumber: number): PragmaDirectiveInfo | null {
  const withoutComment = rawLine.replace(/\/\/.*$/, '').trim();
  if (!withoutComment.startsWith('#pragma')) {
    return null;
  }

  const tokens = withoutComment.split(/\s+/);
  if (tokens.length < 2) {
    return null;
  }

  const directive = tokens[1];
  if (directive in SPECIAL_PRAGMA_SHORTCUTS) {
    const kws = SPECIAL_PRAGMA_SHORTCUTS[directive];
    return {
      line: lineNumber,
      kind: 'multi_compile',
      keywords: kws,
      variantFactor: kws.length,
    };
  }

  let kind: 'multi_compile' | 'shader_feature' | null = null;
  if (/^multi_compile(?:_local)?(?:_vertex|_fragment|_hull|_domain|_geometry|_raytracing)*$/.test(directive)) {
    kind = 'multi_compile';
  } else if (
    /^shader_feature(?:_local)?(?:_vertex|_fragment|_hull|_domain|_geometry|_raytracing)*$/.test(directive) ||
    /^dynamic_branch(?:_local)?(?:_vertex|_fragment|_hull|_domain|_geometry|_raytracing)*$/.test(directive)
  ) {
    kind = 'shader_feature';
  }

  if (!kind) {
    return null;
  }

  const rawKeywords = tokens.slice(2).filter(Boolean);
  if (rawKeywords.length === 0) {
    return null;
  }

  const keywords =
    kind === 'shader_feature' && rawKeywords.length === 1 && !/^_+$/.test(rawKeywords[0])
      ? ['_', rawKeywords[0]]
      : rawKeywords;

  return {
    line: lineNumber,
    kind,
    keywords,
    variantFactor: Math.max(1, keywords.length),
  };
}

export interface AnalyzeShaderVariantsOptions {
  resolveIncludeText?: ResolveIncludeTextFn;
}

function normalizeResolvedInclude(res: ResolveIncludeTextResult): { text: string; resolvedPath?: string } | null {
  if (!res) return null;
  if (typeof res === 'string') return { text: res };
  if (typeof res.text === 'string') return { text: res.text, resolvedPath: res.resolvedPath };
  return null;
}

function collectIncludeWithPragmas(
  text: string,
  resolveIncludeText: ResolveIncludeTextFn,
  fromUri: string | undefined,
  anchorLine: number,
  visited: Set<string>,
  out: PragmaDirectiveInfo[],
): void {
  const cleanText = blankShaderCommentsPreservingLayout(text);
  const lines = cleanText.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const incMatch = /^\s*#include_with_pragmas\s+"([^"]+)"/.exec(trimmed);
    if (incMatch) {
      const incPath = incMatch[1];
      if (!visited.has(incPath)) {
        visited.add(incPath);
        const incResolved = normalizeResolvedInclude(resolveIncludeText(incPath, fromUri));
        if (incResolved) {
          const nextFrom = incResolved.resolvedPath ?? incPath;
          visited.add(nextFrom);
          collectIncludeWithPragmas(
            incResolved.text,
            resolveIncludeText,
            nextFrom,
            anchorLine,
            visited,
            out,
          );
        }
      }
      continue;
    }
    const pragma = parsePragmaDirectiveLine(line, anchorLine);
    if (pragma) {
      out.push(pragma);
    }
  }
}

export function analyzeShaderVariants(
  text: string,
  options?: AnalyzeShaderVariantsOptions,
): ShaderVariantAnalysis {
  const cleanText = blankShaderCommentsPreservingLayout(text);
  const lines = cleanText.split(/\r?\n/);
  const rootIncludePragmas: PragmaDirectiveInfo[] = [];
  const rootVisitedIncludes = new Set<string>();
  let subShaderIncludePragmas: PragmaDirectiveInfo[] = [];
  let subShaderVisitedIncludes = new Set<string>();

  const programBlocks: Array<{
    anchorLine: number;
    inheritedPragmas: PragmaDirectiveInfo[];
    pragmas: PragmaDirectiveInfo[];
  }> = [];
  const standalonePragmas: PragmaDirectiveInfo[] = [];

  let braceDepth = 0;
  let inInclude = false;
  let includeIsRootLevel = true;
  let inProgram = false;
  let passVisitedIncludes = new Set<string>();
  let currentProgram: {
    anchorLine: number;
    inheritedPragmas: PragmaDirectiveInfo[];
    pragmas: PragmaDirectiveInfo[];
  } | null = null;

  const pushPragmas = (pragmas: PragmaDirectiveInfo[]) => {
    for (const pragma of pragmas) {
      if (inInclude) {
        if (includeIsRootLevel) {
          rootIncludePragmas.push(pragma);
        } else {
          subShaderIncludePragmas.push(pragma);
        }
      } else if (inProgram && currentProgram) {
        currentProgram.pragmas.push(pragma);
      } else {
        standalonePragmas.push(pragma);
      }
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;

    if (/^(HLSLINCLUDE|CGINCLUDE)\b/.test(trimmed)) {
      inInclude = true;
      includeIsRootLevel = braceDepth <= 1;
      continue;
    }
    if (/^(ENDHLSL|ENDCG)\b/.test(trimmed)) {
      inInclude = false;
      if (inProgram && currentProgram) {
        programBlocks.push(currentProgram);
      }
      inProgram = false;
      currentProgram = null;
      continue;
    }
    if (/^(HLSLPROGRAM|CGPROGRAM)\b/.test(trimmed)) {
      inProgram = true;
      passVisitedIncludes = new Set([...rootVisitedIncludes, ...subShaderVisitedIncludes]);
      currentProgram = {
        anchorLine: i,
        inheritedPragmas: [...rootIncludePragmas, ...subShaderIncludePragmas],
        pragmas: [],
      };
      continue;
    }

    if (!inInclude && !inProgram) {
      let inStr = false;
      for (let c = 0; c < trimmed.length; c++) {
        const ch = trimmed[c];
        if (inStr) {
          if (ch === '\\') c++;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') braceDepth++;
        else if (ch === '}') {
          braceDepth = Math.max(0, braceDepth - 1);
          if (braceDepth <= 1) {
            subShaderIncludePragmas = [];
            subShaderVisitedIncludes = new Set<string>();
          }
        }
      }
    }

    const incWithPragmasMatch = /^\s*#include_with_pragmas\s+"([^"]+)"/.exec(trimmed);
    if (incWithPragmasMatch && options?.resolveIncludeText) {
      const incPath = incWithPragmasMatch[1];
      const activeVisited = inInclude
        ? (includeIsRootLevel ? rootVisitedIncludes : subShaderVisitedIncludes)
        : passVisitedIncludes;
      if (!activeVisited.has(incPath)) {
        activeVisited.add(incPath);
        const incResolved = normalizeResolvedInclude(options.resolveIncludeText(incPath));
        if (incResolved) {
          const nextFrom = incResolved.resolvedPath ?? incPath;
          activeVisited.add(nextFrom);
          const collected: PragmaDirectiveInfo[] = [];
          collectIncludeWithPragmas(
            incResolved.text,
            options.resolveIncludeText,
            nextFrom,
            i,
            activeVisited,
            collected,
          );
          pushPragmas(collected);
        }
      }
      continue;
    }

    const pragma = parsePragmaDirectiveLine(lines[i], i);
    if (!pragma) continue;
    pushPragmas([pragma]);
  }

  if (inProgram && currentProgram) {
    programBlocks.push(currentProgram);
  }

  const blocks: ShaderBlockVariantSummary[] = [];
  if (programBlocks.length > 0) {
    for (const blk of programBlocks) {
      const combined = [...blk.inheritedPragmas, ...blk.pragmas];
      const variantCount = combined.reduce((acc, p) => acc * p.variantFactor, 1);
      blocks.push({
        anchorLine: blk.anchorLine,
        pragmas: combined,
        variantCount,
      });
    }
  } else if (standalonePragmas.length > 0 || rootIncludePragmas.length > 0 || subShaderIncludePragmas.length > 0) {
    const combined = [...rootIncludePragmas, ...subShaderIncludePragmas, ...standalonePragmas];
    const variantCount = combined.reduce((acc, p) => acc * p.variantFactor, 1);
    blocks.push({
      anchorLine: combined[0].line,
      pragmas: combined,
      variantCount,
    });
  }

  const keywordSet = new Set<string>();
  for (const blk of blocks) {
    for (const p of blk.pragmas) {
      for (const kw of p.keywords) {
        if (!/^_+$/.test(kw)) {
          keywordSet.add(kw);
        }
      }
    }
  }

  const totalVariants =
    blocks.length > 0 ? blocks.reduce((acc, blk) => acc + blk.variantCount, 0) : 0;

  return {
    blocks,
    totalVariants,
    allKeywords: Array.from(keywordSet),
  };
}

export class ShaderVariantCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses: vscode.Event<void> = this.onDidChangeEmitter.event;
  private readonly resolveIncludeText?: DocResolveIncludeTextFn;

  constructor(options?: {
    resolveIncludeText?: DocResolveIncludeTextFn;
  }) {
    this.resolveIncludeText = options?.resolveIncludeText;
  }

  public refresh(): void {
    this.onDidChangeEmitter.fire();
  }

  public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const getConfig = (vscode.workspace as unknown as {
      getConfiguration?: (section?: string) => { get: <T>(key: string, def: T) => T };
    }).getConfiguration;
    const enabled =
      typeof getConfig === 'function' ? getConfig('unityBrain')?.get<boolean>('codeLens.enabled', true) ?? true : true;
    if (!enabled || !isShaderDocument(document)) {
      return [];
    }

    const analysis = analyzeShaderVariants(
      document.getText(),
      this.resolveIncludeText
        ? { resolveIncludeText: (incPath, fromUri) => this.resolveIncludeText!(document.uri, incPath, fromUri) }
        : undefined,
    );
    if (analysis.blocks.length === 0) {
      return [];
    }

    return analysis.blocks.map((blk) => {
      const warning = blk.variantCount > 128 ? ' (배리언트 과다 주의!)' : '';
      return new vscode.CodeLens(new vscode.Range(blk.anchorLine, 0, blk.anchorLine, 0), {
        title: `$(layers) [UnityBrain] 셰이더 배리언트 ${blk.variantCount}개${warning}`,
        command: 'unityBrain.switchShaderKeywords',
        tooltip: '[UnityBrain] 클릭하여 활성 셰이더 전처리기 키워드 컨텍스트를 전환합니다',
      });
    });
  }

  public dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}

export interface InactivePreprocessorRange {
  startLine: number;
  endLine: number;
}

interface PreprocEvalVal {
  known: boolean;
  value: number;
}

type PreprocToken =
  | { kind: 'num'; value: number }
  | { kind: 'ident'; value: string }
  | { kind: 'op'; value: string };

function tokenizePreprocessorExpr(input: string): PreprocToken[] | null {
  const tokens: PreprocToken[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const two = input.slice(i, i + 2);
    if (
      two === '||' ||
      two === '&&' ||
      two === '==' ||
      two === '!=' ||
      two === '<=' ||
      two === '>=' ||
      two === '<<' ||
      two === '>>'
    ) {
      tokens.push({ kind: 'op', value: two });
      i += 2;
      continue;
    }
    if ('()!~+-*/%<>&|^'.includes(ch)) {
      tokens.push({ kind: 'op', value: ch });
      i++;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const m = /^(0[xX][0-9a-fA-F]+|[0-9]+)[uUlL]*/.exec(input.slice(i));
      if (!m) return null;
      const val = m[1].toLowerCase().startsWith('0x')
        ? Number.parseInt(m[1].slice(2), 16)
        : Number.parseInt(m[1], 10);
      tokens.push({ kind: 'num', value: val });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(input.slice(i));
      if (!m) return null;
      tokens.push({ kind: 'ident', value: m[0] });
      i += m[0].length;
      continue;
    }
    return null;
  }
  return tokens;
}

function evaluatePreprocessorCondition(
  expr: string,
  definedSet: ReadonlySet<string>,
  numericMacros: ReadonlyMap<string, number>,
): boolean | null {
  const cleaned = blankShaderCommentsPreservingLayout(expr).trim();
  if (!cleaned) return null;

  const tokens = tokenizePreprocessorExpr(cleaned);
  if (!tokens || tokens.length === 0) return null;

  let pos = 0;
  const peek = (): PreprocToken | undefined => tokens[pos];
  const consume = (): PreprocToken | undefined => tokens[pos++];
  const matchOp = (op: string): boolean => {
    const t = peek();
    if (t && t.kind === 'op' && t.value === op) {
      pos++;
      return true;
    }
    return false;
  };

  const combineBinary = (
    left: PreprocEvalVal,
    right: PreprocEvalVal,
    fn: (a: number, b: number) => number,
  ): PreprocEvalVal => {
    if (!left.known || !right.known) return { known: false, value: 0 };
    return { known: true, value: fn(left.value, right.value) };
  };

  const hasComparisonOrArith = /(?:<=|>=|==|!=|[<>+\-*/%])/.test(cleaned);

  const parsePrimary = (): PreprocEvalVal => {
    if (matchOp('(')) {
      const val = parseLogicalOr();
      if (!matchOp(')')) return { known: false, value: 0 };
      return val;
    }
    const t = consume();
    if (!t) return { known: false, value: 0 };
    if (t.kind === 'num') {
      return { known: true, value: t.value };
    }
    if (t.kind === 'ident') {
      if (t.value === 'defined') {
        const hasParen = matchOp('(');
        const symTok = consume();
        if (!symTok || symTok.kind !== 'ident') return { known: false, value: 0 };
        if (hasParen && !matchOp(')')) return { known: false, value: 0 };
        return { known: true, value: definedSet.has(symTok.value) ? 1 : 0 };
      }
      if (t.value === 'true') return { known: true, value: 1 };
      if (t.value === 'false') return { known: true, value: 0 };
      if (numericMacros.has(t.value)) {
        return { known: true, value: numericMacros.get(t.value)! };
      }
      if (definedSet.has(t.value)) {
        return { known: true, value: 1 };
      }
      return hasComparisonOrArith
        ? { known: false, value: 0 }
        : { known: true, value: 0 };
    }
    return { known: false, value: 0 };
  };

  const parseUnary = (): PreprocEvalVal => {
    if (matchOp('!')) {
      const v = parseUnary();
      return v.known ? { known: true, value: v.value === 0 ? 1 : 0 } : { known: false, value: 0 };
    }
    if (matchOp('-')) {
      const v = parseUnary();
      return v.known ? { known: true, value: -v.value } : { known: false, value: 0 };
    }
    if (matchOp('+')) {
      return parseUnary();
    }
    if (matchOp('~')) {
      const v = parseUnary();
      return v.known ? { known: true, value: ~v.value } : { known: false, value: 0 };
    }
    return parsePrimary();
  };

  const parseMultiplicative = (): PreprocEvalVal => {
    let left = parseUnary();
    while (true) {
      if (matchOp('*')) left = combineBinary(left, parseUnary(), (a, b) => a * b);
      else if (matchOp('/')) {
        const right = parseUnary();
        left = right.known && right.value === 0 ? { known: false, value: 0 } : combineBinary(left, right, (a, b) => Math.trunc(a / b));
      } else if (matchOp('%')) {
        const right = parseUnary();
        left = right.known && right.value === 0 ? { known: false, value: 0 } : combineBinary(left, right, (a, b) => a % b);
      } else break;
    }
    return left;
  };

  const parseAdditive = (): PreprocEvalVal => {
    let left = parseMultiplicative();
    while (true) {
      if (matchOp('+')) left = combineBinary(left, parseMultiplicative(), (a, b) => a + b);
      else if (matchOp('-')) left = combineBinary(left, parseMultiplicative(), (a, b) => a - b);
      else break;
    }
    return left;
  };

  const parseShift = (): PreprocEvalVal => {
    let left = parseAdditive();
    while (true) {
      if (matchOp('<<')) left = combineBinary(left, parseAdditive(), (a, b) => a << b);
      else if (matchOp('>>')) left = combineBinary(left, parseAdditive(), (a, b) => a >> b);
      else break;
    }
    return left;
  };

  const parseRelational = (): PreprocEvalVal => {
    let left = parseShift();
    while (true) {
      if (matchOp('<=')) left = combineBinary(left, parseShift(), (a, b) => (a <= b ? 1 : 0));
      else if (matchOp('>=')) left = combineBinary(left, parseShift(), (a, b) => (a >= b ? 1 : 0));
      else if (matchOp('<')) left = combineBinary(left, parseShift(), (a, b) => (a < b ? 1 : 0));
      else if (matchOp('>')) left = combineBinary(left, parseShift(), (a, b) => (a > b ? 1 : 0));
      else break;
    }
    return left;
  };

  const parseEquality = (): PreprocEvalVal => {
    let left = parseRelational();
    while (true) {
      if (matchOp('==')) left = combineBinary(left, parseRelational(), (a, b) => (a === b ? 1 : 0));
      else if (matchOp('!=')) left = combineBinary(left, parseRelational(), (a, b) => (a !== b ? 1 : 0));
      else break;
    }
    return left;
  };

  const parseBitAnd = (): PreprocEvalVal => {
    let left = parseEquality();
    while (matchOp('&')) left = combineBinary(left, parseEquality(), (a, b) => a & b);
    return left;
  };

  const parseBitXor = (): PreprocEvalVal => {
    let left = parseBitAnd();
    while (matchOp('^')) left = combineBinary(left, parseBitAnd(), (a, b) => a ^ b);
    return left;
  };

  const parseBitOr = (): PreprocEvalVal => {
    let left = parseBitXor();
    while (matchOp('|')) left = combineBinary(left, parseBitXor(), (a, b) => a | b);
    return left;
  };

  const parseLogicalAnd = (): PreprocEvalVal => {
    let left = parseBitOr();
    while (matchOp('&&')) {
      const right = parseBitOr();
      if ((left.known && left.value === 0) || (right.known && right.value === 0)) {
        left = { known: true, value: 0 };
      } else if (left.known && right.known) {
        left = { known: true, value: left.value !== 0 && right.value !== 0 ? 1 : 0 };
      } else {
        left = { known: false, value: 0 };
      }
    }
    return left;
  };

  const parseLogicalOr = (): PreprocEvalVal => {
    let left = parseLogicalAnd();
    while (matchOp('||')) {
      const right = parseLogicalAnd();
      if ((left.known && left.value !== 0) || (right.known && right.value !== 0)) {
        left = { known: true, value: 1 };
      } else if (left.known && right.known) {
        left = { known: true, value: 0 };
      } else {
        left = { known: false, value: 0 };
      }
    }
    return left;
  };

  const result = parseLogicalOr();
  if (pos !== tokens.length || !result.known) {
    return null;
  }
  return result.value !== 0;
}

export function evaluateInactivePreprocessorRanges(
  text: string,
  activeKeywords: ReadonlySet<string>,
  definedMacros?: ReadonlySet<string>,
): InactivePreprocessorRange[] {
  const lines = blankShaderCommentsPreservingLayout(text).split(/\r?\n/);
  const definedSet = new Set<string>(activeKeywords);
  if (definedMacros) {
    for (const m of definedMacros) definedSet.add(m);
  }
  const numericMacros = new Map<string, number>();

  interface Frame {
    parentActive: boolean;
    branchTaken: boolean;
    currentActive: boolean;
    inactiveBodyStartLine: number | null;
  }

  const stack: Frame[] = [];
  const ranges: InactivePreprocessorRange[] = [];

  const isParentActive = (): boolean => (stack.length === 0 ? true : stack[stack.length - 1].currentActive);

  for (let i = 0; i < lines.length; i++) {
    let trimmed = lines[i].replace(/\/\/.*$/, '').trim();
    if (!trimmed.startsWith('#')) continue;

    const directiveStartLine = i;
    while (trimmed.endsWith('\\') && i + 1 < lines.length) {
      trimmed = trimmed.slice(0, -1).trimEnd() + ' ' + lines[++i].replace(/\/\/.*$/, '').trim();
    }

    const ifdefMatch = /^#\s*(ifdef|ifndef)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(trimmed);
    if (ifdefMatch) {
      const parentActive = isParentActive();
      const sym = ifdefMatch[2];
      const cond = ifdefMatch[1] === 'ifdef' ? definedSet.has(sym) : !definedSet.has(sym);
      const active = parentActive && cond;
      stack.push({
        parentActive,
        branchTaken: active,
        currentActive: active,
        inactiveBodyStartLine: !active && parentActive ? i + 1 : null,
      });
      continue;
    }

    const ifMatch = /^#\s*if\s+(.+)$/.exec(trimmed);
    if (ifMatch) {
      const parentActive = isParentActive();
      const evalRes = evaluatePreprocessorCondition(ifMatch[1], definedSet, numericMacros);
      const cond = evalRes === null ? true : evalRes;
      const active = parentActive && cond;
      stack.push({
        parentActive,
        branchTaken: active,
        currentActive: active,
        inactiveBodyStartLine: !active && parentActive ? i + 1 : null,
      });
      continue;
    }

    const elifMatch = /^#\s*elif\s+(.+)$/.exec(trimmed);
    if (elifMatch && stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top.inactiveBodyStartLine !== null && directiveStartLine - 1 >= top.inactiveBodyStartLine) {
        ranges.push({ startLine: top.inactiveBodyStartLine, endLine: directiveStartLine - 1 });
      }
      top.inactiveBodyStartLine = null;

      if (!top.parentActive || top.branchTaken) {
        top.currentActive = false;
        if (top.parentActive) {
          top.inactiveBodyStartLine = i + 1;
        }
      } else {
        const evalRes = evaluatePreprocessorCondition(elifMatch[1], definedSet, numericMacros);
        const cond = evalRes === null ? true : evalRes;
        top.currentActive = cond;
        if (cond) {
          top.branchTaken = true;
        } else {
          top.inactiveBodyStartLine = i + 1;
        }
      }
      continue;
    }

    if (/^#\s*else\b/.test(trimmed) && stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top.inactiveBodyStartLine !== null && directiveStartLine - 1 >= top.inactiveBodyStartLine) {
        ranges.push({ startLine: top.inactiveBodyStartLine, endLine: directiveStartLine - 1 });
      }
      top.inactiveBodyStartLine = null;

      if (!top.parentActive || top.branchTaken) {
        top.currentActive = false;
        if (top.parentActive) {
          top.inactiveBodyStartLine = i + 1;
        }
      } else {
        top.currentActive = true;
        top.branchTaken = true;
      }
      continue;
    }

    if (/^#\s*endif\b/.test(trimmed) && stack.length > 0) {
      const top = stack.pop()!;
      if (top.inactiveBodyStartLine !== null && directiveStartLine - 1 >= top.inactiveBodyStartLine) {
        ranges.push({ startLine: top.inactiveBodyStartLine, endLine: directiveStartLine - 1 });
      }
      continue;
    }

    if (isParentActive()) {
      const defineMatch = /^#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+(\d+))?/.exec(trimmed);
      if (defineMatch) {
        definedSet.add(defineMatch[1]);
        if (defineMatch[2] !== undefined) {
          numericMacros.set(defineMatch[1], Number(defineMatch[2]));
        }
      } else {
        const undefMatch = /^#\s*undef\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(trimmed);
        if (undefMatch) {
          definedSet.delete(undefMatch[1]);
          numericMacros.delete(undefMatch[1]);
        }
      }
    }
  }

  return ranges;
}

export interface PreprocessorKeywordContext {
  isPreprocessorKeywordLine: boolean;
  keywords: string[];
  wordToken: {
    text: string;
    startCol: number;
    endCol: number;
  };
}

const PREPROCESSOR_CONDITION_IGNORED_TOKENS = new Set(['defined', 'true', 'false']);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractPreprocessorDirectiveKeywordsAtPosition(
  documentText: string,
  position: { line: number; character: number },
): PreprocessorKeywordContext {
  const lines = documentText.split(/\r?\n/);
  const fallback: PreprocessorKeywordContext = {
    isPreprocessorKeywordLine: false,
    keywords: [],
    wordToken: {
      text: '',
      startCol: position.character,
      endCol: position.character,
    },
  };

  if (position.line < 0 || position.line >= lines.length) {
    return fallback;
  }

  const physicalLine = lines[position.line] ?? '';
  let wordToken = fallback.wordToken;
  const wordRe = /[A-Za-z0-9_]+/g;
  let wordMatch: RegExpExecArray | null;
  while ((wordMatch = wordRe.exec(physicalLine)) !== null) {
    const start = wordMatch.index;
    const end = start + wordMatch[0].length;
    if (start <= position.character && position.character <= end) {
      wordToken = { text: wordMatch[0], startCol: start, endCol: end };
      break;
    }
  }

  let startLine = position.line;
  while (startLine > 0) {
    const prevStripped = lines[startLine - 1].replace(/\/\/.*$/, '').trimEnd();
    if (!prevStripped.endsWith('\\')) {
      break;
    }
    startLine -= 1;
  }

  let endLine = position.line;
  while (endLine + 1 < lines.length) {
    const currStripped = lines[endLine].replace(/\/\/.*$/, '').trimEnd();
    if (!currStripped.endsWith('\\')) {
      break;
    }
    endLine += 1;
  }

  const logicalParts: string[] = [];
  for (let i = startLine; i <= endLine; i++) {
    let part = lines[i].replace(/\/\/.*$/, '').trimEnd();
    if (part.endsWith('\\')) {
      part = part.slice(0, -1).trimEnd();
    }
    logicalParts.push(part.trim());
  }
  const joined = logicalParts.join(' ').trim();
  if (!joined.startsWith('#')) {
    return { isPreprocessorKeywordLine: false, keywords: [], wordToken };
  }

  const extractedSet = new Set<string>();
  const condMatch = /^#\s*(?:if|elif|ifdef|ifndef)\b(.*)$/.exec(joined);
  if (condMatch) {
    const condExpr = condMatch[1].replace(/\/\*.*?\*\//g, ' ');
    const identMatches = condExpr.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
    for (const ident of identMatches) {
      if (!PREPROCESSOR_CONDITION_IGNORED_TOKENS.has(ident)) {
        extractedSet.add(ident);
      }
    }
  } else if (/^#\s*pragma\b/.test(joined)) {
    const pragma = parsePragmaDirectiveLine(joined, startLine);
    if (pragma) {
      for (const kw of pragma.keywords) {
        if (!/^_+$/.test(kw)) {
          extractedSet.add(kw);
        }
      }
    }
  }

  const extractedKeywords = Array.from(extractedSet);
  if (extractedKeywords.length === 0) {
    return { isPreprocessorKeywordLine: false, keywords: [], wordToken };
  }

  const ordered: string[] = [];
  const added = new Set<string>();
  const pushKw = (kw: string) => {
    if (!added.has(kw)) {
      added.add(kw);
      ordered.push(kw);
    }
  };

  if (wordToken.text && extractedSet.has(wordToken.text)) {
    pushKw(wordToken.text);
  }

  const physicalCode = physicalLine.replace(/\/\/.*$/, '');
  const sameLineDistances: Array<{ kw: string; dist: number }> = [];
  for (const kw of extractedKeywords) {
    if (added.has(kw)) continue;
    const kwRe = new RegExp(`\\b${escapeRegExp(kw)}\\b`, 'g');
    let m: RegExpExecArray | null;
    let bestDist = Number.POSITIVE_INFINITY;
    while ((m = kwRe.exec(physicalCode)) !== null) {
      const s = m.index;
      const e = s + kw.length;
      const dist =
        position.character >= s && position.character <= e
          ? 0
          : Math.min(Math.abs(position.character - s), Math.abs(position.character - e));
      if (dist < bestDist) {
        bestDist = dist;
      }
    }
    if (Number.isFinite(bestDist)) {
      sameLineDistances.push({ kw, dist: bestDist });
    }
  }
  sameLineDistances.sort((a, b) => a.dist - b.dist);
  for (const entry of sameLineDistances) {
    pushKw(entry.kw);
  }

  for (const kw of extractedKeywords) {
    pushKw(kw);
  }

  return {
    isPreprocessorKeywordLine: true,
    keywords: ordered,
    wordToken,
  };
}

export interface ShaderKeywordStatusBarOptions {
  onKeywordsChanged?: (uri: vscode.Uri | undefined, keywords: string[]) => void | Promise<void>;
  getDefinedMacros?: (uri: vscode.Uri) => ReadonlySet<string> | undefined;
  resolveIncludeText?: DocResolveIncludeTextFn;
}

export class ShaderKeywordContextStatusBar implements vscode.Disposable {
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly inactiveDecorationType: vscode.TextEditorDecorationType | null;
  private readonly onKeywordsChanged?: (
    uri: vscode.Uri | undefined,
    keywords: string[],
  ) => void | Promise<void>;
  private readonly getDefinedMacros?: (uri: vscode.Uri) => ReadonlySet<string> | undefined;
  private readonly resolveIncludeText?: DocResolveIncludeTextFn;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly keywordsByUri = new Map<string, string[]>();
  private changeDebounceTimer?: ReturnType<typeof setTimeout>;

  constructor(options: ShaderKeywordStatusBarOptions = {}) {
    this.onKeywordsChanged = options.onKeywordsChanged;
    this.getDefinedMacros = options.getDefinedMacros;
    this.resolveIncludeText = options.resolveIncludeText;
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.command = 'unityBrain.switchShaderKeywords';
    this.inactiveDecorationType =
      typeof vscode.window.createTextEditorDecorationType === 'function'
        ? vscode.window.createTextEditorDecorationType({ opacity: '0.45', isWholeLine: true })
        : null;

    if (this.inactiveDecorationType) {
      this.disposables.push(this.inactiveDecorationType);
    }

    this.disposables.push(
      this.statusBarItem,
      vscode.commands.registerCommand('unityBrain.switchShaderKeywords', (explicitKeywords?: unknown) =>
        this.switchKeywordsCommand(Array.isArray(explicitKeywords) ? (explicitKeywords as string[]) : undefined),
      ),
      vscode.commands.registerCommand(
        'unityBrain.toggleShaderKeyword',
        (uri?: unknown, keyword?: unknown, enabled?: unknown) => {
          const targetUri =
            uri && typeof uri === 'object' && 'scheme' in uri ? (uri as vscode.Uri) : undefined;
          if (typeof keyword === 'string' && keyword.length > 0) {
            return this.setKeywordState(
              targetUri,
              keyword,
              typeof enabled === 'boolean' ? enabled : undefined,
            );
          }
          const editor = vscode.window.activeTextEditor;
          if (editor && isShaderDocument(editor.document)) {
            const ctx = extractPreprocessorDirectiveKeywordsAtPosition(
              editor.document.getText(),
              editor.selection.active,
            );
            if (ctx.isPreprocessorKeywordLine && ctx.keywords.length > 0) {
              return this.setKeywordState(targetUri ?? editor.document.uri, ctx.keywords[0]);
            }
          }
          return this.switchKeywordsCommand();
        },
      ),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.updateForDocument(editor?.document);
        this.applyInactiveDecorations(editor);
        if (editor && isShaderDocument(editor.document)) {
          void this.onKeywordsChanged?.(
            editor.document.uri,
            this.getActiveKeywords(editor.document.uri),
          );
        }
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (vscode.window.activeTextEditor?.document.uri.toString() === e.document.uri.toString()) {
          if (this.changeDebounceTimer) {
            clearTimeout(this.changeDebounceTimer);
          }
          this.changeDebounceTimer = setTimeout(() => {
            this.changeDebounceTimer = undefined;
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor?.document.uri.toString() === e.document.uri.toString()) {
              this.updateForDocument(activeEditor.document);
              this.applyInactiveDecorations(activeEditor);
            }
          }, 200);
        }
      }),
    );

    this.updateForDocument(vscode.window.activeTextEditor?.document);
    this.applyInactiveDecorations(vscode.window.activeTextEditor);
  }

  public applyInactiveDecorations(editor: vscode.TextEditor | undefined): void {
    if (!editor || !this.inactiveDecorationType || typeof editor.setDecorations !== 'function') {
      return;
    }
    if (!isShaderDocument(editor.document)) {
      editor.setDecorations(this.inactiveDecorationType, []);
      return;
    }
    const active = new Set(this.getActiveKeywords(editor.document.uri));
    const crossMacros = this.getDefinedMacros?.(editor.document.uri);
    const inactiveRanges = evaluateInactivePreprocessorRanges(
      editor.document.getText(),
      active,
      crossMacros,
    );
    const decorations = inactiveRanges.map((r) => {
      const endLineLen = editor.document.lineAt(Math.min(r.endLine, editor.document.lineCount - 1)).text.length;
      return new vscode.Range(r.startLine, 0, r.endLine, endLineLen);
    });
    editor.setDecorations(this.inactiveDecorationType, decorations);
  }

  public getStatusBarItem(): vscode.StatusBarItem {
    return this.statusBarItem;
  }

  public getActiveKeywords(uri?: vscode.Uri): string[] {
    if (!uri) return [];
    return [...(this.keywordsByUri.get(uri.toString()) ?? [])];
  }

  public async setKeywordState(
    uri: vscode.Uri | undefined,
    keyword: string,
    enabled?: boolean,
  ): Promise<string[]> {
    const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
    const trimmed = keyword.trim();
    if (!trimmed) {
      return this.getActiveKeywords(targetUri);
    }
    const current = new Set(this.getActiveKeywords(targetUri));
    const nextState = enabled !== undefined ? enabled : !current.has(trimmed);
    if (nextState) {
      current.add(trimmed);
    } else {
      current.delete(trimmed);
    }
    return this.setActiveKeywords(targetUri, Array.from(current));
  }

  public async setActiveKeywords(uri: vscode.Uri | undefined, keywords: string[]): Promise<string[]> {
    const cleaned = Array.from(new Set(keywords.map((k) => k.trim()).filter(Boolean)));
    if (uri) {
      this.keywordsByUri.set(uri.toString(), cleaned);
    }
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && (!uri || activeEditor.document.uri.toString() === uri.toString())) {
      this.updateForDocument(activeEditor.document, cleaned);
      this.applyInactiveDecorations(activeEditor);
    }
    if (this.onKeywordsChanged) {
      await this.onKeywordsChanged(uri, cleaned);
    }
    return cleaned;
  }

  private analyzeDocVariants(doc: vscode.TextDocument): ShaderVariantAnalysis {
    return analyzeShaderVariants(
      doc.getText(),
      this.resolveIncludeText
        ? { resolveIncludeText: (incPath, fromUri) => this.resolveIncludeText!(doc.uri, incPath, fromUri) }
        : undefined,
    );
  }

  public updateForDocument(doc: vscode.TextDocument | undefined, overrideKeywords?: string[]): void {
    if (!isShaderDocument(doc)) {
      this.statusBarItem.hide();
      return;
    }

    const active = overrideKeywords ?? this.getActiveKeywords(doc!.uri);
    const analysis = this.analyzeDocVariants(doc!);
    const label = active.length > 0 ? active.join(', ') : '(기본값)';
    this.statusBarItem.text = `$(symbol-keyword) [UnityBrain] 셰이더 키워드: ${label}`;
    this.statusBarItem.tooltip = `[UnityBrain] 전체 배리언트 ${analysis.totalVariants}개 | 사용 가능 키워드: ${
      analysis.allKeywords.length > 0 ? analysis.allKeywords.join(', ') : '없음'
    }`;
    this.statusBarItem.show();
  }

  private async switchKeywordsCommand(explicitKeywords?: string[]): Promise<string[]> {
    const doc = vscode.window.activeTextEditor?.document;
    const uri = doc?.uri;
    if (explicitKeywords) {
      return this.setActiveKeywords(uri, explicitKeywords);
    }

    const analysis = doc ? this.analyzeDocVariants(doc) : { allKeywords: [], blocks: [], totalVariants: 0 };
    if (analysis.allKeywords.length === 0) {
      await vscode.window.showInformationMessage(
        '[UnityBrain] 현재 셰이더에서 multi_compile 또는 shader_feature 키워드를 찾지 못했습니다.',
      );
      return [];
    }

    const current = new Set(this.getActiveKeywords(uri));
    const items: vscode.QuickPickItem[] = analysis.allKeywords.map((kw) => ({
      label: kw,
      picked: current.has(kw),
      description: current.has(kw) ? '활성화됨' : undefined,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: '[UnityBrain] HLSL 전처리기 컨텍스트에 활성화할 셰이더 키워드를 선택하세요',
    });

    if (!picked) {
      return this.getActiveKeywords(uri);
    }

    const pickedArray = Array.isArray(picked) ? picked : [picked];
    const nextKeywords = pickedArray.map((item) => item.label);
    return this.setActiveKeywords(uri, nextKeywords);
  }

  public dispose(): void {
    if (this.changeDebounceTimer) {
      clearTimeout(this.changeDebounceTimer);
      this.changeDebounceTimer = undefined;
    }
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }
}

export function buildShaderPreprocessorKeywordCompletions(
  document: vscode.TextDocument,
  position: vscode.Position,
  statusBar: ShaderKeywordContextStatusBar,
): vscode.CompletionItem[] | null {
  const ctx = extractPreprocessorDirectiveKeywordsAtPosition(document.getText(), position);
  if (!ctx.isPreprocessorKeywordLine || ctx.keywords.length === 0) {
    return null;
  }

  const activeSet = new Set(statusBar.getActiveKeywords(document.uri));
  const replaceRange = new vscode.Range(
    position.line,
    ctx.wordToken.startCol,
    position.line,
    ctx.wordToken.endCol,
  );

  const items: vscode.CompletionItem[] = [];
  for (let idx = 0; idx < ctx.keywords.length; idx++) {
    const kw = ctx.keywords[idx];
    const isActive = activeSet.has(kw);
    const filterText = ctx.wordToken.text ? `${ctx.wordToken.text} ${kw} ON OFF` : `${kw} ON OFF`;

    const targetState = !isActive;
    const stateTag = targetState ? 'ON' : 'OFF';
    const currentTag = isActive ? 'ON' : 'OFF';
    const toggleItem = new vscode.CompletionItem(
      `[${stateTag}] ${kw} — 셰이더 키워드 ${targetState ? '켜기' : '끄기'} (현재: ${currentTag})`,
      vscode.CompletionItemKind.Event,
    );
    toggleItem.detail = `[UnityBrain] ${kw}: ${currentTag} -> ${stateTag} 전환`;
    toggleItem.documentation = new vscode.MarkdownString(
      `[UnityBrain] 선택 시 텍스트 변경 없이 **\`${kw}\`** 전처리기 키워드를 **${stateTag}** 상태로 전환합니다.`,
    );
    toggleItem.range = replaceRange;
    toggleItem.insertText = ctx.wordToken.text;
    toggleItem.filterText = filterText;
    toggleItem.sortText = `\u0000_${String(idx * 2).padStart(2, '0')}_${kw}`;
    toggleItem.preselect = idx === 0;
    toggleItem.command = {
      command: 'unityBrain.toggleShaderKeyword',
      title: '[UnityBrain] 셰이더 키워드 On/Off 전환',
      arguments: [document.uri, kw, targetState],
    };
    items.push(toggleItem);

    const sameTag = isActive ? 'ON' : 'OFF';
    const keepItem = new vscode.CompletionItem(
      `[${sameTag}] ${kw} — 셰이더 키워드 ${isActive ? '켜기' : '끄기'} (현재: ${sameTag} 유지)`,
      vscode.CompletionItemKind.Keyword,
    );
    keepItem.detail = `[UnityBrain] ${kw}: ${sameTag} 상태 유지`;
    keepItem.documentation = new vscode.MarkdownString(
      `[UnityBrain] 현재 **\`${kw}\`** 키워드 상태를 **${sameTag}**로 명시적으로 설정합니다.`,
    );
    keepItem.range = replaceRange;
    keepItem.insertText = ctx.wordToken.text;
    keepItem.filterText = filterText;
    keepItem.sortText = `\u0000_${String(idx * 2 + 1).padStart(2, '0')}_${kw}`;
    keepItem.command = {
      command: 'unityBrain.toggleShaderKeyword',
      title: '[UnityBrain] 셰이더 키워드 On/Off 전환',
      arguments: [document.uri, kw, isActive],
    };
    items.push(keepItem);
  }

  return items;
}
