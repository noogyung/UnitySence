import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync, spawnSync } from 'node:child_process';
import { stripTypeScriptTypes, builtinModules } from 'node:module';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');

function walkFiles(dir, predicate, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules' ||
      entry.name === 'dist' ||
      entry.name === 'bin' ||
      entry.name === 'obj' ||
      entry.name === '.git' ||
      entry.name === '.ref'
    ) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, predicate, results);
    } else if (predicate(full, entry.name)) {
      results.push(full);
    }
  }
  return results;
}

function stripJsCommentsAndStrings(code) {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];
    if (ch === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) {
        if (code[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      const q = ch;
      out += q;
      i++;
      while (i < code.length) {
        const c = code[i];
        if (c === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        if (c === q) {
          out += q;
          i++;
          break;
        }
        if (c === '\n') out += '\n';
        else out += ' ';
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function stripJsCommentsOnly(code) {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];
    if (ch === '\'' || ch === '"' || ch === '`') {
      const q = ch;
      out += cQuoteSlice();
      function cQuoteSlice() {
        let s = q;
        i++;
        while (i < code.length) {
          const c = code[i];
          s += c;
          i++;
          if (c === '\\' && i < code.length) {
            s += code[i];
            i++;
            continue;
          }
          if (c === q) break;
        }
        return s;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) {
        if (code[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function resolveTargetFile(fromFile, specifier) {
  if (specifier.startsWith('node:') || builtinModules.includes(specifier)) {
    return { ok: true, filePath: null };
  }
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    const pkgParts = specifier.split('/');
    const pkgName = specifier.startsWith('@') ? `${pkgParts[0]}/${pkgParts[1]}` : pkgParts[0];
    const pkgDir = path.join(ROOT, 'node_modules', pkgName);
    if (!fs.existsSync(pkgDir)) {
      return { ok: false, filePath: null };
    }
    const pkgJsonPath = path.join(pkgDir, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      const subpath = pkgParts.slice(specifier.startsWith('@') ? 2 : 1).join('/');
      if (!subpath) {
        const entryRel =
          pkg.exports?.['.']?.default ?? pkg.exports?.['.']?.import ?? pkg.main ?? 'index.js';
        const resolved = path.resolve(pkgDir, entryRel);
        return { ok: fs.existsSync(resolved), filePath: resolved };
      }
      const exportKey = `./${subpath}`;
      const mapped = pkg.exports?.[exportKey]?.default ?? pkg.exports?.[exportKey]?.import;
      if (mapped) {
        const resolved = path.resolve(pkgDir, mapped);
        return { ok: fs.existsSync(resolved), filePath: resolved };
      }
      const direct = path.resolve(pkgDir, subpath);
      return { ok: fs.existsSync(direct), filePath: direct };
    }
    return { ok: true, filePath: null };
  }
  const baseDir = path.dirname(fromFile);
  const rawTarget = path.resolve(baseDir, specifier.replace(/\/+$/, ''));
  const candidates = [
    rawTarget,
    rawTarget.endsWith('.js') ? rawTarget.slice(0, -3) + '.ts' : '',
    rawTarget.endsWith('.mjs') ? rawTarget.slice(0, -4) + '.mts' : '',
    rawTarget + '.ts',
    rawTarget + '.mts',
    rawTarget + '.js',
    rawTarget + '.mjs',
    rawTarget + '.json',
    path.join(rawTarget, 'index.ts'),
    path.join(rawTarget, 'index.js'),
    path.join(rawTarget, 'index.mjs'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) {
      return { ok: true, filePath: c };
    }
  }
  return { ok: false, filePath: null };
}

const exportCache = new Map();

function collectModuleValueExports(filePath, visited = new Set()) {
  const norm = path.resolve(filePath);
  if (exportCache.has(norm)) {
    return exportCache.get(norm);
  }
  if (visited.has(norm) || !fs.existsSync(norm)) {
    return new Set();
  }
  visited.add(norm);
  if (norm.endsWith('.json')) {
    const s = new Set(['default']);
    exportCache.set(norm, s);
    return s;
  }

  const raw = fs.readFileSync(norm, 'utf8');
  let jsText = raw;
  if (norm.endsWith('.ts') || norm.endsWith('.mts')) {
    try {
      jsText = stripTypeScriptTypes(raw, { mode: 'transform' });
    } catch {
      return new Set();
    }
  }
  const clean = stripJsCommentsOnly(jsText);
  const exports = new Set();

  const declRe = /\bexport\s+(?:async\s+)?(?:function\*?\s+|class\s+|const\s+|let\s+|var\s+)([A-Za-z_$][A-Za-z0-9_$]*)/g;
  let m;
  while ((m = declRe.exec(clean)) !== null) {
    exports.add(m[1]);
  }
  if (/\bexport\s+default\b/.test(clean)) {
    exports.add('default');
  }
  const destructRe = /\bexport\s+(?:const|let|var)\s*\{([^}]+)\}/g;
  while ((m = destructRe.exec(clean)) !== null) {
    for (const part of m[1].split(',')) {
      const cleaned = part.trim().split('=')[0].trim();
      const alias = cleaned.includes(':') ? cleaned.split(':')[1].trim() : cleaned;
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(alias)) exports.add(alias);
    }
  }
  const braceRe = /\bexport\s*\{([^}]+)\}(?:\s*from\s*['"]([^'"]+)['"])?/g;
  while ((m = braceRe.exec(clean)) !== null) {
    for (const item of m[1].split(',')) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      const asParts = trimmed.split(/\s+as\s+/);
      const exportedName = (asParts[1] ?? asParts[0]).trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exportedName)) {
        exports.add(exportedName);
      }
    }
  }
  const starRe = /\bexport\s*\*\s*(?:as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*)?from\s*['"]([^'"]+)['"]/g;
  while ((m = starRe.exec(clean)) !== null) {
    if (m[1]) {
      exports.add(m[1]);
    } else {
      const target = resolveTargetFile(norm, m[2]);
      if (target.ok && target.filePath) {
        for (const sub of collectModuleValueExports(target.filePath, visited)) {
          exports.add(sub);
        }
      }
    }
  }

  exportCache.set(norm, exports);
  return exports;
}

function cmdInstall() {
  const required = [
    'package.json',
    'pnpm-workspace.yaml',
    'tsconfig.base.json',
    'UnityBrain.sln',
    'packages/extension/src/contracts/index.ts',
    'node_modules/vitest/package.json',
    'node_modules/vscode/package.json',
    'node_modules/fast-xml-parser/package.json',
    'node_modules/vscode-jsonrpc/package.json',
    'node_modules/vscode-languageserver/package.json',
  ];
  const missing = required.filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
  if (missing.length > 0) {
    console.error('Missing workspace files:', missing.join(', '));
    process.exit(1);
  }
  const dotnetVer = execFileSync('dotnet', ['--version'], { encoding: 'utf8' }).trim();
  console.log(`Offline workspace ready. Node ${process.version}, .NET SDK ${dotnetVer}`);
}

function cmdExtractApi() {
  const loaderUrl = pathToFileURL(path.join(ROOT, 'tools', 'ts-loader.mjs')).href;
  const scriptPath = path.join(ROOT, 'tools', 'api-extractor', 'src', 'index.ts');
  const res = spawnSync(
    process.execPath,
    ['--no-warnings', '--import', loaderUrl, scriptPath],
    { cwd: ROOT, stdio: 'inherit' },
  );
  process.exit(res.status ?? 1);
}

function cmdTypecheck() {
  const tsFiles = [
    ...walkFiles(path.join(ROOT, 'packages'), (f) => f.endsWith('.ts') || f.endsWith('.mts')),
    ...walkFiles(path.join(ROOT, 'tools'), (f) => f.endsWith('.ts') || f.endsWith('.mts')),
  ];
  const jsonFiles = [
    ...walkFiles(path.join(ROOT, 'schemas'), (f) => f.endsWith('.json')),
    path.join(ROOT, 'package.json'),
    path.join(ROOT, 'packages', 'extension', 'package.json'),
    path.join(ROOT, 'packages', 'extension', 'language-configuration.json'),
    path.join(ROOT, 'packages', 'extension', 'resources', 'unity-api.json'),
    ...walkFiles(path.join(ROOT, 'packages', 'extension', 'syntaxes'), (f) => f.endsWith('.json')),
    ...walkFiles(path.join(ROOT, 'packages', 'extension', 'snippets'), (f) => f.endsWith('.json')),
  ].filter((jf) => fs.existsSync(jf));

  const errors = [];
  for (const jf of jsonFiles) {
    try {
      JSON.parse(fs.readFileSync(jf, 'utf8'));
    } catch (err) {
      errors.push(`${path.relative(ROOT, jf)}: JSON parse error: ${err.message}`);
    }
  }

  let checked = 0;
  for (const file of tsFiles) {
    const src = fs.readFileSync(file, 'utf8');
    let transformed;
    try {
      transformed = stripTypeScriptTypes(src, {
        mode: 'transform',
      });
    } catch (err) {
      errors.push(`${path.relative(ROOT, file)}: TypeScript syntax error: ${err.message}`);
      continue;
    }

    const cleanJs = stripJsCommentsOnly(transformed);
    const staticImportRe = /\b(?:import|export)\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]|\b(?:import|export)\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = staticImportRe.exec(cleanJs)) !== null) {
      const clause = (m[1] ?? '').trim();
      const spec = m[2] ?? m[3];
      const resolved = resolveTargetFile(file, spec);
      if (!resolved.ok) {
        errors.push(`${path.relative(ROOT, file)}: Unresolved import '${spec}'`);
        continue;
      }
      if (resolved.filePath && clause) {
        const namedMatch = /\{([^}]+)\}/.exec(clause);
        if (namedMatch) {
          const targetExports = collectModuleValueExports(resolved.filePath);
          if (targetExports.size > 0) {
            for (const part of namedMatch[1].split(',')) {
              const trimmed = part.trim();
              if (!trimmed) continue;
              const origName = trimmed.split(/\s+as\s+/)[0].trim();
              if (origName && !targetExports.has(origName)) {
                errors.push(
                  `${path.relative(ROOT, file)}: Missing exported symbol '${origName}' in '${spec}'`,
                );
              }
            }
          }
        }
      }
    }

    const noStringsJs = stripJsCommentsAndStrings(transformed);
    void noStringsJs;
    const dynImportRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = dynImportRe.exec(cleanJs)) !== null) {
      const spec = m[1];
      const resolved = resolveTargetFile(file, spec);
      if (!resolved.ok) {
        errors.push(`${path.relative(ROOT, file)}: Unresolved dynamic import '${spec}'`);
      }
    }
    checked++;
  }

  const tscBin = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (fs.existsSync(tscBin)) {
    for (const cfg of [
      'packages/extension/tsconfig.json',
      'packages/shader-lsp/tsconfig.json',
      'tools/api-extractor/tsconfig.json',
    ]) {
      const res = spawnSync(process.execPath, [tscBin, '-p', cfg, '--noEmit'], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      if (res.status !== 0) {
        errors.push(`tsc -p ${cfg} failed:\n${res.stdout}\n${res.stderr}`);
      }
    }
  }

  if (errors.length > 0) {
    console.error('Typecheck failed:\n' + errors.join('\n'));
    process.exit(1);
  }
  console.log(`Typecheck passed: ${checked} TypeScript files, ${jsonFiles.length} JSON files.`);
}

