import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { UnityProjectContext } from '../../../extension/src/contracts/index.ts';
import { IncludeDependencyGraph } from '../../src/indexer/hlslIncludeGraph.ts';
import { ShaderDefinitionProvider } from '../../src/providers/definitionProvider.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');
const SAMPLE_EDITOR = path.join(REPO_ROOT, 'test-fixtures', 'SampleEditor');
const TEMP_DEF_DIR = path.join(REPO_ROOT, 'test-output', 'definition-provider-test');

function setupDefinitionFixture(): { projectRoot: string; ctx: UnityProjectContext } {
  const projectRoot = path.join(
    TEMP_DEF_DIR,
    `proj-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const urpLib = path.join(
    projectRoot,
    'Library',
    'PackageCache',
    'com.unity.render-pipelines.universal@d7774c218bdf',
    'ShaderLibrary',
  );
  fs.mkdirSync(urpLib, { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'Assets', 'Shaders', 'Include'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'ProjectSettings'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'Packages'), { recursive: true });

  fs.writeFileSync(path.join(projectRoot, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.5.10f1\n');
  fs.writeFileSync(
    path.join(projectRoot, 'Packages', 'manifest.json'),
    JSON.stringify({ dependencies: { 'com.unity.render-pipelines.universal': '17.5.0' } }, null, 2),
  );
  fs.writeFileSync(
    path.join(projectRoot, 'Packages', 'packages-lock.json'),
    JSON.stringify(
      { dependencies: { 'com.unity.render-pipelines.universal': { version: '17.5.0', source: 'builtin' } } },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(urpLib, 'Core.hlsl'), '// URP Core\n');
  fs.writeFileSync(
    path.join(urpLib, 'BRDF.hlsl'),
    'half3 DirectBRDFSpecular(half3 n, half3 l) { return n + l; }\n',
  );
  fs.writeFileSync(
    path.join(urpLib, 'Lighting.hlsl'),
    [
      '#include "./BRDF.hlsl"',
      'struct InputData {',
      '    float3 positionWS;',
      '    half3 normalWS;',
      '};',
      'half4 UniversalFragmentPBR(InputData data) { return half4(DirectBRDFSpecular(data.normalWS, data.normalWS), 1); }',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(projectRoot, 'Assets', 'Shaders', 'TestLit.shader'),
    [
      'Shader "UnityBrain/TestLit"',
      '{',
      '    Properties',
      '    {',
      '        _BaseColor ("Base Color", Color) = (1, 1, 1, 1)',
      '    }',
      '    SubShader',
      '    {',
      '        Pass',
      '        {',
      '            HLSLPROGRAM',
      '            #pragma fragment Frag',
      '            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"',
      '            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"',
      '            half4 _BaseColor;',
      '            half4 Frag() : SV_Target',
      '            {',
      '                InputData data;',
      '                data.normalWS = half3(0, 1, 0);',
      '                return _BaseColor;',
      '            }',
      '            ENDHLSL',
      '        }',
      '    }',
      '}',
    ].join('\n'),
  );

  return {
    projectRoot,
    ctx: {
      projectRoot,
      editorVersion: '6000.5.10f1',
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
    },
  };
}

describe('ShaderDefinitionProvider', () => {
  afterEach(() => {
    if (fs.existsSync(TEMP_DEF_DIR)) {
      fs.rmSync(TEMP_DEF_DIR, { recursive: true, force: true });
    }
  });

  it('resolves #include Packages/... URIs, #pragma entries, struct member accesses, Properties, and multi-hop HLSL calls', () => {
    const { projectRoot, ctx } = setupDefinitionFixture();
    const graph = new IncludeDependencyGraph(ctx);
    const provider = new ShaderDefinitionProvider(graph);
    const shaderPath = path.join(projectRoot, 'Assets', 'Shaders', 'TestLit.shader');
    const shaderUri = pathToFileURL(shaderPath).toString();
    const content = fs.readFileSync(shaderPath, 'utf8');
    const lines = content.split(/\r?\n/);

    // 1. #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl" (even at col 0 on line)
    const incLine = lines.findIndex((l) => l.includes('ShaderLibrary/Lighting.hlsl'));
    const incLocations = provider.provideDefinition(shaderUri, { line: incLine, character: 2 }, content);
    expect(incLocations.length).toBe(1);
    expect(fileURLToPath(incLocations[0].uri)).toBe(
      path.resolve(
        projectRoot,
        'Library/PackageCache/com.unity.render-pipelines.universal@d7774c218bdf/ShaderLibrary/Lighting.hlsl',
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
      projectRoot,
      'Library/PackageCache/com.unity.render-pipelines.universal@d7774c218bdf/ShaderLibrary/Lighting.hlsl',
    );
    const lightingUri = pathToFileURL(lightingPath).toString();
    const callLine = lightingLines.findIndex((l) => l.includes('DirectBRDFSpecular('));
    const callCol = lightingLines[callLine].indexOf('DirectBRDFSpecular') + 3;
    const brdfLocs = provider.provideDefinition(lightingUri, { line: callLine, character: callCol });
    expect(brdfLocs.length).toBe(1);
    expect(path.basename(fileURLToPath(brdfLocs[0].uri))).toBe('BRDF.hlsl');

    // 5. ShaderLab Property reference `_BaseColor` -> jumps to Properties declaration in TestLit.shader
    const propUseLine = lines.findIndex((l) => l.includes('return _BaseColor;'));
    const propUseCol = lines[propUseLine].indexOf('_BaseColor') + 2;
    const propLocs = provider.provideDefinition(shaderUri, { line: propUseLine, character: propUseCol }, content);
    const propDeclLine = lines.findIndex((l) => l.includes('_BaseColor ("Base Color"'));
    expect(propLocs.some((loc) => loc.range.start.line === propDeclLine)).toBe(true);

    // 6. Local variable `data` -> jumps to `InputData data;` declaration in Frag()
    const dataDeclLine = lines.findIndex((l) => l.includes('InputData data;'));
    const dataUseLine = lines.findIndex((l) => l.includes('data.normalWS ='));
    const dataUseCol = lines[dataUseLine].indexOf('data') + 1;
    const dataLocs = provider.provideDefinition(shaderUri, { line: dataUseLine, character: dataUseCol }, content);
    expect(dataLocs.length).toBe(1);
    expect(dataLocs[0].range.start.line).toBe(dataDeclLine);
  });

  it('isolates multi-Pass structs, parses constants/arrays/loop-vars/multi-line functions, and resolves chained members', () => {
    const { projectRoot, ctx } = setupDefinitionFixture();
    const graph = new IncludeDependencyGraph(ctx);
    const provider = new ShaderDefinitionProvider(graph);
    const multiShaderPath = path.join(projectRoot, 'Assets', 'Shaders', 'MultiPassAdvanced.shader');
    const multiUri = pathToFileURL(multiShaderPath).toString();
    const shaderCode = [
      'Shader "UnityBrain/MultiPass" {',
      '  Properties { _BaseColor ("Base Color", Color) = (1,1,1,1) }',
      '  SubShader {',
      '    Pass {',
      '      Name "Forward"',
      '      HLSLPROGRAM',
      '      static const float PI = 3.14159;',
      '      float4 _Weights[4];',
      '      half _ScaleA, _ScaleB;',
      '      CBUFFER_START(UnityPerMaterial)',
      '        half4 _BaseColor;',
      '      CBUFFER_END',
      '      struct LightInfo { float3 direction; float4 color; };',
      '      struct FrameData { LightInfo mainLight; };',
      '      StructuredBuffer<LightInfo> _LightBuffer;',
      '      struct Varyings {',
      '        float4 positionCS : SV_POSITION;',
      '        float2 uvForward : TEXCOORD0;',
      '      };',
      '      LightInfo GetMainLight(',
      '        int index,',
      '        float bias',
      '      ) {',
      '        LightInfo info;',
      '        info.direction = float3(0, 1, 0);',
      '        info.color = _BaseColor;',
      '        return info;',
      '      }',
      '      float4 FragForward(Varyings input) : SV_Target {',
      '        FrameData frame;',
      '        float3 d = frame.mainLight.direction;',
      '        float4 c1 = _LightBuffer[0].color;',
      '        float4 c2 = GetMainLight(0, PI).color;',
      '        for (int loopIdx = 0; loopIdx < 4; loopIdx++) {',
      '          c1 += _Weights[loopIdx];',
      '        }',
      '        float x = input.uvForward.x * _ScaleB;',
      '        return c1 + c2;',
      '      }',
      '      ENDHLSL',
      '    }',
      '    Pass {',
      '      Name "ShadowCaster"',
      '      HLSLPROGRAM',
      '      struct Varyings {',
      '        float4 positionCS : SV_POSITION;',
      '        float shadowDepth : TEXCOORD1;',
      '      };',
      '      float4 FragShadow(Varyings shadowIn) : SV_Target {',
      '        float dep = shadowIn.shadowDepth;',
      '        return dep;',
      '      }',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const lines = shaderCode.split('\n');
    const fragFwdUvLine = lines.findIndex((l) => l.includes('input.uvForward'));
    const fragShadowDepLine = lines.findIndex((l) => l.includes('shadowIn.shadowDepth'));
    graph.setOpenDocumentContent(multiUri, shaderCode);

    // Multi-pass isolation
    const forwardFields = graph.findStructFields(multiShaderPath, 'Varyings', fragFwdUvLine);
    expect(forwardFields.map((f) => f.name)).toContain('uvForward');
    expect(forwardFields.map((f) => f.name)).not.toContain('shadowDepth');

    const shadowFields = graph.findStructFields(multiShaderPath, 'Varyings', fragShadowDepLine);
    expect(shadowFields.map((f) => f.name)).toContain('shadowDepth');
    expect(shadowFields.map((f) => f.name)).not.toContain('uvForward');

    // Chained member jump: frame.mainLight.direction -> LightInfo.direction
    const chainLine = lines.findIndex((l) => l.includes('frame.mainLight.direction'));
    const dirCol = lines[chainLine].indexOf('direction') + 2;
    const dirLocs = provider.provideDefinition(multiUri, { line: chainLine, character: dirCol }, shaderCode);
    expect(dirLocs.length).toBe(1);
    expect(dirLocs[0].range.start.line).toBe(lines.findIndex((l) => l.includes('struct LightInfo')));

    // StructuredBuffer indexing: _LightBuffer[0].color
    const bufLine = lines.findIndex((l) => l.includes('_LightBuffer[0].color'));
    const bufRes = graph.resolveExpressionChain(multiShaderPath, '_LightBuffer[0].color', bufLine);
    expect(bufRes.field?.name).toBe('color');
    expect(bufRes.ownerType).toBe('LightInfo');

    // Function return chaining: GetMainLight(0, PI).color
    const fnChainLine = lines.findIndex((l) => l.includes('GetMainLight(0, PI).color'));
    const fnRes = graph.resolveExpressionChain(multiShaderPath, 'GetMainLight(0, PI).color', fnChainLine);
    expect(fnRes.field?.name).toBe('color');

    // static const, multi-var, array, loop variable, CBUFFER HLSL type priority
    expect(graph.findSymbolsVisibleFrom(multiShaderPath, 'PI', fragFwdUvLine).length).toBeGreaterThan(0);
    expect(graph.findSymbolsVisibleFrom(multiShaderPath, '_ScaleB', fragFwdUvLine).length).toBeGreaterThan(0);
    expect(graph.inferVariableType(multiShaderPath, '_Weights', fragFwdUvLine)).toBe('float4[4]');
    const loopUseLine = lines.findIndex((l) => l.includes('_Weights[loopIdx]'));
    expect(graph.inferVariableType(multiShaderPath, 'loopIdx', loopUseLine)).toBe('int');
    expect(graph.inferVariableType(multiShaderPath, '_BaseColor', fragFwdUvLine)).toBe('float4');

    // 2D struct array indexing + Texture2D .Sample(...) F12 resolution
    const sample2dPath = path.join(projectRoot, 'Assets', 'Shaders', 'ArraySample2D.shader');
    const sample2dUri = provider['graph'].toUri(sample2dPath);
    const sample2dCode = [
      'Shader "Test/ArraySample2D" {',
      '  SubShader { Pass { HLSLPROGRAM',
      '    TEXTURE2D(_MainTex);',
      '    SAMPLER(sampler_MainTex);',
      '    struct Cell { half4 weight; };',
      '    Cell _Grid[2][4];',
      '    half4 Frag(float2 uv : TEXCOORD0) : SV_Target {',
      '      half r = _MainTex.Sample(sampler_MainTex, uv).r;',
      '      return _Grid[0][1].weight * r;',
      '    }',
      '  ENDHLSL } }',
      '}',
    ].join('\n');
    const sLines = sample2dCode.split('\n');
    graph.setOpenDocumentContent(sample2dUri, sample2dCode);

    const gridLine = sLines.findIndex((l) => l.includes('_Grid[0][1].weight'));
    const weightCol = sLines[gridLine].indexOf('weight') + 2;
    const gridDefs = provider.provideDefinition(sample2dUri, { line: gridLine, character: weightCol }, sample2dCode);
    expect(gridDefs.length).toBe(1);
    expect(gridDefs[0].range.start.line).toBe(sLines.findIndex((l) => l.includes('struct Cell')));

    const sampLine = sLines.findIndex((l) => l.includes('_MainTex.Sample'));
    const sampCol = sLines[sampLine].indexOf('Sample') + 2;
    const sampDefs = provider.provideDefinition(sample2dUri, { line: sampLine, character: sampCol }, sample2dCode);
    expect(sampDefs.length).toBe(1);
    expect(sampDefs[0].range.start.line).toBe(sLines.findIndex((l) => l.includes('TEXTURE2D(_MainTex)')));

    const swizCol = sLines[sampLine].lastIndexOf('.r') + 1;
    const swizDefs = provider.provideDefinition(sample2dUri, { line: sampLine, character: swizCol }, sample2dCode);
    expect(swizDefs.length).toBe(1);
    expect(swizDefs[0].range.start.line).toBe(sLines.findIndex((l) => l.includes('TEXTURE2D(_MainTex)')));
  });

  it('disambiguates Go-to-Definition on same-named struct fields (Step8Attributes vs Step8Varyings)', () => {
    const { projectRoot, ctx } = setupDefinitionFixture();
    const graph = new IncludeDependencyGraph(ctx);
    const provider = new ShaderDefinitionProvider(graph);
    const shaderPath = path.join(projectRoot, 'Assets', 'Shaders', 'Step8DefDemo.shader');
    const shaderUri = pathToFileURL(shaderPath).toString();
    const code = [
      'Shader "UnityBrain/Step8DefDemo"',
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
      '            half4 Frag(Step8Varyings input) : SV_Target',
      '            {',
      '                return half4(input.texcoord, 0, 1);',
      '            }',
      '            ENDHLSL',
      '        }',
      '    }',
      '}',
    ].join('\n');

    const lines = code.split('\n');
    const attrTexLine = lines.findIndex((l, idx) => idx < 13 && l.includes('float2 texcoord'));
    const varyTexLine = lines.findIndex((l, idx) => idx > 13 && l.includes('float2 texcoord'));
    const vertAssignLine = lines.findIndex((l) => l.includes('output.texcoord = input.texcoord;'));
    const fragUseLine = lines.findIndex((l) => l.includes('half4(input.texcoord'));

    // Direct declaration of Step8Varyings.texcoord returns only Step8Varyings.texcoord
    const varyDeclCol = lines[varyTexLine].indexOf('texcoord') + 2;
    const varyDeclDefs = provider.provideDefinition(shaderUri, { line: varyTexLine, character: varyDeclCol }, code);
    expect(varyDeclDefs.length).toBe(1);
    expect(varyDeclDefs[0].range.start.line).toBe(varyTexLine);

    // Vert's `input.texcoord` -> Step8Attributes.texcoord
    const vertInCol = lines[vertAssignLine].lastIndexOf('texcoord') + 2;
    const vertInDefs = provider.provideDefinition(shaderUri, { line: vertAssignLine, character: vertInCol }, code);
    expect(vertInDefs.length).toBe(1);
    expect(vertInDefs[0].range.start.line).toBe(attrTexLine);

    // Vert's `output.texcoord` -> Step8Varyings.texcoord
    const vertOutCol = lines[vertAssignLine].indexOf('texcoord') + 2;
    const vertOutDefs = provider.provideDefinition(shaderUri, { line: vertAssignLine, character: vertOutCol }, code);
    expect(vertOutDefs.length).toBe(1);
    expect(vertOutDefs[0].range.start.line).toBe(varyTexLine);

    // Frag's `input.texcoord` -> Step8Varyings.texcoord
    const fragInCol = lines[fragUseLine].indexOf('texcoord') + 2;
    const fragInDefs = provider.provideDefinition(shaderUri, { line: fragUseLine, character: fragInCol }, code);
    expect(fragInDefs.length).toBe(1);
    expect(fragInDefs[0].range.start.line).toBe(varyTexLine);
  });
});
