import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  blankShaderCommentsPreservingLayout,
  extractVirtualHlslDocument,
  parseShaderPragmas,
  parseShaderProperties,
} from '../../src/parser/shaderLabVirtualDoc.ts';
import { UnityHlslMacroPrepass } from '../../src/parser/unityHlslMacroPrepass.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');
const SAMPLE_SHADER = path.join(
  REPO_ROOT,
  'test-fixtures',
  'SampleUnityProject',
  'Assets',
  'Shaders',
  'TestLit.shader',
);

describe('shaderLabVirtualDoc & UnityHlslMacroPrepass', () => {
  it('preserves 1:1 line and column offsets when extracting HLSLINCLUDE and HLSLPROGRAM blocks', () => {
    const source = fs.readFileSync(SAMPLE_SHADER, 'utf8');
    const result = extractVirtualHlslDocument(source, SAMPLE_SHADER);

    expect(result.isShaderLab).toBe(true);
    expect(result.shaderName).toBe('UnityBrain/TestLit');
    expect(result.blocks.length).toBe(2);
    expect(result.blocks[0].kind).toBe('HLSLINCLUDE');
    expect(result.blocks[1].kind).toBe('HLSLPROGRAM');
    expect(result.blocks[1].includeBlockIndices).toEqual([0]);

    // Line & character length parity check
    const rawLines = source.split('\n');
    const virtualLines = result.virtualHlsl.split('\n');
    expect(virtualLines.length).toBe(rawLines.length);

    const fragRawLine = rawLines.findIndex((l) => l.includes('half4 Frag('));
    const fragVirtualLine = virtualLines.findIndex((l) => l.includes('half4 Frag('));
    expect(fragRawLine).toBeGreaterThan(0);
    expect(fragVirtualLine).toBe(fragRawLine);
    expect(virtualLines[fragVirtualLine].indexOf('Frag')).toBe(rawLines[fragRawLine].indexOf('Frag'));
    expect(virtualLines[0].trim()).toBe(''); // Shader "Name" replaced by spaces
  });

  it('extracts ShaderLab Properties with exact lines and columns and pragma directives', () => {
    const source = fs.readFileSync(SAMPLE_SHADER, 'utf8');
    const props = parseShaderProperties(source, SAMPLE_SHADER);
    expect(props.length).toBe(4);
    expect(props.map((p) => p.name)).toEqual(['_BaseMap', '_BaseColor', '_Cutoff', '_Smoothness']);
    expect(props[0].type).toBe('2D');

    const rawLines = source.split('\n');
    const baseColorProp = props.find((p) => p.name === '_BaseColor');
    expect(baseColorProp?.line).toBe(rawLines.findIndex((l) => l.includes('_BaseColor ("Base Color"')));

    const pragmas = parseShaderPragmas(source);
    expect(pragmas.entryPoints.map((e) => `${e.stage}:${e.name}`)).toEqual(['vertex:Vert', 'fragment:Frag']);
    expect(pragmas.keywordGroups.length).toBe(2);
    expect(pragmas.keywordGroups[0].keywords).toContain('_MAIN_LIGHT_SHADOWS_CASCADE');
  });

  it('normalizes URP/HDRP Unity HLSL macros without shifting line numbers', () => {
    const prepass = new UnityHlslMacroPrepass();
    const hlsl = [
      'TEXTURE2D(_MainTex);',
      'SAMPLER(sampler_MainTex);',
      'CBUFFER_START(UnityPerMaterial)',
      '    half4 _BaseColor;',
      'CBUFFER_END',
      'half4 SampleTex(TEXTURE2D_PARAM(tex, smp), real2 uv) {',
      '    return SAMPLE_TEXTURE2D(tex, smp, uv);',
      '}',
    ].join('\n');

    const res = prepass.preprocess(hlsl, 'file:///test.hlsl');
    const outLines = res.normalizedText.split('\n');
    expect(outLines.length).toBe(8);
    expect(outLines[0]).toBe('Texture2D _MainTex;');
    expect(outLines[1]).toBe('SamplerState sampler_MainTex;');
    expect(outLines[2]).toBe('cbuffer UnityPerMaterial {');
    expect(outLines[3]).toBe('    float4 _BaseColor;');
    expect(outLines[4]).toBe('};');
    expect(outLines[5]).toContain('Texture2D tex, SamplerState smp');
    expect(res.synthesizedSymbols.some((s) => s.name === '_MainTex' && s.returnType === 'Texture2D')).toBe(true);
    expect(res.synthesizedSymbols.some((s) => s.name === 'UnityPerMaterial' && s.kind === 'cbuffer')).toBe(true);
  });

  it('computes #pragma entry point columns without matching inside stage keyword (P1-S1)', () => {
    const pragmas = parseShaderPragmas([
      '#pragma vertex vert',
      '#pragma fragment frag',
      '    #pragma vertex vert',
    ].join('\n'));
    expect(pragmas.entryPoints).toEqual([
      { stage: 'vertex', name: 'vert', line: 0, column: 15 },
      { stage: 'fragment', name: 'frag', line: 1, column: 17 },
      { stage: 'vertex', name: 'vert', line: 2, column: 19 },
    ]);
  });

  it('preserves UTF-16 code-unit offsets across non-BMP emoji comments without truncating code or leaking ENDHLSL (P1-S2)', () => {
    const source = [
      'Shader "Test/Emoji" {',
      '  // 😀😀😀😀 outer comment',
      '  SubShader {',
      '    Pass {',
      '      HLSLPROGRAM',
      '      // 😀😀😀😀 inner comment',
      '      float4 Frag() : SV_Target { return float4(1,1,1,1); }',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const blanked = blankShaderCommentsPreservingLayout(source);
    expect(blanked.length).toBe(source.length);
    expect(blanked).toContain('float4 Frag() : SV_Target { return float4(1,1,1,1); }');

    const result = extractVirtualHlslDocument(source, 'Emoji.shader');
    expect(result.virtualHlsl.length).toBe(source.length);
    expect(result.virtualHlsl).toContain('float4 Frag() : SV_Target { return float4(1,1,1,1); }');
    expect(result.virtualHlsl).not.toContain('ENDHLSL');

    const lines = result.virtualHlsl.split('\n');
    const rawLines = source.split('\n');
    const fragLine = lines.findIndex((l) => l.includes('float4 Frag'));
    expect(lines[fragLine].indexOf('Frag')).toBe(rawLines[fragLine].indexOf('Frag'));
  });

  it('uses word-boundary column lookup for synthesized symbols in UnityHlslMacroPrepass (P1-S3)', () => {
    const prepass = new UnityHlslMacroPrepass();
    const hlsl = [
      'TEXTURE2D(T);',
      'RW_TEXTURE2D(float4, R);',
      'SAMPLER(S);',
      'CBUFFER_START(C)',
      '    UNITY_DEFINE_INSTANCED_PROP(float, f)',
      'CBUFFER_END',
    ].join('\n');

    const res = prepass.preprocess(hlsl, 'file:///short.hlsl');
    const byName = new Map(res.synthesizedSymbols.map((s) => [s.name, s]));
    expect(byName.get('T')?.column).toBe(10);
    expect(byName.get('R')?.column).toBe(21);
    expect(byName.get('S')?.column).toBe(8);
    expect(byName.get('C')?.column).toBe(14);
    expect(byName.get('f')?.column).toBe(39);
  });
});
