import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { MetaFileSyncManager } from '../../src/meta/metaFileSyncManager.ts';

const tempDirs: string[] = [];

function createTempUnityRoot(): string {
  const dir = path.join(
    process.cwd(),
    'test-output',
    `ext-meta-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  fs.mkdirSync(path.join(dir, 'Assets', 'Scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'Library'), { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vscode.__mock.reset();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('MetaFileSyncManager', () => {
  it('moves .meta preserving GUID on file and folder renames via waitUntil', async () => {
    const root = createTempUnityRoot();
    const mgr = new MetaFileSyncManager({ projectRoot: root });

    try {
      const oldCs = path.join(root, 'Assets', 'Scripts', 'OldScript.cs');
      const newCs = path.join(root, 'Assets', 'Scripts', 'Gameplay', 'NewScript.cs');
      const oldMetaContent = 'fileFormatVersion: 2\nguid: 00112233445566778899aabbccddeeff\nMonoImporter:\n';
      fs.writeFileSync(oldCs, 'public class OldScript {}', 'utf8');
      fs.writeFileSync(`${oldCs}.meta`, oldMetaContent, 'utf8');

      const pendingEdits: Promise<vscode.WorkspaceEdit>[] = [];
      vscode.__mock.emitters.onWillRenameFiles.fire({
        files: [{ oldUri: vscode.Uri.file(oldCs), newUri: vscode.Uri.file(newCs) }],
        waitUntil(promise: Promise<vscode.WorkspaceEdit>) {
          pendingEdits.push(promise);
        },
      });

      expect(pendingEdits.length).toBe(1);
      const edit = await pendingEdits[0];
      await vscode.workspace.applyEdit(edit);

      expect(fs.existsSync(`${oldCs}.meta`)).toBe(false);
      expect(fs.existsSync(`${newCs}.meta`)).toBe(true);
      expect(fs.readFileSync(`${newCs}.meta`, 'utf8')).toBe(oldMetaContent);

      // Folder rename test
      const oldFolder = path.join(root, 'Assets', 'OldFolder');
      const newFolder = path.join(root, 'Assets', 'RenamedFolder');
      fs.mkdirSync(oldFolder, { recursive: true });
      const folderMetaContent = 'fileFormatVersion: 2\nguid: ffeeddccbbaa99887766554433221100\nfolderAsset: yes\n';
      fs.writeFileSync(`${oldFolder}.meta`, folderMetaContent, 'utf8');

      const folderEdits: Promise<vscode.WorkspaceEdit>[] = [];
      vscode.__mock.emitters.onWillRenameFiles.fire({
        files: [{ oldUri: vscode.Uri.file(oldFolder), newUri: vscode.Uri.file(newFolder) }],
        waitUntil(promise: Promise<vscode.WorkspaceEdit>) {
          folderEdits.push(promise);
        },
      });

      expect(folderEdits.length).toBe(1);
      await vscode.workspace.applyEdit(await folderEdits[0]);
      expect(fs.existsSync(`${oldFolder}.meta`)).toBe(false);
      expect(fs.readFileSync(`${newFolder}.meta`, 'utf8')).toBe(folderMetaContent);
    } finally {
      mgr.dispose();
    }
  });

  it('deletes peer .meta file when an asset or folder is deleted', async () => {
    const root = createTempUnityRoot();
    const mgr = new MetaFileSyncManager({ projectRoot: root });

    try {
      const target = path.join(root, 'Assets', 'Scripts', 'ToDelete.cs');
      fs.writeFileSync(target, '// bye', 'utf8');
      fs.writeFileSync(`${target}.meta`, 'guid: 11111111111111111111111111111111\n', 'utf8');

      const pending: Promise<vscode.WorkspaceEdit>[] = [];
      vscode.__mock.emitters.onWillDeleteFiles.fire({
        files: [vscode.Uri.file(target)],
        waitUntil(promise: Promise<vscode.WorkspaceEdit>) {
          pending.push(promise);
        },
      });

      expect(pending.length).toBe(1);
      await vscode.workspace.applyEdit(await pending[0]);
      expect(fs.existsSync(`${target}.meta`)).toBe(false);
    } finally {
      mgr.dispose();
    }
  });

  it('generates valid 32-hex GUID .meta on create without overwriting existing .meta or touching non-Assets dirs', async () => {
    const root = createTempUnityRoot();
    const mgr = new MetaFileSyncManager({ projectRoot: root });

    try {
      const newCs = path.join(root, 'Assets', 'Scripts', 'Hero.cs');
      const newShader = path.join(root, 'Assets', 'Scripts', 'Glow.shader');
      const newSubdir = path.join(root, 'Assets', 'Prefabs');
      const existingAsset = path.join(root, 'Assets', 'Scripts', 'Preset.cs');
      const libraryFile = path.join(root, 'Library', 'cache.dat');
      const hiddenFile = path.join(root, 'Assets', 'Scripts', '.DS_Store');

      fs.writeFileSync(newCs, 'public class Hero {}', 'utf8');
      fs.writeFileSync(newShader, 'Shader "Custom/Glow" {}', 'utf8');
      fs.mkdirSync(newSubdir, { recursive: true });
      fs.writeFileSync(existingAsset, 'public class Preset {}', 'utf8');
      fs.writeFileSync(`${existingAsset}.meta`, 'guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', 'utf8');
      fs.writeFileSync(libraryFile, 'bin', 'utf8');
      fs.writeFileSync(hiddenFile, 'hidden', 'utf8');

      const created = await mgr.handleDidCreateFiles([
        vscode.Uri.file(newCs),
        vscode.Uri.file(newShader),
        vscode.Uri.file(newSubdir),
        vscode.Uri.file(existingAsset),
        vscode.Uri.file(`${newCs}.meta`),
        vscode.Uri.file(libraryFile),
        vscode.Uri.file(hiddenFile),
      ]);

      expect(created.length).toBe(3);

      const csMeta = fs.readFileSync(`${newCs}.meta`, 'utf8');
      expect(csMeta).toMatch(/guid:\s+[0-9a-f]{32}/);
      expect(csMeta).toContain('MonoImporter:');

      const shaderMeta = fs.readFileSync(`${newShader}.meta`, 'utf8');
      expect(shaderMeta).toMatch(/guid:\s+[0-9a-f]{32}/);
      expect(shaderMeta).toContain('ShaderImporter:');

      const dirMeta = fs.readFileSync(`${newSubdir}.meta`, 'utf8');
      expect(dirMeta).toMatch(/guid:\s+[0-9a-f]{32}/);
      expect(dirMeta).toContain('folderAsset: yes');

      expect(fs.readFileSync(`${existingAsset}.meta`, 'utf8')).toBe(
        'guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n',
      );
      expect(fs.existsSync(`${libraryFile}.meta`)).toBe(false);
      expect(fs.existsSync(`${hiddenFile}.meta`)).toBe(false);
    } finally {
      mgr.dispose();
    }
  });
});
