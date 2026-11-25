import fs from 'node:fs';
import path from 'node:path';
import {
  normalizePathKey,
  type UnityVirtualPathResolver,
} from '../../../shader-lsp/src/vfs/virtualPathResolver.ts';
import type { CustomEditorDefinitionLocation } from './shaderCustomEditorResolver.ts';

export interface ShaderDirectiveTarget {
  kind: 'Fallback' | 'UsePass';
  shaderName: string;
  passName?: string;
  line: number;
  startCol: number;
  endCol: number;
}

interface ProjectShaderNameCache {
  packageMapSignature: string;
  shaders: Map<string, CustomEditorDefinitionLocation>;
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

const shaderNameCaches = new Map<string, ProjectShaderNameCache>();

function stripCommentsAndHlslBlocksPreservingLayout(shaderText: string): string {
  let out = '';
  let i = 0;
  const len = shaderText.length;
  let inLineComment = false;
  let inBlockComment = false;
  let inString = false;

  while (i < len) {
    const ch = shaderText[i];
    const next = i + 1 < len ? shaderText[i + 1] : '';

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

    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }

    out += ch;
    i++;
  }

  return out.replace(
    /\b(?:HLSLPROGRAM|HLSLINCLUDE)[\s\S]*?\bENDHLSL\b|\b(?:CGPROGRAM|CGINCLUDE)[\s\S]*?\bENDCG\b/g,
    (block) => block.replace(/[^\r\n]/g, ' '),
  );
}

/**
 * Find Fallback "..." or UsePass "ShaderName/PassName" directive at the given 0-based cursor position.
 */
export function findFallbackOrUsePassAtPosition(
  shaderText: string,
  line: number,
  _character: number,
): ShaderDirectiveTarget | null {
  const clean = stripCommentsAndHlslBlocksPreservingLayout(shaderText);

  const fallbackRe = /\bFallback\s+"([^"]+)"/gi;
  let match: RegExpExecArray | null;
  while ((match = fallbackRe.exec(clean)) !== null) {
    const rawName = match[1].trim();
    if (!rawName || rawName.toLowerCase() === 'off') continue;

    const fullMatch = match[0];
    const quoteIdx = fullMatch.indexOf('"');
    const nameOffset = fullMatch.indexOf(match[1], quoteIdx + 1);
    if (nameOffset < 0) continue;

    const absStart = match.index + nameOffset;
    const prefix = clean.slice(0, absStart);
    const lastNewline = prefix.lastIndexOf('\n');
    const matchLine = prefix.split('\n').length - 1;
    const startCol = lastNewline < 0 ? absStart : absStart - lastNewline - 1;
    const endCol = startCol + match[1].length;

    if (matchLine === line) {
      return {
        kind: 'Fallback',
        shaderName: rawName,
        line: matchLine,
        startCol,
        endCol,
      };
    }
  }

  const usePassRe = /\bUsePass\s+"([^"]+)\/([^"\/]+)"/gi;
  while ((match = usePassRe.exec(clean)) !== null) {
    const shaderName = match[1].trim();
    const passName = match[2].trim();
    if (!shaderName || !passName) continue;

    const fullMatch = match[0];
    const quoteIdx = fullMatch.indexOf('"');
    const innerStart = quoteIdx + 1;
    const absStart = match.index + innerStart;
    const innerLen = match[1].length + 1 + match[2].length;
    const prefix = clean.slice(0, absStart);
    const lastNewline = prefix.lastIndexOf('\n');
    const matchLine = prefix.split('\n').length - 1;
    const startCol = lastNewline < 0 ? absStart : absStart - lastNewline - 1;
    const endCol = startCol + innerLen;

    if (matchLine === line) {
      return {
        kind: 'UsePass',
        shaderName,
        passName,
        line: matchLine,
        startCol,
        endCol,
      };
    }
  }

  const rawLine = shaderText.split(/\r?\n/)[line];
  if (!rawLine) return null;
  const lineNoComment = rawLine.replace(/\/\/.*$/, '');

  const lineFallback = /\bFallback\s+"([^"]+)"/i.exec(lineNoComment);
  if (lineFallback) {
    const rawName = lineFallback[1].trim();
    if (rawName && rawName.toLowerCase() !== 'off') {
      const quoteIdx = lineFallback[0].indexOf('"');
      const nameOffset = lineFallback[0].indexOf(lineFallback[1], quoteIdx + 1);
      if (nameOffset >= 0) {
        const startCol = lineFallback.index + nameOffset;
        return {
          kind: 'Fallback',
          shaderName: rawName,
          line,
          startCol,
          endCol: startCol + lineFallback[1].length,
        };
      }
    }
  }

  const lineUsePass = /\bUsePass\s+"([^"]+)\/([^"\/]+)"/i.exec(lineNoComment);
  if (lineUsePass) {
    const shaderName = lineUsePass[1].trim();
    const passName = lineUsePass[2].trim();
    if (shaderName && passName) {
      const quoteIdx = lineUsePass[0].indexOf('"');
      const startCol = lineUsePass.index + quoteIdx + 1;
      const innerLen = lineUsePass[1].length + 1 + lineUsePass[2].length;
      return {
        kind: 'UsePass',
        shaderName,
        passName,
        line,
        startCol,
        endCol: startCol + innerLen,
      };
    }
  }

  return null;
}

function buildPackageMapSignature(resolver: UnityVirtualPathResolver): string {
  return Array.from(resolver.getPackageMap().values())
    .sort((a, b) => a.packageName.localeCompare(b.packageName))
    .map((e) => `${e.packageName}@${e.version}:${e.physicalRoot}`)
    .join('|');
}

function collectShaderFilesInRoot(rootDir: string): string[] {
  const results: string[] = [];
  if (!rootDir || !fs.existsSync(rootDir)) {
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
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        if (lower.endsWith('.shader') || lower.endsWith('.urtshader')) {
          results.push(path.join(current, entry.name));
        }
      }
    }
  }

  return results;
}

