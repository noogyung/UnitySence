import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import {
  computeHeatBackgroundColor,
  computeHeatStripColor,
  DEFAULT_BLAME_AUTHOR_DISPLAY,
  DEFAULT_BLAME_COLUMN_FORMAT,
  DEFAULT_BLAME_COLUMN_WIDTH,
  DEFAULT_BLAME_DATE_FORMAT,
  DEFAULT_BLAME_INLINE_FORMAT,
  formatBlameGutterColumnText,
  formatBlameInlineText,
  formatFullBlameDateTime,
  type GitBlameAuthorDisplay,
  type GitBlameDateFormat,
  type GitBlameLineInfo,
  parseGitBlamePorcelain,
} from './gitBlameParser.ts';

const execFileAsync = promisify(execFile);

export type GitBlameRunner = (filePath: string, unsavedContent?: string) => Promise<string | null>;

interface CachedBlameEntry {
  mtimeMs: number;
  docVersion: number;
  isDirty: boolean;
  linesByNumber: Map<number, GitBlameLineInfo>;
}

interface LegacyWordWrapBackup {
  hadGlobal: boolean;
  previousGlobal?: string;
  languageBackups: Record<string, { hadValue: boolean; previousValue?: string }>;
}

const LEGACY_WORD_WRAP_BACKUP_KEY = 'unitySense.gitBlame.wordWrapBackup.v1';
const VALID_AUTHOR_DISPLAYS = new Set<GitBlameAuthorDisplay>([
  'name',
  'email',
  'emailLocalPart',
  'nameAndEmail',
  'none',
]);

function resolveGitExecutable(): string {
  try {
    const configured = vscode.workspace.getConfiguration('git').get<string>('path');
    if (typeof configured === 'string' && configured.trim().length > 0) {
      return configured.trim();
    }
  } catch {
    // Ignore missing git configuration section
  }
  return 'git';
}

function runGitBlameWithStdin(
  gitBin: string,
  cwd: string,
  baseName: string,
  stdinContent: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val: string | null) => {
      if (!settled) {
        settled = true;
        resolve(val);
      }
    };

    try {
      const child = spawn(
        gitBin,
        ['blame', '--porcelain', '--contents', '-', '--', baseName],
        {
          cwd,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'ignore'],
        },
      );
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      const maxBytes = 16 * 1024 * 1024;

      child.stdout?.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes <= maxBytes) {
          chunks.push(chunk);
        }
      });
      child.on('error', () => finish(null));
      child.on('close', (code) => {
        if (code === 0 && chunks.length > 0) {
          finish(Buffer.concat(chunks).toString('utf8'));
        } else {
          finish(null);
        }
      });

      child.stdin?.on('error', () => {
        // Ignore broken pipe when file is untracked
      });
      child.stdin?.end(stdinContent, 'utf8');
    } catch {
      finish(null);
    }
  });
}

