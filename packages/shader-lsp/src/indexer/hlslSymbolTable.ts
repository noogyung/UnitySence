import type { HlslSymbolEntry, ShaderPropertyEntry } from '../../../extension/src/contracts/index.ts';
import {
  extractVirtualHlslDocument,
  type ShaderCodeBlock,
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

export interface LocalVarDeclaration {
  type: string;
  line: number;
  column: number;
  kind: 'parameter' | 'localVariable';
  signature: string;
}

export interface ScopedStructFieldGroup {
  blockIndex: number;
  fields: HlslSymbolEntry[];
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
  scopedStructFields?: Map<string, ScopedStructFieldGroup[]>;
  blocks?: ShaderCodeBlock[];
  localVarScopes: Array<{
    startLine: number;
    endLine: number;
    variables: Map<string, string>;
    declarations: Map<string, LocalVarDeclaration>;
  }>;
  virtualHlsl: string;
}

export function findBlockIndexAtLine(blocks: readonly ShaderCodeBlock[] | undefined, line: number): number {
  if (!blocks || blocks.length === 0) return -1;
  for (let i = 0; i < blocks.length; i++) {
    if (line >= blocks[i].startLine && line <= blocks[i].endLine) {
      return i;
    }
  }
  return -1;
}

export function isLineVisibleInPass(
  blocks: readonly ShaderCodeBlock[] | undefined,
  symLine: number,
  cursorLine: number | undefined,
): boolean {
  if (cursorLine === undefined || !blocks || blocks.length <= 1) return true;
  const cursorBlk = findBlockIndexAtLine(blocks, cursorLine);
  const symBlk = findBlockIndexAtLine(blocks, symLine);
  if (cursorBlk < 0 || symBlk < 0) return true;
  if (symBlk === cursorBlk) return true;
  return blocks[cursorBlk].includeBlockIndices.includes(symBlk);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findIdentifierColumn(
  line: string,
  name: string,
  searchStart = 0,
  preferredColumn?: number,
): number {
  const start = Math.max(0, Math.min(searchStart, line.length));
  const re = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g');
  re.lastIndex = start;
  let bestIndex = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (preferredColumn === undefined) {
      return m.index;
    }
    const dist = Math.abs(m.index - preferredColumn);
    if (dist < bestDist) {
      bestDist = dist;
      bestIndex = m.index;
    }
  }
  if (bestIndex >= 0) return bestIndex;
  return line.indexOf(name, start);
}

function splitTopLevelCommas(text: string): Array<{ segment: string; offset: number }> {
  const out: Array<{ segment: string; offset: number }> = [];
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') parenDepth++;
    else if (ch === ')' && parenDepth > 0) parenDepth--;
    else if (ch === '[') bracketDepth++;
    else if (ch === ']' && bracketDepth > 0) bracketDepth--;
    else if (ch === '{') braceDepth++;
    else if (ch === '}' && braceDepth > 0) braceDepth--;
    else if (ch === ',' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      out.push({ segment: text.slice(start, i), offset: start });
      start = i + 1;
    }
  }
  out.push({ segment: text.slice(start), offset: start });
  return out;
}

