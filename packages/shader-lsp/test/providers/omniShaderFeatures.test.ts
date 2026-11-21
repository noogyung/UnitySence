import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { InsertTextFormat } from 'vscode-languageserver';
import type { UnityProjectContext } from '../../../extension/src/contracts/index.ts';
import { IncludeDependencyGraph } from '../../src/indexer/hlslIncludeGraph.ts';
import { ShaderCompletionProvider } from '../../src/providers/completionProvider.ts';
import { ShaderHoverProvider } from '../../src/providers/hoverProvider.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');
const tempDirs: string[] = [];

function createTempContext(): UnityProjectContext {
  const baseOut = path.join(REPO_ROOT, 'test-output');
  fs.mkdirSync(baseOut, { recursive: true });
  const root = fs.mkdtempSync(path.join(baseOut, 'ub-omni-lsp-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'Assets', 'Shaders'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Packages'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Packages', 'manifest.json'), '{"dependencies":{}}', 'utf8');
  return {
    projectRoot: root,
    editorVersion: '6000.0.1f1',
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

describe('Omni Shader Features in shader-lsp', () => {
  it('provides snippet-formatted insertText for Unity builtin macros and standard HLSL intrinsics', () => {
    const ctx = createTempContext();
    const graph = new IncludeDependencyGraph(ctx);
    const completion = new ShaderCompletionProvider(graph);
    const uri = pathToFileURL(path.join(ctx.projectRoot, 'Assets', 'Shaders', 'Test.hlsl')).toString();

    const cbufItems = completion.provideCompletionItems(uri, { line: 0, character: 7 }, 'CBUFFER');
    const cbuf = cbufItems.find((i) => i.label === 'CBUFFER_START');
    expect(cbuf).toBeDefined();
    expect(cbuf?.insertTextFormat).toBe(InsertTextFormat.Snippet);
    expect(cbuf?.insertText).toContain('CBUFFER_START(${1:UnityPerMaterial})');
    expect(cbuf?.insertText).toContain('CBUFFER_END');

    const intrinsicItems = completion.provideCompletionItems(uri, { line: 0, character: 3 }, 'ddx');
    expect(intrinsicItems.some((i) => i.label === 'ddx')).toBe(true);
  });

  it('completes and hovers ShaderLab Properties attributes, Tags, Blend/Stencil states outside HLSL blocks', () => {
    const ctx = createTempContext();
    const graph = new IncludeDependencyGraph(ctx);
    const completion = new ShaderCompletionProvider(graph);
    const hover = new ShaderHoverProvider(graph);
    const uri = pathToFileURL(path.join(ctx.projectRoot, 'Assets', 'Shaders', 'Lit.shader')).toString();

    const shaderSrc = [
      'Shader "Custom/Test"',
      '{',
      '    Properties',
      '    {',
      '        [HD',
      '        _BaseColor ("Color", Col',
      '    }',
      '    SubShader',
      '    {',
      '        Tags { "RenderPipeline" = "UniversalPipeline" }',
      '        Pass',
      '        {',
      '            Blend SrcAlpha OneMinusSrcAlpha',
      '            Stencil',
      '            {',
      '                Co',
      '            }',
      '        }',
      '    }',
      '}',
    ].join('\n');

    const attrItems = completion.provideCompletionItems(uri, { line: 4, character: 11 }, shaderSrc);
    expect(attrItems.some((i) => i.label === 'HDR')).toBe(true);

    const typeItems = completion.provideCompletionItems(uri, { line: 5, character: 32 }, shaderSrc);
    expect(typeItems.some((i) => i.label === 'Color')).toBe(true);

    const tagItems = completion.provideCompletionItems(uri, { line: 9, character: 15 }, shaderSrc);
    expect(tagItems.some((i) => i.label === 'RenderPipeline')).toBe(true);

    const stencilItems = completion.provideCompletionItems(uri, { line: 15, character: 18 }, shaderSrc);
    expect(stencilItems.some((i) => i.label === 'Comp')).toBe(true);

    const blendHover = hover.provideHover(uri, { line: 12, character: 14 }, shaderSrc, ctx.projectRoot);
    expect(blendHover).not.toBeNull();
    expect((blendHover?.contents as { value: string }).value).toContain('블렌딩');
  });

  it('completes Cull/ZWrite values, pragma entry functions, Display Name in Properties, and Color HEX hover', () => {
    const ctx = createTempContext();
    const graph = new IncludeDependencyGraph(ctx);
    const completion = new ShaderCompletionProvider(graph);
    const hover = new ShaderHoverProvider(graph);
    const uri = pathToFileURL(path.join(ctx.projectRoot, 'Assets', 'Shaders', 'Details.shader')).toString();

    const src = [
      'Shader "Custom/Details"',
      '{',
      '    Properties',
      '    {',
      '        [HDR] _EmissionColor ("Emission", Color) = (1, 0.5, 0, 1)',
      '        _NewCol (Col)',
      '    }',
      '    SubShader',
      '    {',
      '        Tags { "Queue" = "" }',
      '        Pass',
      '        {',
      '            Cull ',
      '            HLSLPROGRAM',
      '            #pragma vertex ',
      '            float4 myVert() : SV_POSITION { return _EmissionColor; }',
      '            ENDHLSL',
      '        }',
      '    }',
      '}',
    ].join('\n');

    const propTypeItems = completion.provideCompletionItems(uri, { line: 5, character: 20 }, src);
    const colorItem = propTypeItems.find((i) => i.label === 'Color');
    expect(colorItem?.insertText).toContain('Display Name');

    const queueItems = completion.provideCompletionItems(uri, { line: 9, character: 26 }, src);
    expect(queueItems.some((i) => i.label === 'Geometry')).toBe(true);

    const openQuoteTagSrc = 'Shader "A"\n{\n    SubShader\n    {\n        Tags { "Queue\n    }\n}';
    const openQuoteItems = completion.provideCompletionItems(uri, { line: 4, character: 21 }, openQuoteTagSrc);
    const qItem = openQuoteItems.find((i) => i.label === 'Queue');
    expect(qItem?.insertText?.startsWith('"')).toBe(false);
    expect(qItem?.insertText).toContain('Queue" = "');

    const cullItems = completion.provideCompletionItems(uri, { line: 12, character: 17 }, src);
    expect(cullItems.map((i) => i.label)).toEqual(['Back', 'Front', 'Off']);

    const pragmaFnItems = completion.provideCompletionItems(uri, { line: 14, character: 27 }, src);
    expect(pragmaFnItems.some((i) => i.label === 'myVert')).toBe(true);

    const colorHover = hover.provideHover(uri, { line: 15, character: 55 }, src, ctx.projectRoot);
    expect((colorHover?.contents as { value: string }).value).toContain('#FF8000FF');
  });

  it('disambiguates Hover on same-named struct field declarations (Step8Attributes vs Step8Varyings)', () => {
    const ctx = createTempContext();
    const graph = new IncludeDependencyGraph(ctx);
    const hover = new ShaderHoverProvider(graph);
    const uri = pathToFileURL(path.join(ctx.projectRoot, 'Assets', 'Shaders', 'Step8SurfaceDemo.shader')).toString();

    const src = [
      'Shader "UnityBrain/Step8SurfaceDemo"',
      '{',
      '    SubShader',
      '    {',
      '        Pass',
      '        {',
      '            HLSLPROGRAM',
      '            struct Step8Attributes',
      '            {',
      '                float4 positionOS : POSITION;',
      '                float2 texcoord : TEXCOORD0;',
      '            };',
      '            struct Step8Varyings',
      '            {',
      '                float4 positionHCS : SV_POSITION;',
      '                float2 texcoord : TEXCOORD0;',
      '            };',
      '            Step8Varyings Vert(Step8Attributes input)',
      '            {',
      '                Step8Varyings output;',
      '                output.texcoord = input.texcoord;',
      '                return output;',
      '            }',
      '            ENDHLSL',
      '        }',
      '    }',
      '}',
    ].join('\n');

    const lines = src.split('\n');
    const attrTexLine = lines.findIndex((l, idx) => idx < 12 && l.includes('float2 texcoord'));
    const attrTexCol = lines[attrTexLine].indexOf('texcoord') + 2;
    const varyTexLine = lines.findIndex((l, idx) => idx > 12 && l.includes('float2 texcoord'));
    const varyTexCol = lines[varyTexLine].indexOf('texcoord') + 2;

    const attrHover = hover.provideHover(uri, { line: attrTexLine, character: attrTexCol }, src, ctx.projectRoot);
    const attrValue = (attrHover?.contents as { value: string }).value;
    expect(attrValue).toContain('Step8Attributes');
    expect(attrValue).not.toContain('Step8Varyings');
    expect(attrValue).toContain(`Step8SurfaceDemo.shader:${attrTexLine + 1}`);

    const varyHover = hover.provideHover(uri, { line: varyTexLine, character: varyTexCol }, src, ctx.projectRoot);
    const varyValue = (varyHover?.contents as { value: string }).value;
    expect(varyValue).toContain('Step8Varyings');
    expect(varyValue).not.toContain('Step8Attributes');
    expect(varyValue).toContain(`Step8SurfaceDemo.shader:${varyTexLine + 1}`);
  });
});
