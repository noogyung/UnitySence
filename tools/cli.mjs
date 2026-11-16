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
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'bin' || entry.name === 'obj' || entry.name === '.git' || entry.name === '.ref') {
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

function resolveImportTarget(fromFile, specifier) {
  if (specifier.startsWith('node:') || builtinModules.includes(specifier)) {
    return true;
  }
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    const pkgParts = specifier.split('/');
    const pkgName = specifier.startsWith('@') ? `${pkgParts[0]}/${pkgParts[1]}` : pkgParts[0];
    return fs.existsSync(path.join(ROOT, 'node_modules', pkgName));
  }
  const baseDir = path.dirname(fromFile);
  const rawTarget = path.resolve(baseDir, specifier);
  const candidates = [
    rawTarget,
    rawTarget.endsWith('.js') ? rawTarget.slice(0, -3) + '.ts' : '',
    rawTarget + '.ts',
    rawTarget + '.js',
    rawTarget + '.json',
    path.join(rawTarget, 'index.ts'),
    path.join(rawTarget, 'index.js')
  ].filter(Boolean);
  return candidates.some((c) => fs.existsSync(c) && fs.statSync(c).isFile());
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
    'node_modules/vscode-languageserver/package.json'
  ];
  const missing = required.filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
  if (missing.length > 0) {
    console.error('Missing workspace files:', missing.join(', '));
    process.exit(1);
  }
  const dotnetVer = execFileSync('dotnet', ['--version'], { encoding: 'utf8' }).trim();
  console.log(`Offline workspace ready. Node ${process.version}, .NET SDK ${dotnetVer}`);
}

function cmdTypecheck() {
  const tsFiles = [
    ...walkFiles(path.join(ROOT, 'packages'), (f) => f.endsWith('.ts')),
    ...walkFiles(path.join(ROOT, 'tools'), (f) => f.endsWith('.ts'))
  ];
  const jsonFiles = [
    ...walkFiles(path.join(ROOT, 'schemas'), (f) => f.endsWith('.json'))
  ];
  for (const jf of jsonFiles) {
    JSON.parse(fs.readFileSync(jf, 'utf8'));
  }

  let checked = 0;
  const errors = [];
  for (const file of tsFiles) {
    const src = fs.readFileSync(file, 'utf8');
    try {
      stripTypeScriptTypes(src, {
        mode: 'transform',
        sourceUrl: pathToFileURL(file).href
      });
    } catch (err) {
      errors.push(`${path.relative(ROOT, file)}: TypeScript syntax error: ${err.message}`);
      continue;
    }

    const importRegex = /(?:import|export)\s+(?:type\s+)?(?:[^'"`;]+?\s+from\s+)?['"]([^'"]+)['"]/g;
    let m;
    while ((m = importRegex.exec(src)) !== null) {
      const spec = m[1];
      if (!resolveImportTarget(file, spec)) {
        errors.push(`${path.relative(ROOT, file)}: Unresolved import '${spec}'`);
      }
    }
    checked++;
  }

  if (errors.length > 0) {
    console.error('Typecheck failed:\n' + errors.join('\n'));
    process.exit(1);
  }
  console.log(`Typecheck passed: ${checked} TypeScript files, ${jsonFiles.length} JSON schemas.`);
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
    walkFiles(dir, (full, name) => name.endsWith('.test.ts'))
  );

  if (testFiles.length === 0) {
    console.error(`No test files found for filter '${filterArg ?? 'all'}'.`);
    process.exit(1);
  }

  const loaderUrl = pathToFileURL(path.join(ROOT, 'tools', 'ts-loader.mjs')).href;
  const res = spawnSync(
    process.execPath,
    ['--no-warnings', '--import', loaderUrl, '--test', ...testFiles],
    { cwd: ROOT, stdio: 'inherit' }
  );
  process.exit(res.status ?? 1);
}

