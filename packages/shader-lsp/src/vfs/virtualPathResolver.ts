import fs from 'node:fs';
import path from 'node:path';
import type {
  PackageResolutionSource,
  ResolvedPackageEntry,
  UnityProjectContext,
  VirtualPathMapping,
} from '../../../extension/src/contracts/index.ts';

export interface VirtualDirectoryEntry {
  name: string;
  virtualPath: string;
  isDirectory: boolean;
  physicalPath: string;
}

interface ManifestJson {
  dependencies?: Record<string, string>;
}

interface PackagesLockJson {
  dependencies?: Record<
    string,
    {
      version?: string;
      source?: string;
    }
  >;
}

const SHADER_EXTENSIONS = new Set([
  '.shader',
  '.hlsl',
  '.hlsli',
  '.cginc',
  '.compute',
  '.urtshader',
  '.hlslinc',
]);

export class UnityVirtualPathResolver {
  private context: UnityProjectContext;
  private packageMap: Map<string, ResolvedPackageEntry> = new Map();
  private manifestSignature = '';
  private lockSignature = '';
  private packageCacheSignature = '';
  private embeddedFolderByPkgName: Map<string, string> = new Map();

  constructor(context: UnityProjectContext) {
    this.context = context;
    this.refreshPackageMap(true);
  }

  public updateContext(newContext: UnityProjectContext): void {
    this.context = newContext;
    this.invalidateCache();
    this.refreshPackageMap(true);
  }

  public invalidateCache(): void {
    this.manifestSignature = '';
    this.lockSignature = '';
    this.packageCacheSignature = '';
    this.packageMap.clear();
    this.embeddedFolderByPkgName.clear();
  }

  public getPackageMap(): ReadonlyMap<string, ResolvedPackageEntry> {
    this.refreshPackageMap(false);
    return this.packageMap;
  }

  private getFileSignature(filePath: string | null): string {
    if (!filePath || !fs.existsSync(filePath)) {
      return 'missing';
    }
    try {
      const st = fs.statSync(filePath);
      return `${st.mtimeMs}:${st.size}:${st.ctimeMs}`;
    } catch {
      return 'error';
    }
  }

  private getDirectorySignature(dirPath: string): string {
    if (!dirPath || !fs.existsSync(dirPath)) {
      return 'missing';
    }
    try {
      const st = fs.statSync(dirPath);
      const count = fs.readdirSync(dirPath).length;
      return `${st.mtimeMs}:${count}`;
    } catch {
      return 'error';
    }
  }

  private detectLockPath(): string | null {
    if (this.context.packagesLockPath && fs.existsSync(this.context.packagesLockPath)) {
      return this.context.packagesLockPath;
    }
    const candidate = path.join(this.context.projectRoot, 'Packages', 'packages-lock.json');
    if (fs.existsSync(candidate)) {
      this.context.packagesLockPath = candidate;
      return candidate;
    }
    return null;
  }