async function defaultGitBlameRunner(
  filePath: string,
  unsavedContent?: string,
): Promise<string | null> {
  const cwd = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const gitBin = resolveGitExecutable();

  if (unsavedContent !== undefined) {
    const liveOut = await runGitBlameWithStdin(gitBin, cwd, baseName, unsavedContent);
    if (liveOut) {
      return liveOut;
    }
  }

  try {
    const { stdout } = await execFileAsync(
      gitBin,
      ['blame', '--porcelain', '--', baseName],
      {
        cwd,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
    );
    return stdout;
  } catch {
    return null;
  }
}

function buildWrapContinuationCss(
  columnWidth: number,
  hideAccentBar: boolean,
  customBgColor: string,
  customAccentColor: string,
): string {
  const spacerPad = '\u00a0'.repeat(columnWidth + 2);
  const barGlyph = hideAccentBar ? '' : '▎';
  const totalCh = columnWidth + (hideAccentBar ? 2 : 3);
  const bg = customBgColor || 'rgba(148, 163, 184, 0.04)';
  const barColor = customAccentColor && !hideAccentBar
    ? customAccentColor
    : 'rgba(148, 163, 184, 0.25)';

  // Matches ONLY the first token span on soft-wrapped continuation rows (Visual Row 2+):
  // - On Visual Row 1, preceding siblings (InjectedText blame column & firstCharMarker on col 0..1)
  //   carry `ced-*` classes, so `:not([class*="ced-"] ~ &)` never matches Visual Row 1.
  // - On Visual Row 2+, any leading `ws-faux-indent` span has no `ced-*` class, so the first wrapped
  //   token span matches, shifts right by the exact blame column width, and pins an empty continuation
  //   column box at `left: 0` of `<div class="view-line">`.
  return [
    'none;',
    `&:not([class*="ced-"] ~ &) { margin-left: calc(${totalCh}ch + 12px); }`,
    `&:not([class*="ced-"] ~ &)::before { content: "${spacerPad}${barGlyph}"; position: absolute; left: 0; top: 0; width: ${totalCh}ch; overflow: clip; white-space: pre; box-sizing: border-box; color: ${barColor}; background-color: ${bg}; font-style: normal; font-weight: normal; pointer-events: none; }`,
    'border-spacing: 0',
  ].join(' ');
}

export class RiderGitBlameProvider implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly runner: GitBlameRunner;
  private readonly state?: vscode.Memento;
  private readonly editorAnnotateOverrides = new Map<string, boolean>();
  private readonly cache = new Map<string, CachedBlameEntry>();
  private readonly changeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly gutterDecorationType: vscode.TextEditorDecorationType;
  private readonly heatStripDecorationType: vscode.TextEditorDecorationType;
  private readonly firstCharMarkerDecorationType: vscode.TextEditorDecorationType;
  private wrapContinuationDecorationType: vscode.TextEditorDecorationType;
  private wrapContinuationSpecKey = '';
  private readonly inlineDecorationType: vscode.TextEditorDecorationType;
  private disposed = false;

  constructor(runner: GitBlameRunner = defaultGitBlameRunner, context?: vscode.ExtensionContext) {
    this.runner = runner;
    this.state = context?.globalState;
    this.gutterDecorationType = vscode.window.createTextEditorDecorationType({
      before: {
        fontStyle: 'normal',
        fontWeight: 'normal',
        textDecoration: 'none; overflow: clip; white-space: pre; box-sizing: border-box;',
      },
    });
    this.heatStripDecorationType = vscode.window.createTextEditorDecorationType({
      before: {
        fontStyle: 'normal',
        fontWeight: 'normal',
        width: '1ch',
        margin: '0 12px 0 0',
        textDecoration: 'none; overflow: clip; white-space: pre; box-sizing: border-box;',
      },
    });
    this.firstCharMarkerDecorationType = vscode.window.createTextEditorDecorationType({
      textDecoration: 'none',
    });
    this.wrapContinuationDecorationType = this.createWrapContinuationType();
    this.inlineDecorationType = vscode.window.createTextEditorDecorationType({
      after: {
        fontStyle: 'italic',
        margin: '0 0 0 24px',
      },
    });

    this.disposables.push(
      this.gutterDecorationType,
      this.heatStripDecorationType,
      this.firstCharMarkerDecorationType,
      this.inlineDecorationType,
      vscode.workspace.onDidSaveTextDocument((doc) => {
        const key = doc.uri.toString();
        this.clearChangeTimer(key);
        this.cache.delete(key);
        for (const editor of this.findVisibleEditors(key)) {
          void this.refreshEditor(editor);
        }
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length === 0) return;
        const doc = e.document;
        if (doc.isUntitled || doc.uri.scheme !== 'file') return;
        const key = doc.uri.toString();
        if (!this.isAnnotated(doc.uri) && !this.isInlineCurrentLineEnabled()) {
          return;
        }
        this.clearChangeTimer(key);
        this.changeTimers.set(
          key,
          setTimeout(() => {
            this.changeTimers.delete(key);
            this.cache.delete(key);
            for (const editor of this.findVisibleEditors(key)) {
              void this.refreshEditor(editor);
            }
          }, 300),
        );
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        const key = doc.uri.toString();
        this.clearChangeTimer(key);
        this.editorAnnotateOverrides.delete(key);
        this.cache.delete(key);
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          void this.refreshEditor(editor);
        }
      }),
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const ed of editors) {
          void this.refreshEditor(ed);
        }
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (this.isInlineCurrentLineEnabled()) {
          void this.renderInlineCurrentLine(event.textEditor);
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('unitySense.gitBlame')) {
          if (e.affectsConfiguration('unitySense.gitBlame.showGutterColumn')) {
            this.editorAnnotateOverrides.clear();
          }
          this.ensureWrapContinuationDecorationType();
          void this.refreshAllVisibleEditors();
        }
      }),
    );

    void this.restoreLegacyWordWrapBackupIfPresent().then(() => this.refreshAllVisibleEditors());
  }

  private async restoreLegacyWordWrapBackupIfPresent(): Promise<void> {
    if (!this.state) return;
    const legacyBackup = this.state.get<LegacyWordWrapBackup>(LEGACY_WORD_WRAP_BACKUP_KEY);
    if (!legacyBackup) return;

    const editorCfg = vscode.workspace.getConfiguration('editor');
    await editorCfg.update(
      'wordWrap',
      legacyBackup.hadGlobal ? legacyBackup.previousGlobal : undefined,
      vscode.ConfigurationTarget.Global,
    );
    for (const [langId, entry] of Object.entries(legacyBackup.languageBackups ?? {})) {
      const langCfg = vscode.workspace.getConfiguration('editor', { languageId: langId });
      await langCfg.update(
        'wordWrap',
        entry.hadValue ? entry.previousValue : undefined,
        vscode.ConfigurationTarget.Global,
        true,
      );
    }
    await this.state.update(LEGACY_WORD_WRAP_BACKUP_KEY, undefined);
  }

  private computeWrapSpecKey(): {
    key: string;
    columnWidth: number;
    hideAccentBar: boolean;
    customBgColor: string;
    customAccentColor: string;
  } {
    const columnWidth = this.getColumnWidth();
    const customBgColor = this.getCustomBackgroundColor();
    const customAccentColor = this.getCustomAccentBarColor();
    const hideAccentBar =
      customAccentColor.toLowerCase() === 'none' ||
      customAccentColor.toLowerCase() === 'transparent';
    const key = `${columnWidth}|${hideAccentBar ? '1' : '0'}|${customBgColor}|${customAccentColor}`;
    return { key, columnWidth, hideAccentBar, customBgColor, customAccentColor };
  }

  private createWrapContinuationType(): vscode.TextEditorDecorationType {
    const spec = this.computeWrapSpecKey();
    this.wrapContinuationSpecKey = spec.key;
    return vscode.window.createTextEditorDecorationType({
      textDecoration: buildWrapContinuationCss(
        spec.columnWidth,
        spec.hideAccentBar,
        spec.customBgColor,
        spec.customAccentColor,
      ),
    });
  }

  private ensureWrapContinuationDecorationType(): void {
    const spec = this.computeWrapSpecKey();
    if (spec.key === this.wrapContinuationSpecKey) return;

    const prevType = this.wrapContinuationDecorationType;
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations?.(prevType, []);
    }
    if (vscode.window.activeTextEditor) {
      vscode.window.activeTextEditor.setDecorations?.(prevType, []);
    }
    prevType.dispose();
    this.wrapContinuationDecorationType = this.createWrapContinuationType();
  }

  private clearChangeTimer(key: string): void {
    const existing = this.changeTimers.get(key);
    if (existing) {
      clearTimeout(existing);
      this.changeTimers.delete(key);
    }
  }

  public isFeatureEnabled(): boolean {
    return vscode.workspace.getConfiguration('unitySense').get<boolean>('gitBlame.enabled', true);
  }

  public isGutterColumnAlwaysEnabled(): boolean {
    if (!this.isFeatureEnabled()) return false;
    return vscode.workspace
      .getConfiguration('unitySense')
      .get<boolean>('gitBlame.showGutterColumn', true);
  }

  public shouldGroupConsecutiveCommits(): boolean {
    return vscode.workspace
      .getConfiguration('unitySense')
      .get<boolean>('gitBlame.groupConsecutiveCommits', false);
  }

  public isInlineCurrentLineEnabled(): boolean {
    if (!this.isFeatureEnabled()) return false;
    return vscode.workspace
      .getConfiguration('unitySense')
      .get<boolean>('gitBlame.inlineCurrentLine', false);
  }

  public getDateFormat(): GitBlameDateFormat {
    const raw = vscode.workspace
      .getConfiguration('unitySense')
      .get<string>('gitBlame.dateFormat', DEFAULT_BLAME_DATE_FORMAT);
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : DEFAULT_BLAME_DATE_FORMAT;
  }

  public getAuthorDisplay(): GitBlameAuthorDisplay {
    const raw = vscode.workspace
      .getConfiguration('unitySense')
      .get<string>('gitBlame.authorDisplay', DEFAULT_BLAME_AUTHOR_DISPLAY) as GitBlameAuthorDisplay;
    return VALID_AUTHOR_DISPLAYS.has(raw) ? raw : DEFAULT_BLAME_AUTHOR_DISPLAY;
  }

  public getColumnFormat(): string {
    const raw = vscode.workspace
      .getConfiguration('unitySense')
      .get<string>('gitBlame.columnFormat', DEFAULT_BLAME_COLUMN_FORMAT);
    return typeof raw === 'string' && raw.length > 0 ? raw : DEFAULT_BLAME_COLUMN_FORMAT;
  }

  public getColumnWidth(): number {
    const raw = vscode.workspace
      .getConfiguration('unitySense')
      .get<number>('gitBlame.columnWidth', DEFAULT_BLAME_COLUMN_WIDTH);
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return DEFAULT_BLAME_COLUMN_WIDTH;
    }
    return Math.max(6, Math.min(80, Math.round(raw)));
  }

  public getForegroundColor(): string {
    const raw = vscode.workspace
      .getConfiguration('unitySense')
      .get<string>('gitBlame.foregroundColor', '#CBD5E1');
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : '#CBD5E1';
  }

  public getUncommittedForegroundColor(): string {
    const raw = vscode.workspace
      .getConfiguration('unitySense')
      .get<string>('gitBlame.uncommittedForegroundColor', '#E5C07B');
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : '#E5C07B';
  }

  public getCustomBackgroundColor(): string {
    const raw = vscode.workspace
      .getConfiguration('unitySense')
      .get<string>('gitBlame.backgroundColor', '');
    return typeof raw === 'string' ? raw.trim() : '';
  }

  public getCustomAccentBarColor(): string {
    const raw = vscode.workspace
      .getConfiguration('unitySense')
      .get<string>('gitBlame.accentBarColor', '');
    return typeof raw === 'string' ? raw.trim() : '';
  }

  public getInlineFormat(): string {
    const raw = vscode.workspace
      .getConfiguration('unitySense')
      .get<string>('gitBlame.inlineFormat', DEFAULT_BLAME_INLINE_FORMAT);
    return typeof raw === 'string' && raw.trim().length > 0 ? raw : DEFAULT_BLAME_INLINE_FORMAT;
  }

  public getInlineForegroundColor(): string {
    const raw = vscode.workspace
      .getConfiguration('unitySense')
      .get<string>('gitBlame.inlineForegroundColor', 'rgba(148, 163, 184, 0.65)');
    return typeof raw === 'string' && raw.trim().length > 0
      ? raw.trim()
      : 'rgba(148, 163, 184, 0.65)';
  }

  public showHeatStrip(): boolean {
    return vscode.workspace
      .getConfiguration('unitySense')
      .get<boolean>('gitBlame.showHeatStrip', true);
  }

  public isAnnotated(uri: vscode.Uri): boolean {
    if (!this.isFeatureEnabled()) return false;
    const key = uri.toString();
    const override = this.editorAnnotateOverrides.get(key);
    return override !== undefined ? override : this.isGutterColumnAlwaysEnabled();
  }

  public resolveTargetEditor(contextArg?: unknown): vscode.TextEditor | undefined {
    if (contextArg && typeof contextArg === 'object') {
      if ('document' in contextArg && contextArg.document) {
        return contextArg as vscode.TextEditor;
      }
      const candidateUri =
        'uri' in contextArg && contextArg.uri && typeof (contextArg.uri as vscode.Uri).toString === 'function'
          ? (contextArg.uri as vscode.Uri)
          : 'fsPath' in contextArg && typeof (contextArg as vscode.Uri).toString === 'function'
            ? (contextArg as vscode.Uri)
            : undefined;
      if (candidateUri) {
        const matched = this.findVisibleEditors(candidateUri.toString())[0];
        if (matched) return matched;
      }
    }
    return vscode.window.activeTextEditor;
  }

  public async toggleForEditor(
    editorOrContext: unknown = vscode.window.activeTextEditor,
  ): Promise<boolean> {
    const editor = this.resolveTargetEditor(editorOrContext);
    if (!editor || !this.isFeatureEnabled()) {
      return false;
    }
    const currentlyAnnotated = this.isAnnotated(editor.document.uri);
    const unityCfg = vscode.workspace.getConfiguration('unitySense');

    if (currentlyAnnotated) {
      this.editorAnnotateOverrides.clear();
      await unityCfg.update('gitBlame.showGutterColumn', false, vscode.ConfigurationTarget.Global);
      await this.refreshAllVisibleEditors();
      return false;
    }

    const blameMap = await this.loadBlameMap(editor.document);
    if (!blameMap || blameMap.size === 0) {
      void vscode.window.showInformationMessage(
        '[UnitySense] Git Blame 정보를 불러올 수 없습니다. (Git 저장소 외부이거나 아직 추적되지 않은 파일)',
      );
      return false;
    }

    this.editorAnnotateOverrides.clear();
    await unityCfg.update('gitBlame.showGutterColumn', true, vscode.ConfigurationTarget.Global);
    await this.refreshAllVisibleEditors();
    return true;
  }

  public async refreshAllVisibleEditors(): Promise<void> {
    if (this.disposed) return;
    const seen = new Set<vscode.TextEditor>();
    for (const editor of vscode.window.visibleTextEditors) {
      seen.add(editor);
      await this.refreshEditor(editor);
    }
    if (vscode.window.activeTextEditor && !seen.has(vscode.window.activeTextEditor)) {
      await this.refreshEditor(vscode.window.activeTextEditor);
    }
  }

  private clearGutterDecorations(editor: vscode.TextEditor): void {
    editor.setDecorations?.(this.gutterDecorationType, []);
    editor.setDecorations?.(this.heatStripDecorationType, []);
    editor.setDecorations?.(this.firstCharMarkerDecorationType, []);
    editor.setDecorations?.(this.wrapContinuationDecorationType, []);
  }

  public async refreshEditor(editor: vscode.TextEditor): Promise<void> {
    if (this.disposed) return;
    const key = editor.document.uri.toString();

    if (!this.isFeatureEnabled()) {
      this.editorAnnotateOverrides.delete(key);
      this.clearGutterDecorations(editor);
      editor.setDecorations?.(this.inlineDecorationType, []);
      return;
    }

    const wantGutter = this.isAnnotated(editor.document.uri);
    const wantInline = this.isInlineCurrentLineEnabled();
    if (!wantGutter && !wantInline) {
      this.clearGutterDecorations(editor);
      editor.setDecorations?.(this.inlineDecorationType, []);
      return;
    }

    const blameMap = await this.loadBlameMap(editor.document);
    if (!blameMap || blameMap.size === 0) {
      this.clearGutterDecorations(editor);
      editor.setDecorations?.(this.inlineDecorationType, []);
      return;
    }

    if (wantGutter) {
      this.ensureWrapContinuationDecorationType();
      this.applyGutterDecorations(editor, blameMap);
    } else {
      this.clearGutterDecorations(editor);
    }

    if (wantInline) {
      this.applyInlineCurrentLine(editor, blameMap);
    } else {
      editor.setDecorations?.(this.inlineDecorationType, []);
    }
  }

  private async renderInlineCurrentLine(editor: vscode.TextEditor): Promise<void> {
    if (this.disposed) return;
    if (!this.isInlineCurrentLineEnabled()) {
      editor.setDecorations?.(this.inlineDecorationType, []);
      return;
    }

    const blameMap = await this.loadBlameMap(editor.document);
    if (!blameMap || blameMap.size === 0) {
      editor.setDecorations?.(this.inlineDecorationType, []);
      return;
    }

    this.applyInlineCurrentLine(editor, blameMap);
  }

  private applyInlineCurrentLine(
    editor: vscode.TextEditor,
    blameMap: Map<number, GitBlameLineInfo>,
  ): void {
    const activeLine = editor.selection?.active?.line ?? 0;
    if (activeLine < 0 || activeLine >= editor.document.lineCount) {
      editor.setDecorations?.(this.inlineDecorationType, []);
      return;
    }
    const info = blameMap.get(activeLine + 1);
    if (!info) {
      editor.setDecorations?.(this.inlineDecorationType, []);
      return;
    }

    const contentText = formatBlameInlineText(info, {
      dateFormat: this.getDateFormat(),
      authorDisplay: this.getAuthorDisplay(),
      inlineFormat: this.getInlineFormat(),
    });
    if (!contentText) {
      editor.setDecorations?.(this.inlineDecorationType, []);
      return;
    }

    const lineLen = editor.document.lineAt(activeLine).text.length;
    const range = new vscode.Range(activeLine, lineLen, activeLine, lineLen);
    const gutterAlsoOnSamePos = this.isAnnotated(editor.document.uri) && lineLen === 0;
    const decoration: vscode.DecorationOptions = {
      range,
      ...(gutterAlsoOnSamePos ? {} : { hoverMessage: this.buildHoverMarkdown(info) }),
      renderOptions: {
        after: {
          contentText,
          color: this.getInlineForegroundColor(),
        },
      },
    };
    editor.setDecorations?.(this.inlineDecorationType, [decoration]);
  }

  private applyGutterDecorations(
    editor: vscode.TextEditor,
    blameMap: Map<number, GitBlameLineInfo>,
  ): void {
    const dateFormat = this.getDateFormat();
    const authorDisplay = this.getAuthorDisplay();
    const columnFormat = this.getColumnFormat();
    const columnWidth = this.getColumnWidth();
    const fgColor = this.getForegroundColor();
    const uncommittedFgColor = this.getUncommittedForegroundColor();
    const customBgColor = this.getCustomBackgroundColor();
    const customAccentColor = this.getCustomAccentBarColor();
    const hideAccentBar =
      customAccentColor.toLowerCase() === 'none' ||
      customAccentColor.toLowerCase() === 'transparent';
    const useHeatStrip = this.showHeatStrip();
    const groupConsecutive = this.shouldGroupConsecutiveCommits();
    const nowMs = Date.now();
    const columnDecorations: vscode.DecorationOptions[] = [];
    const stripDecorations: vscode.DecorationOptions[] = [];
    const firstCharRanges: vscode.Range[] = [];
    const wrapContinuationRanges: vscode.Range[] = [];

    for (let lineIdx = 0; lineIdx < editor.document.lineCount; lineIdx++) {
      const info = blameMap.get(lineIdx + 1);
      if (!info) continue;

      const text = formatBlameGutterColumnText(info, {
        dateFormat,
        authorDisplay,
        columnFormat,
        columnWidth,
        groupConsecutiveCommits: groupConsecutive,
        nowMs,
      });

      const heatColor = customAccentColor
        ? customAccentColor
        : useHeatStrip
          ? computeHeatStripColor(info.commit.authorTime, info.commit.isUncommitted, nowMs)
          : 'rgba(148, 163, 184, 0.25)';

      const bgColor = customBgColor
        ? customBgColor
        : useHeatStrip
          ? computeHeatBackgroundColor(info.commit.authorTime, info.commit.isUncommitted, nowMs)
          : 'rgba(148, 163, 184, 0.06)';

      const colWidthCss = `${columnWidth + 2}ch`;
      const range = new vscode.Range(lineIdx, 0, lineIdx, 0);
      columnDecorations.push({
        range,
        hoverMessage: this.buildHoverMarkdown(info),
        renderOptions: {
          before: {
            contentText: `\u00a0${text}\u00a0`,
            width: colWidthCss,
            color: info.commit.isUncommitted ? uncommittedFgColor : fgColor,
            backgroundColor: bgColor,
            fontStyle: 'normal',
            fontWeight: 'normal',
            ...(hideAccentBar ? { margin: '0 12px 0 0' } : {}),
          },
        },
      });

      if (!hideAccentBar) {
        stripDecorations.push({
          range,
          renderOptions: {
            before: {
              contentText: '▎',
              width: '1ch',
              color: heatColor,
              backgroundColor: bgColor,
              margin: '0 12px 0 0',
              fontStyle: 'normal',
              fontWeight: 'normal',
            },
          },
        });
      }

      const lineLen = editor.document.lineAt(lineIdx).text.length;
      if (lineLen >= 2) {
        firstCharRanges.push(new vscode.Range(lineIdx, 0, lineIdx, 1));
        wrapContinuationRanges.push(new vscode.Range(lineIdx, 1, lineIdx, lineLen));
      }
    }

    editor.setDecorations?.(this.gutterDecorationType, columnDecorations);
    editor.setDecorations?.(this.heatStripDecorationType, stripDecorations);
    editor.setDecorations?.(this.firstCharMarkerDecorationType, firstCharRanges);
    editor.setDecorations?.(this.wrapContinuationDecorationType, wrapContinuationRanges);
  }

  private buildHoverMarkdown(info: GitBlameLineInfo): vscode.MarkdownString {
    const md = new vscode.MarkdownString('', true);
    md.isTrusted = true;
    md.supportThemeIcons = true;

    if (info.commit.isUncommitted) {
      md.appendMarkdown('**미커밋 변경 사항** (`Not Committed Yet`)');
      return md;
    }

    const dateStr = formatFullBlameDateTime(info.commit.authorTime);
    const copyArgs = encodeURIComponent(JSON.stringify([info.commit.sha]));
    const emailPart = info.commit.authorMail ? ` \`<${info.commit.authorMail}>\`` : '';
    md.appendMarkdown(
      `\`${info.commit.shortSha}\` — **${info.commit.author}**${emailPart} (${dateStr})\n\n`,
    );
    if (info.commit.summary) {
      md.appendMarkdown(`${info.commit.summary}\n\n`);
    }
    md.appendMarkdown(
      `[커밋 해시 복사 (GitFork 검색용)](command:unitySense.copyBlameCommitHash?${copyArgs})`,
    );
    return md;
  }

  private async loadBlameMap(doc: vscode.TextDocument): Promise<Map<number, GitBlameLineInfo> | null> {
    if (doc.isUntitled || doc.uri.scheme !== 'file') {
      return null;
    }

    const filePath = doc.uri.fsPath;
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch {
      return null;
    }

    const isDirty = Boolean(doc.isDirty);
    const docVersion = typeof doc.version === 'number' ? doc.version : 0;
    const key = doc.uri.toString();
    const cached = this.cache.get(key);
    if (
      cached &&
      cached.mtimeMs === mtimeMs &&
      cached.isDirty === isDirty &&
      (!isDirty || cached.docVersion === docVersion)
    ) {
      return cached.linesByNumber;
    }

    const output = await this.runner(filePath, isDirty ? doc.getText() : undefined);
    if (!output) {
      return null;
    }

    const parsed = parseGitBlamePorcelain(output);
    const linesByNumber = new Map<number, GitBlameLineInfo>();
    for (const item of parsed) {
      linesByNumber.set(item.lineNumber, item);
    }

    this.cache.set(key, { mtimeMs, docVersion, isDirty, linesByNumber });
    return linesByNumber;
  }

  private findVisibleEditors(uriKey: string): vscode.TextEditor[] {
    const matches = vscode.window.visibleTextEditors.filter(
      (ed) => ed.document.uri.toString() === uriKey,
    );
    if (
      matches.length === 0 &&
      vscode.window.activeTextEditor &&
      vscode.window.activeTextEditor.document.uri.toString() === uriKey
    ) {
      return [vscode.window.activeTextEditor];
    }
    return matches;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const t of this.changeTimers.values()) {
      clearTimeout(t);
    }
    this.changeTimers.clear();
    for (const editor of vscode.window.visibleTextEditors) {
      this.clearGutterDecorations(editor);
      editor.setDecorations?.(this.inlineDecorationType, []);
    }
    if (vscode.window.activeTextEditor) {
      this.clearGutterDecorations(vscode.window.activeTextEditor);
      vscode.window.activeTextEditor.setDecorations?.(this.inlineDecorationType, []);
    }
    this.wrapContinuationDecorationType.dispose();
    this.editorAnnotateOverrides.clear();
    this.cache.clear();
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }
}

export function registerGitBlameCommands(provider: RiderGitBlameProvider): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('unitySense.toggleGitBlame', async (contextArg?: unknown) => {
      const target = provider.resolveTargetEditor(contextArg);
      const wasAnnotated = target ? provider.isAnnotated(target.document.uri) : false;
      const nextAnnotated = await provider.toggleForEditor(contextArg);
      if (target && wasAnnotated !== nextAnnotated) {
        void vscode.window.showInformationMessage(
          nextAnnotated
            ? '[UnitySense] Git Blame 좌측 주석 열(날짜·작성자)이 활성화되었습니다.'
            : '[UnitySense] Git Blame 좌측 주석 열이 비활성화되었습니다.',
        );
      }
      return nextAnnotated;
    }),
    vscode.commands.registerCommand('unitySense.copyBlameCommitHash', async (sha?: unknown) => {
      const value = typeof sha === 'string' ? sha.trim() : '';
      if (!value) return false;
      if (vscode.env?.clipboard?.writeText) {
        await vscode.env.clipboard.writeText(value);
      }
      void vscode.window.showInformationMessage(
        `[UnitySense] 커밋 해시를 복사했습니다: ${value.slice(0, 8)}`,
      );
      return true;
    }),
  ];
}
