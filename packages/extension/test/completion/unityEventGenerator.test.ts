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
});
