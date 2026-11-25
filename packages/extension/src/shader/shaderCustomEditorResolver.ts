import fs from 'node:fs';
import path from 'node:path';
import {
  normalizePathKey,
  type UnityVirtualPathResolver,
} from '../../../shader-lsp/src/vfs/virtualPathResolver.ts';

export interface CustomEditorResolution {
  editorName: string;
  resolved: boolean;
  inspectedFiles: string[];
  referencedProperties: ReadonlySet<string>;
}

export interface CustomEditorDirective {
  kind: 'CustomEditor' | 'CustomEditorForRenderPipeline';
  name: string;
  line: number;
  startCol: number;
  endCol: number;
}

export interface CustomEditorDefinitionLocation {
  filePath: string;
  line: number;
  column: number;
  endColumn: number;
}

interface FileStatSnapshot {
  filePath: string;
  mtimeMs: number;
  size: number;
}

interface CachedResolutionEntry {
  packageMapSignature: string;
  fileStats: FileStatSnapshot[];
  csGeneration: number;
  result: CustomEditorResolution;
}

interface ProjectCustomEditorCache {
  packageMapSignature: string;
  csGeneration: number;
  entries: Map<string, CachedResolutionEntry>;
  rootFilesCache: Map<string, string[]>;
}

const SKIP_DIRS = new Set([
  'bin',
  'obj',
  '.git',
  'node_modules',
  'Tests',
  'Samples~',
  'Documentation~',
]);

const IGNORED_BASE_CLASSES = new Set([
  'ShaderGUI',
  'MaterialEditor',
  'Object',
  'IDisposable',
]);

const BUILTIN_COMPILED_SHADER_GUIS = new Set([
  'StandardShaderGUI',
  'StandardParticlesShaderGUI',
  'StandardTerrainShaderGUI',
  'TerrainLitShaderGUI',
  'SpeedTreeMaterialInspector',
  'SpeedTree8MaterialInspector',
  'SpritesDefaultShaderGUI',
  'DefaultMaterialEditor',
  'UnityEditor.StandardShaderGUI',
  'UnityEditor.StandardParticlesShaderGUI',
  'UnityEditor.ShaderGUI',
  'UnityEditor.MaterialEditor',
]);

export function isBuiltInCompiledShaderGui(name: string): boolean {
  return BUILTIN_COMPILED_SHADER_GUIS.has(name.trim());
}

const MAX_TRAVERSAL_DEPTH = 6;
const MAX_INSPECTED_FILES = 40;

const projectCaches = new Map<string, ProjectCustomEditorCache>();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getOrCreateProjectCache(projectRoot: string): ProjectCustomEditorCache {
  const key = normalizePathKey(projectRoot);
  let cache = projectCaches.get(key);
  if (!cache) {
    cache = {
      packageMapSignature: '',
      csGeneration: 0,
      entries: new Map(),
      rootFilesCache: new Map(),
    };
    projectCaches.set(key, cache);
  }
  return cache;
}

function buildPackageMapSignature(resolver: UnityVirtualPathResolver): string {
  const pkgMap = resolver.getPackageMap();
  return Array.from(pkgMap.values())
    .sort((a, b) => a.packageName.localeCompare(b.packageName))
    .map((e) => `${e.packageName}@${e.version}:${e.physicalRoot}`)
    .join('|');
}

/**
 * Strip C/C#/ShaderLab line and block comments while preserving string literals and newlines.
 */
