/**
 * UnityBrain Shared Data Contracts (Single Source of Truth)
 * Must stay synchronized with PLAN.md Section 3 and schemas/*.schema.json
 */

export interface UnityProjectContext {
  projectRoot: string;
  editorVersion: string;
  editorInstallPath: string | null;
  cgIncludesPath: string | null;
  builtInPackagesPath: string | null;
  manifestPath: string;
  packagesLockPath: string | null;
  cacheDir: string;
}

export type PackageResolutionSource =
  | 'embedded'
  | 'local'
  | 'registry'
  | 'git'
  | 'builtin'
  | 'packageCacheFallback'
  | 'cgIncludes';

export interface ResolvedPackageEntry {
  packageName: string;
  version: string;
  source: PackageResolutionSource;
  physicalRoot: string;
}

export interface VirtualPathMapping {
  virtualPath: string;
  physicalPath: string | null;
  resolvedVia: PackageResolutionSource | 'relative' | 'projectAssets' | 'unresolved';
  packageName?: string;
}

export interface UnityApiParameter {
  name: string;
  type: string;
  isOptional?: boolean;
  description?: string;
}

export interface UnityEventFunction {
  name: string;
  returnType: string;
  supportsCoroutine: boolean;
  isStatic?: boolean;
  isPerformanceCritical?: boolean;
  minimumUnityVersion?: string;
  maximumUnityVersion?: string;
  description: string;
  parameters: UnityApiParameter[];
}

export interface UnityApiTypeEntry {
  fullName: string;
  kind: 'class' | 'struct';
  minimumUnityVersion?: string;
  events: UnityEventFunction[];
}

export interface UnityApiDatabase {
  schemaVersion: 1;
  generatedAt: string;
  sourceCommit?: string;
  types: UnityApiTypeEntry[];
}

export interface InputAxisEntry {
  name: string;
  descriptiveName?: string;
  type: number;
}

export interface BuildSceneEntry {
  name: string;
  path: string;
  guid: string;
  buildIndex: number;
  enabled: boolean;
}

export interface AnimatorControllerIndex {
  assetPath: string;
  guid: string;
  parameters: Array<{ name: string; type: 'Float' | 'Int' | 'Bool' | 'Trigger' }>;
  states: string[];
}

export interface ProjectSettingsCache {
  schemaVersion: 1;
  updatedAt: string;
  tags: string[];
  layers: Array<{ index: number; name: string }>;
  sortingLayers: Array<{ id: number; name: string }>;
  inputAxes: InputAxisEntry[];
  buildScenes: BuildSceneEntry[];
  animatorControllers: AnimatorControllerIndex[];
}

export interface ShaderPropertyEntry {
  name: string;
  displayName: string;
  type: string;
  shaderFile: string;
  shaderName?: string;
  defaultValue?: string;
  line?: number;
  column?: number;
}

export type HlslSymbolKind =
  | 'function'
  | 'struct'
  | 'field'
  | 'macro'
  | 'cbuffer'
  | 'variable'
  | 'property';

export interface HlslSymbolEntry {
  name: string;
  kind: HlslSymbolKind;
  signature?: string;
  returnType?: string;
  documentation?: string;
  uri: string;
  line: number;
  column: number;
  containerName?: string;
  parameters?: Array<{ name: string; type: string }>;
}

export interface ShaderSymbolIndex {
  schemaVersion: 1;
  shaderNames: string[];
  properties: ShaderPropertyEntry[];
  symbolsByFile: Record<string, HlslSymbolEntry[]>;
}

export interface AssetUsageLocation {
  assetPath: string;
  assetType: 'scene' | 'prefab' | 'asset' | 'controller';
  assetGuid: string;
  gameObjectPath: string;
  fileId: string;
  line: number;
  usageKind: 'component' | 'unityEventCallback' | 'prefabOverride' | 'serializedReference';
  methodName?: string;
  serializedValues?: Record<string, string>;
}

export interface SerializedFieldValueEntry {
  fieldName: string;
  value: string;
  assetPath: string;
  assetType: 'scene' | 'prefab' | 'asset';
  gameObjectPath: string;
  fileId: string;
  line: number;
}

export type DaemonIndexStatus = {
  state: 'idle' | 'indexing' | 'ready' | 'error';
  indexedAssets: number;
  indexedMetas: number;
  lastBuildMs: number;
};

export interface DaemonRpcMethods {
  'index/status': {
    params: Record<string, never>;
    result: DaemonIndexStatus;
  };
  'index/rebuild': {
    params: { force?: boolean; forceFull?: boolean };
    result: {
      indexedAssets: number;
      elapsedMs: number;
    };
  };
  'usage/findByScriptGuid': {
    params: { scriptGuid?: string; guid?: string };
    result: {
      locations: AssetUsageLocation[];
    };
  };
  'usage/findByMethod': {
    params: { scriptGuid?: string; guid?: string; className?: string; methodName: string };
    result: {
      locations: AssetUsageLocation[];
    };
  };
  'inspector/getSerializedValues': {
    params: { scriptGuid?: string; guid?: string; fieldName?: string };
    result: {
      fields: SerializedFieldValueEntry[];
    };
  };
}
