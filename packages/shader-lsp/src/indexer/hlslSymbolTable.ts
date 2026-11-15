import type { HlslSymbolEntry, ShaderPropertyEntry } from '../../../extension/src/contracts/index.ts';
import {
  extractVirtualHlslDocument,
  type ShaderPragmaInfo,
} from '../parser/shaderLabVirtualDoc.ts';
import { UnityHlslMacroPrepass } from '../parser/unityHlslMacroPrepass.ts';

export interface HlslIncludeDirective {
  rawPath: string;
  isAngleBracket: boolean;
  line: number;
  column: number;
  pathStartColumn: number;
  pathEndColumn: number;
}

export interface ParsedHlslFile {
  uri: string;
  filePath: string;
  shaderName: string | null;
  includes: HlslIncludeDirective[];
  symbols: HlslSymbolEntry[];
  properties: ShaderPropertyEntry[];
  pragmas: ShaderPragmaInfo;
  structFieldsByStruct: Map<string, HlslSymbolEntry[]>;
  localVarScopes: Array<{
    startLine: number;
    endLine: number;
    variables: Map<string, string>;
  }>;
  virtualHlsl: string;
}

const CONTROL_KEYWORDS = new Set([
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'return',
  'struct',
  'cbuffer',
  'class',
  'interface',
  'namespace',
  'discard',
  'break',
  'continue',
  'typedef',
]);

function blankCommentsPreservingLayout(text: string): string {
  const chars = Array.from(text);
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') {
        if (text[i] !== '\r') chars[i] = ' ';
        i++;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      chars[i] = ' ';
      chars[i + 1] = ' ';
      i += 2;
      while (i < text.length) {
        if (text[i] === '*' && text[i + 1] === '/') {
          chars[i] = ' ';
          chars[i + 1] = ' ';
          i += 2;
          break;
        }
        if (text[i] !== '\n' && text[i] !== '\r') chars[i] = ' ';
        i++;
      }
      continue;
    }
    i++;
  }
  return chars.join('');
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function offsetToLineCol(lineStarts: number[], offset: number): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (lineStarts[mid] > offset) high = mid;
    else low = mid + 1;
  }
  const line = Math.max(0, low - 1);
  return { line, column: offset - lineStarts[line] };
}

