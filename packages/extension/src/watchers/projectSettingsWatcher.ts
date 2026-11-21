import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type {
  AnimatorControllerIndex,
  BuildSceneEntry,
  InputAxisEntry,
  ProjectSettingsCache,
  UnityProjectContext,
} from '../contracts/index.ts';

const BUILTIN_UNITY_TAGS = [
  'Untagged',
  'Respawn',
  'Finish',
  'EditorOnly',
  'MainCamera',
  'Player',
  'GameController',
];

function stripQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseTagManagerYaml(content: string): {
  tags: string[];
  layers: Array<{ index: number; name: string }>;
  sortingLayers: Array<{ id: number; name: string }>;
} {
  const lines = content.split(/\r?\n/);
  const tags = new Set<string>(BUILTIN_UNITY_TAGS);
  const layers: Array<{ index: number; name: string }> = [];
  const sortingLayers: Array<{ id: number; name: string }> = [];

  let section: 'none' | 'tags' | 'layers' | 'sortingLayers' = 'none';
  let layerIdx = 0;
  let currentSortingName: string | null = null;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('%') || trimmed.startsWith('---')) continue;

    const indent = rawLine.length - rawLine.trimStart().length;
    if (indent <= 2) {
      if (trimmed === 'tags:' || trimmed === 'tags: []') {
        section = trimmed.endsWith('[]') ? 'none' : 'tags';
        continue;
      }
      if (trimmed === 'layers:') {
        section = 'layers';
        layerIdx = 0;
        continue;
      }
      if (trimmed === 'm_SortingLayers:') {
        section = 'sortingLayers';
        currentSortingName = null;
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*:/.test(trimmed)) {
        section = 'none';
        continue;
      }
    }

    if (section === 'tags') {
      const m = /^-\s*(.+)$/.exec(trimmed);
      if (m) {
        const tag = stripQuotes(m[1]);
        if (tag) tags.add(tag);
      }
    } else if (section === 'layers') {
      if (trimmed === '-' || trimmed === '- ""' || trimmed === "- ''") {
        layerIdx++;
        continue;
      }
      const m = /^-\s*(.*)$/.exec(trimmed);
      if (m) {
        const layerName = stripQuotes(m[1]);
        if (layerName) {
          layers.push({ index: layerIdx, name: layerName });
        }
        layerIdx++;
      }
    } else if (section === 'sortingLayers') {
      const nameMatch = /^-?\s*name:\s*(.+)$/.exec(trimmed);
      if (nameMatch) {
        currentSortingName = stripQuotes(nameMatch[1]);
        continue;
      }
      const idMatch = /^uniqueID:\s*(-?\d+)/.exec(trimmed);
      if (idMatch && currentSortingName !== null) {
        sortingLayers.push({
          id: Number.parseInt(idMatch[1], 10),
          name: currentSortingName,
        });
        currentSortingName = null;
      }
    }
  }

  return {
    tags: Array.from(tags),
    layers,
    sortingLayers,
  };
}

export function parseInputManagerYaml(content: string): InputAxisEntry[] {
  const lines = content.split(/\r?\n/);
  const axes: InputAxisEntry[] = [];
  const seenNames = new Set<string>();

  let currentName: string | null = null;
  let currentDesc: string | undefined;
  let currentType = 0;

  const flush = () => {
    if (currentName && !seenNames.has(currentName)) {
      seenNames.add(currentName);
      axes.push({
        name: currentName,
        descriptiveName: currentDesc,
        type: currentType,
      });
    }
    currentName = null;
    currentDesc = undefined;
    currentType = 0;
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('- serializedVersion:')) {
      flush();
      continue;
    }
    const nameMatch = /^m_Name:\s*(.+)$/.exec(trimmed);
    if (nameMatch) {
      currentName = stripQuotes(nameMatch[1]);
      continue;
    }
    const descMatch = /^descriptiveName:\s*(.+)$/.exec(trimmed);
    if (descMatch) {
      const desc = stripQuotes(descMatch[1]);
      if (desc) currentDesc = desc;
      continue;
    }
    const typeMatch = /^type:\s*(\d+)/.exec(trimmed);
    if (typeMatch) {
      currentType = Number.parseInt(typeMatch[1], 10);
    }
  }
  flush();
  return axes;
}

