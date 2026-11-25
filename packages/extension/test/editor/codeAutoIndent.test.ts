import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, it } from 'vitest';
import * as vscode from 'vscode';
import {
  autoIndentText,
  CodeAutoIndentManager,
  isPasteLikeChange,
  registerAutoIndentCommand,
} from '../../src/editor/codeAutoIndent.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');
const TEST_OUTPUT_ROOT = path.join(REPO_ROOT, 'test-output');

function createEditableTextEditor(
  doc: vscode.TextDocument,
  onContentUpdate: (nextText: string) => void,
  selection: vscode.Selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0)),
): vscode.TextEditor & {
  edit: (
    cb: (builder: { replace: (range: vscode.Range, text: string) => void }) => void,
    opts?: { undoStopBefore: boolean; undoStopAfter: boolean },
  ) => Promise<boolean>;
} {
  let currentText = doc.getText();
  const editor = {
    document: doc,
    selection,
    options: { tabSize: 4, insertSpaces: true },
    edit: async (
      cb: (builder: { replace: (range: vscode.Range, text: string) => void }) => void,
    ) => {
      const edits: Array<{ range: vscode.Range; text: string }> = [];
      cb({
        replace: (range, text) => edits.push({ range, text }),
      });
      const sorted = [...edits].sort(
        (a, b) => doc.offsetAt(b.range.start) - doc.offsetAt(a.range.start),
      );
      let next = currentText;
      for (const e of sorted) {
        const start = doc.offsetAt(e.range.start);
        const end = doc.offsetAt(e.range.end);
        next = next.slice(0, start) + e.text + next.slice(end);
      }
      currentText = next;
      onContentUpdate(next);
      return true;
    },
  };
  return editor as unknown as vscode.TextEditor & {
    edit: (
      cb: (builder: { replace: (range: vscode.Range, text: string) => void }) => void,
      opts?: { undoStopBefore: boolean; undoStopAfter: boolean },
    ) => Promise<boolean>;
  };
}