function rewriteJsImports(code, srcFilePath, srcRoot, distRoot) {
  const shaderSrcRoot = path.join(ROOT, 'packages', 'shader-lsp', 'src');
  const distShaderRoot = path.join(ROOT, 'packages', 'extension', 'dist', 'shader-lsp');
  const relFromSrcRoot = path.relative(srcRoot, srcFilePath);
  const outFile = path.join(distRoot, relFromSrcRoot.slice(0, -3) + '.js');

  const withVscodeBridge = code.replace(
    /^\s*import\s+(?:\*\s+as\s+)?vscode\s+from\s+['"]vscode['"];?\s*$/gm,
    "import { createRequire as __createVscodeRequire } from 'node:module'; const vscode = await (async () => { try { return __createVscodeRequire(import.meta.url)('vscode'); } catch { return await import('vscode'); } })();",
  );

  return withVscodeBridge.replace(
    /((?:import|export)\s+(?:[^'"`;]*?\s+from\s+)?['"])(\.[^'"]+)(['"])/g,
    (full, prefix, spec, suffix) => {
      let absTarget = path.resolve(path.dirname(srcFilePath), spec);
      if (absTarget.endsWith('.ts')) {
        absTarget = absTarget.slice(0, -3);
      }
      if (absTarget.startsWith(shaderSrcRoot + path.sep) || absTarget === shaderSrcRoot) {
        const relInsideShader = path.relative(shaderSrcRoot, absTarget);
        let mappedOut = path.join(distShaderRoot, relInsideShader) + '.js';
        if (fs.existsSync(absTarget) && fs.statSync(absTarget).isDirectory() && fs.existsSync(path.join(absTarget, 'index.ts'))) {
          mappedOut = path.join(distShaderRoot, relInsideShader, 'index.js');
        }
        let relImport = path.relative(path.dirname(outFile), mappedOut).replace(/\\/g, '/');
        if (!relImport.startsWith('.')) {
          relImport = './' + relImport;
        }
        return `${prefix}${relImport}${suffix}`;
      }
      if (spec.endsWith('.ts')) {
        return `${prefix}${spec.slice(0, -3)}.js${suffix}`;
      }
      if (spec.endsWith('.js') || spec.endsWith('.json')) {
        return full;
      }
      const rawAbs = path.resolve(path.dirname(srcFilePath), spec);
      if (fs.existsSync(rawAbs) && fs.statSync(rawAbs).isDirectory() && fs.existsSync(path.join(rawAbs, 'index.ts'))) {
        return `${prefix}${spec}/index.js${suffix}`;
      }
      return `${prefix}${spec}.js${suffix}`;
    }
  );
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
  const files = walkFiles(srcRoot, (f) => f.endsWith('.ts'));
  for (const file of files) {
    const rel = path.relative(srcRoot, file);
    const outFile = path.join(distRoot, rel.slice(0, -3) + '.js');
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const raw = fs.readFileSync(file, 'utf8');
    const transformed = stripTypeScriptTypes(raw, {
      mode: 'transform',
      sourceUrl: pathToFileURL(file).href
    });
    const rewritten = rewriteJsImports(transformed, file, srcRoot, distRoot);
    fs.writeFileSync(outFile, rewritten, 'utf8');
  }
  return files.length;
}

function cmdBuildAnalyzers() {
  const csproj = path.join(ROOT, 'analyzers', 'UnityBrain.Analyzers', 'UnityBrain.Analyzers.csproj');
  const res = spawnSync(
    'dotnet',
    ['build', csproj, '-c', 'Release', '-nodeReuse:false', '-p:UseSharedCompilation=false'],
    { cwd: ROOT, stdio: 'inherit' }
  );
  if (res.status !== 0) process.exit(res.status ?? 1);

  const outDir = path.join(ROOT, 'analyzers', 'UnityBrain.Analyzers', 'bin', 'Release', 'netstandard2.0');
  const fallbackDir = path.join(ROOT, 'analyzers', 'UnityBrain.Analyzers', 'bin', 'Release', 'net10.0');
  const sourceDir = fs.existsSync(outDir) ? outDir : fallbackDir;
  const destDir = path.join(ROOT, 'packages', 'extension', 'analyzers');
  fs.mkdirSync(destDir, { recursive: true });
  const dll = path.join(sourceDir, 'UnityBrain.Analyzers.dll');
  if (!fs.existsSync(dll)) {
    console.error('Analyzer DLL not found after build:', dll);
    process.exit(1);
  }
  fs.copyFileSync(dll, path.join(destDir, 'UnityBrain.Analyzers.dll'));
  console.log('Copied UnityBrain.Analyzers.dll to packages/extension/analyzers/');
}

function cmdBuildDaemon() {
  const csproj = path.join(ROOT, 'packages', 'unity-daemon', 'UnityBrain.Daemon.csproj');
  const res = spawnSync(
    'dotnet',
    ['build', csproj, '-c', 'Release', '-nodeReuse:false', '-p:UseSharedCompilation=false'],
    { cwd: ROOT, stdio: 'inherit' }
  );
  if (res.status !== 0) process.exit(res.status ?? 1);

  const releaseRoot = path.join(ROOT, 'packages', 'unity-daemon', 'bin', 'Release');
  const tfms = fs.readdirSync(releaseRoot);
  if (tfms.length === 0) {
    console.error('No Release TFM directory found for daemon.');
    process.exit(1);
  }
  const sourceDir = path.join(releaseRoot, tfms[0]);
  const destDir = path.join(ROOT, 'packages', 'extension', 'bin', 'daemon');
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of fs.readdirSync(sourceDir)) {
    const src = path.join(sourceDir, name);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, path.join(destDir, name));
    }
  }
  console.log(`Copied daemon artifacts (${tfms[0]}) to packages/extension/bin/daemon/`);
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
    "const extensionModulePromise = import('./extension.js');",
    '',
    'exports.activate = async function activate(context, options) {',
    '  const mod = await extensionModulePromise;',
    '  return mod.activate(context, options);',
    '};',
    '',
    'exports.deactivate = async function deactivate() {',
    '  const mod = await extensionModulePromise;',
    "  if (typeof mod.deactivate === 'function') {",
    '    return mod.deactivate();',
    '  }',
    '};',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(distRoot, 'extension.cjs'), cjsEntry, 'utf8');
  console.log(`Built extension (${count} files + extension.cjs) -> packages/extension/dist/`);
}

