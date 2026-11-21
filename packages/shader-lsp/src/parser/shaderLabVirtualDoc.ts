import type { ShaderPropertyEntry } from '../../../extension/src/contracts/index.ts';

export type ShaderBlockKind = 'HLSLPROGRAM' | 'HLSLINCLUDE' | 'CGPROGRAM' | 'CGINCLUDE';

export interface ShaderCodeBlock {
  kind: ShaderBlockKind;
  codeStartOffset: number;
  codeEndOffset: number;
  startLine: number;
  endLine: number;
  subShaderDepth: number;
  includeBlockIndices: number[];
  content: string;
}

export interface PragmaEntryPoint {
  stage: 'vertex' | 'fragment' | 'kernel' | 'hull' | 'domain' | 'geometry';
  name: string;
  line: number;
  column: number;
}

export interface PragmaKeywordGroup {
  directive: string;
  line: number;
  keywords: string[];
}

export interface ShaderPragmaInfo {
  entryPoints: PragmaEntryPoint[];
  keywordGroups: PragmaKeywordGroup[];
}

export interface VirtualHlslExtractionResult {
  virtualHlsl: string;
  shaderName: string | null;
  blocks: ShaderCodeBlock[];
  properties: ShaderPropertyEntry[];
  pragmas: ShaderPragmaInfo;
  isShaderLab: boolean;
}

const BLOCK_PAIRS: Array<{ open: ShaderBlockKind; close: string }> = [
  { open: 'HLSLPROGRAM', close: 'ENDHLSL' },
  { open: 'HLSLINCLUDE', close: 'ENDHLSL' },
  { open: 'CGPROGRAM', close: 'ENDCG' },
  { open: 'CGINCLUDE', close: 'ENDCG' },
];

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      starts.push(i + 1);
    }
  }
  return starts;
}

function offsetToPosition(lineStarts: number[], offset: number): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (lineStarts[mid] > offset) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  const line = Math.max(0, low - 1);
  return { line, column: offset - lineStarts[line] };
}

function isIdentCharCode(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 95
  );
}

function matchKeywordAt(text: string, idx: number, kw: string): boolean {
  if (!text.startsWith(kw, idx)) return false;
  if (idx > 0 && isIdentCharCode(text.charCodeAt(idx - 1))) return false;
  const after = idx + kw.length;
  if (after < text.length && isIdentCharCode(text.charCodeAt(after))) return false;
  return true;
}

export function blankShaderCommentsPreservingLayout(sourceText: string): string {
  const chars = Array.from(sourceText);
  let i = 0;
  let inString = false;
  while (i < sourceText.length) {
    const ch = sourceText[i];
    const next = sourceText[i + 1];
    if (inString) {
      if (ch === '\\' && i + 1 < sourceText.length) {
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
      while (i < sourceText.length && sourceText[i] !== '\n') {
        if (sourceText[i] !== '\r') chars[i] = ' ';
        i++;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      chars[i] = ' ';
      chars[i + 1] = ' ';
      i += 2;
      while (i < sourceText.length) {
        if (sourceText[i] === '*' && sourceText[i + 1] === '/') {
          chars[i] = ' ';
          chars[i + 1] = ' ';
          i += 2;
          break;
        }
        if (sourceText[i] !== '\n' && sourceText[i] !== '\r') chars[i] = ' ';
        i++;
      }
      continue;
    }
    i++;
  }
  return chars.join('');
}

export function extractShaderName(sourceText: string): string | null {
  const cleanText = blankShaderCommentsPreservingLayout(sourceText);
  const m = /^\s*Shader\s+"([^"]+)"/m.exec(cleanText);
  return m ? m[1] : null;
}

