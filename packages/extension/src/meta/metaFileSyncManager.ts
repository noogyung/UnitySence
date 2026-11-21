import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { normalizePathKey } from '../../../shader-lsp/src/vfs/virtualPathResolver.ts';
import { isUnityEditorRunning } from '../editor/unityEditorIntegration.ts';

export interface MetaFileSyncOptions {
  projectRoot: string;
}

export class MetaFileSyncManager implements vscode.Disposable {
  private readonly projectRoot: string;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pendingCreateTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(options: MetaFileSyncOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.disposables.push(
      vscode.workspace.onWillRenameFiles((e) => this.handleWillRenameFiles(e)),
      vscode.workspace.onWillDeleteFiles((e) => this.handleWillDeleteFiles(e)),
      vscode.workspace.onDidCreateFiles((e) => {
        // Yield briefly (600ms when Unity Editor is running, 150ms otherwise) so Unity's importer can emit `.meta` first
        const delayMs = isUnityEditorRunning(this.projectRoot) ? 600 : 150;
        const timer = setTimeout(() => {
          this.pendingCreateTimers.delete(timer);
          void this.handleDidCreateFiles(e.files);
        }, delayMs);
        this.pendingCreateTimers.add(timer);
      }),
    );
    const workspaceWithRename = vscode.workspace as unknown as {
      onDidRenameFiles?: (
        listener: (e: { files: ReadonlyArray<{ oldUri: vscode.Uri; newUri: vscode.Uri }> }) => unknown,
      ) => vscode.Disposable;
    };
    if (typeof workspaceWithRename.onDidRenameFiles === 'function') {
      this.disposables.push(
        workspaceWithRename.onDidRenameFiles((e) => {
          void this.handleDidRenameFiles(e.files);
        }),
      );
    }
  }

  public isEnabled(): boolean {
    return vscode.workspace.getConfiguration('unityBrain').get<boolean>('metaSync.enabled', true);
  }

  public isEligibleUnityPath(targetPath: string): boolean {
    const resolved = path.resolve(targetPath);
    const rel = path.relative(this.projectRoot, resolved);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      return false;
    }

    const segments = rel.split(/[\\/]/).filter(Boolean);
    if (segments.length < 2) {
      // Root folders like "Assets" or "Packages" themselves don't carry a peer .meta file.
      return false;
    }

    const top = segments[0].toLowerCase();
    if (top !== 'assets' && top !== 'packages') {
      return false;
    }
    if (top === 'packages' && segments.length < 3) {
      // Packages/manifest.json and Packages/packages-lock.json do not have .meta files
      return false;
    }

    for (const seg of segments) {
      if (seg.startsWith('.') || seg.endsWith('~') || seg.endsWith('.tmp')) {
        return false;
      }
    }

    const leaf = segments[segments.length - 1].toLowerCase();
    if (leaf.endsWith('.meta')) {
      return false;
    }