export function parseEditorBuildSettingsYaml(content: string): BuildSceneEntry[] {
  const lines = content.split(/\r?\n/);
  const scenes: BuildSceneEntry[] = [];
  let inScenes = false;
  let current: { enabled?: boolean; path?: string; guid?: string } | null = null;
  let nextBuildIndex = 0;

  const flush = () => {
    if (!current || !current.path) {
      current = null;
      return;
    }
    const enabled = Boolean(current.enabled);
    if (enabled) {
      const sceneName = path.basename(current.path, path.extname(current.path));
      scenes.push({
        name: sceneName,
        path: current.path.replace(/\\/g, '/'),
        guid: current.guid ?? '',
        buildIndex: nextBuildIndex++,
        enabled: true,
      });
    }
    current = null;
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed === 'm_Scenes:') {
      inScenes = true;
      continue;
    }
    if (!inScenes) continue;

    if (trimmed.startsWith('- enabled:')) {
      flush();
      const val = trimmed.slice('- enabled:'.length).trim();
      current = { enabled: val === '1' || val === 'true' };
      continue;
    }
    if (!current) continue;
    if (trimmed.startsWith('path:')) {
      current.path = stripQuotes(trimmed.slice('path:'.length));
    } else if (trimmed.startsWith('guid:')) {
      current.guid = stripQuotes(trimmed.slice('guid:'.length));
    }
  }
  flush();
  return scenes;
}

export function parseAnimatorControllerYaml(
  content: string,
  assetPath: string,
  guid: string,
): AnimatorControllerIndex {
  const docs = content.split(/^--- /m);
  const parameters: AnimatorControllerIndex['parameters'] = [];
  const states: string[] = [];

  const typeMap: Record<number, 'Float' | 'Int' | 'Bool' | 'Trigger'> = {
    1: 'Float',
    3: 'Int',
    4: 'Bool',
    9: 'Trigger',
  };

  for (const doc of docs) {
    if (doc.includes('AnimatorState:')) {
      const stateNameMatch = /^\s*m_Name:\s*(.+)$/m.exec(doc);
      if (stateNameMatch) {
        const sName = stripQuotes(stateNameMatch[1]);
        if (sName && !states.includes(sName)) {
          states.push(sName);
        }
      }
    } else if (doc.includes('AnimatorController:')) {
      const paramSectionIdx = doc.indexOf('m_AnimatorParameters:');
      if (paramSectionIdx !== -1) {
        const paramSlice = doc.slice(paramSectionIdx);
        const paramLines = paramSlice.split(/\r?\n/);
        const firstLine = (paramLines[0] ?? '').trim();
        if (!firstLine.endsWith('[]')) {
          const sectionIndent = /^(\s*)/.exec(paramLines[0] ?? '')?.[1].length ?? 2;
          let pendingName: string | null = null;
          for (let i = 1; i < paramLines.length; i++) {
            const pLine = paramLines[i];
            const t = pLine.trim();
            if (!t) continue;
            const lineIndent = /^(\s*)/.exec(pLine)?.[1].length ?? 0;
            if (!t.startsWith('-') && /^[A-Za-z_]/.test(t) && lineIndent <= sectionIndent) {
              break;
            }
            const nameM = /^-?\s*m_Name:\s*(.+)$/.exec(t);
            if (nameM) {
              pendingName = stripQuotes(nameM[1]);
              continue;
            }
            const typeM = /^m_Type:\s*(\d+)/.exec(t);
            if (typeM && pendingName) {
              const pType = typeMap[Number.parseInt(typeM[1], 10)] ?? 'Float';
              parameters.push({ name: pendingName, type: pType });
              pendingName = null;
            }
          }
        }
      }
    }
  }

  return {
    assetPath: assetPath.replace(/\\/g, '/'),
    guid,
    parameters,
    states,
  };
}

