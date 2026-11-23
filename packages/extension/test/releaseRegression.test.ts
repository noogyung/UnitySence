import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vscode from 'vscode';
import { afterEach, describe, expect, it } from 'vitest';
import { UnityCSharpCodeActionProvider } from '../src/analyzers/csharpCodeActionProvider.ts';
import { UnityAsmdefProvider } from '../src/asmdef/unityAsmdefProvider.ts';
import {
  parseCSharpDeclarations,
  UnityAssetUsageCodeLensProvider,
  UnityDaemonClient,
} from '../src/codelens/unityAssetUsageCodeLensProvider.ts';
import { UnityCSharpDefinitionProvider } from '../src/completion/unityCSharpDefinitionProvider.ts';
import {
  extractClassInheritanceFromSource,
  registerGenerateEventFunctionsCommand,
  UnityEventCompletionProvider,
} from '../src/completion/unityEventGenerator.ts';
import { UnityStringCompletionProvider } from '../src/completion/unityStringCompletionProvider.ts';
import {
  generateUnityLaunchConfig,
  stripJsoncCommentsAndTrailingCommas,
} from '../src/editor/unityEditorIntegration.ts';
import { MetaFileSyncManager } from '../src/meta/metaFileSyncManager.ts';
import {
  collectUiToolkitElements,
  UnityUssCompletionProvider,
} from '../src/uitoolkit/unityUiToolkitProvider.ts';
import { parseAnimatorControllerYaml } from '../src/watchers/projectSettingsWatcher.ts';
import type { ProjectSettingsCache } from '../src/contracts/index.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../..');
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const baseOut = path.join(REPO_ROOT, 'test-output');
  fs.mkdirSync(baseOut, { recursive: true });
  const dir = fs.mkdtempSync(path.join(baseOut, prefix));
  tempDirs.push(dir);
  return dir;
}

const EMPTY_CACHE: ProjectSettingsCache = {
  schemaVersion: 1,
  updatedAt: '2026-11-21T00:00:00.000Z',
  tags: ['Player', 'Enemy'],
  layers: [{ index: 0, name: 'Default' }, { index: 8, name: 'EnemyLayer' }],
  sortingLayers: [],
  inputAxes: [],
  buildScenes: [],
  animatorControllers: [],
};

