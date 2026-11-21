import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import {
  registerCSharpGoToDefinitionCommand,
  UnityCSharpDefinitionProvider,
} from '../../src/completion/unityCSharpDefinitionProvider.ts';
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

    // 5. Declared Animator variable (_ctrl) & unclosed quote auto-closing & UI Toolkit .Q<T>
    const declAnimCode = 'class C { Animator _ctrl; void U() { _ctrl.SetFloat("Sp/*CURSOR*/); } }';
    const daDoc = vscode.__mock.createTextDocument(vscode.Uri.file('Assets/C.cs'), declAnimCode.replace('/*CURSOR*/', ''), 'csharp');
    const daItems = await provider.provideCompletionItems(daDoc, daDoc.positionAt(declAnimCode.indexOf('/*CURSOR*/')));
    const speedUnclosed = daItems?.find((i) => i.label === 'Speed');
    expect(speedUnclosed).toBeDefined();
    expect(speedUnclosed?.insertText).toBe('Speed"');

    const uiProvider = new UnityStringCompletionProvider(
      () => MOCK_CACHE,
      () => MOCK_SHADER_INDEX,
      {
        getUiToolkitElements: () => [
          { name: 'StartBtn', className: 'primary-btn', assetPath: 'Assets/UI/Main.uxml', line: 3 },
        ],
      },
    );
    const uiCode = 'class C { void U() { root.Q<Button>("/*CURSOR*/"); } }';
    const uiDoc = vscode.__mock.createTextDocument(vscode.Uri.file('Assets/C.cs'), uiCode.replace('/*CURSOR*/', ''), 'csharp');
    const uiItems = await uiProvider.provideCompletionItems(uiDoc, uiDoc.positionAt(uiCode.indexOf('/*CURSOR*/')));
    expect(uiItems?.map((i) => i.label)).toContain('StartBtn');
    expect(uiItems?.map((i) => i.label)).toContain('primary-btn');
  });

  it('resolves F12 Go to Definition across StartCoroutine, SceneManager, Shader.Find, Resources.Load, and .Q<T>', () => {
    const tmpRoot = path.join(process.cwd(), 'test-output', `csharp-def-${Date.now()}`);
    try {
      fs.mkdirSync(path.join(tmpRoot, 'Assets', 'Scenes'), { recursive: true });
      fs.mkdirSync(path.join(tmpRoot, 'Assets', 'Shaders'), { recursive: true });
      fs.mkdirSync(path.join(tmpRoot, 'Assets', 'Resources', 'Prefabs'), { recursive: true });
      fs.mkdirSync(path.join(tmpRoot, 'Assets', 'UI'), { recursive: true });

      const scenePath = path.join(tmpRoot, 'Assets', 'Scenes', 'Stage01.unity');
      const shaderPath = path.join(tmpRoot, 'Assets', 'Shaders', 'TestLit.shader');
      const resPath = path.join(tmpRoot, 'Assets', 'Resources', 'Prefabs', 'Bullet.prefab');
      const uxmlPath = path.join(tmpRoot, 'Assets', 'UI', 'Hud.uxml');
      fs.writeFileSync(scenePath, '%YAML 1.1\n', 'utf8');
      fs.writeFileSync(shaderPath, '// header\nShader "UnityBrain/TestLit" {\n}\n', 'utf8');
      fs.writeFileSync(resPath, '%YAML 1.1\n', 'utf8');
      fs.writeFileSync(uxmlPath, '<ui:UXML>\n  <ui:Button name="StartBtn" />\n</ui:UXML>\n', 'utf8');

      const defProvider = new UnityCSharpDefinitionProvider({
        projectRoot: tmpRoot,
        getCache: () => MOCK_CACHE,
        getUiToolkitElements: () => [{ name: 'StartBtn', assetPath: uxmlPath, line: 1 }],
      });

      const code = [
        'using System.Collections;',
        'class Hero : MonoBehaviour {',
        '  void Start() {',
        '    StartCoroutine("Fade/*C1*/OutRoutine");',
        '    SceneManager.LoadScene("Stage/*C2*/01");',
        '    Shader.Find("UnityBrain/Test/*C3*/Lit");',
        '    Resources.Load<GameObject>("Prefabs/Bul/*C4*/let");',
        '    root.Q<Button>("Start/*C5*/Btn");',
        '  }',
        '  IEnumerator FadeOutRoutine() { yield break; }',
        '}',
      ].join('\n');

      const clean = code.replace(/\/\*C\d+\*\//g, '');
      const doc = vscode.__mock.createTextDocument(vscode.Uri.file(path.join(tmpRoot, 'Assets', 'Hero.cs')), clean, 'csharp');
      const posOf = (marker: string) => {
        const idx = code.indexOf(marker);
        const before = code.slice(0, idx).replace(/\/\*C\d+\*\//g, '');
        return doc.positionAt(before.length);
      };

      const coroLoc = defProvider.provideDefinition(doc, posOf('/*C1*/'));
      expect(coroLoc?.range.start.line).toBe(9);

      const sceneLoc = defProvider.provideDefinition(doc, posOf('/*C2*/'));
      expect(path.resolve(sceneLoc!.uri.fsPath)).toBe(path.resolve(scenePath));

      const shaderLoc = defProvider.provideDefinition(doc, posOf('/*C3*/'));
      expect(path.resolve(shaderLoc!.uri.fsPath)).toBe(path.resolve(shaderPath));
      expect(shaderLoc!.range.start.line).toBe(1);

      const resLoc = defProvider.provideDefinition(doc, posOf('/*C4*/'));
      expect(path.resolve(resLoc!.uri.fsPath)).toBe(path.resolve(resPath));

      const uiLoc = defProvider.provideDefinition(doc, posOf('/*C5*/'));
      expect(path.resolve(uiLoc!.uri.fsPath)).toBe(path.resolve(uxmlPath));
      expect(uiLoc!.range.start.line).toBe(1);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('prevents Roslyn string.cs fallback on SceneManager F12 and delegates non-Unity symbols', async () => {
    const tmpRoot = path.join(process.cwd(), 'test-output', `csharp-f12-${Date.now()}`);
    const disposables: vscode.Disposable[] = [];
    try {
      fs.mkdirSync(path.join(tmpRoot, 'Assets', 'Scenes'), { recursive: true });
      const scenePath = path.join(tmpRoot, 'Assets', 'Scenes', 'Stage01.unity');
      fs.writeFileSync(scenePath, '%YAML 1.1\n', 'utf8');

      let mockUnityUdpOk = true;
      let udpCalls = 0;
      const defProvider = new UnityCSharpDefinitionProvider({
        projectRoot: tmpRoot,
        getCache: () => MOCK_CACHE,
        openInUnityEditor: async () => {
          udpCalls += 1;
          return mockUnityUdpOk;
        },
      });

      const code = [
        'using UnityEngine.SceneManagement;',
        'class SceneLoader {',
        '  void LoadNext() {',
        '    SceneManager.LoadScene("Sta/*S1*/ge01");',
        '  }',
        '}',
      ].join('\n');
      const clean = code.replace('/*S1*/', '');
      const csDoc = vscode.__mock.createTextDocument(
        vscode.Uri.file(path.join(tmpRoot, 'Assets', 'SceneLoader.cs')),
        clean,
        'csharp',
      );
      const sceneStrPos = csDoc.positionAt(code.indexOf('/*S1*/'));
      const nonStringPos = new vscode.Position(2, 8); // "LoadNext"

      let revealCount = 0;
      let closeEditorCount = 0;
      disposables.push(
        registerCSharpGoToDefinitionCommand(defProvider),
        vscode.commands.registerCommand('editor.action.revealDefinition', () => {
          revealCount += 1;
        }),
        vscode.commands.registerCommand('workbench.action.closeActiveEditor', () => {
          closeEditorCount += 1;
        }),
      );

      // 1. Offline mode (no EditorInstance.json): F12 resolves local location and skips revealDefinition
      vscode.window.activeTextEditor = {
        document: csDoc,
        selection: new vscode.Selection(sceneStrPos, sceneStrPos),
        revealRange: () => {},
        setDecorations: () => {},
      } as unknown as vscode.TextEditor;

      const offlineNav = defProvider.resolveUnityStringNavigation(csDoc, sceneStrPos);
      expect(offlineNav?.kind).toBe('location');
      await vscode.commands.executeCommand('unityBrain.csharpGoToDefinition');
      expect(revealCount).toBe(0);
      expect(path.resolve(vscode.window.activeTextEditor!.document.uri.fsPath)).toBe(
        path.resolve(scenePath),
      );

      // 2. Non-string C# symbol: F12 delegates to editor.action.revealDefinition
      vscode.window.activeTextEditor = {
        document: csDoc,
        selection: new vscode.Selection(nonStringPos, nonStringPos),
        revealRange: () => {},
        setDecorations: () => {},
      } as unknown as vscode.TextEditor;
      expect(defProvider.resolveUnityStringNavigation(csDoc, nonStringPos)).toBeUndefined();
      await vscode.commands.executeCommand('unityBrain.csharpGoToDefinition');
      expect(revealCount).toBe(1);

      // 3. Live Unity Editor running: F12 triggers Unity navigation without revealDefinition
      fs.mkdirSync(path.join(tmpRoot, 'Library'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, 'Library', 'EditorInstance.json'),
        JSON.stringify({ process_id: process.pid, version: '6000.0.0f1' }),
        'utf8',
      );

      const liveNav = defProvider.resolveUnityStringNavigation(csDoc, sceneStrPos);
      expect(liveNav).toEqual({
        kind: 'unity',
        targetPath: scenePath,
        label: 'Stage01',
      });

      vscode.window.activeTextEditor = {
        document: csDoc,
        selection: new vscode.Selection(sceneStrPos, sceneStrPos),
        revealRange: () => {},
        setDecorations: () => {},
      } as unknown as vscode.TextEditor;
      mockUnityUdpOk = true;
      await vscode.commands.executeCommand('unityBrain.csharpGoToDefinition');
      expect(revealCount).toBe(1);
      expect(udpCalls).toBe(1);
      expect(vscode.window.activeTextEditor?.document.uri.fsPath).toBe(csDoc.uri.fsPath);

      // 3b. Live Unity process without UDP listener: F12 falls back to opening scene locally
      mockUnityUdpOk = false;
      await vscode.commands.executeCommand('unityBrain.csharpGoToDefinition');
      expect(revealCount).toBe(1);
      expect(udpCalls).toBe(2);
      expect(path.resolve(vscode.window.activeTextEditor!.document.uri.fsPath)).toBe(
        path.resolve(scenePath),
      );

      // 4. Ctrl+Click / Hover path (`provideDefinition` when Unity is live): pure local Location, zero UDP or String.cs side effects
      const udpCallsBeforeHover = udpCalls;
      const ctrlClickLoc = defProvider.provideDefinition(csDoc, sceneStrPos);
      expect(ctrlClickLoc).toBeDefined();
      expect(path.resolve(ctrlClickLoc!.uri.fsPath)).toBe(path.resolve(scenePath));
      expect(udpCalls).toBe(udpCallsBeforeHover);
      const fakeStringDoc = vscode.__mock.createTextDocument(
        vscode.Uri.parse('csharp-metadata://System/String.cs'),
        'namespace System { public sealed class String {} }',
        'csharp',
      );
      vscode.__mock.emitters.onDidChangeActiveTextEditor.fire({
        document: fakeStringDoc,
      } as unknown as vscode.TextEditor);
      expect(closeEditorCount).toBe(0);
    } finally {
      for (const d of disposables) {
        d.dispose();
      }
      vscode.__mock.reset();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('resolves F12 Go to Definition for Shader properties, InputActions, Animator parameters while keeping provideDefinition pure', () => {
    const tmpRoot = path.join(process.cwd(), 'test-output', `csharp-def-unity6-${Date.now()}`);
    const disposables: vscode.Disposable[] = [];
    try {
      fs.mkdirSync(path.join(tmpRoot, 'Assets', 'Shaders'), { recursive: true });
      fs.mkdirSync(path.join(tmpRoot, 'Assets', 'Input'), { recursive: true });
      fs.mkdirSync(path.join(tmpRoot, 'Assets', 'Animations'), { recursive: true });

      const shaderPath = path.join(tmpRoot, 'Assets', 'Shaders', 'TestLit.shader');
      const inputPath = path.join(tmpRoot, 'Assets', 'Input', 'Controls.inputactions');
      const controllerPath = path.join(tmpRoot, 'Assets', 'Animations', 'Player.controller');

      fs.writeFileSync(
        shaderPath,
        [
          'Shader "UnityBrain/TestLit"',
          '{',
          '    Properties',
          '    {',
          '        _BaseMap ("Base Map", 2D) = "white" {}',
          '        _BaseColor ("Base Color", Color) = (1, 1, 1, 1)',
          '        _Cutoff ("Alpha Cutoff", Range(0.0, 1.0)) = 0.5',
          '    }',
          '}',
        ].join('\n'),
        'utf8',
      );

      fs.writeFileSync(
        inputPath,
        JSON.stringify(
          {
            name: 'Controls',
            maps: [
              {
                name: 'Gameplay',
                actions: [{ name: 'Move', type: 'Value' }],
              },
            ],
          },
          null,
          2,
        ),
        'utf8',
      );

      fs.writeFileSync(
        controllerPath,
        [
          '%YAML 1.1',
          '%TAG !u! tag:unity3d.com,2011:',
          '--- !u!91 &9100000',
          'AnimatorController:',
          '  m_Name: Player',
          '  m_AnimatorParameters:',
          '  - m_Name: Speed',
          '    m_Type: 1',
          '  - m_Name: Attack',
          '    m_Type: 9',
        ].join('\n'),
        'utf8',
      );

      let closeEditorCount = 0;
      disposables.push(
        vscode.commands.registerCommand('workbench.action.closeActiveEditor', () => {
          closeEditorCount += 1;
        }),
      );

      let mockUnityUdpOk = true;
      let udpCalls = 0;
      const defProvider = new UnityCSharpDefinitionProvider({
        projectRoot: tmpRoot,
        getCache: () => MOCK_CACHE,
        openInUnityEditor: async () => {
          udpCalls += 1;
          return mockUnityUdpOk;
        },
      });

      const code = [
        'using UnityEngine;',
        'class CombatActor : MonoBehaviour {',
        '  private Material _mat;',
        '  private Animator _animator;',
        '  void Run(dynamic input) {',
        '    int baseMapId = Shader.PropertyToID("_Base/*P1*/Map");',
        '    _mat.SetColor("_Base/*P2*/Color", Color.white);',
        '    _mat.SetColor(Shader.PropertyToID("_Base/*P3*/Color"), Color.white);',
        '    _mat.SetFloat("_Cut/*P4*/off", 0.5f);',
        '    var moveAct = input.actions.FindAction("Mo/*I1*/ve");',
        '    var map = input.FindActionMap("Game/*I2*/play");',
        '    var idxAct = input.actions["Mo/*I3*/ve"];',
        '    _animator.SetTrigger("Att/*A1*/ack");',
        '    _animator.SetFloat("Spe/*A2*/ed", 1.0f);',
        '    int hash = Animator.StringToHash("Att/*A3*/ack");',
        '  }',
        '}',
      ].join('\n');

      const clean = code.replace(/\/\*[PIA]\d+\*\//g, '');
      const doc = vscode.__mock.createTextDocument(
        vscode.Uri.file(path.join(tmpRoot, 'Assets', 'CombatActor.cs')),
        clean,
        'csharp',
      );
      const posOf = (marker: string) => {
        const idx = code.indexOf(marker);
        const before = code.slice(0, idx).replace(/\/\*[PIA]\d+\*\//g, '');
        return doc.positionAt(before.length);
      };

      const p1 = defProvider.provideDefinition(doc, posOf('/*P1*/'));
      expect(path.resolve(p1!.uri.fsPath)).toBe(path.resolve(shaderPath));
      expect(p1!.range.start.line).toBe(4);

      const p2 = defProvider.provideDefinition(doc, posOf('/*P2*/'));
      expect(path.resolve(p2!.uri.fsPath)).toBe(path.resolve(shaderPath));
      expect(p2!.range.start.line).toBe(5);

      const p3 = defProvider.provideDefinition(doc, posOf('/*P3*/'));
      expect(path.resolve(p3!.uri.fsPath)).toBe(path.resolve(shaderPath));
      expect(p3!.range.start.line).toBe(5);

      const p4 = defProvider.provideDefinition(doc, posOf('/*P4*/'));
      expect(path.resolve(p4!.uri.fsPath)).toBe(path.resolve(shaderPath));
      expect(p4!.range.start.line).toBe(6);

      const i1 = defProvider.provideDefinition(doc, posOf('/*I1*/'));
      expect(path.resolve(i1!.uri.fsPath)).toBe(path.resolve(inputPath));

      const i2 = defProvider.provideDefinition(doc, posOf('/*I2*/'));
      expect(path.resolve(i2!.uri.fsPath)).toBe(path.resolve(inputPath));

      const i3 = defProvider.provideDefinition(doc, posOf('/*I3*/'));
      expect(path.resolve(i3!.uri.fsPath)).toBe(path.resolve(inputPath));
      expect(i1!.range.start.line).toBe(i3!.range.start.line);
      expect(i2!.range.start.line < i1!.range.start.line).toBe(true);

      const a1 = defProvider.provideDefinition(doc, posOf('/*A1*/'));
      expect(path.resolve(a1!.uri.fsPath)).toBe(path.resolve(controllerPath));
      expect(a1!.range.start.line).toBe(8);

      const a2 = defProvider.provideDefinition(doc, posOf('/*A2*/'));
      expect(path.resolve(a2!.uri.fsPath)).toBe(path.resolve(controllerPath));
      expect(a2!.range.start.line).toBe(6);

      const a3 = defProvider.provideDefinition(doc, posOf('/*A3*/'));
      expect(path.resolve(a3!.uri.fsPath)).toBe(path.resolve(controllerPath));
      expect(a3!.range.start.line).toBe(8);

      // provideDefinition stays 100% pure (never arms side-effectful closeActiveEditor listeners)
      const fakeStringDoc = vscode.__mock.createTextDocument(
        vscode.Uri.parse('csharp-metadata://System/String.cs'),
        'namespace System { public sealed class String {} }',
        'csharp',
      );
      vscode.__mock.emitters.onDidChangeActiveTextEditor.fire({
        document: fakeStringDoc,
      } as unknown as vscode.TextEditor);
      expect(closeEditorCount).toBe(0);

      // Live Unity Editor running: Animator parameter resolves to kind: 'unity' targeting Player.controller
      fs.mkdirSync(path.join(tmpRoot, 'Library'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, 'Library', 'EditorInstance.json'),
        JSON.stringify({ process_id: process.pid, version: '6000.0.0f1' }),
        'utf8',
      );
      expect(defProvider.resolveUnityStringNavigation(doc, posOf('/*A1*/'))).toEqual({
        kind: 'unity',
        targetPath: controllerPath,
        label: 'Player.controller (Attack)',
      });
      const liveHoverCtrlLoc = defProvider.provideDefinition(doc, posOf('/*A1*/'));
      expect(path.resolve(liveHoverCtrlLoc!.uri.fsPath)).toBe(path.resolve(controllerPath));
      expect(udpCalls).toBe(0);
      expect(mockUnityUdpOk).toBe(true);
    } finally {
      for (const d of disposables) {
        d.dispose();
      }
      vscode.__mock.reset();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