function parseDeclaratorItems(
  declListText: string,
  baseType: string,
): Array<{ name: string; type: string; arraySuffix: string; semantic: string; relOffset: number }> {
  const items: Array<{ name: string; type: string; arraySuffix: string; semantic: string; relOffset: number }> = [];
  for (const part of splitTopLevelCommas(declListText)) {
    const leadWs = part.segment.length - part.segment.trimStart().length;
    const trimmed = part.segment.trim();
    if (!trimmed) continue;
    const beforeEq = trimmed.split('=')[0].trim();
    const semSplit = beforeEq.split(':');
    const declPart = semSplit[0].trim();
    const semantic = semSplit[1] ? semSplit[1].trim() : '';
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*((?:\[[^\]]*\])+)?$/.exec(declPart);
    if (!m) continue;
    const name = m[1];
    const arraySuffix = m[2] ? m[2].replace(/\s+/g, '') : '';
    const nameInSegment = findIdentifierColumn(part.segment, name, leadWs);
    items.push({
      name,
      type: arraySuffix ? `${baseType}${arraySuffix}` : baseType,
      arraySuffix,
      semantic,
      relOffset: part.offset + (nameInSegment >= 0 ? nameInSegment : leadWs),
    });
  }
  return items;
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
  const chars = text.split('');
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
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = openBraceIndex; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
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
  for (const part of splitTopLevelCommas(trimmed)) {
    const withoutDefault = part.segment.split('=')[0].split(':')[0].trim();
    const cleaned = withoutDefault
      .replace(/^(?:in|out|inout|uniform|const)\s+/g, '')
      .trim();
    const m = /^(.+?)\s+([A-Za-z_][A-Za-z0-9_]*(?:(?:\[[^\]]*\])+)?)$/.exec(cleaned);
    if (m) {
      params.push({ type: m[1].trim(), name: m[2].replace(/\[.*$/, '') });
    }
  }
  return params;
}

function isDeadZeroCondition(condText: string): boolean {
  return /^\(*\s*(?:0|false)\s*\)*$/i.test(condText.trim());
}

function extractDefines(lines: string[], rawLines: string[], uri: string): HlslSymbolEntry[] {
  const out: HlslSymbolEntry[] = [];
  const preprocStack: Array<{ parentDead: boolean; isDead: boolean; knownFalseOnly: boolean }> = [];

  for (let i = 0; i < lines.length; i++) {
    let joined = lines[i];
    if (!/^\s*#/.test(joined)) continue;
    const startLine = i;
    while (joined.trimEnd().endsWith('\\') && i + 1 < lines.length) {
      joined = joined.replace(/\\\s*$/, '').trimEnd() + ' ' + lines[++i].trim();
    }

    const ifMatch = /^\s*#\s*if\s+(.+)$/.exec(joined);
    if (ifMatch) {
      const parentDead = preprocStack.length > 0 && preprocStack[preprocStack.length - 1].isDead;
      if (isDeadZeroCondition(ifMatch[1])) {
        preprocStack.push({ parentDead, isDead: true, knownFalseOnly: true });
      } else {
        preprocStack.push({ parentDead, isDead: parentDead, knownFalseOnly: false });
      }
      continue;
    }

    if (/^\s*#\s*(?:ifdef|ifndef)\b/.test(joined)) {
      const parentDead = preprocStack.length > 0 && preprocStack[preprocStack.length - 1].isDead;
      preprocStack.push({ parentDead, isDead: parentDead, knownFalseOnly: false });
      continue;
    }

    const elifMatch = /^\s*#\s*elif\s+(.+)$/.exec(joined);
    if (elifMatch) {
      if (preprocStack.length > 0) {
        const top = preprocStack[preprocStack.length - 1];
        if (isDeadZeroCondition(elifMatch[1])) {
          top.isDead = true;
        } else {
          top.isDead = top.parentDead;
          top.knownFalseOnly = false;
        }
      }
      continue;
    }

    if (/^\s*#\s*else\b/.test(joined)) {
      if (preprocStack.length > 0) {
        const top = preprocStack[preprocStack.length - 1];
        top.isDead = top.parentDead;
      }
      continue;
    }

    if (/^\s*#\s*endif\b/.test(joined)) {
      if (preprocStack.length > 0) {
        preprocStack.pop();
      }
      continue;
    }

    if (preprocStack.length > 0 && preprocStack[preprocStack.length - 1].isDead) {
      continue;
    }

    if (!/^\s*#\s*define\b/.test(joined)) continue;
    const m = /^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)(\([^)]*\))?(?:\s+(.*))?$/.exec(joined);
    if (!m) continue;
    const name = m[1];
    const params = m[2] ?? '';
    const body = (m[3] ?? '').trim();
    const origLine = rawLines[startLine] ?? lines[startLine];
    const cleanLine = lines[startLine] ?? origLine;
    const defPrefix = /^\s*#\s*define\s+/.exec(cleanLine);
    const col = findIdentifierColumn(cleanLine, name, defPrefix ? defPrefix[0].length : 0);
    out.push({
      name,
      kind: 'macro',
      signature: `#define ${name}${params}${body ? ' ' + body : ''}`,
      documentation: body ? `Expands to \`${body}\`` : `Preprocessor macro \`${name}\``,
      uri,
      line: startLine,
      column: col >= 0 ? col : 0,
    });
  }
  return out;
}

