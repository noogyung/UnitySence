import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, it } from 'vitest';
import * as vscode from 'vscode';
import {
  computeHeatBackgroundColor,
  computeHeatStripColor,
  DEFAULT_BLAME_COLUMN_WIDTH,
  DEFAULT_BLAME_DATE_FORMAT,
  formatBlameAuthor,
  formatBlameDate,
  formatBlameGutterColumnText,
  formatBlameInlineText,
  measureDisplayWidth,
  padOrTruncateDisplayWidth,
  parseGitBlamePorcelain,
} from '../../src/git/gitBlameParser.ts';
import {
  registerGitBlameCommands,
  RiderGitBlameProvider,
} from '../../src/git/riderGitBlameProvider.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');
const TEST_OUTPUT_ROOT = path.join(REPO_ROOT, 'test-output');

function createMockMemento(): vscode.Memento {
  const store = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue?: T): T {
      return (store.has(key) ? store.get(key) : defaultValue) as T;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
    },
  };
}

const SAMPLE_PORCELAIN = [
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 2',
  'author 홍길동',
  'author-mail <hong@example.com>',
  'author-time 1760400000',
  'author-tz +0900',
  'summary Add CBUFFER_START block',
  'filename Assets/Shaders/Test.shader',
  '\tCBUFFER_START(UnityPerMaterial)',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 2 2',
  '\t',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 3 3 1',
  'author UnityBrain Agent',
  'author-mail <agent@unitybrain.local>',
  'author-time 1763600000',
  'author-tz +0900',
  'summary 한글 커밋 메시지 테스트',
  'filename Assets/Shaders/Test.shader',
  '\t    float _Metallic;',
  '0000000000000000000000000000000000000000 4 4 1',
  'author Not Committed Yet',
  'author-mail <not.committed.yet>',
  'author-time 1763900000',
  'author-tz +0900',
  'summary Version of Test.shader from index',
  'filename Assets/Shaders/Test.shader',
  '\tCBUFFER_END',
].join('\n');