export function parseShaderProperties(
  sourceText: string,
  shaderFile = '',
): ShaderPropertyEntry[] {
  const cleanSource = blankShaderCommentsPreservingLayout(sourceText);
  const propHeaderMatch = /\bProperties\s*\{/g.exec(cleanSource);
  if (!propHeaderMatch) return [];

  const shaderName = extractShaderName(sourceText) ?? undefined;
  const lineStarts = computeLineStarts(sourceText);
  const blockStart = propHeaderMatch.index + propHeaderMatch[0].length;
  let depth = 1;
  let blockEnd = cleanSource.length;
  let inString = false;

  for (let i = blockStart; i < cleanSource.length; i++) {
    const ch = cleanSource[i];
    if (inString) {
      if (ch === '\\') {
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        blockEnd = i;
        break;
      }
    }
  }

  const body = cleanSource.slice(blockStart, blockEnd);
  const propRegex =
    /^[ \t]*((?:\[[^\]]*\]\s*)*)([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*"([^"]*)"\s*,\s*([^()]+(?:\([^()]*\)[^()]*)*)\s*\)\s*=\s*([^\r\n]+)/gm;
  const results: ShaderPropertyEntry[] = [];
  let match: RegExpExecArray | null;

  while ((match = propRegex.exec(body)) !== null) {
    const attrPrefix = match[1] ?? '';
    const name = match[2];
    const displayName = match[3];
    const type = match[4].trim();
    const defaultValue = match[5].trim();
    const leadWsMatch = /^[ \t]*/.exec(match[0]);
    const searchFrom = (leadWsMatch ? leadWsMatch[0].length : 0) + attrPrefix.length;
    const nameInMatch = match[0].indexOf(name, searchFrom);
    const nameOffset = blockStart + match.index + (nameInMatch >= 0 ? nameInMatch : searchFrom);
    const pos = offsetToPosition(lineStarts, nameOffset);
    results.push({
      name,
      displayName,
      type,
      shaderFile,
      shaderName,
      defaultValue,
      line: pos.line,
      column: pos.column,
    });
  }

  return results;
}

export function parseShaderPragmas(hlslText: string): ShaderPragmaInfo {
  const entryPoints: PragmaEntryPoint[] = [];
  const keywordGroups: PragmaKeywordGroup[] = [];
  const cleanText = blankShaderCommentsPreservingLayout(hlslText);
  const lines = cleanText.split(/\r?\n/);

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const entryMatch = /^\s*#pragma\s+(vertex|fragment|kernel|hull|domain|geometry)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
    if (entryMatch) {
      const stage = entryMatch[1] as PragmaEntryPoint['stage'];
      const name = entryMatch[2];
      const col = line.indexOf(name, entryMatch.index);
      entryPoints.push({
        stage,
        name,
        line: lineIdx,
        column: col >= 0 ? col : 0,
      });
      continue;
    }

    const kwMatch =
      /^\s*#pragma\s+((?:multi_compile|shader_feature)(?:_[a-zA-Z0-9]+)*|dynamic_branch(?:_local)?(?:_vertex|_fragment)?)\s+(.+?)\s*$/.exec(line);
    if (kwMatch) {
      const directive = kwMatch[1];
      const tokens = kwMatch[2]
        .trim()
        .split(/\s+/)
        .filter((t) => t.length > 0 && !t.startsWith('//'));
      if (tokens.length > 0) {
        keywordGroups.push({
          directive,
          line: lineIdx,
          keywords: tokens,
        });
      }
    }
  }

  return { entryPoints, keywordGroups };
}