function stripCommentsPreservingStrings(source: string): string {
  let out = '';
  let i = 0;
  const len = source.length;
  let inLineComment = false;
  let inBlockComment = false;
  let inString = false;
  let inVerbatimString = false;

  while (i < len) {
    const ch = source[i];
    const next = i + 1 < len ? source[i + 1] : '';

    if (inLineComment) {
      if (ch === '\n' || ch === '\r') {
        inLineComment = false;
        out += ch;
      } else {
        out += ' ';
      }
      i++;
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        out += '  ';
        i += 2;
      } else {
        out += ch === '\n' || ch === '\r' ? ch : ' ';
        i++;
      }
      continue;
    }

    if (inVerbatimString) {
      out += ch;
      if (ch === '"') {
        if (next === '"') {
          out += next;
          i += 2;
          continue;
        }
        inVerbatimString = false;
      }
      i++;
      continue;
    }

    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < len) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      out += '  ';
      i += 2;
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true;
      out += '  ';
      i += 2;
      continue;
    }

    if (ch === '@' && next === '"') {
      inVerbatimString = true;
      out += '@"';
      i += 2;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }

    if (ch === '\'') {
      // Only treat single-line char literals ('x' or '\x') as char literals; leave lone apostrophes inert
      let j = i + 1;
      if (j < len && source[j] === '\\') {
        j += 2;
      } else if (j < len && source[j] !== '\n' && source[j] !== '\r') {
        j += 1;
      }
      if (j < len && source[j] === '\'') {
        out += source.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      out += ch;
      i++;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * Extract CustomEditor and CustomEditorForRenderPipeline directives with exact 0-based line/column spans.
 * Ignores comments and HLSL/CG program/include blocks while preserving line/column offsets.
 */
export function extractCustomEditorDirectives(shaderText: string): CustomEditorDirective[] {
  const withoutComments = stripCommentsPreservingStrings(shaderText);
  const withoutHlslBlocks = withoutComments.replace(
    /\b(?:HLSLPROGRAM|HLSLINCLUDE)[\s\S]*?\bENDHLSL\b|\b(?:CGPROGRAM|CGINCLUDE)[\s\S]*?\bENDCG\b/g,
    (block) => block.replace(/[^\r\n]/g, ' '),
  );

  const directives: CustomEditorDirective[] = [];
  const editorRe =
    /\b(CustomEditorForRenderPipeline)\s+["']([^"']+)["'](?:\s+["'][^"']*["'])?|\b(CustomEditor)\s+["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = editorRe.exec(withoutHlslBlocks)) !== null) {
    const kind = match[1] ? 'CustomEditorForRenderPipeline' : 'CustomEditor';
    const rawName = (match[2] ?? match[4] ?? '').trim();
    if (!rawName) continue;

    const fullMatch = match[0];
    const quoteMatch = /["']/.exec(fullMatch);
    const quoteIdx = quoteMatch ? quoteMatch.index : -1;
    const nameOffsetInMatch = fullMatch.indexOf(rawName, quoteIdx + 1);
    if (nameOffsetInMatch < 0) continue;

    const absStart = match.index + nameOffsetInMatch;
    const prefix = withoutHlslBlocks.slice(0, absStart);
    const lastNewline = prefix.lastIndexOf('\n');
    const line = prefix.split('\n').length - 1;
    const startCol = lastNewline < 0 ? absStart : absStart - lastNewline - 1;
    directives.push({
      kind,
      name: rawName,
      line,
      startCol,
      endCol: startCol + rawName.length,
    });
  }

  return directives;
}

/**
 * Extract CustomEditor and CustomEditorForRenderPipeline class names from ShaderLab text.
 * Ignores comments and HLSL/CG program/include blocks.
 */
export function extractCustomEditorNames(shaderText: string): string[] {
  const names = new Set<string>();
  for (const d of extractCustomEditorDirectives(shaderText)) {
    names.add(d.name);
  }
  return Array.from(names);
}

/**
 * Find CustomEditor or CustomEditorForRenderPipeline directive at the given 0-based cursor position.
 */
export function findCustomEditorAtPosition(
  shaderText: string,
  line: number,
  _character: number,
): CustomEditorDirective | null {
  for (const dir of extractCustomEditorDirectives(shaderText)) {
    if (dir.line === line) {
      return dir;
    }
  }

  const rawLine = shaderText.split(/\r?\n/)[line];
  if (!rawLine) return null;
  const lineNoComment = rawLine.replace(/\/\/.*$/, '');
  const lineMatch =
    /\b(CustomEditorForRenderPipeline)\s+["']([^"']+)["'](?:\s+["'][^"']*["'])?|\b(CustomEditor)\s+["']([^"']+)["']/i.exec(
      lineNoComment,
    );
  if (!lineMatch) return null;
  const kind = lineMatch[1] ? 'CustomEditorForRenderPipeline' : 'CustomEditor';
  const rawName = (lineMatch[2] ?? lineMatch[4] ?? '').trim();
  if (!rawName) return null;
  const quoteMatch = /["']/.exec(lineMatch[0]);
  const quoteIdx = quoteMatch ? quoteMatch.index : -1;
  const nameOffset = lineMatch[0].indexOf(rawName, quoteIdx + 1);
  if (nameOffset < 0) return null;
  const startCol = lineMatch.index + nameOffset;
  return {
    kind,
    name: rawName,
    line,
    startCol,
    endCol: startCol + rawName.length,
  };
}

function collectCsFilesInRoot(rootDir: string, cache: ProjectCustomEditorCache): string[] {
  const rootKey = normalizePathKey(rootDir);
  const cached = cache.rootFilesCache.get(rootKey);
  if (cached) {
    return cached;
  }

  const results: string[] = [];
  if (!rootDir || !fs.existsSync(rootDir)) {
    cache.rootFilesCache.set(rootKey, results);
    return results;
  }

  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        if (!SKIP_DIRS.has(entry.name)) {
          const full = path.join(current, entry.name);
          try {
            if (entry.isDirectory() || fs.statSync(full).isDirectory()) {
              stack.push(full);
            }
          } catch {
            // Ignore broken symlinks
          }
        }
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.cs')) {
        results.push(path.join(current, entry.name));
      }
    }
  }

  // Prioritize files under an Editor directory so ShaderGUI lookups hit sooner
  results.sort((a, b) => {
    const aEditor = /[\\/]Editor[\\/]/i.test(a) ? 0 : 1;
    const bEditor = /[\\/]Editor[\\/]/i.test(b) ? 0 : 1;
    if (aEditor !== bEditor) return aEditor - bEditor;
    return a.localeCompare(b);
  });

  cache.rootFilesCache.set(rootKey, results);
  return results;
}

function splitClassName(fullName: string): { namespacePrefix: string | null; simpleName: string } {
  const trimmed = fullName.trim();
  const lastDot = trimmed.lastIndexOf('.');
  if (lastDot < 0) {
    return { namespacePrefix: null, simpleName: trimmed };
  }
  return {
    namespacePrefix: trimmed.slice(0, lastDot),
    simpleName: trimmed.slice(lastDot + 1),
  };
}

function hasMatchingNamespace(cleanCsText: string, expectedNamespace: string): boolean {
  const directRe = new RegExp(
    `\\bnamespace\\s+${escapeRegExp(expectedNamespace)}\\s*[\\{;]`,
  );
  if (directRe.test(cleanCsText)) {
    return true;
  }

  const segments = expectedNamespace.split('.');
  if (segments.length <= 1) {
    return false;
  }

  // Check nested namespace declarations: namespace A { ... namespace B {
  let searchFrom = 0;
  for (const seg of segments) {
    const segRe = new RegExp(`\\bnamespace\\s+${escapeRegExp(seg)}\\s*\\{`);
    const slice = cleanCsText.slice(searchFrom);
    const m = segRe.exec(slice);
    if (!m) {
      return false;
    }
    searchFrom += m.index + m[0].length;
  }
  return true;
}

function matchesClassInCs(
  cleanCsText: string,
  simpleName: string,
  namespacePrefix: string | null,
): boolean {
  const classDeclRe = new RegExp(`\\bclass\\s+${escapeRegExp(simpleName)}\\b`);
  if (!classDeclRe.test(cleanCsText)) {
    return false;
  }
  if (namespacePrefix && !hasMatchingNamespace(cleanCsText, namespacePrefix)) {
    return false;
  }
  return true;
}

function extractBaseClassName(cleanCsText: string, simpleName: string): string | null {
  const declRe = new RegExp(
    `\\bclass\\s+${escapeRegExp(simpleName)}(?:\\s*<[^>]+>)?\\s*:\\s*([A-Za-z_][A-Za-z0-9_.]*)`,
  );
  const match = declRe.exec(cleanCsText);
  if (!match) return null;

  const baseRaw = match[1].trim();
  const baseSimple = baseRaw.includes('.') ? baseRaw.slice(baseRaw.lastIndexOf('.') + 1) : baseRaw;
  if (IGNORED_BASE_CLASSES.has(baseSimple)) {
    return null;
  }
  if (/^I[A-Z]/.test(baseSimple)) {
    return null;
  }
  return baseRaw;
}

function extractStaticHelperNames(cleanCsText: string): string[] {
  const helpers = new Set<string>();
  const helperRe =
    /\b((?:[A-Za-z_][A-Za-z0-9_]*)?(?:GUI|Properties|PropertyNames|Property|ShaderProperty|ShaderPropertyId|ShaderUtils|Keywords|UIBlock|Section|Ids|IDs|Constants))\s*\./g;
  let match: RegExpExecArray | null;
  while ((match = helperRe.exec(cleanCsText)) !== null) {
    helpers.add(match[1]);
  }
  const ctorRe = /\bnew\s+([A-Za-z_][A-Za-z0-9_]*(?:UIBlock|Section|GUI))\s*\(/g;
  while ((match = ctorRe.exec(cleanCsText)) !== null) {
    helpers.add(match[1]);
  }
  return Array.from(helpers);
}

function extractPropertyRefsFromCs(cleanCsText: string, target: Set<string>): void {
  const underscoreStringRe = /"(_[A-Za-z0-9_]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = underscoreStringRe.exec(cleanCsText)) !== null) {
    target.add(match[1]);
  }

  const apiStringRe =
    /\b(?:FindProperty|PropertyToID|HasProperty|(?:Get|Set|Has)(?:Float|Int|Integer|Color|Vector|Texture|Matrix|Buffer))\s*\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g;
  while ((match = apiStringRe.exec(cleanCsText)) !== null) {
    target.add(match[1]);
  }
}

function readCsCleanText(
  filePath: string,
  textCache: Map<string, string>,
): string | null {
  const key = normalizePathKey(filePath);
  const cached = textCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const clean = stripCommentsPreservingStrings(raw);
    textCache.set(key, clean);
    return clean;
  } catch {
    return null;
  }
}