function cmdTest(filterArg) {
  const searchRoots = [];
  if (!filterArg || filterArg === 'all') {
    searchRoots.push(path.join(ROOT, 'packages'), path.join(ROOT, 'tools'));
  } else if (filterArg === 'api-extractor') {
    searchRoots.push(path.join(ROOT, 'tools', 'api-extractor'));
  } else {
    searchRoots.push(path.join(ROOT, 'packages', filterArg));
  }

  const testFiles = searchRoots.flatMap((dir) =>
    walkFiles(dir, (_full, name) => name.endsWith('.test.ts')),
  );

  if (testFiles.length === 0) {
    console.error(`No test files found for filter '${filterArg ?? 'all'}'.`);
    process.exit(1);
  }

  const loaderUrl = pathToFileURL(path.join(ROOT, 'tools', 'ts-loader.mjs')).href;
  const res = spawnSync(
    process.execPath,
    ['--no-warnings', '--import', loaderUrl, '--test', ...testFiles],
    { cwd: ROOT, stdio: 'inherit' },
  );
  process.exit(res.status ?? 1);
}

function isSameOrInsideDir(targetPath, rootDir) {
  const cmpTarget = process.platform === 'win32' ? targetPath.toLowerCase() : targetPath;
  const cmpRoot = process.platform === 'win32' ? rootDir.toLowerCase() : rootDir;
  return cmpTarget === cmpRoot || cmpTarget.startsWith(cmpRoot + path.sep);
}