export function extractVirtualHlslDocument(
  sourceText: string,
  shaderFile = '',
): VirtualHlslExtractionResult {
  const cleanSource = blankShaderCommentsPreservingLayout(sourceText);
  const lineStarts = computeLineStarts(sourceText);
  const properties = parseShaderProperties(sourceText, shaderFile);
  const shaderName = extractShaderName(sourceText);
  const hasBlocks = /\b(HLSLPROGRAM|HLSLINCLUDE|CGPROGRAM|CGINCLUDE)\b/.test(cleanSource);
  const isShaderLab =
    /^\s*Shader\s+"/m.test(cleanSource) || hasBlocks;

  if (!hasBlocks) {
    const pragmas = parseShaderPragmas(sourceText);
    return {
      virtualHlsl: sourceText,
      shaderName,
      blocks: [],
      properties,
      pragmas,
      isShaderLab,
    };
  }

  const chars = Array.from(sourceText);
  const keepMask = new Uint8Array(chars.length);
  const blocks: ShaderCodeBlock[] = [];
  const rootIncludeIndices: number[] = [];
  const subShaderIncludeIndices: number[] = [];

  let i = 0;
  let braceDepth = 0;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < sourceText.length) {
    const ch = sourceText[i];
    const next = sourceText[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        i += 2;
      } else {
        if (ch === '"') inString = false;
        i++;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === '"') {
      inString = true;
      i++;
      continue;
    }
    if (ch === '{') {
      braceDepth++;
      i++;
      continue;
    }
    if (ch === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      if (braceDepth <= 1) {
        subShaderIncludeIndices.length = 0;
      }
      i++;
      continue;
    }

    let matchedPair: { open: ShaderBlockKind; close: string } | undefined;
    for (const pair of BLOCK_PAIRS) {
      if (matchKeywordAt(sourceText, i, pair.open)) {
        matchedPair = pair;
        break;
      }
    }

    if (matchedPair) {
      const codeStart = i + matchedPair.open.length;
      let j = codeStart;
      let bInStr = false;
      let bInLine = false;
      let bInBlock = false;
      let codeEnd = sourceText.length;
      let closeTokenLen = 0;

      while (j < sourceText.length) {
        const bCh = sourceText[j];
        const bNext = sourceText[j + 1];
        if (bInLine) {
          if (bCh === '\n') bInLine = false;
          j++;
          continue;
        }
        if (bInBlock) {
          if (bCh === '*' && bNext === '/') {
            bInBlock = false;
            j += 2;
          } else {
            j++;
          }
          continue;
        }
        if (bInStr) {
          if (bCh === '\\') {
            j += 2;
          } else {
            if (bCh === '"') bInStr = false;
            j++;
          }
          continue;
        }
        if (bCh === '/' && bNext === '/') {
          bInLine = true;
          j += 2;
          continue;
        }
        if (bCh === '/' && bNext === '*') {
          bInBlock = true;
          j += 2;
          continue;
        }
        if (bCh === '"') {
          bInStr = true;
          j++;
          continue;
        }
        if (matchKeywordAt(sourceText, j, matchedPair.close)) {
          codeEnd = j;
          closeTokenLen = matchedPair.close.length;
          break;
        }
        j++;
      }

      for (let k = codeStart; k < codeEnd; k++) {
        keepMask[k] = 1;
      }

      const startPos = offsetToPosition(lineStarts, codeStart);
      const endPos = offsetToPosition(lineStarts, codeEnd);
      const blockIdx = blocks.length;
      const includeList =
        matchedPair.open === 'HLSLPROGRAM' || matchedPair.open === 'CGPROGRAM'
          ? [...rootIncludeIndices, ...subShaderIncludeIndices]
          : [];

      blocks.push({
        kind: matchedPair.open,
        codeStartOffset: codeStart,
        codeEndOffset: codeEnd,
        startLine: startPos.line,
        endLine: endPos.line,
        subShaderDepth: braceDepth,
        includeBlockIndices: includeList,
        content: sourceText.slice(codeStart, codeEnd),
      });

      if (matchedPair.open === 'HLSLINCLUDE' || matchedPair.open === 'CGINCLUDE') {
        if (braceDepth <= 1) {
          rootIncludeIndices.push(blockIdx);
        } else {
          subShaderIncludeIndices.push(blockIdx);
        }
      }

      i = codeEnd + closeTokenLen;
      continue;
    }

    i++;
  }

  for (let idx = 0; idx < chars.length; idx++) {
    if (keepMask[idx] === 1) continue;
    const ch = chars[idx];
    if (ch !== '\n' && ch !== '\r') {
      chars[idx] = ' ';
    }
  }

  const virtualHlsl = chars.join('');
  const pragmas = parseShaderPragmas(virtualHlsl);

  return {
    virtualHlsl,
    shaderName,
    blocks,
    properties,
    pragmas,
    isShaderLab,
  };
}