  public refreshPackageMap(force = false): Map<string, ResolvedPackageEntry> {
    const lockPath = this.detectLockPath();
    const curManifestSig = this.getFileSignature(this.context.manifestPath);
    const curLockSig = this.getFileSignature(lockPath);
    const curCacheSig = this.getDirectorySignature(
      path.join(this.context.projectRoot, 'Library', 'PackageCache'),
    );

    if (
      !force &&
      curManifestSig === this.manifestSignature &&
      curLockSig === this.lockSignature &&
      curCacheSig === this.packageCacheSignature
    ) {
      return this.packageMap;
    }

    this.manifestSignature = curManifestSig;
    this.lockSignature = curLockSig;
    this.packageCacheSignature = curCacheSig;
    this.packageMap.clear();
    this.embeddedFolderByPkgName.clear();
    this.scanEmbeddedPackages();

    let manifestDeps: Record<string, string> = {};
    if (fs.existsSync(this.context.manifestPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.context.manifestPath, 'utf8')) as ManifestJson;
        manifestDeps = parsed.dependencies ?? {};
      } catch {
        manifestDeps = {};
      }
    }

    if (lockPath && fs.existsSync(lockPath)) {
      try {
        const lockParsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as PackagesLockJson;
        const deps = lockParsed.dependencies ?? {};
        for (const [pkgName, info] of Object.entries(deps)) {
          const rawSource = info.source ?? 'registry';
          const version = info.version ?? manifestDeps[pkgName] ?? '';
          const resolved = this.resolvePackageEntryRoot(pkgName, version, rawSource);
          if (resolved) {
            this.packageMap.set(pkgName, resolved);
          }
        }
      } catch {
        // Fall through to manifest/disk discovery
      }
    }

    for (const [pkgName, spec] of Object.entries(manifestDeps)) {
      if (this.packageMap.has(pkgName)) continue;
      if (spec.startsWith('file:')) {
        const resolved = this.resolvePackageEntryRoot(pkgName, spec, 'local');
        if (resolved) this.packageMap.set(pkgName, resolved);
      } else {
        const resolved = this.resolvePackageEntryRoot(pkgName, spec, 'registry');
        if (resolved) this.packageMap.set(pkgName, resolved);
      }
    }

    for (const [pkgName, folderPath] of this.embeddedFolderByPkgName.entries()) {
      if (!this.packageMap.has(pkgName)) {
        this.packageMap.set(pkgName, {
          packageName: pkgName,
          version: 'embedded',
          source: 'embedded',
          physicalRoot: folderPath,
        });
      }
    }

    return this.packageMap;
  }

  private scanEmbeddedPackages(): void {
    const packagesDir = path.join(this.context.projectRoot, 'Packages');
    if (!fs.existsSync(packagesDir)) return;
    try {
      for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidateDir = path.join(packagesDir, entry.name);
        const pkgJsonPath = path.join(candidateDir, 'package.json');
        let pkgName = entry.name;
        if (fs.existsSync(pkgJsonPath)) {
          try {
            const parsed = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as { name?: string };
            if (parsed.name) {
              pkgName = parsed.name;
            }
          } catch {
            // Keep folder name fallback
          }
        }
        this.embeddedFolderByPkgName.set(pkgName, candidateDir);
      }
    } catch {
      // Ignore scan failure
    }
  }

  private resolvePackageEntryRoot(
    pkgName: string,
    version: string,
    rawSource: string,
  ): ResolvedPackageEntry | null {
    const packagesDir = path.join(this.context.projectRoot, 'Packages');

    if (rawSource === 'embedded') {
      const direct = path.join(packagesDir, pkgName);
      if (fs.existsSync(direct)) {
        return { packageName: pkgName, version, source: 'embedded', physicalRoot: direct };
      }
      const mapped = this.embeddedFolderByPkgName.get(pkgName);
      if (mapped && fs.existsSync(mapped)) {
        return { packageName: pkgName, version, source: 'embedded', physicalRoot: mapped };
      }
      return null;
    }

    if (rawSource === 'local') {
      const cleanSpec = version.replace(/^file:/i, '').trim();
      const target = path.isAbsolute(cleanSpec)
        ? cleanSpec
        : path.resolve(packagesDir, cleanSpec);
      if (fs.existsSync(target)) {
        return { packageName: pkgName, version, source: 'local', physicalRoot: target };
      }
      return null;
    }

    const cacheRoot = path.join(this.context.projectRoot, 'Library', 'PackageCache');

    if (rawSource === 'builtin') {
      if (this.context.builtInPackagesPath) {
        const target = path.join(this.context.builtInPackagesPath, pkgName);
        if (fs.existsSync(target)) {
          return { packageName: pkgName, version, source: 'builtin', physicalRoot: target };
        }
      }
      if (version) {
        const exactDir = path.join(cacheRoot, `${pkgName}@${version}`);
        if (fs.existsSync(exactDir)) {
          return { packageName: pkgName, version, source: 'builtin', physicalRoot: exactDir };
        }
      }
      const fallbackDir = this.findPackageCacheFallback(cacheRoot, pkgName);
      if (fallbackDir) {
        return {
          packageName: pkgName,
          version: version || 'cached',
          source: 'packageCacheFallback',
          physicalRoot: fallbackDir,
        };
      }
      const directCacheDir = path.join(cacheRoot, pkgName);
      if (fs.existsSync(directCacheDir)) {
        return { packageName: pkgName, version, source: 'builtin', physicalRoot: directCacheDir };
      }
      return null;
    }

    const source: PackageResolutionSource = rawSource === 'git' ? 'git' : 'registry';
    if (version) {
      const exactDir = path.join(cacheRoot, `${pkgName}@${version}`);
      if (fs.existsSync(exactDir)) {
        return { packageName: pkgName, version, source, physicalRoot: exactDir };
      }
    }

    const fallbackDir = this.findPackageCacheFallback(cacheRoot, pkgName);
    if (fallbackDir) {
      return {
        packageName: pkgName,
        version: version || 'cached',
        source: 'packageCacheFallback',
        physicalRoot: fallbackDir,
      };
    }

    return null;
  }

  private findPackageCacheFallback(cacheRoot: string, pkgName: string): string | null {
    if (!fs.existsSync(cacheRoot)) return null;
    const prefix = `${pkgName}@`;
    try {
      const entries = fs.readdirSync(cacheRoot, { withFileTypes: true });
      const matches = entries
        .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
        .map((e) => e.name)
        .sort()
        .reverse();
      if (matches.length > 0) {
        return path.join(cacheRoot, matches[0]);
      }
    } catch {
      return null;
    }
    return null;
  }

  public resolve(virtualOrIncludePath: string, currentFilePath?: string): VirtualPathMapping {
    const cleaned = this.normalizeVirtualInput(virtualOrIncludePath);
    if (!cleaned) {
      return { virtualPath: cleaned, physicalPath: null, resolvedVia: 'unresolved' };
    }

    if (cleaned.startsWith('Packages/')) {
      return this.resolvePackagesPath(cleaned);
    }

    if (cleaned.startsWith('Assets/')) {
      const physical = path.join(this.context.projectRoot, cleaned.slice('Assets/'.length));
      const fullAssetPath = path.join(this.context.projectRoot, cleaned);
      void physical;
      if (this.isExistingPath(fullAssetPath)) {
        return { virtualPath: cleaned, physicalPath: path.resolve(fullAssetPath), resolvedVia: 'projectAssets' };
      }
      return { virtualPath: cleaned, physicalPath: null, resolvedVia: 'unresolved' };
    }

    if (currentFilePath) {
      const relCandidate = path.resolve(path.dirname(currentFilePath), cleaned);
      if (this.isExistingPath(relCandidate)) {
        return { virtualPath: cleaned, physicalPath: relCandidate, resolvedVia: 'relative' };
      }
    }

    const projectRelativeCandidate = path.resolve(this.context.projectRoot, cleaned);
    if (this.isExistingPath(projectRelativeCandidate)) {
      return { virtualPath: cleaned, physicalPath: projectRelativeCandidate, resolvedVia: 'relative' };
    }

    if (this.context.cgIncludesPath) {
      const cgCandidate = path.resolve(this.context.cgIncludesPath, cleaned);
      if (this.isExistingPath(cgCandidate)) {
        return { virtualPath: cleaned, physicalPath: cgCandidate, resolvedVia: 'cgIncludes' };
      }
    }

    return { virtualPath: cleaned, physicalPath: null, resolvedVia: 'unresolved' };
  }

  private resolvePackagesPath(cleaned: string): VirtualPathMapping {
    this.refreshPackageMap(false);

    const rest = cleaned.slice('Packages/'.length);
    const slashIdx = rest.indexOf('/');
    const pkgName = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
    const subpath = slashIdx === -1 ? '' : rest.slice(slashIdx + 1);

    const mapped = this.packageMap.get(pkgName);
    if (mapped) {
      const candidate = subpath ? path.join(mapped.physicalRoot, subpath) : mapped.physicalRoot;
      if (this.isExistingPath(candidate)) {
        return {
          virtualPath: cleaned,
          physicalPath: path.resolve(candidate),
          resolvedVia: mapped.source,
          packageName: pkgName,
        };
      }
    }

    const fallbackEmbedded = path.join(this.context.projectRoot, 'Packages', pkgName, subpath);
    if (this.isExistingPath(fallbackEmbedded)) {
      return {
        virtualPath: cleaned,
        physicalPath: path.resolve(fallbackEmbedded),
        resolvedVia: 'embedded',
        packageName: pkgName,
      };
    }

    const embeddedMapped = this.embeddedFolderByPkgName.get(pkgName);
    if (embeddedMapped) {
      const cand = subpath ? path.join(embeddedMapped, subpath) : embeddedMapped;
      if (this.isExistingPath(cand)) {
        return {
          virtualPath: cleaned,
          physicalPath: path.resolve(cand),
          resolvedVia: 'embedded',
          packageName: pkgName,
        };
      }
    }

    const cacheFallbackRoot = this.findPackageCacheFallback(
      path.join(this.context.projectRoot, 'Library', 'PackageCache'),
      pkgName,
    );
    if (cacheFallbackRoot) {
      const cand = subpath ? path.join(cacheFallbackRoot, subpath) : cacheFallbackRoot;
      if (this.isExistingPath(cand)) {
        return {
          virtualPath: cleaned,
          physicalPath: path.resolve(cand),
          resolvedVia: 'packageCacheFallback',
          packageName: pkgName,
        };
      }
    }

    if (this.context.builtInPackagesPath) {
      const cand = path.join(this.context.builtInPackagesPath, pkgName, subpath);
      if (this.isExistingPath(cand)) {
        return {
          virtualPath: cleaned,
          physicalPath: path.resolve(cand),
          resolvedVia: 'builtin',
          packageName: pkgName,
        };
      }
    }

    return {
      virtualPath: cleaned,
      physicalPath: null,
      resolvedVia: 'unresolved',
      packageName: pkgName,
    };
  }

  public listVirtualDirectory(virtualPrefix: string, currentFilePath?: string): VirtualDirectoryEntry[] {
    this.refreshPackageMap(false);
    const cleaned = this.normalizeVirtualInput(virtualPrefix);

    if (cleaned === '' || cleaned === 'Packages' || cleaned === 'Packages/') {
      const results: VirtualDirectoryEntry[] = [];
      for (const [pkgName, entry] of this.packageMap.entries()) {
        results.push({
          name: pkgName,
          virtualPath: `Packages/${pkgName}/`,
          isDirectory: true,
          physicalPath: entry.physicalRoot,
        });
      }
      return results.sort((a, b) => a.name.localeCompare(b.name));
    }

    if (cleaned.startsWith('Packages/') || cleaned.startsWith('Assets/')) {
      const dirLookup = cleaned.replace(/\/$/, '');
      const mapping = this.resolve(dirLookup, currentFilePath);
      if (!mapping.physicalPath || !fs.existsSync(mapping.physicalPath)) {
        return [];
      }
      if (!fs.statSync(mapping.physicalPath).isDirectory()) {
        return [];
      }
      return this.listPhysicalDirectory(mapping.physicalPath, cleaned.endsWith('/') ? cleaned : `${cleaned}/`);
    }

    const entries: VirtualDirectoryEntry[] = [];
    const seen = new Set<string>();
    const addFromDir = (dirPath: string, prefix: string) => {
      if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return;
      for (const item of this.listPhysicalDirectory(dirPath, prefix)) {
        if (!seen.has(item.name)) {
          seen.add(item.name);
          entries.push(item);
        }
      }
    };

    if (currentFilePath) {
      const relDir = path.resolve(path.dirname(currentFilePath), cleaned);
      addFromDir(relDir, cleaned ? (cleaned.endsWith('/') ? cleaned : `${cleaned}/`) : '');
    }
    if (this.context.cgIncludesPath) {
      const cgDir = path.resolve(this.context.cgIncludesPath, cleaned);
      addFromDir(cgDir, cleaned ? (cleaned.endsWith('/') ? cleaned : `${cleaned}/`) : '');
    }

    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  private listPhysicalDirectory(dirPath: string, virtualBase: string): VirtualDirectoryEntry[] {
    const out: VirtualDirectoryEntry[] = [];
    try {
      for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        if (entry.name.endsWith('.meta')) continue;
        if (entry.isDirectory()) {
          out.push({
            name: entry.name,
            virtualPath: `${virtualBase}${entry.name}/`,
            isDirectory: true,
            physicalPath: path.join(dirPath, entry.name),
          });
        } else if (entry.isFile() && SHADER_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          out.push({
            name: entry.name,
            virtualPath: `${virtualBase}${entry.name}`,
            isDirectory: false,
            physicalPath: path.join(dirPath, entry.name),
          });
        }
      }
    } catch {
      return [];
    }
    return out.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
  }

  private normalizeVirtualInput(raw: string): string {
    return raw
      .trim()
      .replace(/^["'<]+|[">']+$/g, '')
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/');
  }

  private isExistingPath(targetPath: string): boolean {
    try {
      return fs.existsSync(targetPath);
    } catch {
      return false;
    }
  }
}