function rewriteVscodeImportsSync(code) {
  let usesVscode = false;
  let result = code.replace(
    /^[ \t]*import[ \t]+((?:(?!\bimport\b)[^;])*?)[ \t]+from[ \t]+['"]vscode['"];?[ \t]*$/gm,
    (_full, rawClause) => {
      usesVscode = true;
      const clause = rawClause.trim();
      const nsOnly = /^\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(clause);
      if (nsOnly) {
        return `const ${nsOnly[1]} = __unitybrainVscode;`;
      }
      const namedOnly = /^\{([\s\S]*)\}$/.exec(clause);
      if (namedOnly) {
        const mapped = namedOnly[1].replace(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)/g, '$1: $2');
        return `const {${mapped}} = __unitybrainVscode;`;
      }
      const defaultAndNs = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*,\s*\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(clause);
      if (defaultAndNs) {
        return `const ${defaultAndNs[1]} = __unitybrainVscode; const ${defaultAndNs[2]} = __unitybrainVscode;`;
      }
      const defaultAndNamed = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*,\s*\{([\s\S]*)\}$/.exec(clause);
      if (defaultAndNamed) {
        const mapped = defaultAndNamed[2].replace(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)/g, '$1: $2');
        return `const ${defaultAndNamed[1]} = __unitybrainVscode; const {${mapped}} = __unitybrainVscode;`;
      }
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(clause)) {
        return `const ${clause} = __unitybrainVscode;`;
      }
      return `const vscode = __unitybrainVscode;`;
    },
  );
  if (usesVscode) {
    result =
      `import { createRequire as __createVscodeRequire } from 'node:module';\nconst __unitybrainVscode = globalThis.__unitybrainVscode ?? __createVscodeRequire(import.meta.url)('vscode');\n` +
      result;
  }
  return result;
}