function readMetaGuid(assetPath: string): string {
  const metaPath = `${assetPath}.meta`;
  if (!fs.existsSync(metaPath)) return '';
  try {
    const txt = fs.readFileSync(metaPath, 'utf8');
    const m = /^guid:\s*([0-9a-fA-F]{32})/m.exec(txt);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

export interface InputActionEntry {
  name: string;
  actionMap: string;
  assetName: string;
}

export function parseInputActionsJson(content: string, assetPath: string): InputActionEntry[] {
  const assetName = path.basename(assetPath, path.extname(assetPath));
  try {
    const parsed = JSON.parse(content) as {
      maps?: Array<{ name?: string; actions?: Array<{ name?: string }> }>;
    };
    const entries: InputActionEntry[] = [];
    for (const map of parsed.maps ?? []) {
      const mapName = map.name ?? 'Default';
      for (const action of map.actions ?? []) {
        if (action.name) {
          entries.push({ name: action.name, actionMap: mapName, assetName });
        }
      }
    }
    return entries;
  } catch {
    return [];
  }
}

interface ScannedAssets {
  controllerFiles: string[];
  inputActionFiles: string[];
  resourcePaths: string[];
}

function scanAssetsForSettings(
  dir: string,
  out: ScannedAssets = { controllerFiles: [], inputActionFiles: [], resourcePaths: [] },
  inResourcesRoot?: string,
): ScannedAssets {
  if (!fs.existsSync(dir)) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nextResourcesRoot =
        inResourcesRoot ?? (entry.name.toLowerCase() === 'resources' ? full : undefined);
      scanAssetsForSettings(full, out, nextResourcesRoot);
    } else if (entry.isFile()) {
      if (entry.name.endsWith('.controller')) {
        out.controllerFiles.push(full);
      } else if (entry.name.endsWith('.inputactions')) {
        out.inputActionFiles.push(full);
      } else if (inResourcesRoot && !entry.name.endsWith('.meta')) {
        const rel = path.relative(inResourcesRoot, full).replace(/\\/g, '/');
        const ext = path.extname(rel);
        out.resourcePaths.push(ext ? rel.slice(0, -ext.length) : rel);
      }
    }
  }
  return out;
}

function scanResourcePathsOnly(
  dir: string,
  out: string[] = [],
  inResourcesRoot?: string,
): string[] {
  if (!fs.existsSync(dir)) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nextResourcesRoot =
        inResourcesRoot ?? (entry.name.toLowerCase() === 'resources' ? full : undefined);
      scanResourcePathsOnly(full, out, nextResourcesRoot);
    } else if (entry.isFile() && inResourcesRoot && !entry.name.endsWith('.meta')) {
      const rel = path.relative(inResourcesRoot, full).replace(/\\/g, '/');
      const ext = path.extname(rel);
      out.push(ext ? rel.slice(0, -ext.length) : rel);
    }
  }
  return out;
}

