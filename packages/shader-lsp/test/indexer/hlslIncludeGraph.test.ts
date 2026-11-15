import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { UnityProjectContext } from '../../../extension/src/contracts/index.ts';
import { IncludeDependencyGraph } from '../../src/indexer/hlslIncludeGraph.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');
const SAMPLE_PROJECT = path.join(REPO_ROOT, 'test-fixtures', 'SampleUnityProject');
const SAMPLE_EDITOR = path.join(REPO_ROOT, 'test-fixtures', 'SampleEditor');
const TEMP_CYCLE_DIR = path.join(REPO_ROOT, 'test-output', 'cycle-include-test');

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

describe('IncludeDependencyGraph & HlslSymbolTable', () => {
  afterEach(() => {
    if (fs.existsSync(TEMP_CYCLE_DIR)) {
      fs.rmSync(TEMP_CYCLE_DIR, { recursive: true, force: true });
    }
  });

  it('traverses 3+ nested include levels across Packages and relative paths and extracts symbols', () => {
    const graph = new IncludeDependencyGraph(createSampleContext());
    const testLit = path.join(SAMPLE_PROJECT, 'Assets', 'Shaders', 'TestLit.shader');

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
    fs.mkdirSync(path.join(TEMP_CYCLE_DIR, 'Assets', 'Shaders'), { recursive: true });
    fs.mkdirSync(path.join(TEMP_CYCLE_DIR, 'ProjectSettings'), { recursive: true });
    fs.mkdirSync(path.join(TEMP_CYCLE_DIR, 'Packages'), { recursive: true });
    fs.writeFileSync(path.join(TEMP_CYCLE_DIR, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 6000.0.23f1\n');
    fs.writeFileSync(path.join(TEMP_CYCLE_DIR, 'Packages/manifest.json'), '{"dependencies":{}}');

    const fileA = path.join(TEMP_CYCLE_DIR, 'Assets/Shaders/A.hlsl');
    const fileB = path.join(TEMP_CYCLE_DIR, 'Assets/Shaders/B.hlsl');
    fs.writeFileSync(fileA, '#include "./B.hlsl"\n#include "Packages/missing.pkg/NoSuchFile.hlsl"\nfloat FuncA() { return 1.0; }\n');
    fs.writeFileSync(fileB, '#include "./A.hlsl"\nfloat FuncB() { return 2.0; }\n');

    const graph = new IncludeDependencyGraph({
      projectRoot: TEMP_CYCLE_DIR,
      editorVersion: '6000.0.23f1',
      editorInstallPath: null,
      cgIncludesPath: null,
      builtInPackagesPath: null,
      manifestPath: path.join(TEMP_CYCLE_DIR, 'Packages/manifest.json'),
      packagesLockPath: null,
      cacheDir: path.join(TEMP_CYCLE_DIR, 'Library/UnityBrainCache'),
    });

    const walk = graph.collectReachableFiles(fileA);
    expect(walk.files.length).toBe(2);
    expect(walk.unresolvedIncludes.length).toBe(1);
    expect(walk.unresolvedIncludes[0].includePath).toBe('Packages/missing.pkg/NoSuchFile.hlsl');
    expect(graph.findSymbolsVisibleFrom(fileA, 'FuncB').length).toBe(1);
  });
});
