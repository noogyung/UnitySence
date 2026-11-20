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
  stage: 'vertex' | 'fragment' | 'kernel' | 'hull' | 'domain';
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

export function extractShaderName(sourceText: string): string | null {
  const m = /^\s*Shader\s+"([^"]+)"/m.exec(sourceText);
  return m ? m[1] : null;
}

export function parseShaderProperties(
  sourceText: string,
  shaderFile = '',
): ShaderPropertyEntry[] {
  const propHeaderMatch = /\bProperties\s*\{/g.exec(sourceText);
  if (!propHeaderMatch) return [];

  const shaderName = extractShaderName(sourceText) ?? undefined;
  const lineStarts = computeLineStarts(sourceText);
  const blockStart = propHeaderMatch.index + propHeaderMatch[0].length;
  let depth = 1;
  let blockEnd = sourceText.length;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = blockStart; i < sourceText.length; i++) {
    const ch = sourceText[i];
    const next = sourceText[i + 1];
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
      if (depth === 0) {
        blockEnd = i;
        break;
      }
    }
  }

  const body = sourceText.slice(blockStart, blockEnd);
  const propRegex =
    /^[ \t]*(?:\[[^\]]*\]\s*)*([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*"([^"]*)"\s*,\s*((?:[^()]+|\([^)]*\))+)\s*\)\s*=\s*([^\r\n]+)/gm;
  const results: ShaderPropertyEntry[] = [];
  let match: RegExpExecArray | null;

  while ((match = propRegex.exec(body)) !== null) {
    const name = match[1];
    const displayName = match[2];
    const type = match[3].trim();
    const defaultValue = match[4].trim();
    const nameOffset = blockStart + match.index + match[0].indexOf(name);
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
  const lines = hlslText.split(/\r?\n/);

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const entryMatch = /^\s*#pragma\s+(vertex|fragment|kernel|hull|domain)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
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
      /^\s*#pragma\s+((?:multi_compile|shader_feature)(?:_[a-zA-Z0-9]+)*|dynamic_branch(?:_local)?(?:_vertex|_fragment)?)\s+(.+?)(?:\/\/.*)?$/.exec(line);
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
  const lineStarts = computeLineStarts(sourceText);
  const properties = parseShaderProperties(sourceText, shaderFile);
  const shaderName = extractShaderName(sourceText);
  const isShaderLab =
    /^\s*Shader\s+"/m.test(sourceText) ||
    /\b(HLSLPROGRAM|HLSLINCLUDE|CGPROGRAM|CGINCLUDE)\b/.test(sourceText);

  if (!/\b(HLSLPROGRAM|HLSLINCLUDE|CGPROGRAM|CGINCLUDE)\b/.test(sourceText)) {
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