export class ProjectSettingsWatcher implements vscode.Disposable {
  private context: UnityProjectContext;
  private cache: ProjectSettingsCache;
  private inputActions: InputActionEntry[] = [];
  private resourcePaths: string[] = [];
  private readonly enableWatchers: boolean;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly _onDidUpdateCache = new vscode.EventEmitter<ProjectSettingsCache>();
  public readonly onDidUpdateCache = this._onDidUpdateCache.event;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private resourceDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(context: UnityProjectContext, options: { enableWatchers?: boolean } = {}) {
    this.context = context;
    this.enableWatchers = options.enableWatchers ?? true;
    this.cache = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      tags: [...BUILTIN_UNITY_TAGS],
      layers: [],
      sortingLayers: [],
      inputAxes: [],
      buildScenes: [],
      animatorControllers: [],
    };
  }

  public getCache(): ProjectSettingsCache {
    return this.cache;
  }

  public getInputActions(): readonly InputActionEntry[] {
    return this.inputActions;
  }

  public getResourcePaths(): readonly string[] {
    return this.resourcePaths;
  }

  public updateContext(newContext: UnityProjectContext): void {
    this.context = newContext;
    this.disposeWatchers();
    if (this.enableWatchers) {
      this.setupWatchers();
    }
  }

  public async start(): Promise<ProjectSettingsCache> {
    const result = await this.rebuildCache();
    if (this.enableWatchers) {
      this.setupWatchers();
    }
    return result;
  }

  private safeReadFile(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }
  }

  public rebuildResourcePaths(): string[] {
    try {
      const paths = scanResourcePathsOnly(path.join(this.context.projectRoot, 'Assets'));
      this.resourcePaths = Array.from(new Set(paths));
    } catch {
      // Keep previous resourcePaths on scan failure
    }
    return this.resourcePaths;
  }

  public async rebuildCache(): Promise<ProjectSettingsCache> {
    const settingsDir = path.join(this.context.projectRoot, 'ProjectSettings');
    const tagPath = path.join(settingsDir, 'TagManager.asset');
    const inputPath = path.join(settingsDir, 'InputManager.asset');
    const buildPath = path.join(settingsDir, 'EditorBuildSettings.asset');

    let tags = [...BUILTIN_UNITY_TAGS];
    let layers: Array<{ index: number; name: string }> = [];
    let sortingLayers: Array<{ id: number; name: string }> = [];

    const tagContent = fs.existsSync(tagPath) ? this.safeReadFile(tagPath) : null;
    if (tagContent !== null) {
      const parsed = parseTagManagerYaml(tagContent);
      tags = parsed.tags;
      layers = parsed.layers;
      sortingLayers = parsed.sortingLayers;
    }

    const inputContent = fs.existsSync(inputPath) ? this.safeReadFile(inputPath) : null;
    const inputAxes = inputContent !== null ? parseInputManagerYaml(inputContent) : [];

    const buildContent = fs.existsSync(buildPath) ? this.safeReadFile(buildPath) : null;
    const buildScenes = buildContent !== null ? parseEditorBuildSettingsYaml(buildContent) : [];

    const scanned = scanAssetsForSettings(path.join(this.context.projectRoot, 'Assets'));
    const animatorControllers: AnimatorControllerIndex[] = [];
    for (const file of scanned.controllerFiles) {
      const content = this.safeReadFile(file);
      if (content === null) continue;
      const relPath = path.relative(this.context.projectRoot, file).replace(/\\/g, '/');
      const guid = readMetaGuid(file);
      animatorControllers.push(parseAnimatorControllerYaml(content, relPath, guid));
    }

    const inputActions: InputActionEntry[] = [];
    for (const file of scanned.inputActionFiles) {
      const content = this.safeReadFile(file);
      if (content === null) continue;
      const relPath = path.relative(this.context.projectRoot, file).replace(/\\/g, '/');
      inputActions.push(...parseInputActionsJson(content, relPath));
    }
    this.inputActions = inputActions;
    this.resourcePaths = Array.from(new Set(scanned.resourcePaths));

    this.cache = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      tags,
      layers,
      sortingLayers,
      inputAxes,
      buildScenes,
      animatorControllers,
    };

    this._onDidUpdateCache.fire(this.cache);

    return this.cache;
  }

  private setupWatchers(): void {
    const fullReloadPatterns = [
      'ProjectSettings/TagManager.asset',
      'ProjectSettings/InputManager.asset',
      'ProjectSettings/EditorBuildSettings.asset',
      'Assets/**/*.controller',
      'Assets/**/*.inputactions',
    ];
    for (const pat of fullReloadPatterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(this.context.projectRoot, pat),
      );
      const trigger = () => {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = undefined;
          void this.rebuildCache().catch(() => {});
        }, 300);
      };
      this.disposables.push(
        watcher,
        watcher.onDidChange(trigger),
        watcher.onDidCreate(trigger),
        watcher.onDidDelete(trigger),
      );
    }

    const resourcesWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.context.projectRoot, 'Assets/**/Resources/**/*'),
    );
    const triggerResources = () => {
      if (this.resourceDebounceTimer) clearTimeout(this.resourceDebounceTimer);
      this.resourceDebounceTimer = setTimeout(() => {
        this.resourceDebounceTimer = undefined;
        this.rebuildResourcePaths();
      }, 300);
    };
    this.disposables.push(
      resourcesWatcher,
      resourcesWatcher.onDidChange(triggerResources),
      resourcesWatcher.onDidCreate(triggerResources),
      resourcesWatcher.onDidDelete(triggerResources),
    );
  }

  private disposeWatchers(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.resourceDebounceTimer) {
      clearTimeout(this.resourceDebounceTimer);
      this.resourceDebounceTimer = undefined;
    }
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  public dispose(): void {
    this.disposeWatchers();
    this._onDidUpdateCache.dispose();
  }
}
