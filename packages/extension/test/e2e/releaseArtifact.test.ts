import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { UnityDaemonClient } from '../../src/codelens/unityAssetUsageCodeLensProvider.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');
const EXT_ROOT = path.join(REPO_ROOT, 'packages', 'extension');
const tempDirs: string[] = [];

function createTempUnityFixture(): string {
  const baseOut = path.join(REPO_ROOT, 'test-output');
  fs.mkdirSync(baseOut, { recursive: true });
  const root = fs.mkdtempSync(path.join(baseOut, 'ub-release-e2e-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'Assets', 'Prefabs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ProjectSettings'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'ProjectSettings', 'ProjectVersion.txt'),
    'm_EditorVersion: 6000.0.23f1\n',
    'utf8',
  );
  return root;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Built Release Artifact End-to-End Verification', () => {
  it('loads and actually activates/deactivates built packages/extension/dist/extension.cjs end-to-end', async () => {
    const cjsEntry = path.join(EXT_ROOT, 'dist', 'extension.cjs');
    const jsEntry = path.join(EXT_ROOT, 'dist', 'extension.js');
    const lspEntry = path.join(EXT_ROOT, 'dist', 'shader-lsp', 'server.js');
    expect(fs.existsSync(cjsEntry)).toBe(true);
    expect(fs.existsSync(jsEntry)).toBe(true);
    expect(fs.existsSync(lspEntry)).toBe(true);

    // Ensure Node built-in imports were NOT stripped by rewriteVscodeImportsSync
    const builtExtJs = fs.readFileSync(jsEntry, 'utf8');
    expect(builtExtJs).toContain("from 'node:fs'");
    expect(builtExtJs).toContain("from 'node:path'");

    const req = createRequire(import.meta.url);
    const extMod = req(cjsEntry) as {
      activate: (ctx: unknown, opts: unknown) => Promise<{
        context: { editorVersion: string; projectRoot: string };
        dispose: () => void;
      } | undefined>;
      deactivate: () => Promise<void> | void;
    };
    expect(typeof extMod.activate).toBe('function');
    expect(typeof extMod.deactivate).toBe('function');

    const root = createTempUnityFixture();
    const subscriptions: Array<{ dispose: () => void }> = [];
    const api = await extMod.activate(
      { extensionPath: EXT_ROOT, subscriptions },
      {
        workspaceRoot: root,
        enableWatchers: false,
        daemonTransportFactory: () => ({
          sendRequest: async <T>() => ({ locations: [], fields: [], state: 'ready', indexedAssets: 0, indexedMetas: 0, lastBuildMs: 0 }) as T,
          dispose: () => {},
        }),
      },
    );
    expect(api).toBeDefined();
    expect(api!.context.editorVersion).toBe('6000.0.23f1');
    for (const s of subscriptions) {
      s.dispose();
    }
    await extMod.deactivate();
  });

  it('spawns real built UnityBrain.Daemon.dll and handles live stdio JSON-RPC index/status, index/rebuild, and shutdown', async () => {
    const daemonDll = path.join(EXT_ROOT, 'bin', 'daemon', 'UnityBrain.Daemon.dll');
    expect(fs.existsSync(daemonDll)).toBe(true);

    const root = createTempUnityFixture();
    const scriptGuid = 'abcdef0123456789abcdef0123456789';
    const scriptPath = path.join(root, 'Assets', 'Scripts', 'Hero.cs');
    const prefabPath = path.join(root, 'Assets', 'Prefabs', 'Hero.prefab');
    fs.writeFileSync(scriptPath, 'using UnityEngine;\npublic class Hero : MonoBehaviour { public float speed; }\n', 'utf8');
    fs.writeFileSync(`${scriptPath}.meta`, `fileFormatVersion: 2\nguid: ${scriptGuid}\n`, 'utf8');
    fs.writeFileSync(`${prefabPath}.meta`, 'fileFormatVersion: 2\nguid: 00112233445566778899aabbccddeeff\n', 'utf8');
    fs.writeFileSync(
      prefabPath,
      [
        '%YAML 1.1',
        '%TAG !u! tag:unity3d.com,2011:',
        '--- !u!1 &1000',
        'GameObject:',
        '  m_Name: HeroRoot',
        '--- !u!4 &1001',
        'Transform:',
        '  m_GameObject: {fileID: 1000}',
        '--- !u!114 &1002',
        'MonoBehaviour:',
        '  m_GameObject: {fileID: 1000}',
        `  m_Script: {fileID: 11500000, guid: ${scriptGuid}, type: 3}`,
        '  speed: 9.5',
      ].join('\n'),
      'utf8',
    );

    const cacheDir = path.join(root, 'Library', 'UnityBrainCache');
    const child = spawn(
      'dotnet',
      [daemonDll, '--project-root', root, '--cache-dir', cacheDir],
      { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    expect(child.stdout).toBeDefined();
    expect(child.stdin).toBeDefined();

    const transport = UnityDaemonClient.createConnectionTransport(child.stdout!, child.stdin!);
    const exitPromise = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
    });

    try {
      const rebuildRes = await transport.sendRequest<{ indexedAssets: number; elapsedMs: number }>(
        'index/rebuild',
        { force: true },
      );
      expect(rebuildRes.indexedAssets).toBe(1);

      const statusRes = await transport.sendRequest<{ state: string; indexedAssets: number }>(
        'index/status',
        {},
      );
      expect(statusRes.state).toBe('ready');
      expect(statusRes.indexedAssets).toBe(1);

      const usages = await transport.sendRequest<{ locations: Array<{ assetPath: string }> }>(
        'usage/findByScriptGuid',
        { scriptGuid },
      );
      expect(usages.locations.length).toBe(1);
      expect(usages.locations[0].assetPath).toContain('Hero.prefab');

      const shutdownRes = await transport.sendRequest<{ ok: boolean }>('shutdown', {});
      expect(shutdownRes.ok).toBe(true);
      child.stdin!.end();
      const exitCode = await exitPromise;
      expect(exitCode).toBe(0);
    } finally {
      transport.dispose();
      if (!child.killed && child.exitCode === null) {
        child.kill();
      }
    }
  });
});
