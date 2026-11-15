import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { UnityProjectContext } from '../../../extension/src/contracts/index.ts';
import { IncludeDependencyGraph } from '../../src/indexer/hlslIncludeGraph.ts';
import { ShaderDefinitionProvider } from '../../src/providers/definitionProvider.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');
const SAMPLE_PROJECT = path.join(REPO_ROOT, 'test-fixtures', 'SampleUnityProject');
const SAMPLE_EDITOR = path.join(REPO_ROOT, 'test-fixtures', 'SampleEditor');

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

describe('ShaderDefinitionProvider', () => {
  it('resolves #include Packages/... URIs, #pragma entries, struct member accesses, Properties, and multi-hop HLSL calls', () => {
    const graph = new IncludeDependencyGraph(createSampleContext());
    const provider = new ShaderDefinitionProvider(graph);
    const shaderPath = path.join(SAMPLE_PROJECT, 'Assets', 'Shaders', 'TestLit.shader');
    const shaderUri = pathToFileURL(shaderPath).toString();
    const content = fs.readFileSync(shaderPath, 'utf8');
    const lines = content.split(/\r?\n/);

    // 1. #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"
    const incLine = lines.findIndex((l) => l.includes('ShaderLibrary/Lighting.hlsl'));
    const incCol = lines[incLine].indexOf('Lighting.hlsl');
    const incLocations = provider.provideDefinition(shaderUri, { line: incLine, character: incCol }, content);
    expect(incLocations.length).toBe(1);
    expect(fileURLToPath(incLocations[0].uri)).toBe(
      path.resolve(
        SAMPLE_PROJECT,
        'Library/PackageCache/com.unity.render-pipelines.universal@17.0.3/ShaderLibrary/Lighting.hlsl',
      ),
    );

    // 2. #pragma fragment Frag -> jumps to Frag declaration in TestLit.shader
    const pragmaLine = lines.findIndex((l) => l.includes('#pragma fragment Frag'));
    const pragmaCol = lines[pragmaLine].indexOf('Frag');
    const pragmaLocations = provider.provideDefinition(shaderUri, { line: pragmaLine, character: pragmaCol }, content);
    const fragDeclLine = lines.findIndex((l) => l.includes('half4 Frag('));
    expect(pragmaLocations.some((loc) => loc.range.start.line === fragDeclLine)).toBe(true);

    // 3. Struct member access `data.normalWS` -> jumps to `InputData.normalWS` inside Lighting.hlsl
    const memberLine = lines.findIndex((l) => l.includes('data.normalWS ='));
    const memberCol = lines[memberLine].indexOf('normalWS') + 2;
    const memberLocations = provider.provideDefinition(shaderUri, { line: memberLine, character: memberCol }, content);
    expect(memberLocations.length).toBe(1);
    expect(path.basename(fileURLToPath(memberLocations[0].uri))).toBe('Lighting.hlsl');
    const lightingLines = fs.readFileSync(fileURLToPath(memberLocations[0].uri), 'utf8').split(/\r?\n/);
    expect(lightingLines[memberLocations[0].range.start.line]).toContain('normalWS');

    // 4. Cross-file function jump across Packages + relative folder (`Lighting.hlsl` -> `./BRDF.hlsl` -> `DirectBRDFSpecular`)
    const lightingPath = path.resolve(
      SAMPLE_PROJECT,
      'Library/PackageCache/com.unity.render-pipelines.universal@17.0.3/ShaderLibrary/Lighting.hlsl',
    );
    const lightingUri = pathToFileURL(lightingPath).toString();
    const callLine = lightingLines.findIndex((l) => l.includes('DirectBRDFSpecular('));
    const callCol = lightingLines[callLine].indexOf('DirectBRDFSpecular') + 3;
    const brdfLocs = provider.provideDefinition(lightingUri, { line: callLine, character: callCol });
    expect(brdfLocs.length).toBe(1);
    expect(path.basename(fileURLToPath(brdfLocs[0].uri))).toBe('BRDF.hlsl');

    // 5. ShaderLab Property reference `_BaseColor` -> jumps to Properties declaration in TestLit.shader
    const propUseLine = lines.findIndex((l) => l.includes('_BaseColor.rgb'));
    const propUseCol = lines[propUseLine].indexOf('_BaseColor') + 2;
    const propLocs = provider.provideDefinition(shaderUri, { line: propUseLine, character: propUseCol }, content);
    const propDeclLine = lines.findIndex((l) => l.includes('_BaseColor ("Base Color"'));
    expect(propLocs.some((loc) => loc.range.start.line === propDeclLine)).toBe(true);
  });
});