describe('gitBlameParser', () => {
  it('parses porcelain output including empty lines, consecutive commits, Korean text, and uncommitted lines', () => {
    const parsed = parseGitBlamePorcelain(SAMPLE_PORCELAIN);
    assert.equal(parsed.length, 4);

    assert.equal(parsed[0].lineNumber, 1);
    assert.equal(parsed[0].isGroupStart, true);
    assert.equal(parsed[0].commit.author, '홍길동');
    assert.equal(parsed[0].commit.authorMail, 'hong@example.com');
    assert.equal(parsed[0].commit.shortSha, 'aaaaaaaa');

    assert.equal(parsed[1].lineNumber, 2);
    assert.equal(parsed[1].isGroupStart, false);
    assert.equal(parsed[1].commit.author, '홍길동');

    assert.equal(parsed[2].lineNumber, 3);
    assert.equal(parsed[2].isGroupStart, true);
    assert.equal(parsed[2].commit.author, 'UnityBrain Agent');
    assert.equal(parsed[2].commit.authorMail, 'agent@unitybrain.local');
    assert.equal(parsed[2].commit.summary, '한글 커밋 메시지 테스트');

    assert.equal(parsed[3].lineNumber, 4);
    assert.equal(parsed[3].commit.isUncommitted, true);
    assert.equal(parsed[3].commit.author, 'Not Committed Yet');
  });

  it('defaults to YY-MM-DD and supports arbitrary custom date tokens, author display modes, templates, and widths', () => {
    assert.equal(DEFAULT_BLAME_DATE_FORMAT, 'YY-MM-DD');
    assert.equal(DEFAULT_BLAME_COLUMN_WIDTH, 20);

    const parsed = parseGitBlamePorcelain(SAMPLE_PORCELAIN);
    const defaultDate = formatBlameDate(parsed[0].commit.authorTime);
    assert.match(defaultDate, /^\d{2}-\d{2}-\d{2}$/);
    assert.match(formatBlameDate(parsed[0].commit.authorTime, 'YYYY.MM.DD'), /^\d{4}\.\d{2}\.\d{2}$/);
    assert.match(formatBlameDate(parsed[0].commit.authorTime, 'MM/DD HH:mm'), /^\d{2}\/\d{2} \d{2}:\d{2}$/);

    // Author display modes
    assert.equal(formatBlameAuthor(parsed[0].commit, 'name'), '홍길동');
    assert.equal(formatBlameAuthor(parsed[0].commit, 'email'), 'hong@example.com');
    assert.equal(formatBlameAuthor(parsed[0].commit, 'emailLocalPart'), 'hong');
    assert.equal(formatBlameAuthor(parsed[0].commit, 'nameAndEmail'), '홍길동 <hong@example.com>');
    assert.equal(formatBlameAuthor(parsed[0].commit, 'none'), '');

    // Default column width = 20
    const col1 = formatBlameGutterColumnText(parsed[0]);
    const col2Grouped = formatBlameGutterColumnText(parsed[1], { groupConsecutiveCommits: true });
    const col3Email = formatBlameGutterColumnText(parsed[2], {
      authorDisplay: 'email',
      columnWidth: 28,
    });
    const colAuthorFirst = formatBlameGutterColumnText(parsed[2], {
      columnFormat: '${author}  ${date}',
      columnWidth: 20,
    });

    assert.equal(measureDisplayWidth(col1), 20);
    assert.equal(measureDisplayWidth(col2Grouped), 20);
    assert.equal(measureDisplayWidth(col3Email), 28);
    assert.equal(measureDisplayWidth(colAuthorFirst), 20);
    assert.ok(col1.includes('홍길동'));
    assert.equal(col2Grouped.trim(), '');
    assert.ok(col3Email.includes('agent@unitybrain'));
    // Trailing ${date} must remain intact even when ${author} precedes it and is truncated
    assert.match(colAuthorFirst.replace(/\u00a0/g, ' '), /\d{2}-\d{2}-\d{2}$/);
    assert.equal(measureDisplayWidth(padOrTruncateDisplayWidth('홍길동전설의개발자', 12)), 12);
  });

  it('formats inline current-line text as "author - date - summary" and computes heat colors', () => {
    const nowMs = 1763900000 * 1000;
    assert.equal(formatBlameDate(1763900000 - 30, 'relative', nowMs), '방금 전');
    assert.equal(formatBlameDate(1763900000 - 3600 * 5, 'relative', nowMs), '5시간 전');
    assert.equal(formatBlameDate(1763900000 - 86400 * 3, 'relative', nowMs), '3일 전');

    const parsed = parseGitBlamePorcelain(SAMPLE_PORCELAIN);
    const inline3 = formatBlameInlineText(parsed[2], { nowMs });
    assert.match(inline3.trim(), /^UnityBrain Agent - \d{2}-\d{2}-\d{2} - 한글 커밋 메시지 테스트$/);

    const inlineEmail = formatBlameInlineText(parsed[0], {
      authorDisplay: 'email',
      dateFormat: 'YYYY/MM/DD',
    });
    assert.match(inlineEmail.trim(), /^hong@example\.com - \d{4}\/\d{2}\/\d{2} - Add CBUFFER_START block$/);
    assert.equal(formatBlameInlineText(parsed[3], nowMs).trim(), 'Not Committed Yet');

    assert.equal(computeHeatStripColor(1763900000 - 86400, false, nowMs), '#38BDF8');
    assert.equal(computeHeatStripColor(0, true, nowMs), '#E5C07B');
    assert.equal(computeHeatBackgroundColor(1763900000 - 86400, false, nowMs), 'rgba(56, 139, 253, 0.34)');
    assert.equal(computeHeatBackgroundColor(0, true, nowMs), 'rgba(229, 192, 123, 0.20)');
  });
});

