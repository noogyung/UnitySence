import * as vscode from 'vscode';
import {
  isShaderFilePath,
  SHADER_LANGUAGE_IDS,
} from '../../../shader-lsp/src/vfs/virtualPathResolver.ts';

export type SupportedAutoIndentLanguage = 'csharp' | 'shader';

export interface AutoIndentOptions {
  tabSize: number;
  insertSpaces: boolean;
}

export interface LineIndentEdit {
  line: number;
  oldIndentLength: number;
  newIndent: string;
}

interface BraceFrame {
  isSwitch: boolean;
  inCaseBody: boolean;
}

interface ScannerState {
  inBlockComment: boolean;
  inVerbatimString: boolean;
  rawStringQuotes: number;
}

interface LineScanResult {
  codeOnly: string;
  startedInCommentOrString: boolean;
  endedInBlockComment: boolean;
  endedInVerbatimString: boolean;
  endedRawStringQuotes: number;
}

const SHADER_LANG_SET = new Set<string>(SHADER_LANGUAGE_IDS);

export function resolveAutoIndentLanguage(
  document: vscode.TextDocument,
): SupportedAutoIndentLanguage | null {
  if (document.languageId === 'csharp') {
    return 'csharp';
  }
  if (SHADER_LANG_SET.has(document.languageId) || isShaderFilePath(document.fileName)) {
    return 'shader';
  }
  return null;
}