function extractIncludes(lines: string[], rawLines: string[]): HlslIncludeDirective[] {
  const out: HlslIncludeDirective[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^\s*#\s*include(?:_with_pragmas)?\s*(["<])([^">]+)([">])/.exec(line);
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
  const scopedStructFields = new Map<string, ScopedStructFieldGroup[]>();
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

  // 1. Parse structs & struct fields (isolated per Pass/code block)
  const structRegex = /\bstruct\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g;
  const structRanges: Array<{ start: number; end: number }> = [];
  let sMatch: RegExpExecArray | null;
  while ((sMatch = structRegex.exec(cleanNormalized)) !== null) {
    const structName = sMatch[1];
    const openBraceIdx = sMatch.index + sMatch[0].length - 1;
    const closeBraceIdx = findMatchingBrace(cleanNormalized, openBraceIdx);
    structRanges.push({ start: sMatch.index, end: closeBraceIdx });

    const structPrefix = /\bstruct\s+/.exec(sMatch[0]);
    const nameInMatch = findIdentifierColumn(
      sMatch[0],
      structName,
      structPrefix ? structPrefix.index + structPrefix[0].length : 0,
    );
    const nameOffset = sMatch.index + (nameInMatch >= 0 ? nameInMatch : 0);
    const sPos = offsetToLineCol(normStarts, nameOffset);
    const origStructLine = rawLines[sPos.line] ?? '';
    const cleanStructLine = cleanOrigLines[sPos.line] ?? origStructLine;
    const exactCol = findIdentifierColumn(cleanStructLine, structName, 0, sPos.column);

    symbols.push({
      name: structName,
      kind: 'struct',
      signature: `struct ${structName}`,
      uri,
      line: sPos.line,
      column: exactCol >= 0 ? exactCol : sPos.column,
    });

    const bodyText = cleanNormalized.slice(openBraceIdx + 1, closeBraceIdx);
    const fieldRegex = /(?:^|(?<=[;\n]))\s*([A-Za-z_][A-Za-z0-9_<>]*)\s+([^;{}]+);/g;
    const fieldList: HlslSymbolEntry[] = [];
    let fMatch: RegExpExecArray | null;
    while ((fMatch = fieldRegex.exec(bodyText)) !== null) {
      const fieldType = fMatch[1].trim();
      const declTail = fMatch[2];
      if (CONTROL_KEYWORDS.has(fieldType) || declTail.includes('(')) continue;

      const tailStartInMatch = fMatch[0].indexOf(declTail);
      const declItems = parseDeclaratorItems(declTail, fieldType);
      for (const item of declItems) {
        const absOffset = openBraceIdx + 1 + fMatch.index + tailStartInMatch + item.relOffset;
        const fPos = offsetToLineCol(normStarts, absOffset);
        const origLine = rawLines[fPos.line] ?? '';
        const cleanLine = cleanOrigLines[fPos.line] ?? origLine;
        const origTypeField = cleanLine.trim();
        const col = findIdentifierColumn(cleanLine, item.name, 0, fPos.column);
        const semStr = item.semantic ? ` : ${item.semantic}` : '';

        const fieldEntry: HlslSymbolEntry = {
          name: item.name,
          kind: 'field',
          returnType: item.type,
          signature: `${origTypeField.replace(/;.*$/, '') || `${item.type} ${item.name}${semStr}`}`,
          containerName: structName,
          uri,
          line: fPos.line,
          column: col >= 0 ? col : fPos.column,
        };
        symbols.push(fieldEntry);
        fieldList.push(fieldEntry);
      }
    }

    const blockIndex = findBlockIndexAtLine(extracted.blocks, sPos.line);
    const existingGroups = scopedStructFields.get(structName) ?? [];
    existingGroups.push({ blockIndex, fields: fieldList });
    scopedStructFields.set(structName, existingGroups);
    if (!structFieldsByStruct.has(structName)) {
      structFieldsByStruct.set(structName, fieldList);
    }
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
    const varRegex = /(?:^|(?<=[;\n]))\s*(?:(?:static|const|uniform)\s+)*([A-Za-z_][A-Za-z0-9_<>]*)\s+([^;{}]+);/g;
    let vMatch: RegExpExecArray | null;
    while ((vMatch = varRegex.exec(bodyText)) !== null) {
      const vType = vMatch[1].trim();
      const declTail = vMatch[2];
      if (CONTROL_KEYWORDS.has(vType) || declTail.includes('(')) continue;
      const tailStartInMatch = vMatch[0].indexOf(declTail);
      for (const item of parseDeclaratorItems(declTail, vType)) {
        const absOffset = openBraceIdx + 1 + vMatch.index + tailStartInMatch + item.relOffset;
        const vPos = offsetToLineCol(normStarts, absOffset);
        const origLine = rawLines[vPos.line] ?? '';
        const cleanLine = cleanOrigLines[vPos.line] ?? origLine;
        const col = findIdentifierColumn(cleanLine, item.name, 0, vPos.column);
        symbols.push({
          name: item.name,
          kind: 'variable',
          returnType: item.type,
          signature: `${vType} ${item.name}${item.arraySuffix}`,
          containerName: cbName,
          uri,
          line: vPos.line,
          column: col >= 0 ? col : vPos.column,
        });
      }
    }
    if (!symbols.some((s) => s.name === cbName && s.kind === 'cbuffer')) {
      const cbCol = findIdentifierColumn(cleanOrigLines[cPos.line] ?? rawLines[cPos.line] ?? '', cbName, cPos.column);
      symbols.push({
        name: cbName,
        kind: 'cbuffer',
        signature: `cbuffer ${cbName}`,
        uri,
        line: cPos.line,
        column: cbCol >= 0 ? cbCol : cPos.column,
      });
    }
  }

  // 3. Parse functions (definitions & declarations, including multi-line headers & attributes)
  const blockContainerRanges = [...structRanges, ...cbufferRanges];
  const fnRegex =
    /(?:^|\n)[ \t]*(?:\[[^\]]*\]\s*)*(?:(?:inline|static|extern)\s+)*([A-Za-z_][A-Za-z0-9_<>]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*(?::\s*[A-Za-z0-9_]+)?\s*(\{|;)/g;
  const fnBodyRanges: Array<{ start: number; end: number }> = [];
  let fnMatch: RegExpExecArray | null;
  while ((fnMatch = fnRegex.exec(cleanNormalized)) !== null) {
    const returnType = fnMatch[1].trim();
    const fnName = fnMatch[2].trim();
    const rawParamsText = fnMatch[3];
    const rawParams = rawParamsText.trim();
    const terminator = fnMatch[4];
    if (CONTROL_KEYWORDS.has(returnType) || CONTROL_KEYWORDS.has(fnName)) continue;

    // Skip matches inside struct or cbuffer blocks
    const inBlock = blockContainerRanges.some(
      (r) => fnMatch!.index >= r.start && fnMatch!.index <= r.end,
    );
    if (inBlock) continue;

    const returnInMatch = fnMatch[0].indexOf(returnType);
    const nameInMatch = findIdentifierColumn(
      fnMatch[0],
      fnName,
      returnInMatch >= 0 ? returnInMatch + returnType.length : 0,
    );
    const nameOffset = fnMatch.index + (nameInMatch >= 0 ? nameInMatch : 0);
    const fnPos = offsetToLineCol(normStarts, nameOffset);
    const origLine = rawLines[fnPos.line] ?? '';
    const origCleanLine = cleanOrigLines[fnPos.line] ?? origLine;
    const origReturnMatch = /^\s*(?:\[[^\]]*\]\s*)*(?:(?:inline|static|extern)\s+)*([A-Za-z_][A-Za-z0-9_<>]*)\s+/.exec(
      origCleanLine,
    );
    const displayReturn = origReturnMatch ? origReturnMatch[1] : returnType;
    const col = findIdentifierColumn(origCleanLine, fnName, 0, fnPos.column);

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
      const scopeDecls = new Map<string, LocalVarDeclaration>();

      const openParenInMatch = fnMatch[0].indexOf('(', nameInMatch + fnName.length);
      const openParenOffset = fnMatch.index + openParenInMatch;
      for (const { segment: rawPart, offset: relPartOffset } of splitTopLevelCommas(rawParamsText)) {
        const partStart = openParenOffset + 1 + relPartOffset;
        const withoutDefault = rawPart.split('=')[0].split(':')[0];
        const cleaned = withoutDefault
          .trim()
          .replace(/^(?:in|out|inout|uniform|const)\s+/g, '')
          .trim();
        const pm = /^(.+?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*((?:\[[^\]]*\])+)?$/.exec(cleaned);
        if (!pm) continue;
        const arrSuffix = pm[3] ? pm[3].replace(/\s+/g, '') : '';
        const pType = arrSuffix ? `${pm[1].trim()}${arrSuffix}` : pm[1].trim();
        const pName = pm[2];
        scopeVars.set(pName, pType);
        const nameInPart = withoutDefault.lastIndexOf(pName);
        const absParamOffset = partStart + (nameInPart >= 0 ? nameInPart : 0);
        const pPos = offsetToLineCol(normStarts, absParamOffset);
        const origParamLine = rawLines[pPos.line] ?? '';
        const cleanParamLine = cleanOrigLines[pPos.line] ?? origParamLine;
        const paramCol = findIdentifierColumn(cleanParamLine, pName, 0, pPos.column);
        scopeDecls.set(pName, {
          type: pType,
          line: pPos.line,
          column: paramCol >= 0 ? paramCol : pPos.column,
          kind: 'parameter',
          signature: `${pType} ${pName}`,
        });
      }

      const bodySlice = cleanNormalized.slice(openBraceIdx + 1, closeBraceIdx);

      // Parse `for (int i = 0; ...)` loop header variable declarations
      const forVarRegex = /\bfor\s*\(\s*(?:const\s+)?([A-Za-z_][A-Za-z0-9_<>]*)\s+([^;)]+);/g;
      let fvMatch: RegExpExecArray | null;
      while ((fvMatch = forVarRegex.exec(bodySlice)) !== null) {
        const lType = fvMatch[1];
        const declTail = fvMatch[2];
        if (CONTROL_KEYWORDS.has(lType)) continue;
        const tailStart = fvMatch[0].indexOf(declTail);
        for (const item of parseDeclaratorItems(declTail, lType)) {
          scopeVars.set(item.name, item.type);
          const absVarOffset = openBraceIdx + 1 + fvMatch.index + tailStart + item.relOffset;
          const lvPos = offsetToLineCol(normStarts, absVarOffset);
          const origVarLine = rawLines[lvPos.line] ?? '';
          const cleanVarLine = cleanOrigLines[lvPos.line] ?? origVarLine;
          const varCol = findIdentifierColumn(cleanVarLine, item.name, 0, lvPos.column);
          scopeDecls.set(item.name, {
            type: item.type,
            line: lvPos.line,
            column: varCol >= 0 ? varCol : lvPos.column,
            kind: 'localVariable',
            signature: `${item.type} ${item.name}`,
          });
        }
      }

      // Parse general local variable declarations (single, array, or comma-separated)
      const localVarRegex =
        /(?:^|(?<=[;\n{}]))\s*(?:(?:static|const)\s+)*([A-Za-z_][A-Za-z0-9_<>]*)\s+([^;{}]+);/g;
      let lvMatch: RegExpExecArray | null;
      while ((lvMatch = localVarRegex.exec(bodySlice)) !== null) {
        const lType = lvMatch[1];
        const declTail = lvMatch[2];
        if (CONTROL_KEYWORDS.has(lType) || lType === 'return' || lType === 'case') continue;
        const tailStart = lvMatch[0].indexOf(declTail);
        for (const item of parseDeclaratorItems(declTail, lType)) {
          scopeVars.set(item.name, item.type);
          const absVarOffset = openBraceIdx + 1 + lvMatch.index + tailStart + item.relOffset;
          const lvPos = offsetToLineCol(normStarts, absVarOffset);
          const origVarLine = rawLines[lvPos.line] ?? '';
          const cleanVarLine = cleanOrigLines[lvPos.line] ?? origVarLine;
          const varCol = findIdentifierColumn(cleanVarLine, item.name, 0, lvPos.column);
          scopeDecls.set(item.name, {
            type: item.type,
            line: lvPos.line,
            column: varCol >= 0 ? varCol : lvPos.column,
            kind: 'localVariable',
            signature: `${lType} ${item.name}${item.arraySuffix}`,
          });
        }
      }

      localVarScopes.push({
        startLine: startPos.line,
        endLine: endPos.line,
        variables: scopeVars,
        declarations: scopeDecls,
      });
    }
  }

  // 4. Parse top-level global variables outside structs/cbuffers/functions
  const allContainerRanges = [...structRanges, ...cbufferRanges, ...fnBodyRanges];
  for (let lineIdx = 0; lineIdx < cleanNormLines.length; lineIdx++) {
    const lineStart = normStarts[lineIdx];
    const inAnyContainer = allContainerRanges.some(
      (r) => lineStart >= r.start && lineStart <= r.end,
    );
    if (inAnyContainer) continue;

    const line = cleanNormLines[lineIdx];
    if (/^\s*#/.test(line)) continue;
    const gMatch =
      /^\s*(?:(?:static|const|uniform|extern|groupshared|precise|volatile)\s+)*([A-Za-z_][A-Za-z0-9_<>]*)\s+([^;()]+);/.exec(
        line,
      );
    if (!gMatch) continue;
    const gType = gMatch[1];
    const declTail = gMatch[2];
    if (CONTROL_KEYWORDS.has(gType) || gType === 'return') continue;
    for (const item of parseDeclaratorItems(declTail, gType)) {
      if (symbols.some((s) => s.name === item.name && s.line === lineIdx)) continue;
      const origLine = rawLines[lineIdx] ?? '';
      const cleanLine = cleanOrigLines[lineIdx] ?? origLine;
      const declPrefixMatch =
        /^\s*(?:(?:static|const|uniform|extern|groupshared|precise|volatile)\s+)*([A-Za-z_][A-Za-z0-9_<>]*)\s+/.exec(
          cleanLine,
        );
      const col = findIdentifierColumn(
        cleanLine,
        item.name,
        declPrefixMatch ? declPrefixMatch[0].length : 0,
      );
      symbols.push({
        name: item.name,
        kind: 'variable',
        returnType: item.type,
        signature: `${gType} ${item.name}${item.arraySuffix}`,
        uri,
        line: lineIdx,
        column: col >= 0 ? col : 0,
      });
    }
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
    scopedStructFields,
    blocks: extracted.blocks,
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
        const decl = scope.declarations.get(varName);
        if (decl && line >= decl.line) return decl.type;
      }
    }
    const hlslSym = file.symbols.find(
      (s) =>
        s.name === varName &&
        s.kind === 'variable' &&
        isLineVisibleInPass(file.blocks, s.line, line),
    );
    if (hlslSym?.returnType) return hlslSym.returnType;
    const propSym = file.symbols.find((s) => s.name === varName && s.kind === 'property');
    return propSym?.returnType ?? null;
  }
}