function getResolverProjectRoot(resolver: UnityVirtualPathResolver): string {
  if (typeof resolver.getContext === 'function') {
    return resolver.getContext().projectRoot;
  }
  return (resolver as unknown as { context: { projectRoot: string } }).context.projectRoot;
}

function getOrBuildShaderNameIndex(
  resolver: UnityVirtualPathResolver,
  fromFilePath?: string,
): Map<string, CustomEditorDefinitionLocation> {
  const projectRoot = getResolverProjectRoot(resolver);
  const projectKey = normalizePathKey(projectRoot);
  const pkgSig = buildPackageMapSignature(resolver);

  const cached = shaderNameCaches.get(projectKey);
  if (cached && cached.packageMapSignature === pkgSig) {
    const normFrom = fromFilePath ? normalizePathKey(fromFilePath) : '';
    if (!normFrom || normFrom.startsWith(projectKey)) {
      return cached.shaders;
    }
  }

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

  if (cached && cached.packageMapSignature === pkgSig) {
    // Check if fromFilePath is already inside the projectRoot (so cached index already covers it)
    const normProject = normalizePathKey(projectRoot);
    const normFrom = fromFilePath ? normalizePathKey(fromFilePath) : '';
    if (!normFrom || normFrom.startsWith(normProject)) {
      return cached.shaders;
    }
  }

  const shaders = new Map<string, CustomEditorDefinitionLocation>();
  const shaderDeclRe = /^\s*Shader\s+"([^"]+)"/m;

  for (const root of searchRoots) {
    for (const filePath of collectShaderFilesInRoot(root)) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const clean = stripCommentsAndHlslBlocksPreservingLayout(content);
        const match = shaderDeclRe.exec(clean);
        if (!match) continue;
        const name = match[1].trim();
        if (!name || shaders.has(name)) continue;

        const nameOffset = match.index + match[0].indexOf(match[1]);
        const prefix = clean.slice(0, nameOffset);
        const lastNewline = prefix.lastIndexOf('\n');
        const line = prefix.split('\n').length - 1;
        const column = lastNewline < 0 ? nameOffset : nameOffset - lastNewline - 1;

        shaders.set(name, {
          filePath,
          line,
          column,
          endColumn: column + match[1].length,
        });
      } catch {
        // Ignore unreadable shader file
      }
    }
  }

  shaderNameCaches.set(projectKey, {
    packageMapSignature: pkgSig,
    shaders,
  });

  return shaders;
}

function findPassNameInShaderFile(
  filePath: string,
  passName: string,
): CustomEditorDefinitionLocation | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const clean = stripCommentsAndHlslBlocksPreservingLayout(content);
    const escaped = passName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const passNameRe = new RegExp(`\\bName\\s+"(${escaped})"`, 'i');
    const match = passNameRe.exec(clean);
    if (!match) return null;

    const offset = match.index + match[0].indexOf(match[1]);
    const prefix = clean.slice(0, offset);
    const lastNewline = prefix.lastIndexOf('\n');
    const line = prefix.split('\n').length - 1;
    const column = lastNewline < 0 ? offset : offset - lastNewline - 1;
    return {
      filePath,
      line,
      column,
      endColumn: column + match[1].length,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve a ShaderLab Fallback "..." or UsePass "ShaderName/PassName" target across Assets/,
 * Packages/, and Library/PackageCache/.
 */
export function resolveShaderDefinitionByName(
  resolver: UnityVirtualPathResolver,
  shaderName: string,
  passName?: string,
  fromFilePath?: string,
): CustomEditorDefinitionLocation | null {
  const trimmedName = shaderName.trim();
  let index = getOrBuildShaderNameIndex(resolver, fromFilePath);
  let shaderLoc = index.get(trimmedName);
  if (!shaderLoc || !fs.existsSync(shaderLoc.filePath)) {
    invalidateShaderNameCache(getResolverProjectRoot(resolver));
    index = getOrBuildShaderNameIndex(resolver, fromFilePath);
    shaderLoc = index.get(trimmedName);
  }
  if (!shaderLoc) {
    return null;
  }

  if (passName) {
    const passLoc = findPassNameInShaderFile(shaderLoc.filePath, passName);
    if (passLoc) {
      return passLoc;
    }
  }

  return shaderLoc;
}

export function invalidateShaderNameCache(projectRoot?: string): void {
  if (!projectRoot) {
    shaderNameCaches.clear();
    return;
  }
  shaderNameCaches.delete(normalizePathKey(projectRoot));
}
