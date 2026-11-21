import * as vscode from 'vscode';

export interface ShaderFormatOptions {
  tabSize: number;
  insertSpaces: boolean;
}

export interface ShaderIndentState {
  braceDepth: number;
  inBlockComment: boolean;
}

interface LexicalLineScan {
  codeOnly: string;
  inBlockComment: boolean;
}

function scanLineLexically(line: string, startInBlockComment: boolean): LexicalLineScan {
  let inBlockComment = startInBlockComment;
  let inString = false;
  let codeOnly = '';

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      if (ch === '\\' && i + 1 < line.length) {
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      break;
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

    codeOnly += ch;
  }

  return { codeOnly, inBlockComment };
}

function countLeadingClosers(codeOnly: string): number {
  const trimmed = codeOnly.trimStart();
  let closers = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '}') {
      closers++;
    } else if (!/\s/.test(ch)) {
      break;
    }
  }
  return closers;
}

function countBraces(codeOnly: string): { openCount: number; closeCount: number } {
  let openCount = 0;
  let closeCount = 0;
  for (let i = 0; i < codeOnly.length; i++) {
    const ch = codeOnly[i];
    if (ch === '{') openCount++;
    else if (ch === '}') closeCount++;
  }
  return { openCount, closeCount };
}

function advanceIndentStateForLine(
  trimmedLine: string,
  state: ShaderIndentState,
  indentUnit: string,
): { formattedLine: string; nextState: ShaderIndentState } {
  if (state.inBlockComment) {
    const scan = scanLineLexically(trimmedLine, true);
    return {
      formattedLine: `${indentUnit.repeat(state.braceDepth)}${trimmedLine}`,
      nextState: { braceDepth: state.braceDepth, inBlockComment: scan.inBlockComment },
    };
  }

  const scan = scanLineLexically(trimmedLine, false);

  if (trimmedLine.startsWith('#')) {
    return {
      formattedLine: `${indentUnit.repeat(state.braceDepth)}${trimmedLine}`,
      nextState: { braceDepth: state.braceDepth, inBlockComment: scan.inBlockComment },
    };
  }

  const leadingClosers = countLeadingClosers(scan.codeOnly);
  const effectiveDepth = Math.max(0, state.braceDepth - leadingClosers);
  const { openCount, closeCount } = countBraces(scan.codeOnly);
  const nextBraceDepth = Math.max(0, state.braceDepth + openCount - closeCount);

  return {
    formattedLine: `${indentUnit.repeat(effectiveDepth)}${trimmedLine}`,
    nextState: {
      braceDepth: nextBraceDepth,
      inBlockComment: scan.inBlockComment,
    },
  };
}

export function computeIndentStateBeforeLine(
  lines: readonly string[],
  targetLine: number,
): ShaderIndentState {
  let state: ShaderIndentState = { braceDepth: 0, inBlockComment: false };
  const limit = Math.min(targetLine, lines.length);
  for (let i = 0; i < limit; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.length === 0) continue;
    const step = advanceIndentStateForLine(trimmed, state, '\t');
    state = step.nextState;
  }
  return state;
}

export function formatShaderText(text: string, options: ShaderFormatOptions): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indentUnit = options.insertSpaces ? ' '.repeat(Math.max(1, options.tabSize)) : '\t';
  const rawLines = text.split(/\r?\n/);
  const outLines: string[] = [];

  let state: ShaderIndentState = { braceDepth: 0, inBlockComment: false };
  let prevBlank = false;

  for (let i = 0; i < rawLines.length; i++) {
    const trimmed = rawLines[i].trim();

    if (trimmed.length === 0) {
      if (!prevBlank && outLines.length > 0) {
        outLines.push('');
        prevBlank = true;
      }
      continue;
    }
    prevBlank = false;

    const step = advanceIndentStateForLine(trimmed, state, indentUnit);
    outLines.push(step.formattedLine);
    state = step.nextState;
  }

  while (outLines.length > 0 && outLines[outLines.length - 1] === '') {
    outLines.pop();
  }
  const trailingEol = text.endsWith('\n') || text.endsWith('\r') ? eol : '';
  return outLines.join(eol) + trailingEol;
}

