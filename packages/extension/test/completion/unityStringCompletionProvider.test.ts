import * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import type { ProjectSettingsCache, ShaderSymbolIndex } from '../../src/contracts/index.ts';
import {
  detectApiStringContext,
  UnityStringCompletionProvider,
} from '../../src/completion/unityStringCompletionProvider.ts';

const MOCK_CACHE: ProjectSettingsCache = {
  schemaVersion: 1,
  updatedAt: '2026-11-16T00:00:00Z',
  tags: ['Untagged', 'Player', 'Enemy'],
  layers: [
    { index: 0, name: 'Default' },
    { index: 8, name: 'Ground' },
    { index: 9, name: 'Hitbox' },
  ],
  sortingLayers: [
    { id: 0, name: 'Default' },
    { id: 1001, name: 'Foreground' },
  ],
  inputAxes: [
    { name: 'Horizontal', type: 0 },
    { name: 'Jump', type: 0 },
  ],
  buildScenes: [
    {
      name: 'Stage01',
      path: 'Assets/Scenes/Stage01.unity',
      guid: '33333333333333333333333333333333',
      buildIndex: 0,
      enabled: true,
    },
  ],
  animatorControllers: [
    {
      assetPath: 'Assets/Animations/Player.controller',
      guid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      parameters: [
        { name: 'Speed', type: 'Float' },
        { name: 'Attack', type: 'Trigger' },
      ],
      states: ['Idle', 'Run'],
    },
  ],
};

const MOCK_SHADER_INDEX: ShaderSymbolIndex = {
  schemaVersion: 1,
  shaderNames: ['UnityBrain/TestLit'],
  properties: [
    {
      name: '_BaseMap',
      displayName: 'Base Map',
      type: '2D',
      shaderFile: 'Assets/Shaders/TestLit.shader',
      shaderName: 'UnityBrain/TestLit',
    },
    {
      name: '_BaseColor',
      displayName: 'Base Color',
      type: 'Color',
      shaderFile: 'Assets/Shaders/TestLit.shader',
      shaderName: 'UnityBrain/TestLit',
    },
  ],
  symbolsByFile: {},
};

async function runAtSnippet(codeWithCursor: string): Promise<vscode.CompletionItem[] | undefined> {
  const provider = new UnityStringCompletionProvider(
    () => MOCK_CACHE,
    () => MOCK_SHADER_INDEX,
  );
  const fullCode = `using UnityEngine;
using UnityEngine.SceneManagement;
using System.Collections;

public class PlayerScript : MonoBehaviour {
    private Material _material;
    private Animator _animator;
    void Update() {
        ${codeWithCursor}
    }
    void RespawnNow() {}
    IEnumerator FadeOutRoutine() { yield break; }
}`;
  const cursorOffset = fullCode.indexOf('/*CURSOR*/');
  const cleanCode = fullCode.replace('/*CURSOR*/', '');
  const doc = vscode.__mock.createTextDocument(vscode.Uri.file('Assets/Scripts/PlayerScript.cs'), cleanCode, 'csharp');
  const pos = doc.positionAt(cursorOffset);
  return provider.provideCompletionItems(doc, pos);
}

