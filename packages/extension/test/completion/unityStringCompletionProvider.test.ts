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
});