function resolveShaderFormatOptions(options: vscode.FormattingOptions): ShaderFormatOptions {
  const getConfig = (vscode.workspace as unknown as {
    getConfiguration?: (section?: string) => { get: <T>(key: string, def: T) => T };
  }).getConfiguration;
  const configuredSize =
    typeof getConfig === 'function' ? getConfig('unityBrain')?.get<number>('shader.format.indentSize', 0) ?? 0 : 0;
  const tabSize =
    typeof configuredSize === 'number' && Number.isFinite(configuredSize) && configuredSize > 0
      ? Math.floor(configuredSize)
      : Math.max(1, options.tabSize);
  return {
    tabSize,
    insertSpaces: options.insertSpaces,
  };
}

export class ShaderFormattingProvider
  implements
    vscode.DocumentFormattingEditProvider,
    vscode.DocumentRangeFormattingEditProvider,
    vscode.OnTypeFormattingEditProvider
{
  public provideOnTypeFormattingEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    ch: string,
    options: vscode.FormattingOptions,
  ): vscode.TextEdit[] {
    if (ch !== '}' && ch !== '\n') return [];
    const targetLine = position.line;
    if (targetLine < 0 || targetLine >= document.lineCount) return [];

    const fmtOpts = resolveShaderFormatOptions(options);
    const indentUnit = fmtOpts.insertSpaces ? ' '.repeat(Math.max(1, fmtOpts.tabSize)) : '\t';
    const docLines = Array.from({ length: targetLine + 1 }, (_, idx) => document.lineAt(idx).text);
    const state = computeIndentStateBeforeLine(docLines, targetLine);
    const currentLine = docLines[targetLine] ?? '';
    const trimmed = currentLine.trim();

    if (ch === '\n' && trimmed.length === 0) {
      const nextIndent = indentUnit.repeat(state.braceDepth);
      if (currentLine === nextIndent) return [];
      return [
        vscode.TextEdit.replace(
          new vscode.Range(targetLine, 0, targetLine, currentLine.length),
          nextIndent,
        ),
      ];
    }

    if (trimmed.length === 0) return [];
    const { formattedLine } = advanceIndentStateForLine(trimmed, state, indentUnit);
    if (formattedLine === currentLine) return [];
    return [
      vscode.TextEdit.replace(
        new vscode.Range(targetLine, 0, targetLine, currentLine.length),
        formattedLine,
      ),
    ];
  }

  public provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
  ): vscode.TextEdit[] {
    const original = document.getText();
    const formatted = formatShaderText(original, resolveShaderFormatOptions(options));
    if (formatted === original) return [];
    const lastLine = Math.max(0, document.lineCount - 1);
    const fullRange = new vscode.Range(0, 0, lastLine, document.lineAt(lastLine).text.length);
    return [vscode.TextEdit.replace(fullRange, formatted)];
  }

  public provideDocumentRangeFormattingEdits(
    document: vscode.TextDocument,
    range: vscode.Range,
    options: vscode.FormattingOptions,
  ): vscode.TextEdit[] {
    const startLine = Math.max(0, range.start.line);
    const endLine = Math.min(document.lineCount - 1, range.end.line);
    if (endLine < startLine) return [];

    const fmtOpts = resolveShaderFormatOptions(options);
    const indentUnit = fmtOpts.insertSpaces ? ' '.repeat(Math.max(1, fmtOpts.tabSize)) : '\t';
    const fullLines = Array.from({ length: endLine + 1 }, (_, idx) => document.lineAt(idx).text);
    let state = computeIndentStateBeforeLine(fullLines, startLine);

    const outLines: string[] = [];
    for (let i = startLine; i <= endLine; i++) {
      const trimmed = fullLines[i].trim();
      if (trimmed.length === 0) {
        outLines.push('');
        continue;
      }
      const step = advanceIndentStateForLine(trimmed, state, indentUnit);
      outLines.push(step.formattedLine);
      state = step.nextState;
    }

    const lineRange = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
    const slice = document.getText(lineRange);
    const eol = slice.includes('\r\n') ? '\r\n' : '\n';
    const formatted = outLines.join(eol);
    if (formatted === slice) return [];
    return [vscode.TextEdit.replace(lineRange, formatted)];
  }
}