describe('RiderGitBlameProvider', () => {
  beforeEach(() => {
    vscode.__mock.reset();
  });

  it('keeps wordWrap ON while guarding wrapped continuation lines from invading the left blame column, avoids duplicate/$(icon) hover, supports simultaneous inline blame, and applies custom colors/widths', async () => {
    fs.mkdirSync(TEST_OUTPUT_ROOT, { recursive: true });
    const tmpDir = fs.mkdtempSync(path.join(TEST_OUTPUT_ROOT, 'unitysense-blame-'));
    const filePath = path.join(tmpDir, 'Doc.md');
    const content = 'Line1\n\nLine3\nLine4';
    fs.writeFileSync(filePath, content, 'utf8');

    try {
      // Simulate user having wordWrap=on (and a leftover v1.1.4 wordWrap backup that must be restored)
      vscode.__mock.configStore.set('editor.wordWrap', 'off');
      vscode.__mock.configStore.set('[markdown].editor.wordWrap', 'off');
      vscode.__mock.configStore.set('unitySense.gitBlame.inlineCurrentLine', true);

      const uri = vscode.Uri.file(filePath);
      const doc = vscode.__mock.createTextDocument(uri, content, 'markdown');
      const appliedDecorations = new Map<string, readonly unknown[]>();
      const editor: vscode.TextEditor = {
        document: doc,
        selection: new vscode.Selection(new vscode.Position(2, 0), new vscode.Position(2, 0)),
        setDecorations: (type, ranges) => {
          appliedDecorations.set(type.key, ranges);
        },
      };
      vscode.window.activeTextEditor = editor;

      let lastUnsavedArg: string | undefined;
      const memento = createMockMemento();
      await memento.update('unitySense.gitBlame.wordWrapBackup.v1', {
        hadGlobal: true,
        previousGlobal: 'on',
        languageBackups: { markdown: { hadValue: false } },
      });
      const ctx = { globalState: memento } as unknown as vscode.ExtensionContext;
      const provider = new RiderGitBlameProvider(async (_fp, unsaved) => {
        lastUnsavedArg = unsaved;
        return SAMPLE_PORCELAIN;
      }, ctx);
      const cmds = registerGitBlameCommands(provider);

      await new Promise((r) => setTimeout(r, 10));
      await provider.refreshEditor(editor);

      // 1. Word-wrap stays ON (and any legacy v1.1.4 override is restored & cleared)
      assert.equal(vscode.__mock.configStore.get('editor.wordWrap'), 'on');
      assert.equal(vscode.__mock.configStore.has('[markdown].editor.wordWrap'), false);

      // 2. Left gutter column (4 lines), heat strip (4 lines), wrap-continuation guard (3 non-empty lines), AND current-line inline blame (1 line) all render simultaneously!
      const fourLineDecos = Array.from(appliedDecorations.values()).filter(
        (arr) => arr.length === 4,
      ) as Array<readonly vscode.DecorationOptions[]>;
      const threeLineRanges = Array.from(appliedDecorations.values()).filter(
        (arr) => arr.length === 3,
      ) as Array<readonly vscode.Range[]>;
      const oneLineDecos = Array.from(appliedDecorations.values()).filter(
        (arr) => arr.length === 1,
      ) as Array<readonly vscode.DecorationOptions[]>;
      assert.equal(fourLineDecos.length, 2, 'Expected left column + heat strip decorations');
      assert.equal(
        threeLineRanges.length,
        2,
        'Expected firstCharMarker (0..1) + wrapContinuation (1..end) ranges on the 3 non-empty lines',
      );
      assert.equal(oneLineDecos.length, 1, 'Expected simultaneous current-line inline blame decoration');
      assert.ok(
        oneLineDecos[0][0].renderOptions?.after?.contentText?.includes(
          'UnityBrain Agent - ',
        ),
      );
      assert.ok(
        oneLineDecos[0][0].renderOptions?.after?.contentText?.includes(
          ' - 한글 커밋 메시지 테스트',
        ),
      );

      // 3. Hover check: NO $(git-commit) or $(copy) text, and stripDecorations has NO hoverMessage (prevents duplicate hover!)
      const columnDeco = fourLineDecos.find((arr) =>
        arr[0].renderOptions?.before?.contentText?.includes('홍길동'),
      )!;
      const stripDeco = fourLineDecos.find((arr) =>
        arr[0].renderOptions?.before?.contentText === '▎',
      )!;
      assert.ok(columnDeco);
      assert.ok(stripDeco);
      assert.equal(stripDeco[0].hoverMessage, undefined, 'Strip decoration must NOT carry duplicate hoverMessage');
      const hoverMd = (columnDeco[0].hoverMessage as vscode.MarkdownString).value;
      assert.equal(hoverMd.includes('$('), false, 'Hover must NOT leak raw $(icon) syntax');
      assert.ok(hoverMd.includes('커밋 해시 복사'));

      // Move cursor to empty line 2 (index 1): inline decoration must omit hoverMessage so hover isn't duplicated at col 0
      editor.selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 0));
      vscode.__mock.emitters.onDidChangeTextEditorSelection.fire({
        textEditor: editor,
        selections: [editor.selection],
      });
      await provider.refreshEditor(editor);
      const emptyLineInline = Array.from(appliedDecorations.values()).find(
        (arr) => arr.length === 1,
      ) as readonly vscode.DecorationOptions[];
      assert.equal(emptyLineInline[0].hoverMessage, undefined);

      // 4. Custom email display, custom width, custom colors, and hidden accent bar
      vscode.__mock.configStore.set('unitySense.gitBlame.authorDisplay', 'email');
      vscode.__mock.configStore.set('unitySense.gitBlame.columnWidth', 26);
      vscode.__mock.configStore.set('unitySense.gitBlame.foregroundColor', '#AABBCC');
      vscode.__mock.configStore.set('unitySense.gitBlame.backgroundColor', '#112233');
      vscode.__mock.configStore.set('unitySense.gitBlame.accentBarColor', 'none');
      vscode.__mock.configStore.set('unitySense.gitBlame.inlineForegroundColor', '#DDEEFF');
      await provider.refreshEditor(editor);

      const customColDeco = Array.from(appliedDecorations.values()).find(
        (arr) => arr.length === 4,
      ) as readonly vscode.DecorationOptions[];
      assert.ok(customColDeco[0].renderOptions?.before?.contentText?.includes('hong@example.com'));
      assert.equal(customColDeco[0].renderOptions?.before?.color, '#AABBCC');
      assert.equal(customColDeco[0].renderOptions?.before?.backgroundColor, '#112233');
      assert.equal(customColDeco[0].renderOptions?.before?.margin, '0 12px 0 0');
      const customInlineDeco = Array.from(appliedDecorations.values()).find(
        (arr) => arr.length === 1,
      ) as readonly vscode.DecorationOptions[];
      assert.equal(customInlineDeco[0].renderOptions?.after?.color, '#DDEEFF');

      // 5. Toggle OFF -> keeps wordWrap untouched and keeps inlineCurrentLine active!
      const toggledOff = await vscode.commands.executeCommand<boolean>('unitySense.toggleGitBlame', {
        uri,
        lineNumber: 2,
      });
      assert.equal(toggledOff, false);
      assert.equal(provider.isAnnotated(uri), false);
      assert.equal(vscode.__mock.configStore.get('editor.wordWrap'), 'on');

      // Dirty buffer check on toggle back ON
      (doc as { isDirty: boolean; version: number }).isDirty = true;
      (doc as { isDirty: boolean; version: number }).version = 2;
      const toggledOn = await vscode.commands.executeCommand<boolean>('unitySense.toggleGitBlame', {
        uri,
        lineNumber: 1,
      });
      assert.equal(toggledOn, true);
      assert.equal(lastUnsavedArg, content);

      for (const d of cmds) d.dispose();
      provider.dispose();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('executes real git blame on docs/AI_EXECUTION_PLAYBOOK.md with YY-MM-DD default format', async () => {
    const playbookPath = path.join(REPO_ROOT, 'docs', 'AI_EXECUTION_PLAYBOOK.md');
    const content = fs.readFileSync(playbookPath, 'utf8');
    const uri = vscode.Uri.file(playbookPath);
    const doc = vscode.__mock.createTextDocument(uri, content, 'markdown');
    const appliedDecorations = new Map<string, readonly vscode.DecorationOptions[]>();
    const editor: vscode.TextEditor = {
      document: doc,
      selection: new vscode.Selection(new vscode.Position(25, 0), new vscode.Position(25, 0)),
      setDecorations: (type, ranges) => {
        appliedDecorations.set(type.key, ranges as readonly vscode.DecorationOptions[]);
      },
    };
    vscode.window.activeTextEditor = editor;

    const provider = new RiderGitBlameProvider();
    await provider.refreshEditor(editor);

    const columnDecos = Array.from(appliedDecorations.values()).find(
      (arr) => arr.length > 40 && arr[23]?.renderOptions?.before?.contentText !== '▎',
    );
    assert.ok(columnDecos, 'Expected left blame column decorations on real repository file');
    for (let lineIdx = 23; lineIdx <= 38; lineIdx++) {
      const beforeText = columnDecos[lineIdx]?.renderOptions?.before?.contentText ?? '';
      assert.match(beforeText, /\d{2}-\d{2}-\d{2}/, `Expected YY-MM-DD date on line ${lineIdx + 1}`);
      assert.ok(beforeText.trim().length > 10, `Expected non-empty author on line ${lineIdx + 1}`);
    }

    provider.dispose();
  });

  it('gracefully ignores non-git or untracked files without throwing', async () => {
    fs.mkdirSync(TEST_OUTPUT_ROOT, { recursive: true });
    const tmpDir = fs.mkdtempSync(path.join(TEST_OUTPUT_ROOT, 'unitysense-nogit-'));
    const filePath = path.join(tmpDir, 'Untracked.cs');
    fs.writeFileSync(filePath, 'public class Untracked {}', 'utf8');

    try {
      vscode.__mock.configStore.set('unitySense.gitBlame.showGutterColumn', false);
      const uri = vscode.Uri.file(filePath);
      const doc = vscode.__mock.createTextDocument(uri, 'public class Untracked {}', 'csharp');
      const editor: vscode.TextEditor = {
        document: doc,
        selection: new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0)),
        setDecorations: () => {},
      };
      const provider = new RiderGitBlameProvider(async () => null);
      const result = await provider.toggleForEditor(editor);
      assert.equal(result, false);
      assert.equal(provider.isAnnotated(uri), false);
      provider.dispose();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