afterEach(() => {
  vscode.__mock.reset();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Extension Release Regression Suite', () => {
  it('enforces daemon client 5s retry cooldown, bypass on rebuild(true), idempotent dispose, and multi-class/inline-attr CodeLens declarations', async () => {
    const root = makeTempDir('ub-ext-daemon-');
    let startAttempts = 0;
    let shouldSucceed = false;
    const client = new UnityDaemonClient({
      projectRoot: root,
      extensionPath: path.join(REPO_ROOT, 'packages', 'extension'),
      transportFactory: () => {
        startAttempts += 1;
        if (!shouldSucceed) {
          throw new Error('simulated daemon failure');
        }
        return {
          sendRequest: async <T>(method: string) => {
            if (method === 'index/rebuild') {
              return { indexedAssets: 7, elapsedMs: 3 } as T;
            }
            if (method === 'usage/findByMethod') {
              return {
                locations: [
                  {
                    assetPath: 'Assets/Main.unity',
                    assetType: 'scene',
                    assetGuid: '0123456789abcdef0123456789abcdef',
                    gameObjectPath: 'Button',
                    fileId: '10',
                    line: 12,
                    usageKind: 'unityEventCallback',
                    methodName: 'OnFire',
                  },
                ],
              } as T;
            }
            return { locations: [], fields: [] } as T;
          },
          dispose: () => {},
        };
      },
    });

    await expect(client.getStatus()).rejects.toThrow(/simulated daemon failure/);
    expect(startAttempts).toBe(1);
    // Second call inside 5s cooldown must fail fast without spawning again
    await expect(client.getStatus()).rejects.toThrow(/cooldown/i);
    expect(startAttempts).toBe(1);

    // Forced rebuild(true) bypasses & resets cooldown
    shouldSucceed = true;
    const rebuildRes = await client.rebuild(true);
    expect(rebuildRes.indexedAssets).toBe(7);
    expect(startAttempts).toBe(2);

    const csSrc = [
      'public class DataHolder',
      '{',
      '    public int unused = 1;',
      '}',
      '',
      '[DisallowMultipleComponent]',
      'public class CombatActor : MonoBehaviour',
      '{',
      '    [SerializeField] float speed = 5f;',
      '    public List<int> items = new();',
      '    [ContextMenu("Run")] public void OnFire() {}',
      '}',
    ].join('\n');
    const decls = parseCSharpDeclarations(csSrc);
    expect(decls.classes.map((c) => c.className)).toEqual(['DataHolder', 'CombatActor']);
    expect(decls.serializedFields).toEqual([
      { fieldName: 'unused', line: 2, className: 'DataHolder' },
      { fieldName: 'speed', line: 8, className: 'CombatActor' },
      { fieldName: 'items', line: 9, className: 'CombatActor' },
    ]);
    expect(decls.methods).toEqual([{ methodName: 'OnFire', line: 10, className: 'CombatActor' }]);

    const csPath = path.join(root, 'Assets', 'CombatActor.cs');
    fs.mkdirSync(path.dirname(csPath), { recursive: true });
    fs.writeFileSync(csPath, csSrc, 'utf8');
    fs.writeFileSync(`${csPath}.meta`, 'guid: abcdefabcdefabcdefabcdefabcdef12\n', 'utf8');
    const doc = vscode.__mock.createTextDocument(vscode.Uri.file(csPath), csSrc, 'csharp');

    const lensProvider = new UnityAssetUsageCodeLensProvider(root, client);
    const lenses = await lensProvider.provideCodeLenses(doc, new vscode.CancellationTokenSource().token);
    const callbackLens = lenses.find((l) => l.command?.title.includes('이벤트 콜백'));
    expect(callbackLens).toBeDefined();
    expect(String((callbackLens!.command!.arguments?.[0] as { title: string }).title)).toContain(
      'CombatActor.OnFire()',
    );

    lensProvider.dispose();
    client.dispose();
    client.dispose();
    await expect(client.getStatus()).rejects.toThrow(/disposed/i);
  });

  it('handles char literals, verbatim @ strings, PackageCache Shader.Find, and filterText/preselect accurately', async () => {
    const root = makeTempDir('ub-ext-str-');
    const pkgShaderDir = path.join(root, 'Library', 'PackageCache', 'com.unity.render-pipelines.universal@17.0.3', 'Shaders');
    fs.mkdirSync(pkgShaderDir, { recursive: true });
    fs.mkdirSync(path.join(root, 'Assets', 'Scripts'), { recursive: true });
    const litShader = path.join(pkgShaderDir, 'Lit.shader');
    fs.writeFileSync(litShader, 'Shader "Universal Render Pipeline/Lit"\n{\n}\n', 'utf8');

    const csCode = [
      'using UnityEngine;',
      'class Demo {',
      '  void f() {',
      "    char q = '\"';",
      '    Shader.Find(@"Universal Render Pipe/*S1*/line/Lit");',
      '    CompareTag(Pl',
      '  }',
      '}',
    ].join('\n');
    const clean = csCode.replace('/*S1*/', '');
    const doc = vscode.__mock.createTextDocument(
      vscode.Uri.file(path.join(root, 'Assets', 'Scripts', 'Demo.cs')),
      clean,
      'csharp',
    );
    const defProvider = new UnityCSharpDefinitionProvider({
      projectRoot: root,
      getCache: () => EMPTY_CACHE,
    });
    const shaderLoc = defProvider.provideDefinition(doc, doc.positionAt(csCode.indexOf('/*S1*/')));
    expect(shaderLoc).toBeDefined();
    expect(path.resolve(shaderLoc!.uri.fsPath)).toBe(path.resolve(litShader));

    const compProvider = new UnityStringCompletionProvider(() => EMPTY_CACHE, () => null);
    const items = await compProvider.provideCompletionItems(doc, new vscode.Position(5, 17));
    expect(items).toBeDefined();
    const player = items!.find((i) => i.label === 'Player') as vscode.CompletionItem & { preselect?: boolean };
    const enemy = items!.find((i) => i.label === 'Enemy') as vscode.CompletionItem & { preselect?: boolean };
    expect(player.filterText).toBe('Pl "Player" Player');
    expect(player.preselect).toBe(true);
    expect(enemy.filterText).toBe('"Enemy" Enemy');
    expect(enemy.preselect).toBe(false);
    defProvider.dispose();
  });

  it('supports NetworkBehaviour/UIBehaviour MonoBehaviour inheritance, showEventSnippets flag, comment masking, and namespace indentation', async () => {
    const root = makeTempDir('ub-ext-ev-');
    const inh = new Map<string, string[]>();
    extractClassInheritanceFromSource(
      '// class Fake : MonoBehaviour {}\nprivate const string s = "class AlsoFake : MonoBehaviour {}";\npublic class NetHero : NetworkBehaviour {}',
      inh,
    );
    expect(inh.has('Fake')).toBe(false);
    expect(inh.has('AlsoFake')).toBe(false);
    expect(inh.get('NetHero')).toEqual(['NetworkBehaviour']);

    const provider = new UnityEventCompletionProvider({ projectRoot: root });
    const netCode = 'public class NetHero : NetworkBehaviour\n{\n    \n}';
    const netDoc = vscode.__mock.createTextDocument(vscode.Uri.file(path.join(root, 'NetHero.cs')), netCode, 'csharp');
    const netItems = provider.provideCompletionItems(netDoc, new vscode.Position(2, 4));
    expect(netItems?.some((i) => i.label === 'OnNetworkSpawn')).toBe(true);
    expect(netItems?.some((i) => i.label === 'Update')).toBe(true);

    await vscode.workspace.getConfiguration('unitySense').update('completion.showEventSnippets', false);
    expect(provider.provideCompletionItems(netDoc, new vscode.Position(2, 4))).toBeUndefined();
    await vscode.workspace.getConfiguration('unitySense').update('completion.showEventSnippets', true);

    const nsFile = path.join(root, 'NsPanel.cs');
    const nsCode = [
      'namespace MyGame.UI',
      '{',
      '    public class NsPanel : MonoBehaviour',
      '    {',
      '        ',
      '    }',
      '}',
    ].join('\n');
    fs.writeFileSync(nsFile, nsCode, 'utf8');
    const nsDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(nsFile));
    vscode.window.activeTextEditor = {
      document: nsDoc,
      selection: new vscode.Selection(new vscode.Position(4, 4), new vscode.Position(4, 4)),
    } as unknown as vscode.TextEditor;
    const disp = registerGenerateEventFunctionsCommand(provider);
    await vscode.commands.executeCommand('unitySense.generateEventFunctions', ['Update']);
    const afterGen = fs.readFileSync(nsFile, 'utf8');
    expect(afterGen).toContain('        private void Update()');
    expect(afterGen).toContain('    }\n}');
    disp.dispose();
  });

  it('handles C# CodeAction edge cases without creating Directory.Build.props', async () => {
    const baseOut = makeTempDir('ub-ext-msb-');

    const codeActionProvider = new UnityCSharpCodeActionProvider();
    const csCode = [
      'using UnityEngine;',
      'public class EdgeCases : MonoBehaviour',
      '{',
      '    private static readonly int FixedId = Shader.PropertyToID("_Spec");',
      '    [Range(0f, 1f)] public Vector3 offset = new Vector3(1, 2, 3);',
      '    private void Awake() {}',
      '    private void Update()',
      '    {',
      '        if (Time.time > 0f)',
      '        {',
      '            var rb = GetComponent<Rigidbody>();',
      '        }',
      '    }',
      '}',
    ].join('\n');
    const edgeCsPath = path.join(baseOut, 'EdgeCases.cs');
    fs.writeFileSync(edgeCsPath, csCode, 'utf8');
    const csDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(edgeCsPath));

    // static readonly hash declaration should not trigger extract-hash quick fix
    const hashLineActions = codeActionProvider.provideCodeActions(csDoc, new vscode.Range(3, 4, 3, 4));
    expect(hashLineActions.some((a) => a.title.includes('해시를 static readonly'))).toBe(false);

    // Attributed field with `(` initializer gets FormerlySerializedAs action
    const fsaActions = codeActionProvider.provideCodeActions(csDoc, new vscode.Range(4, 4, 4, 4));
    expect(fsaActions.some((a) => a.title.includes('FormerlySerializedAs') && a.title.includes('offset'))).toBe(true);

    // GetComponent inside `if` inside `Update` expands single-line Awake() {} cleanly
    const gcActions = codeActionProvider.provideCodeActions(csDoc, new vscode.Range(10, 20, 10, 20));
    const awakeAction = gcActions.find((a) => a.title.includes('Awake()에'));
    expect(awakeAction).toBeDefined();
    await vscode.workspace.applyEdit(awakeAction!.edit!);
    const appliedCs = fs.readFileSync(edgeCsPath, 'utf8');
    expect(appliedCs).toContain('private Rigidbody _cachedRigidbody;');
    expect(appliedCs).toContain('_cachedRigidbody = GetComponent<Rigidbody>();');
    expect(appliedCs).toContain('var rb = _cachedRigidbody;');
  });

  it('validates dirty asmdef overlays with O(V+E) cycle detection and handles launch.json & USS/Meta regressions', async () => {
    const root = makeTempDir('ub-ext-eco-');
    fs.mkdirSync(path.join(root, 'Assets', 'Asm'), { recursive: true });
    fs.mkdirSync(path.join(root, 'Assets', 'UI'), { recursive: true });
    fs.mkdirSync(path.join(root, '.vscode'), { recursive: true });

    // Asmdef dirty overlay & exact offending ref
    const asmA = path.join(root, 'Assets', 'Asm', 'A.asmdef');
    const asmB = path.join(root, 'Assets', 'Asm', 'B.asmdef');
    const asmSafe = path.join(root, 'Assets', 'Asm', 'Safe.asmdef');
    fs.writeFileSync(asmA, JSON.stringify({ name: 'A', references: [] }), 'utf8');
    fs.writeFileSync(asmB, JSON.stringify({ name: 'B', references: ['A'] }), 'utf8');
    fs.writeFileSync(asmSafe, JSON.stringify({ name: 'Safe', references: [] }), 'utf8');

    const asmProvider = new UnityAsmdefProvider(root);
    let hintChanged = 0;
    asmProvider.onDidChangeInlayHints(() => {
      hintChanged += 1;
    });
    const cleanDocA = vscode.__mock.createTextDocument(
      vscode.Uri.file(asmA),
      JSON.stringify({ name: 'A', references: ['Safe'] }),
      'json',
    );
    expect(asmProvider.validateDocument(cleanDocA)).toEqual([]);

    // Now edit docA in memory (without saving to disk!) so A -> Safe, B -> loops
    const dirtyCyclicText = JSON.stringify({ name: 'A', references: ['Safe', 'B'] }, null, 2);
    const dirtyDocA = vscode.__mock.createTextDocument(vscode.Uri.file(asmA), dirtyCyclicText, 'json');
    const cycleDiags = asmProvider.validateDocument(dirtyDocA);
    expect(cycleDiags.length).toBe(1);
    expect(cycleDiags[0].message).toContain('A -> B -> A');
    expect(dirtyDocA.getText(cycleDiags[0].range)).toBe('B');

    asmProvider.invalidate();
    expect(hintChanged).toBe(1);
    asmProvider.dispose();

    // JSONC preservation (URL with // and trailing commas) + abort without overwrite on invalid JSON
    const urlStripped = stripJsoncCommentsAndTrailingCommas(
      '{\n  // header comment\n  "url": "https://unity.com//docs, }", /* block */\n  "arr": [1, 2, ],\n}\n',
    );
    expect(JSON.parse(urlStripped)).toEqual({ url: 'https://unity.com//docs, }', arr: [1, 2] });

    const launchPath = path.join(root, '.vscode', 'launch.json');
    const brokenOriginal = '{ "broken": [1, 2,,] }\n';
    fs.writeFileSync(launchPath, brokenOriginal, 'utf8');
    const abortRes = generateUnityLaunchConfig(root);
    expect(abortRes.aborted).toBe(true);
    expect(fs.readFileSync(launchPath, 'utf8')).toBe(brokenOriginal);

    // USS multiline comment stripping, @import exclusion, and braceDepth > 0 gating
    const ussPath = path.join(root, 'Assets', 'UI', 'Panel.uss');
    const ussSrc = [
      '/* .CommentedOut { color: red; } */',
      '@import url("Packages/com.foo/Other.uss");',
      '.RealClass {',
      '  opacity: 1;',
      '}',
    ].join('\n');
    fs.writeFileSync(ussPath, ussSrc, 'utf8');
    const uiElems = collectUiToolkitElements(root);
    expect(uiElems.some((e) => e.className === 'RealClass')).toBe(true);
    expect(uiElems.some((e) => e.className === 'CommentedOut')).toBe(false);
    expect(uiElems.some((e) => e.className === 'uss')).toBe(false);

    const ussProvider = new UnityUssCompletionProvider(() => uiElems);
    const topLevelUss = vscode.__mock.createTextDocument(vscode.Uri.file(ussPath), '.RealClass {}\nflex-', 'uss');
    expect(ussProvider.provideCompletionItems(topLevelUss, new vscode.Position(1, 5))).toBeUndefined();
    const insideRuleUss = vscode.__mock.createTextDocument(vscode.Uri.file(ussPath), '.RealClass {\n  flex-', 'uss');
    const insideItems = ussProvider.provideCompletionItems(insideRuleUss, new vscode.Position(1, 7));
    expect(insideItems?.some((i) => i.label === 'flex-direction')).toBe(true);

    // AnimatorController YAML section boundary at m_AnimatorLayers:
    const ctrlYaml = [
      '--- !u!91 &9100000',
      'AnimatorController:',
      '  m_AnimatorParameters:',
      '  - m_Name: MoveSpeed',
      '    m_Type: 1',
      '  m_AnimatorLayers:',
      '  - m_Name: Base Layer',
    ].join('\n');
    const parsedCtrl = parseAnimatorControllerYaml(ctrlYaml, 'Assets/P.controller', '1234');
    expect(parsedCtrl.parameters.map((p) => p.name)).toEqual(['MoveSpeed']);

    // MetaFileSyncManager rename quadrants + oldMetaPath dedup
    fs.mkdirSync(path.join(root, 'Assets', 'InDir'), { recursive: true });
    fs.mkdirSync(path.join(root, 'OutsideDir'), { recursive: true });
    const metaMgr = new MetaFileSyncManager({ projectRoot: root });
    try {
      const insideFile = path.join(root, 'Assets', 'InDir', 'Movable.txt');
      const outsideDest = path.join(root, 'OutsideDir', 'Movable.txt');
      fs.writeFileSync(insideFile, 'x', 'utf8');
      fs.writeFileSync(`${insideFile}.meta`, 'guid: 11112222333344445555666677778888\n', 'utf8');

      // Moving Assets -> Outside schedules deletion of orphan .meta
      const editsOut: Promise<vscode.WorkspaceEdit>[] = [];
      metaMgr.handleWillRenameFiles({
        files: [{ oldUri: vscode.Uri.file(insideFile), newUri: vscode.Uri.file(outsideDest) }],
        waitUntil: (p) => editsOut.push(p),
      });
      expect(editsOut.length).toBe(1);
      await vscode.workspace.applyEdit(await editsOut[0]);
      expect(fs.existsSync(`${insideFile}.meta`)).toBe(false);

      // Moving Outside -> Assets into brand new folder generates parent folder & asset .meta
      const incomingSrc = path.join(root, 'OutsideDir', 'Incoming.txt');
      const newSubFolder = path.join(root, 'Assets', 'NewImportedFolder');
      const incomingDst = path.join(newSubFolder, 'Incoming.txt');
      fs.mkdirSync(newSubFolder, { recursive: true });
      fs.writeFileSync(incomingDst, 'hello', 'utf8');
      const created = await metaMgr.handleDidRenameFiles([
        { oldUri: vscode.Uri.file(incomingSrc), newUri: vscode.Uri.file(incomingDst) },
      ]);
      expect(created.some((p) => p.endsWith('NewImportedFolder.meta'))).toBe(true);
      expect(created.some((p) => p.endsWith('Incoming.txt.meta'))).toBe(true);
    } finally {
      metaMgr.dispose();
    }

    // Extension manifest grammars & snippets declare only registered languages with unique scopeNames
    const pkgJson = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'packages', 'extension', 'package.json'), 'utf8'),
    ) as {
      contributes: {
        languages: Array<{ id: string }>;
        grammars: Array<{ language: string; scopeName: string; path: string }>;
        snippets: Array<{ language: string; path: string }>;
      };
    };
    const declaredLangs = new Set(pkgJson.contributes.languages.map((l) => l.id));
    const seenScopes = new Set<string>();
    for (const g of pkgJson.contributes.grammars) {
      expect(declaredLangs.has(g.language)).toBe(true);
      expect(seenScopes.has(g.scopeName)).toBe(false);
      seenScopes.add(g.scopeName);
    }
    for (const s of pkgJson.contributes.snippets) {
      expect(declaredLangs.has(s.language)).toBe(true);
    }
  });
});