function expandPreferredDirs(preferredDir: string | null): string[] {
  if (!preferredDir) return [];
  const dirs: string[] = [preferredDir];
  const parentDir = path.dirname(preferredDir);
  if (/[\\/]ShaderGUI$/i.test(parentDir) || /[\\/]ShaderGUI[\\/]/i.test(preferredDir)) {
    dirs.push(parentDir);
    dirs.push(path.join(parentDir, 'Sections'));
  }
  dirs.push(path.join(preferredDir, 'Sections'));
  return dirs;
}

function getResolverProjectRoot(resolver: UnityVirtualPathResolver): string {
  if (typeof resolver.getContext === 'function') {
    return resolver.getContext().projectRoot;
  }
  return (resolver as unknown as { context: { projectRoot: string } }).context.projectRoot;
}

function buildSearchRoots(resolver: UnityVirtualPathResolver, fromFilePath?: string): string[] {
  const projectRoot = getResolverProjectRoot(resolver);
  const searchRoots: string[] = [];
  const seenRoots = new Set<string>();
  const addRoot = (dir: string) => {
    if (!dir) return;
    const key = normalizePathKey(dir);
    if (!seenRoots.has(key)) {
      seenRoots.add(key);
      searchRoots.push(dir);
    }
  };

  const addSubdirs = (baseDir: string) => {
    if (!fs.existsSync(baseDir)) return;
    try {
      for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          const full = path.join(baseDir, entry.name);
          try {
            if (entry.isDirectory() || fs.statSync(full).isDirectory()) {
              addRoot(full);
            }
          } catch {
            // Ignore broken symlinks
          }
        }
      }
    } catch {
      // Ignore unreadable directory
    }
  };

  addRoot(path.join(projectRoot, 'Assets'));
  for (const pkgEntry of resolver.getPackageMap().values()) {
    addRoot(pkgEntry.physicalRoot);
  }
  addSubdirs(path.join(projectRoot, 'Packages'));
  addSubdirs(path.join(projectRoot, 'Library', 'PackageCache'));

  if (fromFilePath) {
    let cur = path.dirname(path.resolve(fromFilePath));
    addRoot(cur);
    for (let i = 0; i < 10; i++) {
      const parent = path.dirname(cur);
      const parentBase = path.basename(parent).toLowerCase();
      if (parentBase === 'packagecache' || parentBase === 'packages') {
        addRoot(cur);
      }
      const hasAssets = fs.existsSync(path.join(cur, 'Assets'));
      const hasPkgCache = fs.existsSync(path.join(cur, 'Library', 'PackageCache'));
      if (hasAssets || hasPkgCache) {
        addRoot(path.join(cur, 'Assets'));
        addSubdirs(path.join(cur, 'Packages'));
        addSubdirs(path.join(cur, 'Library', 'PackageCache'));
      }
      if (!parent || parent === cur) break;
      cur = parent;
    }
  }

  return searchRoots;
}

