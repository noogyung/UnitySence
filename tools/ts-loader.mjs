import fs from 'node:fs';
import path from 'node:path';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

function tryResolveTsFile(candidatePath) {
  if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
    return candidatePath;
  }
  if (candidatePath.endsWith('.js')) {
    const tsPath = candidatePath.slice(0, -3) + '.ts';
    if (fs.existsSync(tsPath) && fs.statSync(tsPath).isFile()) {
      return tsPath;
    }
  }
  for (const ext of ['.ts', '.mts', '.js', '.mjs']) {
    const withExt = candidatePath + ext;
    if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
      return withExt;
    }
  }
  if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isDirectory()) {
    for (const indexFile of ['index.ts', 'index.js', 'index.mjs']) {
      const idx = path.join(candidatePath, indexFile);
      if (fs.existsSync(idx) && fs.statSync(idx).isFile()) {
        return idx;
      }
    }
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('./') ||
      specifier.startsWith('../') ||
      specifier.startsWith('file://')
    ) {
      const parentPath = context.parentURL
        ? fileURLToPath(context.parentURL)
        : path.join(process.cwd(), 'index.js');
      const targetPath = specifier.startsWith('file://')
        ? fileURLToPath(specifier)
        : path.resolve(path.dirname(parentPath), specifier);
      const resolved = tryResolveTsFile(targetPath);
      if (resolved) {
        return {
          url: pathToFileURL(resolved).href,
          shortCircuit: true
        };
      }
    }
    return nextResolve(specifier, context);
  },

  load(url, context, nextLoad) {
    if (url.endsWith('.ts') || url.endsWith('.mts')) {
      const filePath = fileURLToPath(url);
      const rawSource = fs.readFileSync(filePath, 'utf8');
      const transformed = stripTypeScriptTypes(rawSource, {
        mode: 'transform',
        sourceUrl: url
      });
      return {
        format: 'module',
        source: transformed,
        shortCircuit: true
      };
    }
    return nextLoad(url, context);
  }
});