describe('codeAutoIndent', () => {
  beforeEach(() => {
    vscode.__mock.reset();
  });

  it('indents misaligned C# classes, switch/case, multi-line params, LINQ chains, braceless if/else, attributes, and regions', () => {
    const raw = [
      'using UnityEngine;',
      'namespace Demo',
      '{',
      '    [SerializeField]',
      'private int _count;',
      '    #region Lifecycle',
      '  public class Player : MonoBehaviour',
      '    {',
      'void Update()',
      '{',
      'if (Input.GetKeyDown(KeyCode.Space))',
      'Debug.Log("Jump");',
      'else',
      'Debug.Log("Idle");',
      'switch (_count)',
      '{',
      'case 0:',
      'DoZero();',
      'break;',
      'default:',
      'DoDefault();',
      'break;',
      '}',
      'var list = items',
      '.Where(x => x > 0)',
      '.ToList();',
      'Foo(',
      '1,',
      '2',
      ');',
      '}',
      '}',
      '    #endregion',
      '}',
    ].join('\n');

    const expected = [
      'using UnityEngine;',
      'namespace Demo',
      '{',
      '    [SerializeField]',
      '    private int _count;',
      '    #region Lifecycle',
      '    public class Player : MonoBehaviour',
      '    {',
      '        void Update()',
      '        {',
      '            if (Input.GetKeyDown(KeyCode.Space))',
      '                Debug.Log("Jump");',
      '            else',
      '                Debug.Log("Idle");',
      '            switch (_count)',
      '            {',
      '                case 0:',
      '                    DoZero();',
      '                    break;',
      '                default:',
      '                    DoDefault();',
      '                    break;',
      '            }',
      '            var list = items',
      '                .Where(x => x > 0)',
      '                .ToList();',
      '            Foo(',
      '                1,',
      '                2',
      '            );',
      '        }',
      '    }',
      '    #endregion',
      '}',
    ].join('\n');

    const indented = autoIndentText(raw, 'csharp', { tabSize: 4, insertSpaces: true });
    assert.equal(indented, expected);
    assert.equal(autoIndentText(indented, 'csharp', { tabSize: 4, insertSpaces: true }), indented);
  });

  it('preserves multi-line C# verbatim strings, C# 11 raw strings, char literals, and block comments', () => {
    const raw = [
      'public class StringSafety',
      '{',
      'public string Verbatim =',
      '@"line 1',
      '  keep leading spaces',
      '      { not a brace }";',
      'public string Raw = """',
      '   raw line 1',
      'raw line 2',
      '   """;',
      'public char OpenBrace = \'{\';',
      '/* block comment',
      '* star line',
      '*/',
      'public int After = 1;',
      '}',
    ].join('\n');

    const expected = [
      'public class StringSafety',
      '{',
      '    public string Verbatim =',
      '        @"line 1',
      '  keep leading spaces',
      '      { not a brace }";',
      '    public string Raw = """',
      '   raw line 1',
      'raw line 2',
      '   """;',
      '    public char OpenBrace = \'{\';',
      '    /* block comment',
      '     * star line',
      '     */',
      '    public int After = 1;',
      '}',
    ].join('\n');

    assert.equal(autoIndentText(raw, 'csharp', { tabSize: 4, insertSpaces: true }), expected);
  });

  it('indents ShaderLab and HLSL blocks cleanly', () => {
    const raw = [
      'Shader "Custom/AutoIndent"',
      '{',
      'Properties',
      '{',
      '_MainTex ("Texture", 2D) = "white" {}',
      '}',
      'SubShader',
      '{',
      'Pass',
      '{',
      'HLSLPROGRAM',
      '#pragma vertex vert',
      'CBUFFER_START(UnityPerMaterial)',
      'float4 _BaseColor;',
      'CBUFFER_END',
      'struct appdata',
      '{',
      'float4 vertex : POSITION;',
      '};',
      'ENDHLSL',
      '}',
      '}',
      '}',
    ].join('\n');

    const indented = autoIndentText(raw, 'shader', { tabSize: 4, insertSpaces: true });
    assert.ok(indented.includes('    Properties'));
    assert.ok(indented.includes('        _MainTex ("Texture", 2D) = "white" {}'));
    assert.ok(indented.includes('            HLSLPROGRAM'));
    assert.ok(indented.includes('            #pragma vertex vert'));
    assert.ok(indented.includes('                float4 vertex : POSITION;'));
  });

  it('auto-indents pasted multi-line and single-line code while ignoring normal typing, mid-line completion, and Undo/Redo', async () => {
    fs.mkdirSync(TEST_OUTPUT_ROOT, { recursive: true });
    const tmpDir = fs.mkdtempSync(path.join(TEST_OUTPUT_ROOT, 'unitysense-indent-'));
    const csPath = path.join(tmpDir, 'PasteTest.cs');

    try {
      const initialLines = [
        'public class PasteTest',
        '{',
        '    void Run()',
        '    {',
        'int a = 1;',
        'if (a > 0)',
        '{',
        'a++;',
        '}',
        '    }',
        '}',
      ];
      let content = initialLines.join('\n');
      fs.writeFileSync(csPath, content, 'utf8');

      const uri = vscode.Uri.file(csPath);
      const doc = vscode.__mock.createTextDocument(uri, content, 'csharp');
      const editor = createEditableTextEditor(doc, (next) => {
        content = next;
      });
      vscode.window.activeTextEditor = editor;

      const manager = new CodeAutoIndentManager();

      // 1. Multi-line paste change
      const multiLinePaste: vscode.TextDocumentContentChangeEvent = {
        range: new vscode.Range(4, 0, 4, 0),
        rangeOffset: doc.offsetAt(new vscode.Position(4, 0)),
        rangeLength: 0,
        text: 'int a = 1;\nif (a > 0)\n{\na++;\n}',
      };
      assert.equal(isPasteLikeChange(multiLinePaste, doc), true);

      // 2. Normal single-char typing and Enter should NOT be treated as paste
      const singleCharTyping: vscode.TextDocumentContentChangeEvent = {
        range: new vscode.Range(4, 5, 4, 5),
        rangeOffset: 0,
        rangeLength: 0,
        text: 'x',
      };
      const enterKey: vscode.TextDocumentContentChangeEvent = {
        range: new vscode.Range(4, 10, 4, 10),
        rangeOffset: 0,
        rangeLength: 0,
        text: '\n    ',
      };
      const midLineCompletion: vscode.TextDocumentContentChangeEvent = {
        range: new vscode.Range(4, 4, 4, 4),
        rangeOffset: 0,
        rangeLength: 0,
        text: 'GetComponent',
      };
      assert.equal(isPasteLikeChange(singleCharTyping, doc), false);
      assert.equal(isPasteLikeChange(enterKey, doc), false);
      assert.equal(isPasteLikeChange(midLineCompletion, doc), false);

      // 3. Undo/Redo must be ignored even with multi-line text
      vscode.__mock.emitters.onDidChangeTextDocument.fire({
        document: doc,
        contentChanges: [multiLinePaste],
        reason: vscode.TextDocumentChangeReason.Undo,
      });
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(content, initialLines.join('\n'));

      // 4. Real multi-line paste triggers auto-indent on pasted lines only
      vscode.__mock.emitters.onDidChangeTextDocument.fire({
        document: doc,
        contentChanges: [multiLinePaste],
      });
      await new Promise((r) => setTimeout(r, 10));
      const updatedLines = content.split('\n');
      assert.equal(updatedLines[4], '        int a = 1;');
      assert.equal(updatedLines[5], '        if (a > 0)');
      assert.equal(updatedLines[6], '        {');
      assert.equal(updatedLines[7], '            a++;');
      assert.equal(updatedLines[8], '        }');

      // 5. Single-line misaligned paste at column 0
      const singleLineContent = [
        'public class SinglePaste',
        '{',
        '    void Run()',
        '    {',
        'int pastedAtZero = 42;',
        '    }',
        '}',
      ].join('\n');
      let singleText = singleLineContent;
      const singleDoc = vscode.__mock.createTextDocument(
        vscode.Uri.file(path.join(tmpDir, 'SinglePaste.cs')),
        singleText,
        'csharp',
      );
      const singleEditor = createEditableTextEditor(singleDoc, (next) => {
        singleText = next;
      });
      vscode.window.activeTextEditor = singleEditor;
      vscode.__mock.emitters.onDidChangeTextDocument.fire({
        document: singleDoc,
        contentChanges: [
          {
            range: new vscode.Range(4, 0, 4, 0),
            rangeOffset: singleDoc.offsetAt(new vscode.Position(4, 0)),
            rangeLength: 0,
            text: 'int pastedAtZero = 42;',
          },
        ],
      });
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(singleText.split('\n')[4], '        int pastedAtZero = 42;');

      manager.dispose();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('computes save-time TextEdits and executes unitySense.autoIndentDocument command on selection and full document', async () => {
    fs.mkdirSync(TEST_OUTPUT_ROOT, { recursive: true });
    const tmpDir = fs.mkdtempSync(path.join(TEST_OUTPUT_ROOT, 'unitysense-cmd-'));
    const csPath = path.join(tmpDir, 'CmdTest.cs');

    try {
      let content = [
        'public class CmdTest',
        '{',
        'void A()',
        '{',
        'int x = 1;',
        '}',
        'void B()',
        '{',
        'int y = 2;',
        '}',
        '}',
      ].join('\n');
      fs.writeFileSync(csPath, content, 'utf8');

      const uri = vscode.Uri.file(csPath);
      const doc = vscode.__mock.createTextDocument(uri, content, 'csharp');
      const manager = new CodeAutoIndentManager();
      const cmd = registerAutoIndentCommand(manager);

      // Save-time edits cover all misaligned lines
      const saveEdits = manager.computeDocumentTextEdits(doc);
      assert.equal(saveEdits.length, 8);

      // Selection-only command indents only lines 2..5
      const selEditor = createEditableTextEditor(
        doc,
        (next) => {
          content = next;
        },
        new vscode.Selection(new vscode.Position(2, 0), new vscode.Position(5, 1)),
      );
      vscode.window.activeTextEditor = selEditor;
      const selResult = await vscode.commands.executeCommand<boolean>('unitySense.autoIndentDocument');
      assert.equal(selResult, true);
      const afterSel = content.split('\n');
      assert.equal(afterSel[2], '    void A()');
      assert.equal(afterSel[4], '        int x = 1;');
      assert.equal(afterSel[6], 'void B()'); // untouched outside selection

      // Full-document command when selection is empty
      const updatedDoc = vscode.__mock.createTextDocument(uri, content, 'csharp');
      const fullEditor = createEditableTextEditor(
        updatedDoc,
        (next) => {
          content = next;
        },
        new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0)),
      );
      vscode.window.activeTextEditor = fullEditor;
      const fullResult = await vscode.commands.executeCommand<boolean>('unitySense.autoIndentDocument');
      assert.equal(fullResult, true);
      const afterFull = content.split('\n');
      assert.equal(afterFull[6], '    void B()');
      assert.equal(afterFull[8], '        int y = 2;');

      cmd.dispose();
      manager.dispose();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
