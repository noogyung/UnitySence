import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vscode from 'vscode';
import { afterEach, describe, expect, it } from 'vitest';
import {
  registerGenerateEventFunctionsCommand,
  UnityEventCompletionProvider,
} from '../../src/completion/unityEventGenerator.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');
const TEMP_CS_DIR = path.join(REPO_ROOT, 'test-output', 'event-gen-test');

describe('UnityEventCompletionProvider & generateEventFunctions Command', () => {
  afterEach(() => {
    vscode.__mock.reset();
    if (fs.existsSync(TEMP_CS_DIR)) {
      fs.rmSync(TEMP_CS_DIR, { recursive: true, force: true });
    }
  });

  it('excludes already-implemented events like Update and offers Coroutine variants for Start/OnTriggerEnter', () => {
    const csCode = `using UnityEngine;

public class PlayerController : MonoBehaviour
{
    private void Update() {}
    /*CURSOR*/
}`;
    const cursorOffset = csCode.indexOf('/*CURSOR*/');
    const cleanCode = csCode.replace('/*CURSOR*/', '');
    const doc = vscode.__mock.createTextDocument(vscode.Uri.file('Assets/PlayerController.cs'), cleanCode, 'csharp');
    const pos = doc.positionAt(cursorOffset);

    const provider = new UnityEventCompletionProvider({
      getEditorVersion: () => '6000.0.23f1',
    });

    const items = provider.provideCompletionItems(doc, pos);
    expect(items).toBeDefined();
    const labels = items!.map((i) => i.label);
    expect(labels).not.toContain('Update');
    expect(labels).toContain('Awake');
    expect(labels).toContain('Start');
    expect(labels).toContain('OnTriggerEnter');
    expect(labels).toContain('OnTriggerEnter (Coroutine)');

    const coroItem = items!.find((i) => i.label === 'OnTriggerEnter (Coroutine)');
    const snippetVal = (coroItem?.insertText as vscode.SnippetString).value;
    expect(snippetVal).toContain('IEnumerator OnTriggerEnter(Collider other)');
    expect(snippetVal).toContain('yield break;');
  });

  it('resolves indirect inheritance hierarchies and suppresses suggestions inside method bodies', () => {
    const csCode = `public class DerivedHero : BaseEntity
{
    private void Start()
    {
        /*INSIDE_METHOD*/
    }
    /*CLASS_LEVEL*/
}`;
    const cleanCode = csCode.replace('/*INSIDE_METHOD*/', '').replace('/*CLASS_LEVEL*/', '');
    const doc = vscode.__mock.createTextDocument(vscode.Uri.file('Assets/DerivedHero.cs'), cleanCode, 'csharp');

    const inheritanceMap = new Map<string, string[]>([['BaseEntity', ['MonoBehaviour']]]);
    const provider = new UnityEventCompletionProvider({
      getInheritanceMap: () => inheritanceMap,
    });

    const insideMethodPos = new vscode.Position(4, 8);
    expect(provider.provideCompletionItems(doc, insideMethodPos)).toBeUndefined();

    const classLevelPos = new vscode.Position(6, 4);
    const items = provider.provideCompletionItems(doc, classLevelPos);
    expect(items).toBeDefined();
    expect(items!.map((i) => i.label)).toContain('FixedUpdate');
    expect(items!.map((i) => i.label)).not.toContain('Start');
  });

  it('inserts selected event and coroutine stubs via unityBrain.generateEventFunctions command', async () => {
    fs.mkdirSync(TEMP_CS_DIR, { recursive: true });
    const csFile = path.join(TEMP_CS_DIR, 'TriggerZone.cs');
    const initial = `using UnityEngine;

public class TriggerZone : MonoBehaviour
{
}
`;
    fs.writeFileSync(csFile, initial, 'utf8');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(csFile));
    vscode.window.activeTextEditor = {
      document: doc,
      selection: new vscode.Selection(new vscode.Position(3, 0), new vscode.Position(3, 0)),
    };

    const provider = new UnityEventCompletionProvider();
    const disp = registerGenerateEventFunctionsCommand(provider);

    const insertedCount = await vscode.commands.executeCommand<number>(
      'unityBrain.generateEventFunctions',
      ['OnTriggerEnter (Coroutine)', 'FixedUpdate'],
    );
    expect(insertedCount).toBe(2);

    const updated = fs.readFileSync(csFile, 'utf8');
    expect(updated).toContain('private IEnumerator OnTriggerEnter(Collider other)');
    expect(updated).toContain('private void FixedUpdate()');
    disp.dispose();
  });

  it('replaces modifier+void prefixes cleanly, supports generic where constraints, and uses public override for Editor/StateMachineBehaviour', () => {
    const provider = new UnityEventCompletionProvider({
      getEditorVersion: () => '6000.0.23f1',
    });

    // 1. Partial `private void Up` replacement range + generic where constraint
    const csCode = `public class GenericBehaviour<T> : MonoBehaviour where T : class
{
    private void Up/*CURSOR*/
}`;
    const cursorOffset = csCode.indexOf('/*CURSOR*/');
    const doc = vscode.__mock.createTextDocument(
      vscode.Uri.file('Assets/GenericBehaviour.cs'),
      csCode.replace('/*CURSOR*/', ''),
      'csharp',
    );
    const items = provider.provideCompletionItems(doc, doc.positionAt(cursorOffset));
    const updateItem = items?.find((i) => i.label === 'Update');
    expect(updateItem).toBeDefined();
    expect(doc.getText(updateItem!.range as vscode.Range)).toBe('private void Up');

    // 2. Editor class emits `public override void OnInspectorGUI()`
    const editorCode = `using UnityEditor;
public class CustomInspector : Editor
{
    /*CURSOR*/
}`;
    const edOffset = editorCode.indexOf('/*CURSOR*/');
    const edDoc = vscode.__mock.createTextDocument(
      vscode.Uri.file('Assets/Editor/CustomInspector.cs'),
      editorCode.replace('/*CURSOR*/', ''),
      'csharp',
    );
    const edItems = provider.provideCompletionItems(edDoc, edDoc.positionAt(edOffset));
    const inspectorItem = edItems?.find((i) => i.label === 'OnInspectorGUI');
    expect((inspectorItem?.insertText as vscode.SnippetString).value).toContain('public override void OnInspectorGUI()');

    // 3. UIBehaviour emits `protected override`, ignores comment/string braces, preserves explicit `public`, and replaces trailing `()`
    const uiCode = `using UnityEngine.EventSystems;
public class CustomPanel : UIBehaviour
{
    private const string Dummy = "{ ignored { braces } }";
    // { commented brace
    public void Awake/*CURSOR*/()
}`;
    const uiOffset = uiCode.indexOf('/*CURSOR*/');
    const uiDoc = vscode.__mock.createTextDocument(
      vscode.Uri.file('Assets/UI/CustomPanel.cs'),
      uiCode.replace('/*CURSOR*/', ''),
      'csharp',
    );
    const uiItems = provider.provideCompletionItems(uiDoc, uiDoc.positionAt(uiOffset));
    const awakeItem = uiItems?.find((i) => i.label === 'Awake');
    expect(awakeItem).toBeDefined();
    expect(uiDoc.getText(awakeItem!.range as vscode.Range)).toBe('public void Awake()');
    expect((awakeItem!.insertText as vscode.SnippetString).value).toContain('public override void Awake()');

    const defaultUiCode = `using UnityEngine.EventSystems;
public class PlainPanel : UIBehaviour
{
    /*CURSOR*/
}`;
    const plainOffset = defaultUiCode.indexOf('/*CURSOR*/');
    const plainDoc = vscode.__mock.createTextDocument(
      vscode.Uri.file('Assets/UI/PlainPanel.cs'),
      defaultUiCode.replace('/*CURSOR*/', ''),
      'csharp',
    );
    const plainItems = provider.provideCompletionItems(plainDoc, plainDoc.positionAt(plainOffset));
    const dimChanged = plainItems?.find((i) => i.label === 'OnRectTransformDimensionsChange');
    expect((dimChanged?.insertText as vscode.SnippetString).value).toContain(
      'protected override void OnRectTransformDimensionsChange()',
    );

    // 4. Mid-identifier Ctrl+Space on `public override void Aw|ake()` with existing `{ ... }` body:
    // converts to `protected override void Awake()` cleanly without leaving `ake()` or duplicating `{}`
    const midCode = `using UnityEngine.EventSystems;
public class MidConvertPanel : UIBehaviour
{
    public override void Aw/*CURSOR*/ake()
    {
        base.Awake();
    }
}`;
    const midOffset = midCode.indexOf('/*CURSOR*/');
    const midDoc = vscode.__mock.createTextDocument(
      vscode.Uri.file('Assets/UI/MidConvertPanel.cs'),
      midCode.replace('/*CURSOR*/', ''),
      'csharp',
    );
    const midItems = provider.provideCompletionItems(midDoc, midDoc.positionAt(midOffset));
    const midAwake = midItems?.find((i) => i.label === 'Awake');
    expect(midAwake).toBeDefined();
    expect(midDoc.getText(midAwake!.range as vscode.Range)).toBe('public override void Awake()');
    expect((midAwake!.insertText as vscode.SnippetString).value).toBe('protected override void Awake()');
    expect((midAwake as vscode.CompletionItem & { preselect?: boolean }).preselect).toBe(true);
  });

  it('offers Unity 6 async Awaitable event functions and prioritizes them when typing async Awaitable', async () => {
    const provider = new UnityEventCompletionProvider({
      getEditorVersion: () => '6000.0.23f1',
    });

    // 1. Standard empty cursor inside MonoBehaviour emits Start (Awaitable) without displacing void Start
    const blankCode = `using UnityEngine;
public class AsyncHero : MonoBehaviour
{
    /*CURSOR*/
}`;
    const blankOffset = blankCode.indexOf('/*CURSOR*/');
    const blankDoc = vscode.__mock.createTextDocument(
      vscode.Uri.file('Assets/AsyncHero.cs'),
      blankCode.replace('/*CURSOR*/', ''),
      'csharp',
    );
    const blankItems = provider.provideCompletionItems(blankDoc, blankDoc.positionAt(blankOffset));
    const startAwaitable = blankItems?.find((i) => i.label === 'Start (Awaitable)');
    expect(startAwaitable).toBeDefined();
    expect(startAwaitable?.detail).toBe(
      '[UnityBrain] Unity 6 Awaitable 비동기 이벤트 함수 — async Awaitable Start()',
    );
    expect((startAwaitable?.insertText as vscode.SnippetString).value).toContain(
      'private async Awaitable Start()',
    );
    expect((startAwaitable?.insertText as vscode.SnippetString).value).toContain(
      'await Awaitable.NextFrameAsync();',
    );
    expect(startAwaitable?.sortText?.startsWith('2_unity_')).toBe(true);

    const triggerAwaitable = blankItems?.find((i) => i.label === 'OnTriggerEnter (Awaitable)');
    expect(triggerAwaitable?.detail).toBe(
      '[UnityBrain] Unity 6 Awaitable 비동기 이벤트 함수 — async Awaitable OnTriggerEnter(Collider other)',
    );

    // 2. Typing `async Awaitable St` sorts and preselects Start (Awaitable) first
    const typedCode = `using UnityEngine;
public class AsyncHero : MonoBehaviour
{
    async Awaitable St/*CURSOR*/
}`;
    const typedOffset = typedCode.indexOf('/*CURSOR*/');
    const typedDoc = vscode.__mock.createTextDocument(
      vscode.Uri.file('Assets/AsyncHero.cs'),
      typedCode.replace('/*CURSOR*/', ''),
      'csharp',
    );
    const typedItems = provider.provideCompletionItems(typedDoc, typedDoc.positionAt(typedOffset));
    const typedStartAwaitable = typedItems?.find((i) => i.label === 'Start (Awaitable)');
    const typedStartVoid = typedItems?.find((i) => i.label === 'Start');
    expect(typedStartAwaitable).toBeDefined();
    expect(typedStartAwaitable?.sortText).toBe('0_unity_Start_0awaitable');
    expect((typedStartAwaitable as vscode.CompletionItem & { preselect?: boolean }).preselect).toBe(
      true,
    );
    expect(typedDoc.getText(typedStartAwaitable!.range as vscode.Range)).toBe('async Awaitable St');
    expect((typedStartAwaitable!.insertText as vscode.SnippetString).value).toContain(
      'private async Awaitable Start()',
    );
    expect((typedStartVoid as vscode.CompletionItem & { preselect?: boolean }).preselect).toBe(
      false,
    );
    expect(typedStartAwaitable!.sortText! < typedStartVoid!.sortText!).toBe(true);

    // 3. Explicit `public async Awaitable Up` includes non-coroutine events like Update and honors access modifier
    const updateCode = `using UnityEngine;
public class AsyncHero : MonoBehaviour
{
    public async Awaitable Up/*CURSOR*/
}`;
    const updateOffset = updateCode.indexOf('/*CURSOR*/');
    const updateDoc = vscode.__mock.createTextDocument(
      vscode.Uri.file('Assets/AsyncHero.cs'),
      updateCode.replace('/*CURSOR*/', ''),
      'csharp',
    );
    const updateItems = provider.provideCompletionItems(updateDoc, updateDoc.positionAt(updateOffset));
    const updateAwaitable = updateItems?.find((i) => i.label === 'Update (Awaitable)');
    expect(updateAwaitable).toBeDefined();
    expect(updateAwaitable?.sortText).toBe('0_unity_Update_0awaitable');
    expect((updateAwaitable!.insertText as vscode.SnippetString).value).toContain(
      'public async Awaitable Update()',
    );

    // 4. Existing `{ ... }` body emits signatureOnly for (Awaitable)
    const sigCode = `using UnityEngine;
public class AsyncHero : MonoBehaviour
{
    async Awaitable St/*CURSOR*/()
    {
        await Awaitable.NextFrameAsync();
    }
}`;
    const sigOffset = sigCode.indexOf('/*CURSOR*/');
    const sigDoc = vscode.__mock.createTextDocument(
      vscode.Uri.file('Assets/AsyncHero.cs'),
      sigCode.replace('/*CURSOR*/', ''),
      'csharp',
    );
    const sigItems = provider.provideCompletionItems(sigDoc, sigDoc.positionAt(sigOffset));
    const sigAwaitable = sigItems?.find((i) => i.label === 'Start (Awaitable)');
    expect(sigAwaitable).toBeDefined();
    expect(sigDoc.getText(sigAwaitable!.range as vscode.Range)).toBe('async Awaitable St()');
    expect((sigAwaitable!.insertText as vscode.SnippetString).value).toBe(
      'private async Awaitable Start()',
    );

    // 5. generateEventFunctions command also supports (Awaitable)
    fs.mkdirSync(TEMP_CS_DIR, { recursive: true });
    const cmdFile = path.join(TEMP_CS_DIR, 'AsyncCmdHero.cs');
    const cmdCode = `using UnityEngine;
public class AsyncCmdHero : MonoBehaviour
{
    private int hp;
}`;
    fs.writeFileSync(cmdFile, cmdCode, 'utf8');
    const cmdDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(cmdFile));
    vscode.window.activeTextEditor = {
      document: cmdDoc,
      selection: new vscode.Selection(new vscode.Position(2, 4), new vscode.Position(2, 4)),
    };
    const cmdDisp = registerGenerateEventFunctionsCommand(provider);
    const createdCount = await vscode.commands.executeCommand<number>(
      'unityBrain.generateEventFunctions',
      ['Start (Awaitable)'],
    );
    expect(createdCount).toBe(1);
    const updatedCmdText = fs.readFileSync(cmdFile, 'utf8');
    expect(updatedCmdText).toContain('private async Awaitable Start()');
    expect(updatedCmdText).toContain('await Awaitable.NextFrameAsync();');
    cmdDisp.dispose();
  });

  it('does not emit Unity event completions after non-declaration prefixes like private int x =', () => {
    const csCode = `using UnityEngine;
public class FieldTyping : MonoBehaviour
{
    private int x = /*CURSOR*/
}`;
    const cursorOffset = csCode.indexOf('/*CURSOR*/');
    const doc = vscode.__mock.createTextDocument(
      vscode.Uri.file('Assets/FieldTyping.cs'),
      csCode.replace('/*CURSOR*/', ''),
      'csharp',
    );
    const provider = new UnityEventCompletionProvider({
      getEditorVersion: () => '6000.0.23f1',
    });

    const items = provider.provideCompletionItems(doc, doc.positionAt(cursorOffset));
    expect(items).toBeUndefined();
  });
});