function rewriteJsImports(code, srcFilePath, srcRoot, distRoot) {
  const shaderSrcRoot = path.join(ROOT, 'packages', 'shader-lsp', 'src');
  const distShaderRoot = path.join(ROOT, 'packages', 'extension', 'dist', 'shader-lsp');
  const relFromSrcRoot = path.relative(srcRoot, srcFilePath);
  const outRel = relFromSrcRoot.endsWith('.mts')
    ? relFromSrcRoot.slice(0, -4) + '.mjs'
    : relFromSrcRoot.slice(0, -3) + '.js';
  const outFile = path.join(distRoot, outRel);

  const withVscodeBridge = rewriteVscodeImportsSync(code);

  const rewriteSpec = (spec) => {
    const cleanSpec = spec.replace(/\/+$/, '') || '.';
    let absTarget = path.resolve(path.dirname(srcFilePath), cleanSpec);
    absTarget = absTarget.replace(/\.(?:mts|ts|js|mjs)$/i, '');

    if (isSameOrInsideDir(absTarget, shaderSrcRoot)) {
      const relInsideShader = path.relative(shaderSrcRoot, absTarget);
      let mappedOut = relInsideShader
        ? path.join(distShaderRoot, relInsideShader) + '.js'
        : path.join(distShaderRoot, 'index.js');
      if (
        fs.existsSync(absTarget) &&
        fs.statSync(absTarget).isDirectory() &&
        fs.existsSync(path.join(absTarget, 'index.ts'))
      ) {
        mappedOut = path.join(distShaderRoot, relInsideShader, 'index.js');
      }
      let relImport = path.relative(path.dirname(outFile), mappedOut).replace(/\\/g, '/');
      if (!relImport.startsWith('.')) {
        relImport = './' + relImport;
      }
      return relImport;
    }

    if (cleanSpec.endsWith('.ts')) {
      return cleanSpec.slice(0, -3) + '.js';
    }
    if (cleanSpec.endsWith('.mts')) {
      return cleanSpec.slice(0, -4) + '.mjs';
    }
    if (cleanSpec.endsWith('.js') || cleanSpec.endsWith('.mjs') || cleanSpec.endsWith('.cjs') || cleanSpec.endsWith('.json')) {
      return cleanSpec;
    }
    const rawAbs = path.resolve(path.dirname(srcFilePath), cleanSpec);
    if (
      fs.existsSync(rawAbs) &&
      fs.statSync(rawAbs).isDirectory() &&
      fs.existsSync(path.join(rawAbs, 'index.ts'))
    ) {
      return `${cleanSpec}/index.js`;
    }
    return `${cleanSpec}.js`;
  };

  let out = withVscodeBridge.replace(
    /((?:import|export)\s+(?:[^'"`;]*?\s+from\s+)?['"])(\.[^'"]+)(['"])/g,
    (_full, prefix, spec, suffix) => `${prefix}${rewriteSpec(spec)}${suffix}`,
  );
  out = out.replace(
    /(\bimport\s*\(\s*['"])(\.[^'"]+)(['"]\s*\))/g,
    (_full, prefix, spec, suffix) => `${prefix}${rewriteSpec(spec)}${suffix}`,
  );
  return out;
}

function compileTsDirectory(srcRoot, distRoot, preserveDirs = []) {
  if (fs.existsSync(distRoot)) {
    for (const entry of fs.readdirSync(distRoot)) {
      if (!preserveDirs.includes(entry)) {
        fs.rmSync(path.join(distRoot, entry), { recursive: true, force: true });
      }
    }
  }
  fs.mkdirSync(distRoot, { recursive: true });
  const files = walkFiles(srcRoot, (f) => f.endsWith('.ts') || f.endsWith('.mts'));
  for (const file of files) {
    const rel = path.relative(srcRoot, file);
    const outRel = rel.endsWith('.mts') ? rel.slice(0, -4) + '.mjs' : rel.slice(0, -3) + '.js';
    const outFile = path.join(distRoot, outRel);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const raw = fs.readFileSync(file, 'utf8');
    const transformed = stripTypeScriptTypes(raw, {
      mode: 'transform',
    });
    const rewritten = rewriteJsImports(transformed, file, srcRoot, distRoot);
    fs.writeFileSync(outFile, rewritten, 'utf8');
  }
  return files.length;
}

function cmdBuildAnalyzers() {
  const csproj = path.join(ROOT, 'analyzers', 'UnityBrain.Analyzers', 'UnityBrain.Analyzers.csproj');
  const buildArgs = ['build', csproj, '-c', 'Release', '-nodeReuse:false', '-p:UseSharedCompilation=false'];
  if (process.env.UseNuGetNetStandard !== 'true') {
    buildArgs.push('--no-restore');
  }
  const res = spawnSync('dotnet', buildArgs, { cwd: ROOT, stdio: 'inherit' });
  if (res.status !== 0) process.exit(res.status ?? 1);

  const releaseRoot = path.join(ROOT, 'analyzers', 'UnityBrain.Analyzers', 'bin', 'Release');
  const tfmDirs = fs.existsSync(releaseRoot)
    ? fs
        .readdirSync(releaseRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(releaseRoot, e.name, 'UnityBrain.Analyzers.dll'))
        .filter((p) => fs.existsSync(p))
    : [];
  tfmDirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const dll = tfmDirs[0];
  if (!dll) {
    console.error('Analyzer DLL not found after build in:', releaseRoot);
    process.exit(1);
  }
  const destDir = path.join(ROOT, 'packages', 'extension', 'analyzers');
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(dll, path.join(destDir, 'UnityBrain.Analyzers.dll'));
  console.log(`Copied ${path.relative(ROOT, dll)} to packages/extension/analyzers/`);
}

function cmdBuildDaemon() {
  const csproj = path.join(ROOT, 'packages', 'unity-daemon', 'UnityBrain.Daemon.csproj');
  const buildArgs = ['build', csproj, '-c', 'Release', '-nodeReuse:false', '-p:UseSharedCompilation=false'];
  if (process.env.UseNuGetNetStandard !== 'true') {
    buildArgs.push('--no-restore');
  }
  const res = spawnSync('dotnet', buildArgs, { cwd: ROOT, stdio: 'inherit' });
  if (res.status !== 0) process.exit(res.status ?? 1);

  const releaseRoot = path.join(ROOT, 'packages', 'unity-daemon', 'bin', 'Release');
  const preferredTfms = ['net8.0', 'net10.0'];
  const chosenTfm =
    preferredTfms.find((t) => fs.existsSync(path.join(releaseRoot, t, 'UnityBrain.Daemon.dll'))) ??
    fs.readdirSync(releaseRoot).find((t) => fs.existsSync(path.join(releaseRoot, t, 'UnityBrain.Daemon.dll')));
  if (!chosenTfm) {
    console.error('No Release TFM directory containing UnityBrain.Daemon.dll found.');
    process.exit(1);
  }
  const sourceDir = path.join(releaseRoot, chosenTfm);
  const destDir = path.join(ROOT, 'packages', 'extension', 'bin', 'daemon');
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });

  const allowedFiles = ['UnityBrain.Daemon.dll', 'UnityBrain.Daemon.runtimeconfig.json'];
  for (const name of allowedFiles) {
    const src = path.join(sourceDir, name);
    if (!fs.existsSync(src)) {
      console.error('Missing daemon artifact:', src);
      process.exit(1);
    }
    fs.copyFileSync(src, path.join(destDir, name));
  }
  console.log(`Copied daemon artifacts (${chosenTfm}: ${allowedFiles.join(', ')}) to packages/extension/bin/daemon/`);
}

function cmdBuildLsp() {
  const srcRoot = path.join(ROOT, 'packages', 'shader-lsp', 'src');
  const distRoot = path.join(ROOT, 'packages', 'extension', 'dist', 'shader-lsp');
  const count = compileTsDirectory(srcRoot, distRoot);
  fs.writeFileSync(path.join(distRoot, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
  console.log(`Built shader-lsp (${count} files) -> packages/extension/dist/shader-lsp/`);
}

function cmdBuildExtension() {
  const srcRoot = path.join(ROOT, 'packages', 'extension', 'src');
  const distRoot = path.join(ROOT, 'packages', 'extension', 'dist');
  const count = compileTsDirectory(srcRoot, distRoot, ['shader-lsp']);
  fs.writeFileSync(path.join(distRoot, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
  const cjsEntry = [
    "'use strict';",
    '',
    'let extensionModulePromise = null;',
    '',
    'exports.activate = async function activate(context, options) {',
    '  try {',
    "    globalThis.__unitybrainVscode = require('vscode');",
    '  } catch {',
    '    // Fall back to module-local createRequire when loaded outside VS Code Extension Host',
    '  }',
    '  if (!extensionModulePromise) {',
    "    extensionModulePromise = import('./extension.js');",
    '  }',
    '  const mod = await extensionModulePromise;',
    '  return mod.activate(context, options);',
    '};',
    '',
    'exports.deactivate = async function deactivate() {',
    '  if (!extensionModulePromise) return;',
    '  try {',
    '    const mod = await extensionModulePromise;',
    "    if (typeof mod.deactivate === 'function') {",
    '      return mod.deactivate();',
    '    }',
    '  } catch {',
    '    // Ignore deactivate error when activate failed to load module',
    '  }',
    '};',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(distRoot, 'extension.cjs'), cjsEntry, 'utf8');
  console.log(`Built extension (${count} files + extension.cjs) -> packages/extension/dist/`);
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') {
    return zlib.crc32(buf) >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const UTF8_FLAG = 0x0800;
  const DOS_TIME = 0x0000;
  const DOS_DATE = 0x0021; // 1980-01-01

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
    const rawData = entry.data;
    const compressed = zlib.deflateRawSync(rawData);
    const useDeflate = compressed.length < rawData.length;
    const payload = useDeflate ? compressed : rawData;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(rawData);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(UTF8_FLAG, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(DOS_TIME, 10);
    localHeader.writeUInt16LE(DOS_DATE, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(rawData.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(DOS_TIME, 12);
    centralHeader.writeUInt16LE(DOS_DATE, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(rawData.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + payload.length;
  }

  const centralSize = centralParts.reduce((acc, b) => acc + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function collectFilesRecursive(dir, basePrefix, entries, filterFn = () => true) {
  if (!fs.existsSync(dir)) return;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    const zipName = `${basePrefix}/${item.name}`;
    if (item.isDirectory()) {
      collectFilesRecursive(full, zipName, entries, filterFn);
    } else if (filterFn(full, item.name)) {
      entries.push({ name: zipName, data: fs.readFileSync(full) });
    }
  }
}

function cmdPackageVsix() {
  const extDir = path.join(ROOT, 'packages', 'extension');
  const pkg = JSON.parse(fs.readFileSync(path.join(extDir, 'package.json'), 'utf8'));

  const docPaths = {};
  const extraEntries = [];
  for (const docFile of ['README.md', 'CHANGELOG.md', 'LICENSE', 'language-configuration.json']) {
    const extDoc = path.join(extDir, docFile);
    const rootDoc = path.join(ROOT, docFile);
    const chosen = fs.existsSync(extDoc) ? extDoc : (fs.existsSync(rootDoc) ? rootDoc : null);
    if (chosen) {
      const zipPath = `extension/${docFile}`;
      docPaths[docFile] = zipPath;
      extraEntries.push({ name: zipPath, data: fs.readFileSync(chosen) });
    }
  }

  const contentTypesXml = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="map" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="cjs" ContentType="application/javascript" />
  <Default Extension="mjs" ContentType="application/javascript" />
  <Default Extension="dll" ContentType="application/octet-stream" />
  <Default Extension="pdb" ContentType="application/octet-stream" />
  <Default Extension="exe" ContentType="application/octet-stream" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
  <Default Extension="xml" ContentType="text/xml" />
  <Default Extension="md" ContentType="text/plain" />
  <Default Extension="txt" ContentType="text/plain" />
  <Default Extension="png" ContentType="image/png" />
  <Default Extension="svg" ContentType="image/svg+xml" />${docPaths['LICENSE'] ? `\n  <Override PartName="/${docPaths['LICENSE']}" ContentType="text/plain" />` : ''}
</Types>`;

  const iconRel = pkg.icon ? String(pkg.icon).replace(/^\.\//, '') : '';
  const hasIcon = iconRel && fs.existsSync(path.join(extDir, iconRel));
  const tags = Array.isArray(pkg.keywords) ? pkg.keywords.map(escapeXml).join(',') : '';
  const categories = Array.isArray(pkg.categories) ? pkg.categories.map(escapeXml).join(',') : '';
  const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? '');
  const engineVer = pkg.engines?.vscode ?? '^1.90.0';

  const manifestAssets = [
    `    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />`,
    hasIcon ? `    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/${escapeXml(iconRel)}" Addressable="true" />` : '',
    docPaths['README.md'] ? `    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="${docPaths['README.md']}" Addressable="true" />` : '',
    docPaths['CHANGELOG.md'] ? `    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="${docPaths['CHANGELOG.md']}" Addressable="true" />` : '',
    docPaths['LICENSE'] ? `    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="${docPaths['LICENSE']}" Addressable="true" />` : '',
  ].filter(Boolean).join('\n');

  const manifestXml = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${escapeXml(pkg.name)}" Version="${escapeXml(pkg.version)}" Publisher="${escapeXml(pkg.publisher || 'unitybrain')}" />
    <DisplayName>${escapeXml(pkg.displayName || 'UnityBrain')}</DisplayName>
    <Description xml:space="preserve">${escapeXml(pkg.description || '')}</Description>${tags ? `\n    <Tags>${tags}</Tags>` : ''}${categories ? `\n    <Categories>${categories}</Categories>` : ''}${docPaths['LICENSE'] ? `\n    <License>${docPaths['LICENSE']}</License>` : ''}
    <GalleryFlags>Public</GalleryFlags>${hasIcon ? `\n    <Icon>extension/${escapeXml(iconRel)}</Icon>` : ''}
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${escapeXml(engineVer)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />${repoUrl ? `\n      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="${escapeXml(repoUrl)}" />\n      <Property Id="Microsoft.VisualStudio.Services.Links.GitHub" Value="${escapeXml(repoUrl)}" />` : ''}
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
${manifestAssets}
  </Assets>
</PackageManifest>`;

  const entries = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypesXml, 'utf8') },
    { name: 'extension.vsixmanifest', data: Buffer.from(manifestXml, 'utf8') },
    { name: 'extension/package.json', data: fs.readFileSync(path.join(extDir, 'package.json')) },
    ...extraEntries,
  ];

  for (const folder of ['dist', 'resources', 'syntaxes', 'snippets', 'analyzers', 'bin']) {
    collectFilesRecursive(path.join(extDir, folder), `extension/${folder}`, entries);
  }
  for (const runtimePkg of ['vscode-languageserver', 'vscode-jsonrpc']) {
    collectFilesRecursive(
      path.join(ROOT, 'node_modules', runtimePkg),
      `extension/node_modules/${runtimePkg}`,
      entries,
      (_full, name) => !name.endsWith('.d.ts') && !name.endsWith('.d.mts'),
    );
  }

  const requiredSuffixes = [
    'extension/package.json',
    'extension/dist/extension.cjs',
    'extension/dist/extension.js',
    'extension/dist/shader-lsp/server.js',
    'extension/analyzers/UnityBrain.Analyzers.dll',
    'extension/bin/daemon/UnityBrain.Daemon.dll',
    'extension/bin/daemon/UnityBrain.Daemon.runtimeconfig.json',
    'extension/resources/unity-api.json',
  ];

  const entrySet = new Set(entries.map((e) => e.name));
  const missing = requiredSuffixes.filter((req) => !entrySet.has(req));
  if (missing.length > 0) {
    console.error('Cannot package VSIX; missing required artifacts:', missing.join(', '));
    process.exit(1);
  }

  const zipBuf = createZipBuffer(entries);
  const outDir = path.join(ROOT, 'dist');
  fs.mkdirSync(outDir, { recursive: true });
  for (const existingFile of fs.readdirSync(outDir)) {
    if (existingFile.startsWith(`${pkg.name}-`) && existingFile.endsWith('.vsix')) {
      fs.rmSync(path.join(outDir, existingFile), { force: true });
    }
  }
  const vsixPath = path.join(outDir, `${pkg.name}-${pkg.version}.vsix`);
  fs.writeFileSync(vsixPath, zipBuf);
  console.log(`Packaged ${vsixPath} (${entries.length} entries, ${zipBuf.length} bytes)`);
}

function cmdBuildAll() {
  cmdBuildAnalyzers();
  cmdBuildDaemon();
  cmdBuildLsp();
  cmdBuildExtension();
}

const [, , cmd, arg] = process.argv;
switch (cmd) {
  case 'install':
    cmdInstall();
    break;
  case 'extract:api':
    cmdExtractApi();
    break;
  case 'typecheck':
    cmdTypecheck();
    break;
  case 'test':
    cmdTest(arg);
    break;
  case 'build':
    cmdBuildAll();
    break;
  case 'build:analyzers':
    cmdBuildAnalyzers();
    break;
  case 'build:daemon':
    cmdBuildDaemon();
    break;
  case 'build:lsp':
    cmdBuildLsp();
    break;
  case 'build:extension':
    cmdBuildExtension();
    break;
  case 'package:vsix':
    cmdPackageVsix();
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    process.exit(1);
}