function findMatchingClassFiles(
  className: string,
  searchRoots: string[],
  preferredDir: string | null,
  cache: ProjectCustomEditorCache,
  textCache: Map<string, string>,
): string[] {
  const { namespacePrefix, simpleName } = splitClassName(className);
  const expectedFileName = `${simpleName}.cs`.toLowerCase();

  // Collect candidate files from preferredDir (same directory) first, then all searchRoots
  const exactNameCandidates: string[] = [];
  const fallbackCandidates: string[] = [];
  const seenPaths = new Set<string>();

  const addCandidate = (filePath: string) => {
    const key = normalizePathKey(filePath);
    if (seenPaths.has(key)) return;
    seenPaths.add(key);
    if (path.basename(filePath).toLowerCase() === expectedFileName) {
      exactNameCandidates.push(filePath);
    } else {
      fallbackCandidates.push(filePath);
    }
  };

  for (const prefDir of expandPreferredDirs(preferredDir)) {
    if (!fs.existsSync(prefDir)) continue;
    try {
      for (const entry of fs.readdirSync(prefDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.cs')) {
          addCandidate(path.join(prefDir, entry.name));
        }
      }
    } catch {
      // Ignore unreadable directory
    }
  }

  for (const root of searchRoots) {
    for (const filePath of collectCsFilesInRoot(root, cache)) {
      addCandidate(filePath);
    }
  }

  const matched: string[] = [];
  const partialDeclRe = new RegExp(`\\bpartial\\s+class\\s+${escapeRegExp(simpleName)}\\b`);
  let hasPartial = false;
  // Tier 1: Exact filename match + class & namespace match
  for (const filePath of exactNameCandidates) {
    const clean = readCsCleanText(filePath, textCache);
    if (clean && matchesClassInCs(clean, simpleName, namespacePrefix)) {
      matched.push(filePath);
      if (partialDeclRe.test(clean)) {
        hasPartial = true;
      }
    }
  }
  if (matched.length > 0) {
    if (hasPartial) {
      for (const filePath of fallbackCandidates) {
        const clean = readCsCleanText(filePath, textCache);
        if (clean && partialDeclRe.test(clean) && matchesClassInCs(clean, simpleName, namespacePrefix)) {
          matched.push(filePath);
        }
      }
    }
    return matched;
  }

  // Tier 2: Any .cs file + class & namespace match
  for (const filePath of fallbackCandidates) {
    const clean = readCsCleanText(filePath, textCache);
    if (clean && matchesClassInCs(clean, simpleName, namespacePrefix)) {
      matched.push(filePath);
    }
  }
  if (matched.length > 0) {
    return matched;
  }

  // Tier 3: Namespace-relaxed class match, then exact filename fallback
  if (namespacePrefix) {
    for (const filePath of exactNameCandidates) {
      const clean = readCsCleanText(filePath, textCache);
      if (clean && matchesClassInCs(clean, simpleName, null)) {
        matched.push(filePath);
      }
    }
    if (matched.length > 0) {
      return matched;
    }

    for (const filePath of fallbackCandidates) {
      const clean = readCsCleanText(filePath, textCache);
      if (clean && matchesClassInCs(clean, simpleName, null)) {
        matched.push(filePath);
      }
    }
    if (matched.length > 0) {
      return matched;
    }
  }

  if (exactNameCandidates.length > 0) {
    return exactNameCandidates;
  }

  return matched;
}