function crc32(buf) {
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
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
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
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
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

function collectFilesRecursive(dir, basePrefix, entries) {
  if (!fs.existsSync(dir)) return;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    const zipName = `${basePrefix}/${item.name}`;
    if (item.isDirectory()) {
      collectFilesRecursive(full, zipName, entries);
    } else {
      entries.push({ name: zipName, data: fs.readFileSync(full) });
    }
  }
}

function cmdPackageVsix() {
  const extDir = path.join(ROOT, 'packages', 'extension');
  const pkg = JSON.parse(fs.readFileSync(path.join(extDir, 'package.json'), 'utf8'));

  const contentTypesXml = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".dll" ContentType="application/octet-stream" />
  <Default Extension=".exe" ContentType="application/octet-stream" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
</Types>`;

  const manifestXml = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher || 'unitybrain'}" />
    <DisplayName>${pkg.displayName || 'UnityBrain'}</DisplayName>
    <Description xml:space="preserve">${pkg.description || ''}</Description>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>`;

  const entries = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypesXml, 'utf8') },
    { name: 'extension.vsixmanifest', data: Buffer.from(manifestXml, 'utf8') },
    { name: 'extension/package.json', data: fs.readFileSync(path.join(extDir, 'package.json')) }
  ];

  for (const folder of ['dist', 'resources', 'syntaxes', 'analyzers', 'bin']) {
    collectFilesRecursive(path.join(extDir, folder), `extension/${folder}`, entries);
  }
  for (const runtimePkg of ['vscode-languageserver', 'vscode-jsonrpc', 'fast-xml-parser']) {
    collectFilesRecursive(path.join(ROOT, 'node_modules', runtimePkg), `extension/node_modules/${runtimePkg}`, entries);
  }

  const requiredSuffixes = [
    'extension/package.json',
    'extension/dist/extension.cjs',
    'extension/dist/extension.js',
    'extension/dist/shader-lsp/server.js',
    'extension/analyzers/UnityBrain.Analyzers.dll',
    'extension/bin/daemon/UnityBrain.Daemon.dll',
    'extension/resources/unity-api.json'
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
  const vsixPath = path.join(outDir, `${pkg.name}-${pkg.version}.vsix`);
  fs.writeFileSync(vsixPath, zipBuf);
  console.log(`Packaged ${vsixPath} (${entries.length} entries, ${zipBuf.length} bytes)`);
}

const [, , cmd, arg] = process.argv;
switch (cmd) {
  case 'install':
    cmdInstall();
    break;
  case 'typecheck':
    cmdTypecheck();
    break;
  case 'test':
    cmdTest(arg);
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
