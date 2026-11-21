import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { UnityProjectContext } from '../../extension/src/contracts/index.ts';
import { IncludeDependencyGraph } from '../src/indexer/hlslIncludeGraph.ts';
import {
  extractShaderName,
  extractVirtualHlslDocument,
  parseShaderProperties,
} from '../src/parser/shaderLabVirtualDoc.ts';
import { UnityHlslMacroPrepass } from '../src/parser/unityHlslMacroPrepass.ts';
import { ShaderCompletionProvider } from '../src/providers/completionProvider.ts';
import { ShaderHoverProvider } from '../src/providers/hoverProvider.ts';
import { UnityVirtualPathResolver } from '../src/vfs/virtualPathResolver.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../..');
const tempDirs: string[] = [];

function createTempContext(): UnityProjectContext {
  const baseOut = path.join(REPO_ROOT, 'test-output');
  fs.mkdirSync(baseOut, { recursive: true });
  const root = fs.mkdtempSync(path.join(baseOut, 'ub-lsp-reg-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'Assets', 'Shaders'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Packages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Library', 'PackageCache'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Packages', 'manifest.json'), '{"dependencies":{}}', 'utf8');
  return {
    projectRoot: root,
    editorVersion: '6000.0.10f1',
    editorInstallPath: null,
    cgIncludesPath: null,
    builtInPackagesPath: null,
    manifestPath: path.join(root, 'Packages', 'manifest.json'),
    packagesLockPath: null,
    cacheDir: path.join(root, 'Library', 'UnityBrainCache'),
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Shader LSP Release Regression Suite', () => {
  it('picks highest semver PackageCache fallback and invalidates packages-lock.json edits at 0ms', () => {
    const ctx = createTempContext();
    const pkgCache = path.join(ctx.projectRoot, 'Library', 'PackageCache');
    const v1 = path.join(pkgCache, 'com.acme.shaders@1.2.0');
    const v2 = path.join(pkgCache, 'com.acme.shaders@1.10.0');
    const v3 = path.join(pkgCache, 'com.acme.shaders@1.3.0-preview.1');
    for (const dir of [v1, v2, v3]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'Common.hlsl'), '// ' + path.basename(dir), 'utf8');
    }

    const resolver = new UnityVirtualPathResolver(ctx);
    const shaderUri = path.join(ctx.projectRoot, 'Assets', 'Shaders', 'Test.shader');
    const picked = resolver.resolve('Packages/com.acme.shaders/Common.hlsl', shaderUri);
    expect(picked.physicalPath).toBe(path.join(v2, 'Common.hlsl'));

    // Immediate invalidation when packages-lock.json changes (even twice in same millisecond)
    const targetLockPkgDir = path.join(pkgCache, 'com.acme.custom@2.0.0');
    const targetNextPkgDir = path.join(pkgCache, 'com.acme.custom@2.1.0');
    fs.mkdirSync(targetLockPkgDir, { recursive: true });
    fs.mkdirSync(targetNextPkgDir, { recursive: true });
    fs.writeFileSync(path.join(targetLockPkgDir, 'Lib.hlsl'), '// 2.0', 'utf8');
    fs.writeFileSync(path.join(targetNextPkgDir, 'Lib.hlsl'), '// 2.1', 'utf8');

    const lockPath = path.join(ctx.projectRoot, 'Packages', 'packages-lock.json');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ dependencies: { 'com.acme.custom': { version: '2.0.0' } } }),
      'utf8',
    );
    ctx.packagesLockPath = lockPath;
    resolver.updateContext(ctx);
    expect(resolver.resolve('Packages/com.acme.custom/Lib.hlsl', shaderUri).physicalPath).toBe(
      path.join(targetLockPkgDir, 'Lib.hlsl'),
    );

    fs.writeFileSync(
      lockPath,
      JSON.stringify({ dependencies: { 'com.acme.custom': { version: '2.1.0' } } }),
      'utf8',
    );
    expect(resolver.resolve('Packages/com.acme.custom/Lib.hlsl', shaderUri).physicalPath).toBe(
      path.join(targetNextPkgDir, 'Lib.hlsl'),
    );
  });

  it('keeps comments inert in shaderLabVirtualDoc and parses geometry pragma & attributed properties', () => {
    const shaderText = [
      '// Shader "Commented/FakeShader"',
      '/* Shader "BlockComment/FakeShader" */',
      'Shader "Real/Lit"',
      '{',
      '    Properties',
      '    {',
      '        [MainTexture] [NoScaleOffset] _MainTex ("Albedo", 2D) = "white" {}',
      '        [Range(0.0, 1.0)] _Roughness ("Roughness", Range(0.0, 1.0)) = 0.5',
      '    }',
      '    SubShader',
      '    {',
      '        Pass',
      '        {',
      '            // HLSLPROGRAM fake block',
      '            /* HLSLPROGRAM also fake ENDHLSL */',
      '            HLSLPROGRAM',
      '            #pragma vertex vert',
      '            #pragma geometry geom',
      '            #pragma fragment frag',
      '            float4 vert(float4 p : POSITION) : SV_Position { return p; }',
      '            ENDHLSL',
      '        }',
      '    }',
      '}',
    ].join('\n');

    expect(extractShaderName(shaderText)).toBe('Real/Lit');
    const props = parseShaderProperties(shaderText, 'Test.shader');
    expect(props.map((p) => p.name)).toEqual(['_MainTex', '_Roughness']);
    expect(props[0].column).toBe(shaderText.split(/\r?\n/)[6].indexOf('_MainTex'));

    const doc = extractVirtualHlslDocument(shaderText, 'Test.shader');
    expect(doc.blocks.length).toBe(1);
    expect(doc.pragmas.entryPoints.some((e) => e.stage === 'geometry' && e.name === 'geom')).toBe(true);
  });

  it('expands RW_TEXTURE2D / TEXTURE2D_X_* macros and prunes stale include edges', () => {
    const prepass = new UnityHlslMacroPrepass();
    const hlsl = [
      'TEXTURE2D_X_HALF(_ColorTex);',
      'TEXTURE2D_X_FLOAT(_DepthTex);',
      'RW_TEXTURE2D(float4, _OutTex);',
      'RW_TEXTURE2D_X(float, _OutXR);',
    ].join('\n');
    const expanded = prepass.preprocess(hlsl, 'file:///test.compute');
    expect(expanded.synthesizedSymbols.some((s) => s.name === '_ColorTex')).toBe(true);
    expect(expanded.synthesizedSymbols.some((s) => s.name === '_DepthTex')).toBe(true);
    expect(expanded.synthesizedSymbols.some((s) => s.name === '_OutTex' && s.returnType.includes('RWTexture2D'))).toBe(true);
    expect(expanded.synthesizedSymbols.some((s) => s.name === '_OutXR' && s.returnType === 'RWTexture2D<float>')).toBe(true);

    const ctx = createTempContext();
    const incA = path.join(ctx.projectRoot, 'Assets', 'Shaders', 'IncA.hlsl');
    const main = path.join(ctx.projectRoot, 'Assets', 'Shaders', 'Main.shader');
    fs.writeFileSync(incA, 'float MyHelperA() { return 1.0; }\n', 'utf8');
    fs.writeFileSync(main, 'Shader "S" { SubShader { Pass { HLSLPROGRAM\n#include "IncA.hlsl"\nENDHLSL } } }\n', 'utf8');

    const graph = new IncludeDependencyGraph(ctx);
    graph.registerWorkspaceShaderFiles([main, incA]);
    const mainUri = pathToFileURL(main).toString();
    expect(graph.findParentIncludeFiles(incA).length).toBe(1);

    // Edit out the #include from main in memory -> stale reverse edge to IncA must be pruned
    graph.setOpenDocumentContent(mainUri, 'Shader "S" { SubShader { Pass { HLSLPROGRAM\nENDHLSL } } }\n');
    expect(graph.findParentIncludeFiles(incA).length).toBe(0);

    // Closing unsaved buffer restores disk edges
    graph.closeOpenDocument(mainUri);
    expect(graph.findParentIncludeFiles(incA).length).toBe(1);
  });

  it('completes core HLSL intrinsics and prioritizes ShaderLab hover docs outside HLSL blocks', () => {
    const ctx = createTempContext();
    const main = path.join(ctx.projectRoot, 'Assets', 'Shaders', 'HoverCase.shader');
    const source = [
      'Shader "Test/HoverCase"',
      '{',
      '    Properties',
      '    {',
      '        _Tint ("Tint Color", Color) = (1,1,1,1)',
      '    }',
      '    SubShader',
      '    {',
      '        Tags { "Queue" = "Transparent" }',
      '        Pass',
      '        {',
      '            ZWrite Off',
      '            HLSLPROGRAM',
      '            void ZWrite() {}',
      '            float4 frag() : SV_Target { return le }',
      '            ENDHLSL',
      '        }',
      '    }',
      '}',
    ].join('\n');
    fs.writeFileSync(main, source, 'utf8');
    const graph = new IncludeDependencyGraph(ctx);
    const uri = pathToFileURL(main).toString();

    const completion = new ShaderCompletionProvider(graph);
    const items = completion.provideCompletionItems(uri, { line: 14, character: 48 }, source);
    expect(items.some((i) => i.label === 'lerp')).toBe(true);

    const hover = new ShaderHoverProvider(graph);
    // Hovering ZWrite outside HLSLPROGRAM should show ShaderLab render state docs, not HLSL void ZWrite()
    const outsideHover = hover.provideHover(uri, { line: 11, character: 14 }, source, ctx.projectRoot);
    const outsideText =
      outsideHover && typeof outsideHover.contents === 'object' && 'value' in outsideHover.contents
        ? String(outsideHover.contents.value)
        : '';
    expect(outsideText).toContain('ZWrite');
    expect(outsideText).not.toContain('void ZWrite()');
  });
});
