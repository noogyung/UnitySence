import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import type { UnityProjectContext } from '../contracts/index.ts';

export interface UnityProjectContextOptions {
  workspaceRoot?: string;
  unityEditorPath?: string | null;
  enableWatchers?: boolean;
}

export class UnityProjectContextManager implements vscode.Disposable {
  private _context: UnityProjectContext | null = null;
  private readonly _onDidChangeContext = new vscode.EventEmitter<UnityProjectContext | null>();
  public readonly onDidChangeContext = this._onDidChangeContext.event;
  private readonly _disposables: vscode.Disposable[] = [];
  private readonly _options: UnityProjectContextOptions;
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: UnityProjectContextOptions = {}) {
    this._options = options;
  }

  public get context(): UnityProjectContext | null {
    return this._context;
  }

  public async initialize(): Promise<UnityProjectContext | null> {
    const projectRoot = this.detectUnityProjectRoot();
    if (!projectRoot) {
      this._context = null;
      return null;
    }

    const built = this.buildContext(projectRoot);
    this._context = built;
    this._onDidChangeContext.fire(built);

    if (this._options.enableWatchers !== false) {
      this.setupWatchers(projectRoot);
    }

    return built;
  }

  public async refresh(): Promise<UnityProjectContext | null> {
    const projectRoot = this._context?.projectRoot ?? this.detectUnityProjectRoot();
    if (!projectRoot) {
      this._context = null;
      this._onDidChangeContext.fire(null);
      return null;
    }

    const updated = this.buildContext(projectRoot);
    this._context = updated;
    this._onDidChangeContext.fire(updated);
    return updated;
  }

  private detectUnityProjectRoot(): string | null {
    const candidates: string[] = [];
    if (this._options.workspaceRoot) {
      candidates.push(this._options.workspaceRoot);
    }
    if (vscode.workspace.workspaceFolders) {
      for (const folder of vscode.workspace.workspaceFolders) {
        candidates.push(folder.uri.fsPath);
      }
    }

    for (const root of candidates) {
      if (this.isUnityProjectDir(root)) {
        return path.resolve(root);
      }
      try {
        const entries = fs.readdirSync(root, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) {
            continue;
          }
          const sub = path.join(root, entry.name);
          if (this.isUnityProjectDir(sub)) {
            return path.resolve(sub);
          }
        }
      } catch {
        // Ignore unreadable root
      }
    }

    return null;
  }

  private isUnityProjectDir(dirPath: string): boolean {
    try {
      const assetsDir = path.join(dirPath, 'Assets');
      const projectVersion = path.join(dirPath, 'ProjectSettings', 'ProjectVersion.txt');
      return (
        fs.existsSync(assetsDir) &&
        fs.statSync(assetsDir).isDirectory() &&
        fs.existsSync(projectVersion) &&
        fs.statSync(projectVersion).isFile()
      );
    } catch {
      return false;
    }
  }

  private buildContext(projectRoot: string): UnityProjectContext {
    const versionFile = path.join(projectRoot, 'ProjectSettings', 'ProjectVersion.txt');
    const editorVersion = this.parseEditorVersion(versionFile);
    const editorInstallPath = this.resolveEditorInstallPath(editorVersion, projectRoot);

    let cgIncludesPath: string | null = null;
    let builtInPackagesPath: string | null = null;

    if (editorInstallPath) {
      const dataCandidates = [
        path.join(editorInstallPath, 'Data'),
        path.join(editorInstallPath, 'Editor', 'Data'),
        editorInstallPath,
      ];
      for (const dataRoot of dataCandidates) {
        const cg = path.join(dataRoot, 'CGIncludes');
        if (!cgIncludesPath && fs.existsSync(cg) && fs.statSync(cg).isDirectory()) {
          cgIncludesPath = cg;
        }
        const builtin = path.join(dataRoot, 'Resources', 'PackageManager', 'BuiltInPackages');
        if (!builtInPackagesPath && fs.existsSync(builtin) && fs.statSync(builtin).isDirectory()) {
          builtInPackagesPath = builtin;
        }
      }
      if (!cgIncludesPath) {
        const directCg = path.join(editorInstallPath, 'CGIncludes');
        if (fs.existsSync(directCg) && fs.statSync(directCg).isDirectory()) {
          cgIncludesPath = directCg;
        }
      }
      if (!builtInPackagesPath) {
        const directBuiltin = path.join(editorInstallPath, 'BuiltInPackages');
        if (fs.existsSync(directBuiltin) && fs.statSync(directBuiltin).isDirectory()) {
          builtInPackagesPath = directBuiltin;
        }
      }
    }

    const manifestPath = path.join(projectRoot, 'Packages', 'manifest.json');
    const lockCandidate = path.join(projectRoot, 'Packages', 'packages-lock.json');
    const packagesLockPath = fs.existsSync(lockCandidate) ? lockCandidate : null;
    const cacheDir = path.join(projectRoot, 'Library', 'UnityBrainCache');

    return {
      projectRoot,
      editorVersion,
      editorInstallPath,
      cgIncludesPath,
      builtInPackagesPath,
      manifestPath,
      packagesLockPath,
      cacheDir,
    };
  }

  private parseEditorVersion(versionFilePath: string): string {
    try {
      const content = fs.readFileSync(versionFilePath, 'utf8');
      const match = /m_EditorVersion:\s*([^\r\n]+)/.exec(content);
      return match ? match[1].trim() : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private resolveEditorInstallPath(editorVersion: string, projectRoot: string): string | null {
    const configPath = vscode.workspace
      .getConfiguration('unityBrain')
      .get<string>('unityEditorPath');
    const explicit = this._options.unityEditorPath ?? (configPath && configPath.trim() ? configPath.trim() : null);

    if (explicit) {
      const resolvedExplicit = path.isAbsolute(explicit) ? explicit : path.resolve(projectRoot, explicit);
      if (fs.existsSync(resolvedExplicit)) {
        return resolvedExplicit;
      }
    }

    if (!editorVersion || editorVersion === 'unknown') {
      return null;
    }

    const candidates: string[] = [];
    const secondaryRoots = this.readUnityHubSecondaryPaths();
    for (const root of secondaryRoots) {
      candidates.push(path.join(root, editorVersion, 'Editor'));
      candidates.push(path.join(root, editorVersion, 'Unity.app', 'Contents'));
      candidates.push(path.join(root, editorVersion));
    }

    if (process.platform === 'win32') {
      candidates.push(`C:/Program Files/Unity/Hub/Editor/${editorVersion}/Editor`);
      candidates.push(`C:/Program Files/Unity/Hub/Editor/${editorVersion}`);
    } else if (process.platform === 'darwin') {
      candidates.push(`/Applications/Unity/Hub/Editor/${editorVersion}/Unity.app/Contents`);
    } else {
      try {
        candidates.push(path.join(os.homedir(), 'Unity', 'Hub', 'Editor', editorVersion, 'Editor'));
      } catch {
        // Ignore homedir error
      }
    }

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
          return candidate;
        }
      } catch {
        // Skip inaccessible install candidates
      }
    }

    return null;
  }

  private readUnityHubSecondaryPaths(): string[] {
    const results: string[] = [];
    const hubConfigCandidates: string[] = [];
    try {
      if (process.platform === 'win32' && process.env.APPDATA) {
        hubConfigCandidates.push(path.join(process.env.APPDATA, 'UnityHub', 'secondaryInstallPath.json'));
      } else if (process.platform === 'darwin') {
        hubConfigCandidates.push(
          path.join(os.homedir(), 'Library', 'Application Support', 'UnityHub', 'secondaryInstallPath.json'),
        );
      } else {
        hubConfigCandidates.push(path.join(os.homedir(), '.config', 'UnityHub', 'secondaryInstallPath.json'));
      }
    } catch {
      return results;
    }

    for (const cfg of hubConfigCandidates) {
      try {
        if (!fs.existsSync(cfg)) continue;
        const parsed = JSON.parse(fs.readFileSync(cfg, 'utf8')) as unknown;
        if (typeof parsed === 'string' && parsed.trim()) {
          results.push(parsed.trim());
        } else if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (typeof item === 'string' && item.trim()) {
              results.push(item.trim());
            }
          }
        }
      } catch {
        // Ignore malformed UnityHub config
      }
    }
    return results;
  }

  private setupWatchers(projectRoot: string): void {
    this.disposeWatchersOnly();

    const patterns = [
      'Packages/manifest.json',
      'Packages/packages-lock.json',
      'ProjectSettings/ProjectVersion.txt',
    ];

    for (const pat of patterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(projectRoot, pat));
      const scheduleRefresh = () => {
        if (this._debounceTimer) clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => {
          void this.refresh();
        }, 100);
      };
      this._disposables.push(
        watcher,
        watcher.onDidChange(scheduleRefresh),
        watcher.onDidCreate(scheduleRefresh),
        watcher.onDidDelete(scheduleRefresh),
      );
    }

    this._disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('unityBrain.unityEditorPath')) {
          void this.refresh();
        }
      }),
    );
  }

  private disposeWatchersOnly(): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = undefined;
    }
    while (this._disposables.length > 0) {
      this._disposables.pop()?.dispose();
    }
  }

  public dispose(): void {
    this.disposeWatchersOnly();
    this._onDidChangeContext.dispose();
  }
}