describe('UnityStringCompletionProvider', () => {
  it('completes Tags, Layers (including multi-arg), SortingLayers, Input Axes, Build Scenes, Shader Properties, Animator params, Invoke, and StartCoroutine', async () => {
    const tagItems = await runAtSnippet('if (other.CompareTag("/*CURSOR*/")) {}');
    expect(tagItems?.map((i) => i.label)).toContain('Enemy');
    expect(tagItems?.find((i) => i.label === 'Enemy')?.detail).toContain('Unity Tag');
    expect(tagItems?.find((i) => i.label === 'Enemy')?.detail).toContain('[UnityBrain]');

    // Also completes right after '(' before typing quotes, inserting quoted string and sorting at top
    const parenTagItems = await runAtSnippet('if (other.CompareTag(/*CURSOR*/)) {}');
    const enemyParen = parenTagItems?.find((i) => i.label === 'Enemy');
    expect(enemyParen).toBeDefined();
    expect(enemyParen?.insertText).toBe('"Enemy"');
    expect(enemyParen?.sortText?.startsWith('\u0000')).toBe(true);

    const layerItems = await runAtSnippet('int mask = LayerMask.GetMask("Default", "/*CURSOR*/");');
    expect(layerItems?.map((i) => i.label)).toContain('Ground');
    expect(layerItems?.find((i) => i.label === 'Ground')?.detail).toContain('Layer 8');

    const sortingItems = await runAtSnippet('int s = SortingLayer.NameToID("/*CURSOR*/");');
    expect(sortingItems?.map((i) => i.label)).toContain('Foreground');

    const inputItems = await runAtSnippet('float h = Input.GetAxis("/*CURSOR*/");');
    expect(inputItems?.map((i) => i.label)).toContain('Horizontal');

    const sceneItems = await runAtSnippet('SceneManager.LoadScene("/*CURSOR*/");');
    expect(sceneItems?.[0].label).toBe('Stage01');
    expect(sceneItems?.[0].detail).toContain('Build Index 0');

    const shaderItems = await runAtSnippet('_material.SetColor("/*CURSOR*/", Color.white);');
    expect(shaderItems?.map((i) => i.label)).toContain('_BaseColor');
    expect(shaderItems?.find((i) => i.label === '_BaseColor')?.detail).toContain('UnityBrain/TestLit');

    const animItems = await runAtSnippet('_animator.SetTrigger("/*CURSOR*/");');
    expect(animItems?.map((i) => i.label)).toContain('Attack');
    expect(animItems?.map((i) => i.label)).toContain('Run');

    const invokeItems = await runAtSnippet('Invoke("/*CURSOR*/", 1.0f);');
    expect(invokeItems?.map((i) => i.label)).toContain('RespawnNow');

    const coroutineItems = await runAtSnippet('StartCoroutine("/*CURSOR*/");');
    const fadeItem = coroutineItems?.find((i) => i.label === 'FadeOutRoutine');
    const regularItem = coroutineItems?.find((i) => i.label === 'RespawnNow');
    expect(fadeItem).toBeDefined();
    expect(fadeItem!.sortText! < regularItem!.sortText!).toBe(true);
  });

  it('returns undefined on ordinary C# string literals to avoid interfering with Roslyn/C# Dev Kit', async () => {
    const nonUnity = await runAtSnippet('Debug.Log("/*CURSOR*/");');
    expect(nonUnity).toBeUndefined();
    expect(detectApiStringContext('string msg = "hello')).toBeNull();
    expect(detectApiStringContext('// CompareTag("')).toBeNull();
  });

  it('replaces until closing quote, supports unquoted identifier prefix, filters Animator methods, and completes Shader.Find/EnableKeyword/Resources/InputActions', async () => {
    const provider = new UnityStringCompletionProvider(
      () => MOCK_CACHE,
      () => MOCK_SHADER_INDEX,
      {
        getInputActions: () => [{ name: 'Move', actionMap: 'Player', assetName: 'Controls' }],
        getResourcePaths: () => ['Prefabs/Bullet', 'Audio/HitSfx'],
        getShaderKeywords: () => ['_ALPHATEST_ON', '_EMISSION'],
      },
    );

    // 1. Closing quote replacement: other.CompareTag("Pla|yer") -> replaces "Pla|yer" up to closing quote
    const qCode = 'class C : MonoBehaviour { void U() { gameObject.CompareTag("Pl/*CURSOR*/ayer"); } }';
    const qOffset = qCode.indexOf('/*CURSOR*/');
    const qDoc = vscode.__mock.createTextDocument(vscode.Uri.file('Assets/C.cs'), qCode.replace('/*CURSOR*/', ''), 'csharp');
    const qItems = await provider.provideCompletionItems(qDoc, qDoc.positionAt(qOffset));
    const playerItem = qItems?.find((i) => i.label === 'Player');
    expect(playerItem?.range).toBeDefined();
    const qRange = playerItem!.range as vscode.Range;
    expect(qDoc.getText(qRange)).toBe('Player');

    // 2. Unquoted identifier prefix: CompareTag(En/*CURSOR*/) -> replaces En with "Enemy"
    const uCode = 'class C : MonoBehaviour { void U() { gameObject.CompareTag(En/*CURSOR*/); } }';
    const uOffset = uCode.indexOf('/*CURSOR*/');
    const uDoc = vscode.__mock.createTextDocument(vscode.Uri.file('Assets/C.cs'), uCode.replace('/*CURSOR*/', ''), 'csharp');
    const uItems = await provider.provideCompletionItems(uDoc, uDoc.positionAt(uOffset));
    const enemyUnquoted = uItems?.find((i) => i.label === 'Enemy');
    expect(enemyUnquoted?.insertText).toBe('"Enemy"');
    expect(uDoc.getText(enemyUnquoted!.range as vscode.Range)).toBe('En');

    // 3. Animator filtering & priority: Play -> only states; SetFloat -> Speed first without Trigger
    const playItems = await runAtSnippet('_animator.Play("/*CURSOR*/");');
    expect(playItems?.map((i) => i.label)).toEqual(['Idle', 'Run']);

    const floatItems = await runAtSnippet('_animator.SetFloat("/*CURSOR*/", 1f);');
    expect(floatItems?.[0].label).toBe('Speed');
    expect(floatItems?.map((i) => i.label)).not.toContain('Attack');

    // 4. Shader.Find, Shader.EnableKeyword, Resources.Load, InputAction
    const shaderFindCode = 'class C { void U() { var s = Shader.Find("/*CURSOR*/"); } }';
    const sfDoc = vscode.__mock.createTextDocument(vscode.Uri.file('Assets/C.cs'), shaderFindCode.replace('/*CURSOR*/', ''), 'csharp');
    const sfItems = await provider.provideCompletionItems(sfDoc, sfDoc.positionAt(shaderFindCode.indexOf('/*CURSOR*/')));
    expect(sfItems?.map((i) => i.label)).toContain('UnityBrain/TestLit');

    const kwCode = 'class C { void U() { Shader.EnableKeyword("/*CURSOR*/"); } }';
    const kwDoc = vscode.__mock.createTextDocument(vscode.Uri.file('Assets/C.cs'), kwCode.replace('/*CURSOR*/', ''), 'csharp');
    const kwItems = await provider.provideCompletionItems(kwDoc, kwDoc.positionAt(kwCode.indexOf('/*CURSOR*/')));
    expect(kwItems?.map((i) => i.label)).toContain('_ALPHATEST_ON');

    const resCode = 'class C { void U() { Resources.Load<GameObject>("/*CURSOR*/"); } }';
    const resDoc = vscode.__mock.createTextDocument(vscode.Uri.file('Assets/C.cs'), resCode.replace('/*CURSOR*/', ''), 'csharp');
    const resItems = await provider.provideCompletionItems(resDoc, resDoc.positionAt(resCode.indexOf('/*CURSOR*/')));
    expect(resItems?.map((i) => i.label)).toContain('Prefabs/Bullet');

    const actCode = 'class C { void U() { input.actions.FindAction("/*CURSOR*/"); } }';
    const actDoc = vscode.__mock.createTextDocument(vscode.Uri.file('Assets/C.cs'), actCode.replace('/*CURSOR*/', ''), 'csharp');
    const actItems = await provider.provideCompletionItems(actDoc, actDoc.positionAt(actCode.indexOf('/*CURSOR*/')));
    expect(actItems?.map((i) => i.label)).toContain('Move');
  });
});