function findMatchingBrace(text: string, openBraceIndex: number): number {
  let depth = 0;
  for (let i = openBraceIndex; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length - 1;
}

function parseParameterList(paramStr: string): Array<{ name: string; type: string }> {
  const trimmed = paramStr.trim();
  if (!trimmed || trimmed === 'void') return [];
  const params: Array<{ name: string; type: string }> = [];
  for (const part of trimmed.split(',')) {
    const withoutDefault = part.split('=')[0].split(':')[0].trim();
    const cleaned = withoutDefault
      .replace(/^(?:in|out|inout|uniform|const)\s+/g, '')
      .trim();
    const m = /^(.+?)\s+([A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?)$/.exec(cleaned);
    if (m) {
      params.push({ type: m[1].trim(), name: m[2].replace(/\[.*$/, '') });
    }
  }
  return params;
}

function extractDefines(lines: string[], rawLines: string[], uri: string): HlslSymbolEntry[] {
  const out: HlslSymbolEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^\s*#define\s+([A-Za-z_][A-Za-z0-9_]*)(\([^)]*\))?(?:\s+(.*))?$/.exec(line);
    if (!m) continue;
    const name = m[1];
    const params = m[2] ?? '';
    const body = (m[3] ?? '').trim();
    const origLine = rawLines[i] ?? line;
    const col = origLine.indexOf(name);
    out.push({
      name,
      kind: 'macro',
      signature: `#define ${name}${params}${body ? ' ' + body : ''}`,
      documentation: body ? `Expands to \`${body}\`` : `Preprocessor macro \`${name}\``,
      uri,
      line: i,
      column: col >= 0 ? col : 0,
    });
  }
  return out;
}

function extractIncludes(lines: string[], rawLines: string[]): HlslIncludeDirective[] {
  const out: HlslIncludeDirective[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^\s*#\s*include\s*(["<])([^">]+)([">])/.exec(line);
    if (!m) continue;
    const origLine = rawLines[i] ?? line;
    const rawPath = m[2].trim();
    const pathStartColumn = origLine.indexOf(rawPath);
    out.push({
      rawPath,
      isAngleBracket: m[1] === '<',
      line: i,
      column: origLine.indexOf('#'),
      pathStartColumn: pathStartColumn >= 0 ? pathStartColumn : 0,
      pathEndColumn: pathStartColumn >= 0 ? pathStartColumn + rawPath.length : rawPath.length,
    });
  }
  return out;
}

export function parseHlslSymbols(
  sourceText: string,
  filePath: string,
  uri: string,
  prepass = new UnityHlslMacroPrepass(),
): ParsedHlslFile {
  const extracted = extractVirtualHlslDocument(sourceText, filePath);
  const prepassRes = prepass.preprocess(extracted.virtualHlsl, uri);
  const normalized = prepassRes.normalizedText;
  const cleanNormalized = blankCommentsPreservingLayout(normalized);
  const cleanOriginal = blankCommentsPreservingLayout(extracted.virtualHlsl);

  const rawLines = sourceText.split(/\r?\n/);
  const cleanOrigLines = cleanOriginal.split(/\r?\n/);
  const cleanNormLines = cleanNormalized.split(/\r?\n/);
  const normStarts = computeLineStarts(cleanNormalized);

  const includes = extractIncludes(cleanOrigLines, rawLines);
  const macroSymbols = extractDefines(cleanOrigLines, rawLines, uri);
  const symbols: HlslSymbolEntry[] = [...macroSymbols, ...prepassRes.synthesizedSymbols];
  const structFieldsByStruct = new Map<string, HlslSymbolEntry[]>();
  const localVarScopes: ParsedHlslFile['localVarScopes'] = [];

  for (const prop of extracted.properties) {
    symbols.push({
      name: prop.name,
      kind: 'property',
      returnType: prop.type,
      signature: `${prop.name} ("${prop.displayName}", ${prop.type})`,
      documentation: `ShaderLab Property (${prop.shaderName ?? filePath}): ${prop.defaultValue ?? ''}`,
      uri,
      line: prop.line ?? 0,
      column: prop.column ?? 0,
    });
  }

  // 1. Parse structs & struct fields
  const structRegex = /\bstruct\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g;
  const structRanges: Array<{ start: number; end: number }> = [];
  let sMatch: RegExpExecArray | null;
  while ((sMatch = structRegex.exec(cleanNormalized)) !== null) {
    const structName = sMatch[1];
    const openBraceIdx = sMatch.index + sMatch[0].length - 1;
    const closeBraceIdx = findMatchingBrace(cleanNormalized, openBraceIdx);
    structRanges.push({ start: sMatch.index, end: closeBraceIdx });

    const nameOffset = sMatch.index + sMatch[0].indexOf(structName);
    const sPos = offsetToLineCol(normStarts, nameOffset);
    const origStructLine = rawLines[sPos.line] ?? '';
    const exactCol = origStructLine.indexOf(structName);

    symbols.push({
      name: structName,
      kind: 'struct',
      signature: `struct ${structName}`,
      uri,
      line: sPos.line,
      column: exactCol >= 0 ? exactCol : sPos.column,
    });

    const bodyText = cleanNormalized.slice(openBraceIdx + 1, closeBraceIdx);
    const fieldRegex = /(?:^|;|\n)\s*([A-Za-z_][A-Za-z0-9_<>]*)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*:\s*([A-Za-z0-9_]+))?\s*;/g;
    const fieldList: HlslSymbolEntry[] = [];
    let fMatch: RegExpExecArray | null;
    while ((fMatch = fieldRegex.exec(bodyText)) !== null) {
      const fieldType = fMatch[1].trim();
      const fieldName = fMatch[2].trim();
      const semantic = fMatch[3] ? ` : ${fMatch[3]}` : '';
      if (CONTROL_KEYWORDS.has(fieldType)) continue;

      const relNameIdx = fMatch[0].lastIndexOf(fieldName);
      const absOffset = openBraceIdx + 1 + fMatch.index + relNameIdx;
      const fPos = offsetToLineCol(normStarts, absOffset);
      const origLine = rawLines[fPos.line] ?? '';
      const origTypeField = (cleanOrigLines[fPos.line] ?? origLine).trim();
      const col = origLine.indexOf(fieldName);

      const fieldEntry: HlslSymbolEntry = {
        name: fieldName,
        kind: 'field',
        returnType: fieldType,
        signature: `${origTypeField.replace(/;.*$/, '') || `${fieldType} ${fieldName}${semantic}`}`,
        containerName: structName,
        uri,
        line: fPos.line,
        column: col >= 0 ? col : fPos.column,
      };
      symbols.push(fieldEntry);
      fieldList.push(fieldEntry);
    }
    structFieldsByStruct.set(structName, fieldList);
  }

  // 2. Parse cbuffers and variables inside cbuffers
  const cbufferRegex = /\bcbuffer\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g;
  const cbufferRanges: Array<{ start: number; end: number }> = [];
  let cMatch: RegExpExecArray | null;
  while ((cMatch = cbufferRegex.exec(cleanNormalized)) !== null) {
    const cbName = cMatch[1];
    const openBraceIdx = cMatch.index + cMatch[0].length - 1;
    const closeBraceIdx = findMatchingBrace(cleanNormalized, openBraceIdx);
    cbufferRanges.push({ start: cMatch.index, end: closeBraceIdx });

    const cPos = offsetToLineCol(normStarts, cMatch.index);
    const bodyText = cleanNormalized.slice(openBraceIdx + 1, closeBraceIdx);
    const varRegex = /(?:^|;|\n)\s*([A-Za-z_][A-Za-z0-9_<>]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/g;
    let vMatch: RegExpExecArray | null;
    while ((vMatch = varRegex.exec(bodyText)) !== null) {
      const vType = vMatch[1].trim();
      const vName = vMatch[2].trim();
      const absOffset = openBraceIdx + 1 + vMatch.index + vMatch[0].lastIndexOf(vName);
      const vPos = offsetToLineCol(normStarts, absOffset);
      const origLine = rawLines[vPos.line] ?? '';
      const col = origLine.indexOf(vName);
      symbols.push({
        name: vName,
        kind: 'variable',
        returnType: vType,
        signature: `${vType} ${vName}`,
        containerName: cbName,
        uri,
        line: vPos.line,
        column: col >= 0 ? col : vPos.column,
      });
    }
    if (!symbols.some((s) => s.name === cbName && s.kind === 'cbuffer')) {
      symbols.push({
        name: cbName,
        kind: 'cbuffer',
        signature: `cbuffer ${cbName}`,
        uri,
        line: cPos.line,
        column: 0,
      });
    }
  }

  // 3. Parse functions (definitions & declarations)
  const fnRegex =
    /(?:^|\n)[ \t]*(?:(?:inline|static|extern)\s+)*([A-Za-z_][A-Za-z0-9_<>]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?::\s*[A-Za-z0-9_]+)?\s*(\{|;)/g;
  const fnBodyRanges: Array<{ start: number; end: number }> = [];
  let fnMatch: RegExpExecArray | null;
  while ((fnMatch = fnRegex.exec(cleanNormalized)) !== null) {
    const returnType = fnMatch[1].trim();
    const fnName = fnMatch[2].trim();
    const rawParams = fnMatch[3].trim();
    const terminator = fnMatch[4];
    if (CONTROL_KEYWORDS.has(returnType) || CONTROL_KEYWORDS.has(fnName)) continue;

    // Skip matches inside struct or cbuffer blocks
    const inBlock = [...structRanges, ...cbufferRanges].some(
      (r) => fnMatch!.index >= r.start && fnMatch!.index <= r.end,
    );
    if (inBlock) continue;

    const nameOffset = fnMatch.index + fnMatch[0].indexOf(fnName, fnMatch[0].indexOf(returnType) + returnType.length);
    const fnPos = offsetToLineCol(normStarts, nameOffset);
    const origLine = rawLines[fnPos.line] ?? '';
    const origCleanLine = cleanOrigLines[fnPos.line] ?? origLine;
    const origReturnMatch = /^\s*(?:(?:inline|static|extern)\s+)*([A-Za-z_][A-Za-z0-9_<>]*)\s+/.exec(origCleanLine);
    const displayReturn = origReturnMatch ? origReturnMatch[1] : returnType;
    const col = origLine.indexOf(fnName);

    const parsedParams = parseParameterList(rawParams);
    symbols.push({
      name: fnName,
      kind: 'function',
      returnType: displayReturn,
      signature: `${displayReturn} ${fnName}(${rawParams.replace(/\s+/g, ' ')})`,
      parameters: parsedParams,
      uri,
      line: fnPos.line,
      column: col >= 0 ? col : fnPos.column,
    });

    if (terminator === '{') {
      const openBraceIdx = fnMatch.index + fnMatch[0].length - 1;
      const closeBraceIdx = findMatchingBrace(cleanNormalized, openBraceIdx);
      fnBodyRanges.push({ start: fnMatch.index, end: closeBraceIdx });

      const startPos = offsetToLineCol(normStarts, fnMatch.index);
      const endPos = offsetToLineCol(normStarts, closeBraceIdx);
      const scopeVars = new Map<string, string>();
      for (const p of parsedParams) {
        scopeVars.set(p.name, p.type);
      }
      const bodySlice = cleanNormalized.slice(openBraceIdx + 1, closeBraceIdx);
      const localVarRegex = /(?:^|;|\n)\s*([A-Za-z_][A-Za-z0-9_<>]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|;)/g;
      let lvMatch: RegExpExecArray | null;
      while ((lvMatch = localVarRegex.exec(bodySlice)) !== null) {
        const lType = lvMatch[1];
        const lName = lvMatch[2];
        if (!CONTROL_KEYWORDS.has(lType)) {
          scopeVars.set(lName, lType);
        }
      }
      localVarScopes.push({
        startLine: startPos.line,
        endLine: endPos.line,
        variables: scopeVars,
      });
    }
  }

  // 4. Parse top-level global variables outside structs/cbuffers/functions
  for (let lineIdx = 0; lineIdx < cleanNormLines.length; lineIdx++) {
    const lineStart = normStarts[lineIdx];
    const inAnyContainer = [...structRanges, ...cbufferRanges, ...fnBodyRanges].some(
      (r) => lineStart >= r.start && lineStart <= r.end,
    );
    if (inAnyContainer) continue;

    const line = cleanNormLines[lineIdx];
    if (/^\s*#/.test(line)) continue;
    const gMatch = /^\s*(?:static|uniform|extern)?\s*([A-Za-z_][A-Za-z0-9_<>]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=[^;]*)?;/.exec(line);
    if (!gMatch) continue;
    const gType = gMatch[1];
    const gName = gMatch[2];
    if (CONTROL_KEYWORDS.has(gType) || gType === 'return') continue;
    if (symbols.some((s) => s.name === gName && s.line === lineIdx)) continue;
    const origLine = rawLines[lineIdx] ?? '';
    const col = origLine.indexOf(gName);
    symbols.push({
      name: gName,
      kind: 'variable',
      returnType: gType,
      signature: `${gType} ${gName}`,
      uri,
      line: lineIdx,
      column: col >= 0 ? col : 0,
    });
  }

  return {
    uri,
    filePath,
    shaderName: extracted.shaderName,
    includes,
    symbols,
    properties: extracted.properties,
    pragmas: extracted.pragmas,
    structFieldsByStruct,
    localVarScopes,
    virtualHlsl: extracted.virtualHlsl,
  };
}

export class HlslSymbolTable {
  private readonly files = new Map<string, ParsedHlslFile>();

  public setFile(parsed: ParsedHlslFile): void {
    this.files.set(parsed.filePath, parsed);
  }

  public getFile(filePath: string): ParsedHlslFile | undefined {
    return this.files.get(filePath);
  }

  public findSymbolsByName(name: string): HlslSymbolEntry[] {
    const results: HlslSymbolEntry[] = [];
    for (const file of this.files.values()) {
      for (const sym of file.symbols) {
        if (sym.name === name) results.push(sym);
      }
    }
    return results;
  }

  public findStructField(structName: string, fieldName: string): HlslSymbolEntry[] {
    const results: HlslSymbolEntry[] = [];
    for (const file of this.files.values()) {
      const fields = file.structFieldsByStruct.get(structName);
      if (!fields) continue;
      for (const f of fields) {
        if (f.name === fieldName) results.push(f);
      }
    }
    return results;
  }

  public inferVariableTypeAtLine(filePath: string, varName: string, line: number): string | null {
    const file = this.files.get(filePath);
    if (!file) return null;
    for (const scope of file.localVarScopes) {
      if (line >= scope.startLine && line <= scope.endLine) {
        const found = scope.variables.get(varName);
        if (found) return found;
      }
    }
    const globalSym = file.symbols.find(
      (s) => s.name === varName && (s.kind === 'variable' || s.kind === 'property'),
    );
    return globalSym?.returnType ?? null;
  }
}
