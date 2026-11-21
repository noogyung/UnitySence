import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc';
import { createConnection } from 'vscode-languageserver';
import type { ShaderSymbolIndex, UnityProjectContext } from '../../extension/src/contracts/index.ts';
import { IncludeDependencyGraph } from '../src/indexer/hlslIncludeGraph.ts';
import { ShaderCompletionProvider } from '../src/providers/completionProvider.ts';
import { ShaderHoverProvider } from '../src/providers/hoverProvider.ts';
import { ShaderDefinitionProvider } from '../src/providers/definitionProvider.ts';
import { createShaderLanguageServer } from '../src/server.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../..');
const SAMPLE_PROJECT = path.join(REPO_ROOT, 'test-fixtures', 'SampleUnityProject');
const SAMPLE_EDITOR = path.join(REPO_ROOT, 'test-fixtures', 'SampleEditor');
const BENCHMARK_DIR = path.join(REPO_ROOT, 'test-output', 'shader-lsp-bench-50');

function createSampleContext(): UnityProjectContext {
  return {
    projectRoot: SAMPLE_PROJECT,
    editorVersion: '6000.0.23f1',
    editorInstallPath: SAMPLE_EDITOR,
    cgIncludesPath: path.join(SAMPLE_EDITOR, 'Data', 'CGIncludes'),
    builtInPackagesPath: path.join(
      SAMPLE_EDITOR,
      'Data',
      'Resources',
      'PackageManager',
      'BuiltInPackages',
    ),
    manifestPath: path.join(SAMPLE_PROJECT, 'Packages', 'manifest.json'),
    packagesLockPath: path.join(SAMPLE_PROJECT, 'Packages', 'packages-lock.json'),
    cacheDir: path.join(SAMPLE_PROJECT, 'Library', 'UnityBrainCache'),
  };
}

