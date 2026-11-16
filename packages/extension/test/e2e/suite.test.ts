import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { activate, deactivate } from '../../src/extension.ts';

const tempDirs: string[] = [];

const EXCLUDED_TOP_DIRS = new Set(['Temp', 'Logs', 'UserSettings', 'obj', '.git', '.unitybrain']);

function copyDirRecursive(src: string, dst: string, relBase = ''): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (!relBase && EXCLUDED_TOP_DIRS.has(entry.name)) {
      continue;
    }
    if (relBase === 'Library' && entry.name !== 'PackageCache') {
      continue;
    }

    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath, relPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

function createMockExtensionContext(extensionPath: string): vscode.ExtensionContext {
  const storageDir = path.join(extensionPath, 'test-output', 'e2e-storage');
  return {
    subscriptions: [],
    extensionPath,
    extensionUri: vscode.Uri.file(extensionPath),
    globalStorageUri: vscode.Uri.file(storageDir),
    storageUri: vscode.Uri.file(storageDir),
    extensionMode: vscode.ExtensionMode.Test,
    asAbsolutePath: (rel: string) => path.resolve(extensionPath, rel),
  };
}

afterEach(() => {
  deactivate();
  vscode.__mock.reset();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('UnityBrain Extension End-to-End Integration Suite', () => {
  it('activates on SampleUnityProject and integrates Directory.Build.props, Shader Definition/Variants, C# Completions, CodeLens, and Meta Sync', async () => {
    const repoRoot = process.cwd();
    const fixtureProject = path.join(repoRoot, 'test-fixtures', 'SampleUnityProject');
    const fixtureEditor = path.join(repoRoot, 'test-fixtures', 'SampleEditor');
    const extensionRoot = path.join(repoRoot, 'packages', 'extension');

    const workDir = path.join(
      repoRoot,
      'test-output',
      `e2e-unity-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const sampleRoot = path.join(workDir, 'SampleUnityProject');
    copyDirRecursive(fixtureProject, sampleRoot);
    tempDirs.push(workDir);

    vscode.workspace.workspaceFolders = [
      { uri: vscode.Uri.file(sampleRoot), name: 'SampleUnityProject', index: 0 },
    ];

    const extCtx = createMockExtensionContext(extensionRoot);
    const api = await activate(extCtx, {
      workspaceRoot: sampleRoot,
      unityEditorPath: fixtureEditor,
      enableWatchers: false,
      daemonTransportFactory: () => ({
        sendRequest: async <T>(method: string) => {
          if (method === 'usage/findByScriptGuid') {
            return {
              locations: [
                {
                  assetPath: 'Assets/Scenes/Main.unity',
                  assetType: 'scene',
                  assetGuid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                  gameObjectPath: 'Player',
                  fileId: '101',
                  line: 14,
                  usageKind: 'component',
                },
              ],
            } as T;
          }
          if (method === 'inspector/getSerializedValues') {
            return { fields: [] } as T;
          }
          if (method === 'usage/findByMethod') {
            return { locations: [] } as T;
          }
          return { state: 'ready', indexedAssets: 1, indexedMetas: 1, lastBuildMs: 1 } as T;
        },
        dispose: () => {},
      }),
    });

    expect(api).toBeDefined();
    expect(api!.context.editorVersion).toContain('6000.');

    // 1. Verify Directory.Build.props points directly to ProjectSettings YAML without disk cache duplication
    const propsPath = path.join(sampleRoot, 'Directory.Build.props');
    expect(fs.existsSync(propsPath)).toBe(true);
    const propsText = fs.readFileSync(propsPath, 'utf8');
    expect(propsText).toContain('<!-- UnityBrain:Begin -->');
    expect(propsText).toContain('UnityBrain.Analyzers.dll');
    expect(propsText).toContain('TagManager.asset');
    expect(propsText).toContain('EditorBuildSettings.asset');
    expect(propsText).toContain('unity-api.json');
    expect(propsText).not.toContain('project-settings.json');

    expect(fs.existsSync(api!.context.cacheDir)).toBe(false);
    const memCache = api!.settingsWatcher.getCache();
    expect(memCache.tags).toContain('Enemy');
    expect(memCache.layers.some((l: { name: string }) => l.name === 'Hitbox')).toBe(true);

    // 2. Verify ShaderLab #include "Packages/..." Go-to-Definition + Shader Variant CodeLens
    const testLitPath = path.join(sampleRoot, 'Assets', 'Shaders', 'TestLit.shader');
    const testLitText = fs.readFileSync(testLitPath, 'utf8');
    const shaderDoc = vscode.__mock.createTextDocument(
      vscode.Uri.file(testLitPath),
      testLitText,
      'unity-shaderlab',
    );

    const defEntry = vscode.__mock.registeredProviders.find((p) => p.type === 'definition');
    expect(defEntry).toBeDefined();
    const defProvider = defEntry!.provider as {
      provideDefinition: (doc: vscode.TextDocument, pos: vscode.Position) => vscode.Location[];
    };
    const coreIncludeLine = testLitText.split(/\r?\n/).findIndex((l) => l.includes('Core.hlsl'));
    const defs = defProvider.provideDefinition(shaderDoc, new vscode.Position(coreIncludeLine, 25));
    expect(defs.length).toBeGreaterThan(0);
    expect(defs[0].uri.fsPath.replace(/\\/g, '/')).toMatch(
      /Library\/PackageCache\/com\.unity\.render-pipelines\.universal@[^/]+\/ShaderLibrary\/Core\.hlsl$/,
    );

    const variantLenses = api!.shaderVariantCodeLensProvider.provideCodeLenses(shaderDoc);
    expect(variantLenses.length).toBe(1);
    expect(variantLenses[0].command?.title).toBe('$(layers) [UnityBrain] 셰이더 배리언트 6개');

    // 3. Verify C# CompareTag("") completion + Asset Usage CodeLens
    const scriptsDir = path.join(sampleRoot, 'Assets', 'Scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    const csPath = path.join(scriptsDir, 'HeroBehaviour.cs');
    const csText = [
      'using UnityEngine;',
      '',
      'public class HeroBehaviour : MonoBehaviour',
      '{',
      '    void Update()',
      '    {',
      '        if (CompareTag("',
      '    }',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(csPath, csText, 'utf8');
    fs.writeFileSync(`${csPath}.meta`, 'guid: 99887766554433221100ffeeddccbbaa\n', 'utf8');

    const csDoc = vscode.__mock.createTextDocument(vscode.Uri.file(csPath), csText, 'csharp');
    const compItems = await api!.stringCompletionProvider.provideCompletionItems(
      csDoc,
      new vscode.Position(6, 24),
    );
    expect(compItems).toBeDefined();
    expect(compItems!.some((i) => i.label === 'Interactable')).toBe(true);

    const usageLenses = await api!.assetUsageCodeLensProvider.provideCodeLenses(
      csDoc,
      new vscode.CancellationTokenSource().token,
    );
    expect(usageLenses.length).toBeGreaterThan(0);
    expect(usageLenses[0].command?.title).toBe('$(symbol-reference) [UnityBrain] 에셋 참조 1곳 (씬 1개)');

    // 4. Verify .meta lifecycle sync on newly created file
    const spawnedCs = path.join(scriptsDir, 'NewItem.cs');
    fs.writeFileSync(spawnedCs, 'public class NewItem {}', 'utf8');
    const createdMetas = await api!.metaSyncManager.handleDidCreateFiles([vscode.Uri.file(spawnedCs)]);
    expect(createdMetas.length).toBe(1);
    expect(fs.readFileSync(`${spawnedCs}.meta`, 'utf8')).toMatch(/guid:\s+[0-9a-f]{32}/);

    // 5. Verify clean deactivation disposes everything
    for (const s of extCtx.subscriptions) {
      s.dispose();
    }
    deactivate();
  });
});