function scanLine(
  line: string,
  language: SupportedAutoIndentLanguage,
  state: ScannerState,
): LineScanResult {
  let inBlockComment = state.inBlockComment;
  let inVerbatimString = state.inVerbatimString;
  let rawStringQuotes = state.rawStringQuotes;
  const startedInCommentOrString =
    inBlockComment || inVerbatimString || rawStringQuotes > 0;

  let inString = false;
  let inChar = false;
  let codeOnly = '';

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];

    if (rawStringQuotes > 0) {
      if (ch === '"') {
        let count = 1;
        while (i + count < line.length && line[i + count] === '"') {
          count++;
        }
        if (count >= rawStringQuotes) {
          i += rawStringQuotes - 1;
          rawStringQuotes = 0;
        } else {
          i += count - 1;
        }
      }
      continue;
    }

    if (inVerbatimString) {
      if (ch === '"') {
        if (next === '"') {
          i++;
        } else {
          inVerbatimString = false;
        }
      }
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
      if (ch === '\\' && i + 1 < line.length) {
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (inChar) {
      if (ch === '\\' && i + 1 < line.length) {
        i++;
      } else if (ch === '\'') {
        inChar = false;
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

    if (language === 'csharp') {
      if (ch === '$' && next === '@' && line[i + 2] === '"') {
        inVerbatimString = true;
        i += 2;
        continue;
      }
      if (ch === '@' && next === '$' && line[i + 2] === '"') {
        inVerbatimString = true;
        i += 2;
        continue;
      }
      if (ch === '@' && next === '"') {
        inVerbatimString = true;
        i++;
        continue;
      }
      if (ch === '$' && next === '"') {
        // Check for interpolated raw string ($"""...""")
        if (line[i + 2] === '"' && line[i + 3] === '"') {
          let q = 3;
          while (i + 1 + q < line.length && line[i + 1 + q] === '"') q++;
          rawStringQuotes = q;
          i += q;
          continue;
        }
        inString = true;
        i++;
        continue;
      }
      if (ch === '"' && next === '"' && line[i + 2] === '"') {
        let q = 3;
        while (i + q < line.length && line[i + q] === '"') q++;
        rawStringQuotes = q;
        i += q - 1;
        continue;
      }
      if (ch === '\'') {
        inChar = true;
        continue;
      }
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    codeOnly += ch;
  }

  return {
    codeOnly,
    startedInCommentOrString,
    endedInBlockComment: inBlockComment,
    endedInVerbatimString: inVerbatimString,
    endedRawStringQuotes: rawStringQuotes,
  };
}

function getLeadingWhitespaceLength(line: string): number {
  let len = 0;
  while (len < line.length && (line[len] === ' ' || line[len] === '\t')) {
    len++;
  }
  return len;
}

function isSwitchHeader(codeTrimmed: string): boolean {
  return /\bswitch\s*\([^)]*\)\s*\{?$/.test(codeTrimmed);
}

function isCaseOrDefaultLabel(codeTrimmed: string): boolean {
  return /^(?:case\b.*:|default\s*:)/.test(codeTrimmed);
}

function isBracelessControlHeader(
  codeTrimmed: string,
  language: SupportedAutoIndentLanguage,
): boolean {
  if (language === 'shader' && /^\s*#/.test(codeTrimmed)) return false;
  if (codeTrimmed.endsWith('{') || codeTrimmed.endsWith(';')) return false;
  if (/^(?:else\s+if|if|for|foreach|while|using|lock|fixed)\s*\(.*\)$/.test(codeTrimmed)) {
    return true;
  }
  if (/^else$/.test(codeTrimmed)) {
    return true;
  }
  return false;
}

function isLikelyHeaderExpectingBrace(
  codeTrimmed: string,
  language: SupportedAutoIndentLanguage,
): boolean {
  if (!codeTrimmed) return false;
  if (codeTrimmed.endsWith(')') || codeTrimmed.endsWith(']')) {
    // Method/control header or attribute
    if (/^\[.*\]$/.test(codeTrimmed)) return true;
    if (
      /^(?:public|private|protected|internal|static|virtual|override|abstract|sealed|async|extern|unsafe|partial|new|inline|void|bool|int|uint|float|double|half|real|fixed|string|var|[A-Za-z_][A-Za-z0-9_<>,.\s]*)\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(
        codeTrimmed,
      )
    ) {
      return true;
    }
    if (/^(?:if|else\s+if|for|foreach|while|switch|catch|using|lock|fixed)\s*\(/.test(codeTrimmed)) {
      return true;
    }
  }
  if (
    /^(?:namespace|class|struct|interface|enum|record|try|else|finally|do|get|set|init|add|remove)\b/.test(
      codeTrimmed,
    )
  ) {
    return true;
  }
  if (
    language === 'shader' &&
    /^(?:Shader|Properties|SubShader|Pass|Category|Stencil|Blend|Fallback|cbuffer|tbuffer|struct)\b/.test(
      codeTrimmed,
    )
  ) {
    return true;
  }
  return false;
}

export function computeAutoIndentEdits(
  lines: readonly string[],
  language: SupportedAutoIndentLanguage,
  options: AutoIndentOptions,
  startLine = 0,
  endLine = lines.length - 1,
): LineIndentEdit[] {
  const safeTabSize = Math.max(1, Math.floor(options.tabSize || 4));
  const indentUnit = options.insertSpaces ? ' '.repeat(safeTabSize) : '\t';
  const clampedStart = Math.max(0, startLine);
  const clampedEnd = Math.min(lines.length - 1, endLine);
  if (clampedEnd < clampedStart) return [];

  const edits: LineIndentEdit[] = [];
  const braceStack: BraceFrame[] = [];
  let scannerState: ScannerState = {
    inBlockComment: false,
    inVerbatimString: false,
    rawStringQuotes: 0,
  };
  let parenDepth = 0;
  let bracketDepth = 0;
  let singleLineControlDepth = 0;
  let inContinuation = false;
  let prevNonBlankCode = '';

  for (let lineIdx = 0; lineIdx <= clampedEnd; lineIdx++) {
    const rawLine = lines[lineIdx] ?? '';
    const oldIndentLen = getLeadingWhitespaceLength(rawLine);
    const oldIndent = rawLine.slice(0, oldIndentLen);
    const trimmed = rawLine.trim();
    const wasInMultilineString =
      scannerState.inVerbatimString || scannerState.rawStringQuotes > 0;
    const wasInBlockComment = scannerState.inBlockComment;

    const scan = scanLine(rawLine, language, scannerState);
    scannerState = {
      inBlockComment: scan.endedInBlockComment,
      inVerbatimString: scan.endedInVerbatimString,
      rawStringQuotes: scan.endedRawStringQuotes,
    };

    // Never touch lines that start inside multi-line verbatim or raw strings,
    // but if the string closes on this line, still update brace/continuation state from trailing code.
    if (wasInMultilineString) {
      const codeAfterString = scan.codeOnly.trim();
      if (codeAfterString.length > 0) {
        for (let i = 0; i < scan.codeOnly.length; i++) {
          const ch = scan.codeOnly[i];
          if (ch === '{') {
            braceStack.push({ isSwitch: false, inCaseBody: false });
          } else if (ch === '}' && braceStack.length > 0) {
            braceStack.pop();
          } else if (ch === '(') {
            parenDepth++;
          } else if (ch === ')') {
            parenDepth = Math.max(0, parenDepth - 1);
          } else if (ch === '[') {
            bracketDepth++;
          } else if (ch === ']') {
            bracketDepth = Math.max(0, bracketDepth - 1);
          }
        }
        if (
          parenDepth === 0 &&
          bracketDepth === 0 &&
          (codeAfterString.endsWith(';') ||
            codeAfterString.endsWith('}') ||
            codeAfterString.endsWith('{'))
        ) {
          singleLineControlDepth = 0;
          inContinuation = false;
        }
      }
      continue;
    }

    // Blank line: strip stray whitespace only within target range
    if (trimmed.length === 0) {
      if (lineIdx >= clampedStart && oldIndentLen > 0) {
        edits.push({ line: lineIdx, oldIndentLength: oldIndentLen, newIndent: '' });
      }
      continue;
    }

    const codeTrimmed = scan.codeOnly.trim();
    const braceDepth = braceStack.length;

    // Inside multi-line block comment (line has no leading code before comment)
    if (wasInBlockComment && codeTrimmed.length === 0) {
      const topSwitch = braceStack[braceStack.length - 1];
      const extraCase = topSwitch?.isSwitch && topSwitch.inCaseBody ? 1 : 0;
      const depth = braceDepth + extraCase + (parenDepth > 0 ? 1 : 0);
      const baseIndent = indentUnit.repeat(depth);
      const expectedIndent = trimmed.startsWith('*') ? `${baseIndent} ` : baseIndent;
      if (lineIdx >= clampedStart && oldIndent !== expectedIndent) {
        edits.push({ line: lineIdx, oldIndentLength: oldIndentLen, newIndent: expectedIndent });
      }
      continue;
    }

    // Preprocessor directives
    if (!wasInBlockComment && trimmed.startsWith('#')) {
      let expectedIndent = oldIndent;
      if (language === 'shader') {
        expectedIndent = indentUnit.repeat(braceDepth);
      } else if (/^#\s*(?:region|endregion)\b/.test(trimmed)) {
        expectedIndent = indentUnit.repeat(braceDepth);
      } else if (oldIndentLen > 0) {
        // Preserve column 0 directives if already at column 0; otherwise align to braceDepth
        expectedIndent = indentUnit.repeat(braceDepth);
      }
      if (lineIdx >= clampedStart && oldIndent !== expectedIndent) {
        edits.push({ line: lineIdx, oldIndentLength: oldIndentLen, newIndent: expectedIndent });
      }
      continue;
    }

    // If line starts with '{', cancel braceless control & continuation indent
    if (codeTrimmed.startsWith('{')) {
      singleLineControlDepth = 0;
      inContinuation = false;
    }

    // Count leading closers ('}', ')', ']')
    let leadingBraceClosers = 0;
    let leadingParenClosers = 0;
    let leadingBracketClosers = 0;
    for (let i = 0; i < codeTrimmed.length; i++) {
      const c = codeTrimmed[i];
      if (c === '}') leadingBraceClosers++;
      else if (c === ')') leadingParenClosers++;
      else if (c === ']') leadingBracketClosers++;
      else if (!/\s/.test(c)) break;
    }

    const effectiveBraceDepth = Math.max(0, braceDepth - leadingBraceClosers);
    const effectiveParenDepth = Math.max(0, parenDepth - leadingParenClosers);
    const effectiveBracketDepth = Math.max(0, bracketDepth - leadingBracketClosers);

    const topFrame =
      effectiveBraceDepth > 0 ? braceStack[effectiveBraceDepth - 1] : undefined;
    const isCaseLine = Boolean(topFrame?.isSwitch && isCaseOrDefaultLabel(codeTrimmed));
    const caseBodyExtra =
      topFrame?.isSwitch && topFrame.inCaseBody && !isCaseLine && leadingBraceClosers === 0
        ? 1
        : 0;

    let extraDepth = caseBodyExtra;
    if (effectiveParenDepth > 0 || effectiveBracketDepth > 0) {
      extraDepth += 1;
    } else if (singleLineControlDepth > 0 && leadingBraceClosers === 0) {
      extraDepth += singleLineControlDepth;
    } else if (inContinuation && leadingBraceClosers === 0 && !isCaseLine) {
      extraDepth += 1;
    }

    const totalDepth = effectiveBraceDepth + extraDepth;
    const expectedIndent = indentUnit.repeat(totalDepth);

    if (lineIdx >= clampedStart && oldIndent !== expectedIndent) {
      edits.push({
        line: lineIdx,
        oldIndentLength: oldIndentLen,
        newIndent: expectedIndent,
      });
    }

    // Update switch case tracking on current switch frame
    if (topFrame?.isSwitch) {
      if (isCaseLine) {
        topFrame.inCaseBody = true;
      }
    }

    // Advance braceStack, parenDepth, bracketDepth from codeOnly
    const pendingSwitchForNextBrace = isSwitchHeader(codeTrimmed);
    const prevWasSwitch = isSwitchHeader(prevNonBlankCode);
    for (let i = 0; i < scan.codeOnly.length; i++) {
      const ch = scan.codeOnly[i];
      if (ch === '{') {
        const isSwitch =
          pendingSwitchForNextBrace ||
          (i === scan.codeOnly.indexOf('{') && codeTrimmed.startsWith('{') && prevWasSwitch);
        braceStack.push({ isSwitch, inCaseBody: false });
      } else if (ch === '}') {
        if (braceStack.length > 0) {
          braceStack.pop();
        }
      } else if (ch === '(') {
        parenDepth++;
      } else if (ch === ')') {
        parenDepth = Math.max(0, parenDepth - 1);
      } else if (ch === '[') {
        bracketDepth++;
      } else if (ch === ']') {
        bracketDepth = Math.max(0, bracketDepth - 1);
      }
    }

    // Update singleLineControlDepth & inContinuation for next line
    if (codeTrimmed.length > 0) {
      if (parenDepth === 0 && bracketDepth === 0) {
        if (isBracelessControlHeader(codeTrimmed, language)) {
          singleLineControlDepth++;
          inContinuation = false;
        } else if (
          codeTrimmed.endsWith(';') ||
          codeTrimmed.endsWith('}') ||
          codeTrimmed.endsWith('{')
        ) {
          singleLineControlDepth = 0;
          inContinuation = false;
        } else if (
          codeTrimmed.endsWith(':') ||
          codeTrimmed.endsWith(',') ||
          isLikelyHeaderExpectingBrace(codeTrimmed, language)
        ) {
          inContinuation = false;
        } else {
          inContinuation = true;
        }
      } else {
        inContinuation = false;
      }
      prevNonBlankCode = codeTrimmed;
    }
  }

  return edits;
}

export function autoIndentText(
  text: string,
  language: SupportedAutoIndentLanguage,
  options: AutoIndentOptions,
): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const edits = computeAutoIndentEdits(lines, language, options);
  if (edits.length === 0) return text;

  const updated = [...lines];
  for (const edit of edits) {
    updated[edit.line] = edit.newIndent + updated[edit.line].slice(edit.oldIndentLength);
  }
  return updated.join(eol);
}

const AUTO_PAIR_INSERTIONS = new Set(['""', "''", '()', '{}', '[]', '/* */', ', ']);

export function isPasteLikeChange(
  change: vscode.TextDocumentContentChangeEvent,
  document: vscode.TextDocument,
): boolean {
  const text = change.text;
  if (!text || text.length === 0) return false;
  if (/^\r?\n[ \t]*$/.test(text)) return false;
  if (text.length <= 1) return false;
  if (AUTO_PAIR_INSERTIONS.has(text)) return false;

  if (/\r?\n/.test(text)) {
    return text.trim().length > 0;
  }

  // Single-line insertion: treat as paste when non-whitespace >= 2 chars
  // and inserted at leading indentation or starts with whitespace.
  if (text.trim().length < 2) return false;
  const startLine = change.range.start.line;
  if (startLine < 0 || startLine >= document.lineCount) return false;
  const lineText = document.lineAt(startLine).text;
  const leadingLen = getLeadingWhitespaceLength(lineText);
  return change.range.start.character <= leadingLen || /^[ \t]+/.test(text);
}

interface EditorWithOptions {
  options?: { tabSize?: number | string; insertSpaces?: boolean | string };
  edit?: (
    callback: (editBuilder: { replace: (range: vscode.Range, newText: string) => void }) => void,
    options?: { undoStopBefore: boolean; undoStopAfter: boolean },
  ) => Promise<boolean>;
}

export class CodeAutoIndentManager implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly applyingUris = new Set<string>();
  private disposed = false;

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        void this.handleDocumentChange(event);
      }),
    );

    const workspaceWithWillSave = vscode.workspace as unknown as {
      onWillSaveTextDocument?: (
        listener: (e: {
          document: vscode.TextDocument;
          reason?: number;
          waitUntil: (thenable: PromiseLike<vscode.TextEdit[]>) => void;
        }) => void,
      ) => vscode.Disposable;
    };

    if (typeof workspaceWithWillSave.onWillSaveTextDocument === 'function') {
      this.disposables.push(
        workspaceWithWillSave.onWillSaveTextDocument((event) => {
          if (!this.isEnabled() || !this.isOnSaveEnabled()) return;
          if (event.reason !== undefined && event.reason !== 1) return;
          const edits = this.computeDocumentTextEdits(event.document);
          if (edits.length > 0) {
            event.waitUntil(Promise.resolve(edits));
          }
        }),
      );
    }
  }

  public isEnabled(): boolean {
    return vscode.workspace
      .getConfiguration('unitySense')
      .get<boolean>('autoIndent.enabled', true);
  }

  public isOnPasteEnabled(): boolean {
    return vscode.workspace
      .getConfiguration('unitySense')
      .get<boolean>('autoIndent.onPaste', true);
  }

  public isOnSaveEnabled(): boolean {
    return vscode.workspace
      .getConfiguration('unitySense')
      .get<boolean>('autoIndent.onSave', true);
  }

  public resolveOptions(
    document: vscode.TextDocument,
    language: SupportedAutoIndentLanguage,
    editor?: vscode.TextEditor,
  ): AutoIndentOptions {
    const editorCfg = vscode.workspace.getConfiguration('editor');
    let tabSize = editorCfg.get<number>('tabSize', 4);
    let insertSpaces = editorCfg.get<boolean>('insertSpaces', true);

    const targetEditor =
      editor ??
      vscode.window.visibleTextEditors.find(
        (ed) => ed.document.uri.toString() === document.uri.toString(),
      ) ??
      (vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString()
        ? vscode.window.activeTextEditor
        : undefined);

    const edOpts = (targetEditor as unknown as EditorWithOptions | undefined)?.options;
    if (edOpts) {
      if (typeof edOpts.tabSize === 'number' && Number.isFinite(edOpts.tabSize) && edOpts.tabSize > 0) {
        tabSize = Math.floor(edOpts.tabSize);
      }
      if (typeof edOpts.insertSpaces === 'boolean') {
        insertSpaces = edOpts.insertSpaces;
      }
    }

    if (language === 'shader') {
      const shaderIndentSize = vscode.workspace
        .getConfiguration('unitySense')
        .get<number>('shader.format.indentSize', 0);
      if (typeof shaderIndentSize === 'number' && Number.isFinite(shaderIndentSize) && shaderIndentSize > 0) {
        tabSize = Math.floor(shaderIndentSize);
      }
    }

    return {
      tabSize: Math.max(1, Math.floor(tabSize || 4)),
      insertSpaces: Boolean(insertSpaces),
    };
  }

  public computeDocumentTextEdits(
    document: vscode.TextDocument,
    startLine?: number,
    endLine?: number,
    editor?: vscode.TextEditor,
  ): vscode.TextEdit[] {
    const language = resolveAutoIndentLanguage(document);
    if (!language) return [];

    const options = this.resolveOptions(document, language, editor);
    const lines = Array.from({ length: document.lineCount }, (_, i) => document.lineAt(i).text);
    const indentEdits = computeAutoIndentEdits(lines, language, options, startLine, endLine);
    return indentEdits.map((ed) =>
      vscode.TextEdit.replace(
        new vscode.Range(ed.line, 0, ed.line, ed.oldIndentLength),
        ed.newIndent,
      ),
    );
  }

  public async indentEditor(
    editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
  ): Promise<boolean> {
    if (!editor || this.disposed) return false;
    const doc = editor.document;
    const language = resolveAutoIndentLanguage(doc);
    if (!language) return false;

    const sel = editor.selection;
    const hasSelection =
      sel && (sel.start.line !== sel.end.line || sel.start.character !== sel.end.character);
    const startLine = hasSelection ? sel.start.line : 0;
    const endLine = hasSelection ? sel.end.line : doc.lineCount - 1;

    const edits = this.computeDocumentTextEdits(doc, startLine, endLine, editor);
    if (edits.length === 0) return false;

    return this.applyTextEdits(doc, edits, editor, true);
  }

  private async handleDocumentChange(event: vscode.TextDocumentChangeEvent): Promise<void> {
    if (this.disposed) return;
    if (!this.isEnabled() || !this.isOnPasteEnabled()) return;
    if (event.contentChanges.length === 0) return;

    const doc = event.document;
    const uriKey = doc.uri.toString();
    if (this.applyingUris.has(uriKey)) return;

    const reasonEnum = (
      vscode as unknown as { TextDocumentChangeReason?: { Undo: number; Redo: number } }
    ).TextDocumentChangeReason;
    if (
      event.reason !== undefined &&
      reasonEnum !== undefined &&
      (event.reason === reasonEnum.Undo || event.reason === reasonEnum.Redo)
    ) {
      return;
    }

    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor || activeEditor.document.uri.toString() !== uriKey) return;

    const language = resolveAutoIndentLanguage(doc);
    if (!language) return;

    const pasteChanges = event.contentChanges.filter((c) => isPasteLikeChange(c, doc));
    if (pasteChanges.length === 0) return;

    let minStartLine = Number.POSITIVE_INFINITY;
    let maxEndLine = -1;
    for (const change of pasteChanges) {
      const addedLines = change.text.split(/\r?\n/).length - 1;
      const startL = Math.max(0, change.range.start.line);
      const endL = Math.min(doc.lineCount - 1, startL + addedLines);
      if (startL < minStartLine) minStartLine = startL;
      if (endL > maxEndLine) maxEndLine = endL;
    }
    if (maxEndLine < minStartLine) return;

    const edits = this.computeDocumentTextEdits(doc, minStartLine, maxEndLine, activeEditor);
    if (edits.length === 0) return;

    await this.applyTextEdits(doc, edits, activeEditor, false);
  }

  private async applyTextEdits(
    document: vscode.TextDocument,
    edits: readonly vscode.TextEdit[],
    editor: vscode.TextEditor | undefined,
    undoStopBefore: boolean,
  ): Promise<boolean> {
    const uriKey = document.uri.toString();
    this.applyingUris.add(uriKey);
    try {
      const editable = editor as unknown as EditorWithOptions | undefined;
      if (editable && typeof editable.edit === 'function') {
        return await editable.edit(
          (builder) => {
            for (const te of edits) {
              builder.replace(te.range, te.newText);
            }
          },
          { undoStopBefore, undoStopAfter: true },
        );
      }

      const wsEdit = new vscode.WorkspaceEdit();
      for (const te of edits) {
        wsEdit.replace(document.uri, te.range, te.newText);
      }
      return await vscode.workspace.applyEdit(wsEdit);
    } finally {
      this.applyingUris.delete(uriKey);
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.applyingUris.clear();
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }
}

export function registerAutoIndentCommand(manager: CodeAutoIndentManager): vscode.Disposable {
  return vscode.commands.registerCommand('unitySense.autoIndentDocument', () =>
    manager.indentEditor(),
  );
}