describe('ShaderCompletionProvider, ShaderHoverProvider, Server RPC & 50-file Benchmark', () => {
  afterEach(() => {
    if (fs.existsSync(BENCHMARK_DIR)) {
      fs.rmSync(BENCHMARK_DIR, { recursive: true, force: true });
    }
  });

  it('provides #include virtual directory completions, struct member fields, and hover docs with virtual path', () => {
    const ctx = createSampleContext();
    const graph = new IncludeDependencyGraph(ctx);
    const completion = new ShaderCompletionProvider(graph);
    const hover = new ShaderHoverProvider(graph);

    const shaderPath = path.join(SAMPLE_PROJECT, 'Assets', 'Shaders', 'TestLit.shader');
    const shaderUri = pathToFileURL(shaderPath).toString();
    const content = fs.readFileSync(shaderPath, 'utf8');

    // #include completion after "Packages/"
    const synthetic = `${content}\n#include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/`;
    const syntheticLines = synthetic.split('\n');
    const lastLine = syntheticLines.length - 1;
    const incItems = completion.provideCompletionItems(
      shaderUri,
      { line: lastLine, character: syntheticLines[lastLine].length },
      synthetic,
    );
    expect(incItems.some((item) => item.label === 'Core.hlsl')).toBe(true);
    expect(incItems.some((item) => item.label === 'Lighting.hlsl')).toBe(true);

    // Preprocessor directive completion after `#include_`
    const dirDoc = `${content}\n      #include_`;
    const dirLines = dirDoc.split('\n');
    const dirLineIdx = dirLines.length - 1;
    const dirItems = completion.provideCompletionItems(
      shaderUri,
      { line: dirLineIdx, character: dirLines[dirLineIdx].length },
      dirDoc,
    );
    const incWithPragmas = dirItems.find((item) => item.label === '#include_with_pragmas');
    expect(incWithPragmas).toBeDefined();
    expect(incWithPragmas?.insertText).toBe('include_with_pragmas "');

    // Member completion for `data.` (InputData)
    const lines = content.split(/\r?\n/);
    const dataLine = lines.findIndex((l) => l.includes('data.normalWS ='));
    const dotChar = lines[dataLine].indexOf('data.') + 'data.'.length;
    const fieldItems = completion.provideCompletionItems(
      shaderUri,
      { line: dataLine, character: dotChar },
      content,
    );
    expect(fieldItems.map((i) => i.label)).toContain('normalWS');
    expect(fieldItems.map((i) => i.label)).toContain('viewDirectionWS');

    // Hover on UniversalFragmentPBR
    const callLine = lines.findIndex((l) => l.includes('UniversalFragmentPBR('));
    const callCol = lines[callLine].indexOf('UniversalFragmentPBR') + 3;
    const hoverRes = hover.provideHover(
      shaderUri,
      { line: callLine, character: callCol },
      content,
      ctx.projectRoot,
    );
    expect(hoverRes).not.toBeNull();
    const hoverMd = typeof hoverRes?.contents === 'string' ? hoverRes.contents : hoverRes?.contents.value;
    expect(hoverMd).toContain('UniversalFragmentPBR');
    expect(hoverMd).toContain('Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl');
  });

  it('serves LSP requests over JSON-RPC streams including custom RPCs and unresolved diagnostics', async () => {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();

    const serverConn = createConnection(clientToServer, serverToClient);
    const serverHandle = createShaderLanguageServer(serverConn, createSampleContext());

    const clientConn = createMessageConnection(
      new StreamMessageReader(serverToClient),
      new StreamMessageWriter(clientToServer),
    );
    const publishedDiagnostics: unknown[] = [];
    clientConn.onNotification('textDocument/publishDiagnostics', (p) => {
      publishedDiagnostics.push(p);
    });
    clientConn.listen();

    await clientConn.sendRequest('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(SAMPLE_PROJECT).toString(),
      initializationOptions: { unityContext: createSampleContext() },
    });

    const shaderPath = path.join(SAMPLE_PROJECT, 'Assets', 'Shaders', 'TestLit.shader');
    const shaderUri = pathToFileURL(shaderPath).toString();
    const content = fs.readFileSync(shaderPath, 'utf8');

    await clientConn.sendNotification('textDocument/didOpen', {
      textDocument: { uri: shaderUri, languageId: 'shaderlab', version: 1, text: content },
    });

    const indexRes = (await clientConn.sendRequest('unitySense/getShaderPropertyIndex')) as ShaderSymbolIndex;
    expect(indexRes.schemaVersion).toBe(1);
    expect(indexRes.shaderNames).toContain('UnityBrain/TestLit');
    expect(indexRes.properties.some((p) => p.name === '_BaseMap')).toBe(true);

    await clientConn.sendNotification('unitySense/setShaderKeywords', {
      keywords: ['_MAIN_LIGHT_SHADOWS', '_ALPHATEST_ON'],
    });
    expect(serverHandle.getHoverProvider()?.getActiveKeywords().has('_ALPHATEST_ON')).toBe(true);

    // Trigger diagnostic for unresolved include inside HLSLPROGRAM
    const hlslLine = content.split(/\r?\n/).findIndex((l) => l.includes('HLSLPROGRAM')) + 1;
    await clientConn.sendNotification('textDocument/didChange', {
      textDocument: { uri: shaderUri, version: 2 },
      contentChanges: [
        {
          range: { start: { line: hlslLine, character: 0 }, end: { line: hlslLine, character: 0 } },
          text: '#include "Packages/nonexistent.pkg/Missing.hlsl"\n',
        },
      ],
    });
    await new Promise((r) => setTimeout(r, 25));
    const latestDiag = publishedDiagnostics[publishedDiagnostics.length - 1] as { diagnostics: Array<{ message: string }> };
    expect(latestDiag.diagnostics.some((d) => d.message.includes('Missing.hlsl'))).toBe(true);

    clientConn.dispose();
    serverHandle.dispose();
  });

  it('resolves warm DefinitionRequest across 50 nested #include files in under 50ms on average', () => {
    fs.mkdirSync(path.join(BENCHMARK_DIR, 'Assets', 'Shaders', 'Deep'), { recursive: true });
    fs.mkdirSync(path.join(BENCHMARK_DIR, 'ProjectSettings'), { recursive: true });
    fs.mkdirSync(path.join(BENCHMARK_DIR, 'Packages'), { recursive: true });
    fs.writeFileSync(path.join(BENCHMARK_DIR, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 6000.0.23f1\n');
    fs.writeFileSync(path.join(BENCHMARK_DIR, 'Packages/manifest.json'), '{"dependencies":{}}');

    // Create chain of 50 include files: Level49.hlsl <- Level48.hlsl <- ... <- Entry.shader
    fs.writeFileSync(
      path.join(BENCHMARK_DIR, 'Assets/Shaders/Deep/Level49.hlsl'),
      'float4 DeepLeafColor(float4 c) { return c * 2.0; }\n',
    );
    for (let i = 48; i >= 0; i--) {
      const target = `Level${i + 1}.hlsl`;
      fs.writeFileSync(
        path.join(BENCHMARK_DIR, `Assets/Shaders/Deep/Level${i}.hlsl`),
        `#include "./${target}"\nfloat4 HelperFunc${i}(float4 c) { return c; }\n`,
      );
    }
    const entryShader = path.join(BENCHMARK_DIR, 'Assets/Shaders/Entry.shader');
    const shaderText = [
      'Shader "Bench/Deep50" {',
      '  SubShader { Pass { HLSLPROGRAM',
      '    #include "./Deep/Level0.hlsl"',
      '    float4 Frag() : SV_Target { return DeepLeafColor(float4(1,1,1,1)); }',
      '  ENDHLSL } }',
      '}',
    ].join('\n');
    fs.writeFileSync(entryShader, shaderText);

    const ctx: UnityProjectContext = {
      projectRoot: BENCHMARK_DIR,
      editorVersion: '6000.0.23f1',
      editorInstallPath: null,
      cgIncludesPath: null,
      builtInPackagesPath: null,
      manifestPath: path.join(BENCHMARK_DIR, 'Packages/manifest.json'),
      packagesLockPath: null,
      cacheDir: path.join(BENCHMARK_DIR, 'Library/UnityBrainCache'),
    };
    const graph = new IncludeDependencyGraph(ctx);
    const def = new ShaderDefinitionProvider(graph);
    const entryUri = pathToFileURL(entryShader).toString();
    const pos = { line: 3, character: shaderText.split('\n')[3].indexOf('DeepLeafColor') + 2 };

    // Cold warm-up
    const coldRes = def.provideDefinition(entryUri, pos, shaderText);
    expect(coldRes.length).toBe(1);
    expect(path.basename(fileURLToPath(coldRes[0].uri))).toBe('Level49.hlsl');

    // Measure 20 warm requests
    const start = performance.now();
    for (let k = 0; k < 20; k++) {
      const locs = def.provideDefinition(entryUri, pos, shaderText);
      expect(locs.length).toBe(1);
    }
    const avgMs = (performance.now() - start) / 20;
    expect(avgMs).toBeLessThan(50);
  });
});