    return true;
  }

  public handleWillRenameFiles(event: vscode.FileWillRenameEvent): void {
    if (!this.isEnabled()) {
      return;
    }

    const movedOldKeys = new Set(event.files.map((e) => normalizePathKey(e.oldUri.fsPath)));
    const edit = new vscode.WorkspaceEdit();
    for (const entry of event.files) {
      const oldEligible = this.isEligibleUnityPath(entry.oldUri.fsPath);
      const newEligible = this.isEligibleUnityPath(entry.newUri.fsPath);
      if (!oldEligible && !newEligible) {
        // Quadrant 4: Outside -> Outside
        continue;
      }

      const oldMetaPath = `${entry.oldUri.fsPath}.meta`;
      const newMetaPath = `${entry.newUri.fsPath}.meta`;
      if (movedOldKeys.has(normalizePathKey(oldMetaPath))) {
        // User explicitly selected the .meta alongside the asset; skip duplicate op
        continue;
      }
      if (!fs.existsSync(oldMetaPath)) {
        continue;
      }

      if (oldEligible && newEligible) {
        // Quadrant 1: Assets/Packages -> Assets/Packages
        edit.renameFile(vscode.Uri.file(oldMetaPath), vscode.Uri.file(newMetaPath), {
          overwrite: true,
        });
      } else if (oldEligible && !newEligible) {
        // Quadrant 2: Assets/Packages -> Outside (delete orphan .meta)
        edit.deleteFile(vscode.Uri.file(oldMetaPath), {
          ignoreIfNotExists: true,
          useTrash: true,
        });
      } else {
        // Quadrant 3: Outside -> Assets/Packages with pre-existing peer .meta
        edit.renameFile(vscode.Uri.file(oldMetaPath), vscode.Uri.file(newMetaPath), {
          overwrite: true,
        });
      }
    }

    if (edit.size > 0) {
      event.waitUntil(Promise.resolve(edit));
    }
  }

  public async handleDidRenameFiles(
    files: ReadonlyArray<{ oldUri: vscode.Uri; newUri: vscode.Uri }>,
  ): Promise<string[]> {
    if (!this.isEnabled()) {
      return [];
    }

    const created: string[] = [];
    for (const entry of files) {
      const oldEligible = this.isEligibleUnityPath(entry.oldUri.fsPath);
      const newEligible = this.isEligibleUnityPath(entry.newUri.fsPath);
      if (!newEligible) {
        continue;
      }

      // Ensure parent directory .meta files exist for newly entered directories
      created.push(...(await this.ensureParentDirectoryMetas(entry.newUri.fsPath)));

      if (!oldEligible) {
        // Quadrant 3: Outside -> Assets/Packages (generate missing .meta for asset/folder & children)
        created.push(...(await this.createMissingMetaRecursively(entry.newUri.fsPath)));
      }
    }
    return created;
  }

  private async ensureParentDirectoryMetas(assetPath: string): Promise<string[]> {
    const ancestors: string[] = [];
    let current = path.dirname(path.resolve(assetPath));
    while (this.isEligibleUnityPath(current)) {
      ancestors.push(current);
      const next = path.dirname(current);
      if (next === current) break;
      current = next;
    }
    ancestors.reverse();
    const uris = ancestors.map((dir) => vscode.Uri.file(dir));
    return this.handleDidCreateFiles(uris);
  }

  private async createMissingMetaRecursively(entryPath: string): Promise<string[]> {
    const targets: vscode.Uri[] = [vscode.Uri.file(entryPath)];
    try {
      const stat = fs.statSync(entryPath);
      if (stat.isDirectory()) {
        const stack = [entryPath];
        while (stack.length > 0) {
          const dir = stack.pop()!;
          let entries: fs.Dirent[];
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const child of entries) {
            if (child.name.startsWith('.') || child.name.endsWith('.meta')) continue;
            const full = path.join(dir, child.name);
            if (this.isEligibleUnityPath(full)) {
              targets.push(vscode.Uri.file(full));
              if (child.isDirectory()) stack.push(full);
            }
          }
        }
      }
    } catch {
      // Ignore missing entry
    }
    return this.handleDidCreateFiles(targets);
  }

  public handleWillDeleteFiles(event: vscode.FileWillDeleteEvent): void {
    if (!this.isEnabled()) {
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    for (const uri of event.files) {
      if (!this.isEligibleUnityPath(uri.fsPath)) {
        continue;
      }

      const metaPath = `${uri.fsPath}.meta`;
      if (fs.existsSync(metaPath)) {
        edit.deleteFile(vscode.Uri.file(metaPath), {
          ignoreIfNotExists: true,
          useTrash: true,
        });
      }
    }

    if (edit.size > 0) {
      event.waitUntil(Promise.resolve(edit));
    }
  }

  public async handleDidCreateFiles(files: readonly vscode.Uri[]): Promise<string[]> {
    if (!this.isEnabled()) {
      return [];
    }

    const createdMetaPaths: string[] = [];
    for (const uri of files) {
      if (!this.isEligibleUnityPath(uri.fsPath)) {
        continue;
      }

      const metaPath = `${uri.fsPath}.meta`;
      if (fs.existsSync(metaPath)) {
        continue;
      }

      let isDirectory = false;
      try {
        isDirectory = fs.statSync(uri.fsPath).isDirectory();
      } catch {
        continue;
      }

      const guid = MetaFileSyncManager.generateUnityGuid();
      const content = MetaFileSyncManager.buildMetaContent(uri.fsPath, guid, isDirectory);

      try {
        await fs.promises.writeFile(metaPath, content, { encoding: 'utf8', flag: 'wx' });
        createdMetaPaths.push(metaPath);
      } catch (err) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code !== 'EEXIST') {
          throw err;
        }
      }
    }

    return createdMetaPaths;
  }

  public async cleanOrphanMetaFiles(): Promise<string[]> {
    const removed: string[] = [];
    const scanDirs = [path.join(this.projectRoot, 'Assets'), path.join(this.projectRoot, 'Packages')];

    for (const rootDir of scanDirs) {
      if (!fs.existsSync(rootDir)) continue;
      const stack = [rootDir];
      while (stack.length > 0) {
        const dir = stack.pop();
        if (!dir) continue;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            stack.push(full);
          } else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.meta')) {
            if (entry.isSymbolicLink()) {
              try {
                if (fs.statSync(full).isDirectory()) continue;
              } catch {
                // Broken symlink to .meta still counts as file-like orphan candidate
              }
            }
            const peerPath = full.slice(0, -'.meta'.length);
            let peerExists = false;
            try {
              fs.lstatSync(peerPath);
              peerExists = true;
            } catch {
              peerExists = false;
            }
            if (this.isEligibleUnityPath(peerPath) && !peerExists) {
              try {
                const wsFs = (
                  vscode.workspace as unknown as {
                    fs?: { delete?: (uri: vscode.Uri, opts?: { useTrash?: boolean }) => Promise<void> };
                  }
                ).fs;
                if (typeof wsFs?.delete === 'function') {
                  await wsFs.delete(vscode.Uri.file(full), { useTrash: true });
                } else {
                  await fs.promises.unlink(full);
                }
                removed.push(full);
              } catch {
                try {
                  await fs.promises.unlink(full);
                  removed.push(full);
                } catch {
                  // Ignore unlink errors
                }
              }
            }
          }
        }
      }
    }

    return removed;
  }

  public static generateUnityGuid(): string {
    return crypto.randomUUID().replace(/-/g, '').toLowerCase();
  }

  public static buildMetaContent(assetPath: string, guid: string, isDirectory: boolean): string {
    if (isDirectory) {
      return [
        'fileFormatVersion: 2',
        `guid: ${guid}`,
        'folderAsset: yes',
        'DefaultImporter:',
        '  externalObjects: {}',
        '  userData: ',
        '  assetBundleName: ',
        '  assetBundleVariant: ',
        '',
      ].join('\n');
    }

    const ext = path.extname(assetPath).toLowerCase();
    if (ext === '.cs') {
      return [
        'fileFormatVersion: 2',
        `guid: ${guid}`,
        'MonoImporter:',
        '  externalObjects: {}',
        '  serializedVersion: 2',
        '  defaultReferences: []',
        '  executionOrder: 0',
        '  icon: {instanceID: 0}',
        '  userData: ',
        '  assetBundleName: ',
        '  assetBundleVariant: ',
        '',
      ].join('\n');
    }

    if (ext === '.shader' || ext === '.compute') {
      return [
        'fileFormatVersion: 2',
        `guid: ${guid}`,
        'ShaderImporter:',
        '  externalObjects: {}',
        '  defaultTextures: []',
        '  nonModifiableTextures: []',
        '  userData: ',
        '  assetBundleName: ',
        '  assetBundleVariant: ',
        '',
      ].join('\n');
    }

    if (ext === '.asmdef') {
      return [
        'fileFormatVersion: 2',
        `guid: ${guid}`,
        'AssemblyDefinitionImporter:',
        '  externalObjects: {}',
        '  userData: ',
        '  assetBundleName: ',
        '  assetBundleVariant: ',
        '',
      ].join('\n');
    }

    if (ext === '.asmref') {
      return [
        'fileFormatVersion: 2',
        `guid: ${guid}`,
        'AssemblyDefinitionReferenceImporter:',
        '  externalObjects: {}',
        '  userData: ',
        '  assetBundleName: ',
        '  assetBundleVariant: ',
        '',
      ].join('\n');
    }

    if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.tga' || ext === '.psd') {
      return [
        'fileFormatVersion: 2',
        `guid: ${guid}`,
        'TextureImporter:',
        '  fileIDToRecycleName: {}',
        '  externalObjects: {}',
        '  serializedVersion: 13',
        '  userData: ',
        '  assetBundleName: ',
        '  assetBundleVariant: ',
        '',
      ].join('\n');
    }

    if (ext === '.wav' || ext === '.mp3' || ext === '.ogg') {
      return [
        'fileFormatVersion: 2',
        `guid: ${guid}`,
        'AudioImporter:',
        '  externalObjects: {}',
        '  serializedVersion: 4',
        '  userData: ',
        '  assetBundleName: ',
        '  assetBundleVariant: ',
        '',
      ].join('\n');
    }

    return [
      'fileFormatVersion: 2',
      `guid: ${guid}`,
      'DefaultImporter:',
      '  externalObjects: {}',
      '  userData: ',
      '  assetBundleName: ',
      '  assetBundleVariant: ',
      '',
    ].join('\n');
  }

  public dispose(): void {
    for (const timer of this.pendingCreateTimers) {
      clearTimeout(timer);
    }
    this.pendingCreateTimers.clear();
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }
}