function findOwningPackageRoot(filePathOrDir: string | null): string | null {
  if (!filePathOrDir) return null;
  let cur = path.resolve(filePathOrDir);
  for (let i = 0; i < 10; i++) {
    const parent = path.dirname(cur);
    const parentBase = path.basename(parent).toLowerCase();
    if (parentBase === 'packagecache' || parentBase === 'packages') {
      return cur;
    }
    if (!parent || parent === cur) break;
    cur = parent;
  }
  return null;
}

function findHelperFiles(
  helperName: string,
  searchRoots: string[],
  preferredDir: string | null,
  cache: ProjectCustomEditorCache,
  textCache: Map<string, string>,
): string[] {
  const expectedFileName = `${helperName}.cs`.toLowerCase();
  const matched: string[] = [];
  const seen = new Set<string>();
  const preferredScopeFiles: string[] = [];

  const checkFile = (filePath: string, collectIntoScope: boolean) => {
    const key = normalizePathKey(filePath);
    if (seen.has(key)) return;
    seen.add(key);
    if (collectIntoScope) {
      preferredScopeFiles.push(filePath);
    }
    if (path.basename(filePath).toLowerCase() === expectedFileName) {
      matched.push(filePath);
    }
  };

  for (const prefDir of expandPreferredDirs(preferredDir)) {
    if (!fs.existsSync(prefDir)) continue;
    try {
      for (const entry of fs.readdirSync(prefDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.cs')) {
          checkFile(path.join(prefDir, entry.name), true);
        }
      }
    } catch {
      // Ignore unreadable directory
    }
  }

  for (const root of searchRoots) {
    for (const filePath of collectCsFilesInRoot(root, cache)) {
      checkFile(filePath, false);
    }
  }

  if (matched.length > 0) {
    return matched;
  }

  // Fallback for nested/non-filename helper classes (e.g. `static class Property` inside `BaseShaderGUI.cs` or `ShaderUtils.cs`)
  const declRe = new RegExp(`\\b(?:class|struct)\\s+${escapeRegExp(helperName)}\\b`);
  const scanScope = (files: string[]): string[] => {
    const hits: string[] = [];
    for (const filePath of files) {
      const clean = readCsCleanText(filePath, textCache);
      if (clean && declRe.test(clean)) {
        hits.push(filePath);
      }
    }
    return hits;
  };

  const prefHits = scanScope(preferredScopeFiles);
  if (prefHits.length > 0) {
    return prefHits;
  }

  const owningPkgRoot = findOwningPackageRoot(preferredDir);
  if (owningPkgRoot) {
    const pkgHits = scanScope(collectCsFilesInRoot(owningPkgRoot, cache));
    if (pkgHits.length > 0) {
      return pkgHits;
    }
  }

  for (const root of searchRoots) {
    if (owningPkgRoot && normalizePathKey(root) === normalizePathKey(owningPkgRoot)) {
      continue;
    }
    const rootHits = scanScope(collectCsFilesInRoot(root, cache));
    if (rootHits.length > 0) {
      return rootHits;
    }
  }

  return matched;
}

