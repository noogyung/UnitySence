import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { UnityProjectContext } from '../../../extension/src/contracts/index.ts';
import { IncludeDependencyGraph } from '../../src/indexer/hlslIncludeGraph.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');
const SAMPLE_EDITOR = path.join(REPO_ROOT, 'test-fixtures', 'SampleEditor');
const TEMP_GRAPH_DIR = path.join(REPO_ROOT, 'test-output', 'include-graph-test');

function createIsolatedGraphProject(): string {
  const root = path.join(TEMP_GRAPH_DIR, `proj-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(path.join(root, 'Assets', 'Shaders', 'Include'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ProjectSettings'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Packages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Library', 'PackageCache', 'com.unity.render-pipelines.universal@d7774c218bdf', 'ShaderLibrary'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Library', 'PackageCache', 'com.unity.render-pipelines.core@a1b2c3d4e5f6', 'ShaderLibrary'), { recursive: true });

  fs.writeFileSync(path.join(root, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0.23f1\n');
  fs.writeFileSync(
    path.join(root, 'Packages', 'manifest.json'),
    JSON.stringify(
      {
        dependencies: {
          'com.unity.render-pipelines.universal': '17.0.3',
          'com.unity.render-pipelines.core': '17.0.3',
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(root, 'Packages', 'packages-lock.json'),
    JSON.stringify(
      {
        dependencies: {
          'com.unity.render-pipelines.universal': { version: '17.0.3', source: 'builtin' },
          'com.unity.render-pipelines.core': { version: '17.0.3', source: 'builtin' },
        },
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(root, 'Library', 'PackageCache', 'com.unity.render-pipelines.core@a1b2c3d4e5f6', 'ShaderLibrary', 'Common.hlsl'),
    '#define SAMPLE_TEXTURE2D_SAFE(tex, sam, uv) SAMPLE_TEXTURE2D(tex, sam, uv)\n',
  );
  fs.writeFileSync(
    path.join(root, 'Library', 'PackageCache', 'com.unity.render-pipelines.universal@d7774c218bdf', 'ShaderLibrary', 'Core.hlsl'),
    '#include "Packages/com.unity.render-pipelines.core/ShaderLibrary/Common.hlsl"\n#include "Packages/com.unity.render-pipelines.ps5/ShaderLibrary/API/PSSL.hlsl"\n',
  );
  fs.writeFileSync(
    path.join(root, 'Library', 'PackageCache', 'com.unity.render-pipelines.universal@d7774c218bdf', 'ShaderLibrary', 'BRDF.hlsl'),
    'half3 DirectBRDFSpecular(half3 n, half3 v) { return n + v; }\n',
  );
  fs.writeFileSync(
    path.join(root, 'Library', 'PackageCache', 'com.unity.render-pipelines.universal@d7774c218bdf', 'ShaderLibrary', 'Lighting.hlsl'),
    '#include "./BRDF.hlsl"\nstruct InputData {\n    float3 positionWS;\n    half3 normalWS;\n};\n',
  );
  fs.writeFileSync(
    path.join(root, 'Assets', 'Shaders', 'Include', 'LocalShaderHelper.hlsl'),
    'half4 HelperTint(half4 c) { return c * 0.5; }\n',
  );
  fs.writeFileSync(
    path.join(root, 'Assets', 'Shaders', 'TestLit.shader'),
    [
      'Shader "UnityBrain/TestLit" {',
      '  SubShader { Pass { HLSLPROGRAM',
      '    #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"',
      '    #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"',
      '    #include "./Include/LocalShaderHelper.hlsl"',
      '    half4 Frag() : SV_Target {',
      '      InputData data;',
      '      data.normalWS = half3(0, 1, 0);',
      '      return HelperTint(half4(DirectBRDFSpecular(data.normalWS, data.normalWS), 1));',
      '    }',
      '  ENDHLSL } }',
      '}',
    ].join('\n'),
  );
  return root;
}

function createGraphContext(projectRoot: string): UnityProjectContext {
  return {
    projectRoot,
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
    manifestPath: path.join(projectRoot, 'Packages', 'manifest.json'),
    packagesLockPath: path.join(projectRoot, 'Packages', 'packages-lock.json'),
    cacheDir: path.join(projectRoot, 'Library', 'UnityBrainCache'),
  };
}

describe('IncludeDependencyGraph & HlslSymbolTable', () => {
  afterEach(() => {
    if (fs.existsSync(TEMP_GRAPH_DIR)) {
      fs.rmSync(TEMP_GRAPH_DIR, { recursive: true, force: true });
    }
  });

  it('traverses 3+ nested include levels across Packages and relative paths and ignores PackageCache console includes', () => {
    const projectRoot = createIsolatedGraphProject();
    const graph = new IncludeDependencyGraph(createGraphContext(projectRoot));
    const testLit = path.join(projectRoot, 'Assets', 'Shaders', 'TestLit.shader');

    const walk = graph.collectReachableFiles(testLit);
    const fileBasenames = walk.files.map((f) => path.basename(f.filePath));
    expect(fileBasenames).toContain('TestLit.shader');
    expect(fileBasenames).toContain('Core.hlsl');
    expect(fileBasenames).toContain('Lighting.hlsl');
    expect(fileBasenames).toContain('BRDF.hlsl');
    expect(fileBasenames).toContain('Common.hlsl');
    expect(fileBasenames).toContain('LocalShaderHelper.hlsl');
    expect(walk.unresolvedIncludes.length).toBe(0);

    // Transitive function across 3 levels (TestLit -> Lighting.hlsl -> ./BRDF.hlsl)
    const brdfSyms = graph.findSymbolsVisibleFrom(testLit, 'DirectBRDFSpecular');
    expect(brdfSyms.length).toBe(1);
    expect(path.basename(brdfSyms[0].uri)).toBe('BRDF.hlsl');

    // Macro from 3rd level (Core.hlsl -> hashed Core@.../Common.hlsl)
    const macroSyms = graph.findSymbolsVisibleFrom(testLit, 'SAMPLE_TEXTURE2D_SAFE');
    expect(macroSyms.length).toBe(1);
    expect(macroSyms[0].kind).toBe('macro');

    // Struct fields in Lighting.hlsl
    const inputFields = graph.findStructFields(testLit, 'InputData');
    expect(inputFields.map((f) => f.name)).toContain('normalWS');

    // Local variable inference in TestLit.shader Frag()
    const fragLines = fs.readFileSync(testLit, 'utf8').split('\n');
    const dataUseLine = fragLines.findIndex((l) => l.includes('data.normalWS ='));
    expect(graph.inferVariableType(testLit, 'data', dataUseLine)).toBe('InputData');
  });

  it('guards against circular #include cycles and reports unresolved includes', () => {
    const cycleRoot = path.join(TEMP_GRAPH_DIR, 'cycle');
    fs.mkdirSync(path.join(cycleRoot, 'Assets', 'Shaders'), { recursive: true });
    fs.mkdirSync(path.join(cycleRoot, 'ProjectSettings'), { recursive: true });
    fs.mkdirSync(path.join(cycleRoot, 'Packages'), { recursive: true });
    fs.writeFileSync(path.join(cycleRoot, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 6000.0.23f1\n');
    fs.writeFileSync(path.join(cycleRoot, 'Packages/manifest.json'), '{"dependencies":{}}');

    const fileA = path.join(cycleRoot, 'Assets/Shaders/A.hlsl');
    const fileB = path.join(cycleRoot, 'Assets/Shaders/B.hlsl');
    fs.writeFileSync(fileA, '#include "./B.hlsl"\n#include "Packages/missing.pkg/NoSuchFile.hlsl"\nfloat FuncA() { return 1.0; }\n');
    fs.writeFileSync(fileB, '#include "./A.hlsl"\nfloat FuncB() { return 2.0; }\n');

    const graph = new IncludeDependencyGraph({
      projectRoot: cycleRoot,
      editorVersion: '6000.0.23f1',
      editorInstallPath: null,
      cgIncludesPath: null,
      builtInPackagesPath: null,
      manifestPath: path.join(cycleRoot, 'Packages/manifest.json'),
      packagesLockPath: null,
      cacheDir: path.join(cycleRoot, 'Library/UnityBrainCache'),
    });

    const walk = graph.collectReachableFiles(fileA);
    expect(walk.files.length).toBe(2);
    expect(walk.unresolvedIncludes.length).toBe(1);
    expect(walk.unresolvedIncludes[0].includePath).toBe('Packages/missing.pkg/NoSuchFile.hlsl');
    expect(graph.findSymbolsVisibleFrom(fileA, 'FuncB').length).toBe(1);
  });

  it('resolves reverse include parents when opening a standalone .hlsl header', () => {
    const projectRoot = createIsolatedGraphProject();
    const graph = new IncludeDependencyGraph(createGraphContext(projectRoot));
    const helperPath = path.join(projectRoot, 'Assets', 'Shaders', 'Include', 'LocalShaderHelper.hlsl');

    const parentFiles = graph.findParentIncludeFiles(helperPath);
    expect(parentFiles.some((f) => path.basename(f.filePath) === 'TestLit.shader')).toBe(true);

    // DirectBRDFSpecular and InputData come from TestLit.shader's earlier #includes
    const brdfFromHelper = graph.findSymbolsVisibleFrom(helperPath, 'DirectBRDFSpecular');
    expect(brdfFromHelper.length).toBe(1);
    const inputFieldsFromHelper = graph.findStructFields(helperPath, 'InputData');
    expect(inputFieldsFromHelper.map((f) => f.name)).toContain('normalWS');
  });
});