function areFileStatsValid(fileStats: FileStatSnapshot[]): boolean {
  for (const snap of fileStats) {
    try {
      const st = fs.statSync(snap.filePath);
      if (!st.isFile() || st.mtimeMs !== snap.mtimeMs || st.size !== snap.size) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

function snapshotFileStats(filePaths: string[]): FileStatSnapshot[] {
  const snaps: FileStatSnapshot[] = [];
  for (const filePath of filePaths) {
    try {
      const st = fs.statSync(filePath);
      snaps.push({
        filePath,
        mtimeMs: st.mtimeMs,
        size: st.size,
      });
    } catch {
      // Skip unstatable file
    }
  }
  return snaps;
}

/**
 * Resolve C# CustomEditor class (including base classes and GUI helpers) across Assets/,
 * Packages/, and Library/PackageCache/, and extract referenced shader property names.
 */
export function resolveCustomEditorProperties(
  resolver: UnityVirtualPathResolver,
  editorClassName: string,
  fromFilePath?: string,
): CustomEditorResolution {
  const projectRoot = getResolverProjectRoot(resolver);
  const cache = getOrCreateProjectCache(projectRoot);
  const packageMapSignature = buildPackageMapSignature(resolver);

  if (cache.packageMapSignature !== packageMapSignature) {
    cache.packageMapSignature = packageMapSignature;
    cache.entries.clear();
    cache.rootFilesCache.clear();
  }

  const trimmedEditorName = editorClassName.trim();
  const cachedEntry = cache.entries.get(trimmedEditorName);
  if (
    cachedEntry &&
    cachedEntry.packageMapSignature === packageMapSignature &&
    cachedEntry.result.resolved &&
    areFileStatsValid(cachedEntry.fileStats)
  ) {
    return cachedEntry.result;
  }

  // Clear directory listing cache on any miss so newly created/moved .cs files are discovered immediately
  cache.rootFilesCache.clear();

  // Build deduplicated ordered search roots: Assets/ first, then resolved packages and PackageCache
  const searchRoots = buildSearchRoots(resolver, fromFilePath);

  const textCache = new Map<string, string>();
  const inspectedFiles: string[] = [];
  const inspectedKeySet = new Set<string>();
  const referencedProperties = new Set<string>();
  const visitedClasses = new Set<string>();
  const visitedHelpers = new Set<string>();

  const inspectFile = (filePath: string): string | null => {
    const key = normalizePathKey(filePath);
    if (inspectedKeySet.has(key) || inspectedFiles.length >= MAX_INSPECTED_FILES) {
      return textCache.get(key) ?? null;
    }
    const clean = readCsCleanText(filePath, textCache);
    if (!clean) return null;
    inspectedKeySet.add(key);
    inspectedFiles.push(filePath);
    extractPropertyRefsFromCs(clean, referencedProperties);
    return clean;
  };

  const traverseClass = (
    targetClassName: string,
    preferredDir: string | null,
    depth: number,
  ): boolean => {
    if (depth > MAX_TRAVERSAL_DEPTH || inspectedFiles.length >= MAX_INSPECTED_FILES) {
      return false;
    }
    const normClassKey = targetClassName.trim();
    if (!normClassKey || visitedClasses.has(normClassKey)) {
      return false;
    }
    visitedClasses.add(normClassKey);

    const matchedFiles = findMatchingClassFiles(
      normClassKey,
      searchRoots,
      preferredDir,
      cache,
      textCache,
    );
    if (matchedFiles.length === 0) {
      return false;
    }

    const { simpleName } = splitClassName(normClassKey);
    const pendingHelpers: Array<{ name: string; dir: string }> = [];
    const pendingBaseClasses: Array<{ name: string; dir: string }> = [];

    for (const filePath of matchedFiles) {
      if (inspectedFiles.length >= MAX_INSPECTED_FILES) break;
      const clean = inspectFile(filePath);
      if (!clean) continue;

      const fileDir = path.dirname(filePath);
      const baseClass = extractBaseClassName(clean, simpleName);
      if (baseClass) {
        pendingBaseClasses.push({ name: baseClass, dir: fileDir });
      }
      for (const helper of extractStaticHelperNames(clean)) {
        if (helper !== simpleName && !visitedHelpers.has(helper)) {
          pendingHelpers.push({ name: helper, dir: fileDir });
        }
      }
    }

    for (const helper of pendingHelpers) {
      if (inspectedFiles.length >= MAX_INSPECTED_FILES) break;
      if (visitedHelpers.has(helper.name)) continue;
      visitedHelpers.add(helper.name);
      const helperFiles = findHelperFiles(helper.name, searchRoots, helper.dir, cache, textCache);
      for (const hf of helperFiles) {
        if (inspectedFiles.length >= MAX_INSPECTED_FILES) break;
        inspectFile(hf);
      }
    }

    for (const base of pendingBaseClasses) {
      if (inspectedFiles.length >= MAX_INSPECTED_FILES) break;
      traverseClass(base.name, base.dir, depth + 1);
    }

    return true;
  };

  const resolved = traverseClass(trimmedEditorName, null, 0);
  const result: CustomEditorResolution = {
    editorName: trimmedEditorName,
    resolved,
    inspectedFiles,
    referencedProperties,
  };

  if (resolved) {
    cache.entries.set(trimmedEditorName, {
      packageMapSignature,
      fileStats: snapshotFileStats(inspectedFiles),
      csGeneration: cache.csGeneration,
      result,
    });
  } else {
    cache.entries.delete(trimmedEditorName);
  }

  return result;
}

function findClassDeclarationSpan(
  cleanCsText: string,
  simpleName: string,
): { line: number; column: number; endColumn: number } {
  const declRe = new RegExp(`\\bclass\\s+(${escapeRegExp(simpleName)})\\b`);
  const match = declRe.exec(cleanCsText);
  if (!match) {
    return { line: 0, column: 0, endColumn: 0 };
  }
  const offset = match.index + match[0].lastIndexOf(match[1]);
  const prefix = cleanCsText.slice(0, offset);
  const lastNewline = prefix.lastIndexOf('\n');
  const line = prefix.split('\n').length - 1;
  const column = lastNewline < 0 ? offset : offset - lastNewline - 1;
  return { line, column, endColumn: column + simpleName.length };
}

/**
 * Resolve Go-to-Definition locations for a CustomEditor / CustomEditorForRenderPipeline C# class
 * across Assets/, Packages/, and Library/PackageCache/.
 */
export function resolveCustomEditorDefinition(
  resolver: UnityVirtualPathResolver,
  editorClassName: string,
  fromFilePath?: string,
): CustomEditorDefinitionLocation[] {
  const projectRoot = getResolverProjectRoot(resolver);
  const cache = getOrCreateProjectCache(projectRoot);
  const packageMapSignature = buildPackageMapSignature(resolver);
  if (cache.packageMapSignature !== packageMapSignature) {
    cache.packageMapSignature = packageMapSignature;
    cache.entries.clear();
    cache.rootFilesCache.clear();
  }

  const trimmed = editorClassName.trim();
  if (!trimmed) return [];

  const searchRoots = buildSearchRoots(resolver, fromFilePath);
  const textCache = new Map<string, string>();
  let matchedFiles = findMatchingClassFiles(trimmed, searchRoots, null, cache, textCache).filter((fp) =>
    fs.existsSync(fp),
  );
  if (matchedFiles.length === 0) {
    cache.rootFilesCache.clear();
    const refreshedRoots = buildSearchRoots(resolver, fromFilePath);
    matchedFiles = findMatchingClassFiles(trimmed, refreshedRoots, null, cache, textCache).filter((fp) =>
      fs.existsSync(fp),
    );
  }
  const { simpleName } = splitClassName(trimmed);
  const locations: CustomEditorDefinitionLocation[] = [];

  for (const filePath of matchedFiles) {
    const clean = readCsCleanText(filePath, textCache);
    if (!clean) continue;
    const span = findClassDeclarationSpan(clean, simpleName);
    locations.push({
      filePath,
      line: span.line,
      column: span.column,
      endColumn: span.endColumn,
    });
  }

  return locations;
}

/**
 * Invalidate cached CustomEditor resolutions for a project (or all projects).
 * When changedCsPath is provided, only entries referencing that file (or unresolved entries) are purged.
 */
export function invalidateCustomEditorCache(projectRoot?: string, changedCsPath?: string): void {
  if (!projectRoot) {
    projectCaches.clear();
    return;
  }

  const projectKey = normalizePathKey(projectRoot);
  const cache = projectCaches.get(projectKey);
  if (!cache) {
    return;
  }

  if (!changedCsPath) {
    cache.entries.clear();
    cache.rootFilesCache.clear();
    cache.csGeneration++;
    return;
  }

  cache.csGeneration++;
  cache.rootFilesCache.clear();
  const changedKey = normalizePathKey(changedCsPath);
  for (const [editorKey, entry] of cache.entries.entries()) {
    if (
      !entry.result.resolved ||
      entry.fileStats.some((snap) => normalizePathKey(snap.filePath) === changedKey)
    ) {
      cache.entries.delete(editorKey);
    }
  }
}
