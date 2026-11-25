import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vscode from 'vscode';
import {
  extractMemberChainExpression,
  type IncludeDependencyGraph,
} from '../../../shader-lsp/src/indexer/hlslIncludeGraph.ts';
import {
  findBlockIndexAtLine,
  isLineVisibleInPass,
  type ParsedHlslFile,
} from '../../../shader-lsp/src/indexer/hlslSymbolTable.ts';
import {
  blankShaderCommentsPreservingLayout,
  extractVirtualHlslDocument,
} from '../../../shader-lsp/src/parser/shaderLabVirtualDoc.ts';
import { isShaderFilePath, normalizePathKey } from '../../../shader-lsp/src/vfs/virtualPathResolver.ts';
import {
  extractCustomEditorDirectives,
  isBuiltInCompiledShaderGui,
  resolveCustomEditorProperties,
} from './shaderCustomEditorResolver.ts';

export const SHADER_SEMANTIC_TOKEN_TYPES = [
  'struct',
  'function',
  'parameter',
  'variable',
  'property',
  'macro',
  'type',
] as const;

export const SHADER_SEMANTIC_TOKEN_MODIFIERS = ['declaration', 'readonly'] as const;

export const SHADER_KEYWORDS_SKIP = new Set([
  'Shader', 'Properties', 'SubShader', 'Pass', 'Category', 'UsePass', 'GrabPass', 'Tags',
  'LOD', 'Fallback', 'CustomEditor', 'Dependency', 'Cull', 'ZWrite', 'ZTest', 'Blend',
  'BlendOp', 'ColorMask', 'Offset', 'Stencil', 'Ref', 'Comp', 'Fail', 'ZFail',
  'HLSLPROGRAM', 'ENDHLSL', 'HLSLINCLUDE', 'CGPROGRAM', 'ENDCG', 'CGINCLUDE',
  'struct', 'cbuffer', 'tbuffer', 'if', 'else', 'for', 'while', 'do', 'switch', 'case',
  'default', 'return', 'break', 'continue', 'discard', 'typedef', 'uniform', 'static',
  'inline', 'extern', 'const', 'in', 'out', 'inout', 'groupshared', 'void', 'bool', 'bool2',
  'bool3', 'bool4', 'int', 'uint', 'dword', 'half', 'float', 'double', 'real', 'fixed',
  'fixed2', 'fixed3', 'fixed4', 'float2', 'float3', 'float4', 'half2', 'half3', 'half4',
  'real2', 'real3', 'real4', 'int2', 'int3', 'int4', 'uint2', 'uint3', 'uint4',
  'float2x2', 'float3x3', 'float4x4', 'half2x2', 'half3x3', 'half4x4', 'real2x2',
  'real3x3', 'real4x4', 'Texture2D', 'Texture2DArray', 'Texture3D', 'TextureCube',
  'SamplerState', 'SamplerComparisonState', 'StructuredBuffer', 'RWStructuredBuffer',
  'TEXTURE2D', 'SAMPLER', 'CBUFFER_START', 'CBUFFER_END', 'true', 'false',
  'Range', 'Float', 'Int', 'Integer', 'Color', 'Vector', 'Cube', 'Any', 'Off', 'On',
]);

const SWIZZLE_RE = /^(?:[xyzw]{1,4}|[rgba]{1,4})$/;
const SCALAR_OR_VECTOR_TYPE_RE = /^(?:float|half|real|min16float|fixed|int|uint|bool)[1234]?$/;

const BUILTIN_HLSL_SIGNATURES: Record<string, Array<{ label: string; doc: string }>> = {
  lerp: [{ label: 'T lerp(T x, T y, T s)', doc: '[UnitySense] x와 y 사이를 s 비율로 선형 보간합니다.' }],
  saturate: [{ label: 'T saturate(T x)', doc: '[UnitySense] 값을 [0, 1] 범위로 클램프합니다.' }],
  clamp: [{ label: 'T clamp(T x, T min, T max)', doc: '[UnitySense] 값을 [min, max] 범위로 제한합니다.' }],
  smoothstep: [{ label: 'T smoothstep(T min, T max, T x)', doc: '[UnitySense] min~max 구간에서 부드러운 에르미트 보간을 수행합니다.' }],
  step: [{ label: 'T step(T edge, T x)', doc: '[UnitySense] x >= edge이면 1, 아니면 0을 반환합니다.' }],
  dot: [{ label: 'scalar dot(vec a, vec b)', doc: '[UnitySense] 두 벡터의 내적(dot product)을 계산합니다.' }],
  cross: [{ label: 'float3 cross(float3 a, float3 b)', doc: '[UnitySense] 두 3D 벡터의 외적(cross product)을 계산합니다.' }],
  mul: [
    { label: 'float4 mul(float4x4 m, float4 v)', doc: '[UnitySense] 행렬과 벡터 또는 두 행렬을 곱합니다.' },
    { label: 'float3 mul(float3x3 m, float3 v)', doc: '[UnitySense] 3x3 회전/변환 행렬과 3D 벡터를 곱합니다.' },
  ],
  normalize: [{ label: 'T normalize(T v)', doc: '[UnitySense] 벡터를 단위 길이(1)로 정규화합니다.' }],
  length: [{ label: 'float length(vec v)', doc: '[UnitySense] 벡터의 유클리드 길이를 반환합니다.' }],
  distance: [{ label: 'float distance(vec a, vec b)', doc: '[UnitySense] 두 점 사이의 거리를 반환합니다.' }],
  reflect: [{ label: 'T reflect(T i, T n)', doc: '[UnitySense] 입사 벡터 i를 법선 n 기준으로 반사합니다.' }],
  refract: [{ label: 'T refract(T i, T n, float eta)', doc: '[UnitySense] 굴절률 eta를 적용하여 굴절 벡터를 계산합니다.' }],
  pow: [{ label: 'T pow(T base, T exp)', doc: '[UnitySense] 거듭제곱 base^exp를 계산합니다.' }],
  max: [{ label: 'T max(T a, T b)', doc: '[UnitySense] 두 값 중 큰 값을 반환합니다.' }],
  min: [{ label: 'T min(T a, T b)', doc: '[UnitySense] 두 값 중 작은 값을 반환합니다.' }],
  tex2D: [{ label: 'float4 tex2D(sampler2D s, float2 uv)', doc: '[UnitySense] 레거시 2D 텍스처 샘플링을 수행합니다.' }],
  tex2Dlod: [{ label: 'float4 tex2Dlod(sampler2D s, float4 uv_lod)', doc: '[UnitySense] 명시적 밉맵 LOD(.w)로 2D 텍스처를 샘플링합니다.' }],
  SAMPLE_TEXTURE2D: [{ label: 'half4 SAMPLE_TEXTURE2D(Texture2D tex, SamplerState smp, float2 uv)', doc: '[UnitySense] URP/SRP 표준 2D 텍스처를 샘플링합니다.' }],
  SAMPLE_TEXTURE2D_LOD: [{ label: 'half4 SAMPLE_TEXTURE2D_LOD(Texture2D tex, SamplerState smp, float2 uv, float lod)', doc: '[UnitySense] 지정된 mip 레벨(lod)로 2D 텍스처를 샘플링합니다.' }],
  TEXTURE2D: [{ label: 'TEXTURE2D(textureName)', doc: '[UnitySense] SRP 플랫폼 호환 Texture2D 변수를 선언합니다.' }],
  SAMPLER: [{ label: 'SAMPLER(samplerName)', doc: '[UnitySense] SRP 플랫폼 호환 SamplerState 변수를 선언합니다.' }],
  TransformObjectToHClip: [{ label: 'float4 TransformObjectToHClip(float3 positionOS)', doc: '[UnitySense] 오브젝트 공간 좌표를 동차 클립 공간으로 변환합니다.' }],
  TransformObjectToWorld: [{ label: 'float3 TransformObjectToWorld(float3 positionOS)', doc: '[UnitySense] 오브젝트 공간 좌표를 월드 공간으로 변환합니다.' }],
  TransformObjectToWorldNormal: [{ label: 'float3 TransformObjectToWorldNormal(float3 normalOS, bool doNormalize)', doc: '[UnitySense] 오브젝트 공간 법선을 월드 공간 법선으로 변환합니다.' }],
  TransformWorldToHClip: [{ label: 'float4 TransformWorldToHClip(float3 positionWS)', doc: '[UnitySense] 월드 공간 좌표를 클립 공간으로 변환합니다.' }],
  GetVertexPositionInputs: [{ label: 'VertexPositionInputs GetVertexPositionInputs(float3 positionOS)', doc: '[UnitySense] positionWS/VS/CS/NDC를 한 번에 계산합니다.' }],
  GetVertexNormalInputs: [{ label: 'VertexNormalInputs GetVertexNormalInputs(float3 normalOS, float4 tangentOS)', doc: '[UnitySense] TBN(tangentWS, bitangentWS, normalWS) 벡터를 계산합니다.' }],
  GetMainLight: [
    { label: 'Light GetMainLight()', doc: '[UnitySense] 메인 방향성 라이트 정보를 반환합니다.' },
    { label: 'Light GetMainLight(float4 shadowCoord, float3 positionWS, half4 shadowMask)', doc: '[UnitySense] 그림자 감쇠가 포함된 메인 라이트 정보를 반환합니다.' },
  ],
  GetAdditionalLight: [{ label: 'Light GetAdditionalLight(uint i, float3 positionWS)', doc: '[UnitySense] 인덱스 i에 해당하는 추가 라이트(Point/Spot)를 반환합니다.' }],
  UniversalFragmentPBR: [{ label: 'half4 UniversalFragmentPBR(InputData inputData, SurfaceData surfaceData)', doc: '[UnitySense] URP PBR 라이팅 최종 색상을 계산합니다.' }],
  MixFog: [{ label: 'half3 MixFog(half3 fragColor, float fogCoord)', doc: '[UnitySense] 프래그먼트 색상에 씬 안개(Fog)를 혼합합니다.' }],
  TraceRay: [{ label: 'void TraceRay(RaytracingAccelerationStructure AccelerationStructure, uint RayFlags, uint InstanceInclusionMask, uint RayContributionToHitGroupIndex, uint MultiplierForGeometryContributionToHitGroupIndex, uint MissShaderIndex, RayDesc Ray, inout payload_t Payload)', doc: '[UnitySense] DXR / Unity RayTracing 가속 구조체에 대해 광선을 추적합니다.' }],
  WaveActiveSum: [{ label: 'T WaveActiveSum(T expr)', doc: '[UnitySense] SM 6.0 Wave 내 모든 활성 레인의 값 합계를 반환합니다.' }],
  WaveReadLaneFirst: [{ label: 'T WaveReadLaneFirst(T expr)', doc: '[UnitySense] SM 6.0 Wave의 첫 번째 활성 레인 값을 모든 레인에 브로드캐스트합니다.' }],
  asfloat: [{ label: 'float asfloat(uint x)', doc: '[UnitySense] 32비트 정수 비트를 IEEE 754 float로 재해석합니다.' }],
  asuint: [{ label: 'uint asuint(float x)', doc: '[UnitySense] IEEE 754 float 비트를 부호 없는 32비트 정수로 재해석합니다.' }],
  f16tof32: [{ label: 'float f16tof32(uint value)', doc: '[UnitySense] 하위 16비트 half 값을 32비트 float로 변환합니다.' }],
  f32tof16: [{ label: 'uint f32tof16(float value)', doc: '[UnitySense] 32비트 float 값을 하위 16비트 half 비트로 변환합니다.' }],
  NonUniformResourceIndex: [{ label: 'uint NonUniformResourceIndex(uint index)', doc: '[UnitySense] SM 5.1+/6.x 동적(비균일) 디스크립터 배열 인덱싱을 표시합니다.' }],
  sin: [{ label: 'T sin(T x)', doc: '[UnitySense] 라디안 각도 x의 사인 값을 계산합니다.' }],
  cos: [{ label: 'T cos(T x)', doc: '[UnitySense] 라디안 각도 x의 코사인 값을 계산합니다.' }],
  tan: [{ label: 'T tan(T x)', doc: '[UnitySense] 라디안 각도 x의 탄젠트 값을 계산합니다.' }],
  asin: [{ label: 'T asin(T x)', doc: '[UnitySense] [-1, 1] 범위 값의 아크사인을 계산합니다.' }],
  acos: [{ label: 'T acos(T x)', doc: '[UnitySense] [-1, 1] 범위 값의 아크코사인을 계산합니다.' }],
  atan: [{ label: 'T atan(T x)', doc: '[UnitySense] 값 x의 아크탄젠트를 계산합니다.' }],
  atan2: [{ label: 'T atan2(T y, T x)', doc: '[UnitySense] y/x의 아크탄젠트(사분면 보존)를 계산합니다.' }],
  abs: [{ label: 'T abs(T x)', doc: '[UnitySense] x의 절댓값을 반환합니다.' }],
  sign: [{ label: 'T sign(T x)', doc: '[UnitySense] x의 부호(-1, 0, 1)를 반환합니다.' }],
  floor: [{ label: 'T floor(T x)', doc: '[UnitySense] x보다 작거나 같은 최대 정수를 반환합니다.' }],
  ceil: [{ label: 'T ceil(T x)', doc: '[UnitySense] x보다 크거나 같은 최소 정수를 반환합니다.' }],
  round: [{ label: 'T round(T x)', doc: '[UnitySense] x를 가장 가까운 정수로 반올림합니다.' }],
  frac: [{ label: 'T frac(T x)', doc: '[UnitySense] x의 소수부(x - floor(x))를 반환합니다.' }],
  fmod: [{ label: 'T fmod(T x, T y)', doc: '[UnitySense] x를 y로 나눈 부동소수점 나머지를 반환합니다.' }],
  sqrt: [{ label: 'T sqrt(T x)', doc: '[UnitySense] x의 제곱근을 계산합니다.' }],
  rsqrt: [{ label: 'T rsqrt(T x)', doc: '[UnitySense] x의 역제곱근(1 / sqrt(x))을 계산합니다.' }],
  exp: [{ label: 'T exp(T x)', doc: '[UnitySense] 자연지수 e^x를 계산합니다.' }],
  exp2: [{ label: 'T exp2(T x)', doc: '[UnitySense] 2^x를 계산합니다.' }],
  log: [{ label: 'T log(T x)', doc: '[UnitySense] x의 자연로그 ln(x)를 계산합니다.' }],
  log2: [{ label: 'T log2(T x)', doc: '[UnitySense] x의 밑이 2인 로그를 계산합니다.' }],
  ddx: [{ label: 'T ddx(T x)', doc: '[UnitySense] 픽셀 셰이더에서 화면 X축 방향 편미분을 계산합니다.' }],
  ddy: [{ label: 'T ddy(T x)', doc: '[UnitySense] 픽셀 셰이더에서 화면 Y축 방향 편미분을 계산합니다.' }],
  fwidth: [{ label: 'T fwidth(T x)', doc: '[UnitySense] abs(ddx(x)) + abs(ddy(x))를 반환합니다.' }],
  clip: [{ label: 'void clip(T x)', doc: '[UnitySense] x의 어느 한 성분이라도 0 미만이면 현재 픽셀을 폐기합니다.' }],
  all: [{ label: 'bool all(T x)', doc: '[UnitySense] x의 모든 성분이 0이 아니면 true를 반환합니다.' }],
  any: [{ label: 'bool any(T x)', doc: '[UnitySense] x의 성분 중 하나라도 0이 아니면 true를 반환합니다.' }],
  mad: [{ label: 'T mad(T mvalue, T avalue, T bvalue)', doc: '[UnitySense] 곱셈-덧셈 융합 연산(mvalue * avalue + bvalue)을 수행합니다.' }],
  rcp: [{ label: 'T rcp(T x)', doc: '[UnitySense] x의 빠른 근사 역수(1 / x)를 계산합니다.' }],
  sincos: [{ label: 'void sincos(T x, out T s, out T c)', doc: '[UnitySense] x의 사인(s)과 코사인(c)을 동시에 계산합니다.' }],
  tex2Dproj: [{ label: 'float4 tex2Dproj(sampler2D s, float4 t)', doc: '[UnitySense] 투영 나눗셈(t.xy / t.w)을 적용해 2D 텍스처를 샘플링합니다.' }],
  texCUBE: [{ label: 'float4 texCUBE(samplerCUBE s, float3 t)', doc: '[UnitySense] 방향 벡터 t로 큐브맵 텍스처를 샘플링합니다.' }],
};

export function stripCommentsAndStringsByLine(lines: readonly string[]): string[] {
  const out: string[] = [];
  let inBlockComment = false;
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx];
    const chars = rawLine.split('');
    let inString = false;
    for (let c = 0; c < chars.length; c++) {
      const ch = rawLine[c];
      const next = rawLine[c + 1];
      if (inBlockComment) {
        chars[c] = ' ';
        if (ch === '*' && next === '/') {
          chars[c + 1] = ' ';
          inBlockComment = false;
          c++;
        }
        continue;
      }
      if (inString) {
        chars[c] = ' ';
        if (ch === '\\' && c + 1 < chars.length) {
          chars[c + 1] = ' ';
          c++;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '/' && next === '/') {
        for (let k = c; k < chars.length; k++) chars[k] = ' ';
        break;
      }
      if (ch === '/' && next === '*') {
        chars[c] = ' ';
        chars[c + 1] = ' ';
        inBlockComment = true;
        c++;
        continue;
      }
      if (ch === '"') {
        chars[c] = ' ';
        inString = true;
      }
    }
    out.push(chars.join(''));
  }
  return out;
}

export class ShaderSemanticTokensProvider {
  constructor(
    private readonly shaderGraph: IncludeDependencyGraph,
    private readonly legend: vscode.SemanticTokensLegend,
  ) {}

  public provideDocumentSemanticTokens(doc: vscode.TextDocument): vscode.SemanticTokens | undefined {
    const text = doc.getText();
    this.shaderGraph.setOpenDocumentContent(doc.uri.toString(), text);
    const filePath = this.shaderGraph.normalizeFilePath(doc.uri.toString());
    const walk = this.shaderGraph.collectReachableFiles(doc.uri.toString());
    const parsed = walk.files[0];
    if (!parsed) return undefined;

    const virtualDoc = extractVirtualHlslDocument(text, filePath);
    const pragmaEntryNames = new Set(virtualDoc.pragmas.entryPoints.map((e) => e.name));
    const pragmaKeywords = new Set<string>();
    for (const grp of virtualDoc.pragmas.keywordGroups) {
      for (const kw of grp.keywords) {
        if (!/^_+$/.test(kw)) pragmaKeywords.add(kw);
      }
    }

    const structNames = new Set<string>();
    const functionNames = new Set<string>();
    const propertyNames = new Set<string>();
    const macroNames = new Set<string>();
    const globalVarNames = new Set<string>();

    for (const f of walk.files) {
      for (const sym of f.symbols) {
        if (sym.kind === 'struct') structNames.add(sym.name);
        else if (sym.kind === 'function') functionNames.add(sym.name);
        else if (sym.kind === 'property') propertyNames.add(sym.name);
        else if (sym.kind === 'macro') macroNames.add(sym.name);
        else if (sym.kind === 'variable' || sym.kind === 'cbuffer') globalVarNames.add(sym.name);
      }
    }

    const lines = text.split(/\r?\n/);
    const codeLines = stripCommentsAndStringsByLine(lines);
    const builder = new vscode.SemanticTokensBuilder(this.legend);

    const hlslRanges = virtualDoc.isShaderLab
      ? virtualDoc.blocks.map((b) => ({ start: b.startLine, end: b.endLine }))
      : [{ start: 0, end: Math.max(0, lines.length - 1) }];

    const isInsideHlsl = (lineIdx: number): boolean =>
      hlslRanges.some((r) => lineIdx >= r.start && lineIdx <= r.end);

    for (let lineIdx = 0; lineIdx < codeLines.length; lineIdx++) {
      const codeLine = codeLines[lineIdx];
      const inHlsl = isInsideHlsl(lineIdx);

      if (!inHlsl) {
        // Inside ShaderLab Properties / SubShader: only color explicitly declared Properties identifiers
        const identRe = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
        let m: RegExpExecArray | null;
        while ((m = identRe.exec(codeLine)) !== null) {
          const ident = m[1];
          if (propertyNames.has(ident) && !SHADER_KEYWORDS_SKIP.has(ident)) {
            builder.push(lineIdx, m.index, ident.length, 4, 0);
          }
        }
        continue;
      }

      if (/^\s*#/.test(codeLine)) {
        const trimmed = codeLine.trim();
        const incDirectiveMatch = /^(\s*#\s*(?:include_with_pragmas|include))\b/.exec(codeLine);
        if (incDirectiveMatch) {
          const hashIdx = incDirectiveMatch[1].indexOf('#');
          if (hashIdx >= 0) {
            builder.push(lineIdx, hashIdx, incDirectiveMatch[1].length - hashIdx, 5, 0);
          }
        } else if (/^#\s*pragma\b/.test(trimmed)) {
          const identRe = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
          let m: RegExpExecArray | null;
          while ((m = identRe.exec(codeLine)) !== null) {
            const ident = m[1];
            if (pragmaEntryNames.has(ident)) {
              builder.push(lineIdx, m.index, ident.length, 1, 0);
            } else if (pragmaKeywords.has(ident) || macroNames.has(ident)) {
              builder.push(lineIdx, m.index, ident.length, 5, 0);
            }
          }
        } else if (/^#\s*(?:if|ifdef|ifndef|elif)\b/.test(trimmed)) {
          const identRe = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
          let m: RegExpExecArray | null;
          while ((m = identRe.exec(codeLine)) !== null) {
            const ident = m[1];
            if (ident === 'if' || ident === 'ifdef' || ident === 'ifndef' || ident === 'elif' || ident === 'defined') {
              continue;
            }
            if (macroNames.has(ident) || pragmaKeywords.has(ident) || /^[A-Z][A-Z0-9_]{2,}$/.test(ident)) {
              builder.push(lineIdx, m.index, ident.length, 5, 0);
            }
          }
        }
        continue;
      }

      const scope = parsed.localVarScopes.find(
        (sc) => lineIdx >= sc.startLine && lineIdx <= sc.endLine,
      );

      const identRe = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
      let m: RegExpExecArray | null;
      while ((m = identRe.exec(codeLine)) !== null) {
        const ident = m[1];
        const col = m.index;
        if (SHADER_KEYWORDS_SKIP.has(ident)) continue;

        const isDotMember = col > 0 && codeLine[col - 1] === '.';
        if (isDotMember) {
          const isCall = codeLine.slice(col + ident.length).trimStart().startsWith('(');
          if (isCall) {
            builder.push(lineIdx, col, ident.length, 1, 0);
          } else if (!SWIZZLE_RE.test(ident)) {
            builder.push(lineIdx, col, ident.length, 4, 0);
          }
          continue;
        }

        const localDecl = scope?.declarations.get(ident);
        if (localDecl && lineIdx >= localDecl.line) {
          const typeIdx = localDecl.kind === 'parameter' ? 2 : 3;
          const modMask = localDecl.line === lineIdx ? 1 : 0;
          builder.push(lineIdx, col, ident.length, typeIdx, modMask);
          continue;
        }

        if (structNames.has(ident)) {
          builder.push(lineIdx, col, ident.length, 0, 0);
        } else if (functionNames.has(ident)) {
          builder.push(lineIdx, col, ident.length, 1, 0);
        } else if (globalVarNames.has(ident)) {
          builder.push(lineIdx, col, ident.length, 3, 0);
        } else if (propertyNames.has(ident)) {
          builder.push(lineIdx, col, ident.length, 4, 0);
        } else if (macroNames.has(ident) || pragmaKeywords.has(ident)) {
          builder.push(lineIdx, col, ident.length, 5, 0);
        } else if (codeLine.slice(col + ident.length).trimStart().startsWith('(')) {
          builder.push(lineIdx, col, ident.length, 1, 0);
        }
      }
    }

    return builder.build();
  }
}

export class ShaderDocumentSymbolProvider {
  constructor(private readonly shaderGraph: IncludeDependencyGraph) {}

  public provideDocumentSymbols(doc: vscode.TextDocument): vscode.DocumentSymbol[] {
    const text = doc.getText();
    this.shaderGraph.setOpenDocumentContent(doc.uri.toString(), text);
    const filePath = this.shaderGraph.normalizeFilePath(doc.uri.toString());
    const parsed = this.shaderGraph.getOrParseFile(filePath);
    if (!parsed) return [];

    const docLineCount = Math.max(1, doc.lineCount);
    const safeRange = (startLine: number, startCol = 0, endLine = startLine, endCol = 80) => {
      const sl = Math.max(0, Math.min(startLine, docLineCount - 1));
      const el = Math.max(sl, Math.min(endLine, docLineCount - 1));
      const maxEndCol = doc.lineAt(el).text.length;
      return new vscode.Range(sl, Math.max(0, startCol), el, Math.min(maxEndCol, Math.max(startCol, endCol)));
    };

    const topSymbols: vscode.DocumentSymbol[] = [];

    if (parsed.properties.length > 0) {
      const firstPropLine = parsed.properties[0].line ?? 0;
      const lastPropLine = parsed.properties[parsed.properties.length - 1].line ?? firstPropLine;
      const propsGroup = new vscode.DocumentSymbol(
        'Properties',
        `셰이더 프로퍼티 ${parsed.properties.length}개`,
        vscode.SymbolKind.Namespace,
        safeRange(firstPropLine, 0, lastPropLine, doc.lineAt(Math.min(lastPropLine, docLineCount - 1)).text.length),
        safeRange(firstPropLine, 0, firstPropLine, 10),
      );
      for (const prop of parsed.properties) {
        const pLine = prop.line ?? 0;
        const pCol = prop.column ?? 0;
        const lineLen = doc.lineAt(Math.min(pLine, docLineCount - 1)).text.length;
        propsGroup.children.push(
          new vscode.DocumentSymbol(
            prop.name,
            `${prop.displayName} (${prop.type})`,
            vscode.SymbolKind.Property,
            safeRange(pLine, pCol, pLine, lineLen),
            safeRange(pLine, pCol, pLine, pCol + prop.name.length),
          ),
        );
      }
      topSymbols.push(propsGroup);
    }

    const rawLines = text.split(/\r?\n/);
    const subShaderPassRanges: Array<{
      kind: 'SubShader' | 'Pass';
      name: string;
      startLine: number;
      endLine: number;
      node: vscode.DocumentSymbol;
      parentSubShaderIdx?: number;
    }> = [];
    {
      const shaderLabChars = text.split('');
      for (const blk of parsed.blocks ?? []) {
        for (let k = blk.codeStartOffset; k < blk.codeEndOffset && k < shaderLabChars.length; k++) {
          if (shaderLabChars[k] !== '\n' && shaderLabChars[k] !== '\r') {
            shaderLabChars[k] = ' ';
          }
        }
      }
      const shaderLabLines = stripCommentsAndStringsByLine(shaderLabChars.join('').split(/\r?\n/));
      const blockStack: Array<{
        kind: 'SubShader' | 'Pass' | 'Stencil' | 'Other';
        name: string;
        startLine: number;
        parentSubShaderIdx?: number;
      }> = [];
      let pendingKind: 'SubShader' | 'Pass' | 'Stencil' | 'Other' | null = null;
      let pendingStartLine = 0;
      let currentSubShaderIdx = -1;
      let passCounter = 0;
      let subShaderCounter = 0;

      const tokenRe = /\b(SubShader|Pass|Stencil|Category)\b|([{}])/g;
      for (let i = 0; i < shaderLabLines.length; i++) {
        const line = shaderLabLines[i];
        tokenRe.lastIndex = 0;
        let tok: RegExpExecArray | null;
        while ((tok = tokenRe.exec(line)) !== null) {
          const kw = tok[1];
          const brace = tok[2];
          if (kw) {
            if (kw === 'SubShader') {
              pendingKind = 'SubShader';
              pendingStartLine = i;
            } else if (kw === 'Pass') {
              if (blockStack[blockStack.length - 1]?.kind !== 'Stencil') {
                pendingKind = 'Pass';
                pendingStartLine = i;
              }
            } else if (kw === 'Stencil') {
              pendingKind = 'Stencil';
              pendingStartLine = i;
            } else if (kw === 'Category') {
              pendingKind = 'Other';
              pendingStartLine = i;
            }
          } else if (brace === '{') {
            if (pendingKind === 'SubShader') {
              subShaderCounter++;
              blockStack.push({ kind: 'SubShader', name: `SubShader #${subShaderCounter}`, startLine: pendingStartLine });
              currentSubShaderIdx = subShaderPassRanges.length;
              pendingKind = null;
            } else if (pendingKind === 'Pass') {
              passCounter++;
              blockStack.push({
                kind: 'Pass',
                name: `Pass #${passCounter}`,
                startLine: pendingStartLine,
                parentSubShaderIdx: currentSubShaderIdx >= 0 ? currentSubShaderIdx : undefined,
              });
              pendingKind = null;
            } else if (pendingKind === 'Stencil') {
              blockStack.push({ kind: 'Stencil', name: 'Stencil', startLine: pendingStartLine });
              pendingKind = null;
            } else {
              blockStack.push({ kind: 'Other', name: '', startLine: i });
              pendingKind = null;
            }
          } else if (brace === '}' && blockStack.length > 0) {
            const popped = blockStack.pop()!;
            if (popped.kind === 'SubShader' || popped.kind === 'Pass') {
              let displayName = popped.name;
              if (popped.kind === 'Pass') {
                const rawSlice = rawLines.slice(popped.startLine, Math.min(i + 1, popped.startLine + 12)).join('\n');
                const nameMatch = /\bName\s+"([^"]+)"/.exec(rawSlice);
                if (nameMatch) {
                  displayName = `Pass "${nameMatch[1]}"`;
                }
              }
              const r = safeRange(popped.startLine, 0, i, doc.lineAt(Math.min(i, docLineCount - 1)).text.length);
              const sel = safeRange(popped.startLine, 0, popped.startLine, doc.lineAt(Math.min(popped.startLine, docLineCount - 1)).text.length);
              const node = new vscode.DocumentSymbol(
                displayName,
                popped.kind === 'SubShader' ? 'ShaderLab SubShader' : 'ShaderLab Pass',
                popped.kind === 'SubShader' ? vscode.SymbolKind.Module : vscode.SymbolKind.Class,
                r,
                sel,
              );
              subShaderPassRanges.push({
                kind: popped.kind,
                name: displayName,
                startLine: popped.startLine,
                endLine: i,
                node,
                parentSubShaderIdx: popped.parentSubShaderIdx,
              });
              if (popped.kind === 'SubShader') {
                currentSubShaderIdx = -1;
              }
            }
          }
        }
      }
    }

    const passEntries = subShaderPassRanges.filter((e) => e.kind === 'Pass');
    const subShaderEntries = subShaderPassRanges.filter((e) => e.kind === 'SubShader');

    const attachToHierarchy = (symLine: number, node: vscode.DocumentSymbol) => {
      const passHit = passEntries.find((p) => symLine >= p.startLine && symLine <= p.endLine);
      if (passHit) {
        passHit.node.children.push(node);
        return;
      }
      const ssHit = subShaderEntries.find((s) => symLine >= s.startLine && symLine <= s.endLine);
      if (ssHit) {
        ssHit.node.children.push(node);
        return;
      }
      topSymbols.push(node);
    };

    const structNodes = new Map<string, vscode.DocumentSymbol>();
    for (const sym of parsed.symbols) {
      if (sym.kind === 'property') continue;
      if (sym.kind === 'field') continue;

      const symRange = safeRange(
        sym.line,
        sym.column,
        sym.line,
        doc.lineAt(Math.min(sym.line, docLineCount - 1)).text.length,
      );
      const selRange = safeRange(sym.line, sym.column, sym.line, sym.column + sym.name.length);
      const kind =
        sym.kind === 'struct'
          ? vscode.SymbolKind.Struct
          : sym.kind === 'function'
            ? vscode.SymbolKind.Function
            : sym.kind === 'cbuffer'
              ? vscode.SymbolKind.Namespace
              : sym.kind === 'macro'
                ? vscode.SymbolKind.Constant
                : vscode.SymbolKind.Variable;
      const detail = sym.signature ?? sym.returnType ?? sym.kind;
      const node = new vscode.DocumentSymbol(sym.name, detail, kind, symRange, selRange);
      if (sym.kind === 'struct') {
        structNodes.set(`${sym.line}:${sym.name}`, node);
        const symBlockIdx = findBlockIndexAtLine(parsed.blocks, sym.line);
        const scopedGroups = parsed.scopedStructFields?.get(sym.name);
        const matchedGroup = scopedGroups?.find((g) => g.blockIndex === symBlockIdx);
        const fields = matchedGroup?.fields ?? parsed.structFieldsByStruct.get(sym.name) ?? [];
        for (const f of fields) {
          const fRange = safeRange(f.line, f.column, f.line, f.column + f.name.length);
          node.children.push(
            new vscode.DocumentSymbol(f.name, f.returnType ?? 'field', vscode.SymbolKind.Field, fRange, fRange),
          );
        }
      }
      attachToHierarchy(sym.line, node);
    }

    for (const p of passEntries) {
      const parentSs = subShaderEntries.find((s) => p.startLine >= s.startLine && p.endLine <= s.endLine);
      if (parentSs) {
        parentSs.node.children.push(p.node);
      } else {
        topSymbols.push(p.node);
      }
    }
    for (const s of subShaderEntries) {
      topSymbols.push(s.node);
    }

    if (parsed.shaderName) {
      const rootNode = new vscode.DocumentSymbol(
        `Shader "${parsed.shaderName}"`,
        'Unity ShaderLab',
        vscode.SymbolKind.Module,
        safeRange(0, 0, docLineCount - 1, doc.lineAt(docLineCount - 1).text.length),
        safeRange(0, 0, 0, doc.lineAt(0).text.length),
      );
      rootNode.children.push(...topSymbols);
      return [rootNode];
    }

    return topSymbols;
  }
}

function splitTopLevelParams(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\' && i + 1 < text.length) {
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '(' || ch === '[' || ch === '<' || ch === '{') {
      depth++;
    } else if ((ch === ')' || ch === ']' || ch === '>' || ch === '}') && depth > 0) {
      depth--;
    } else if (ch === ',' && depth === 0) {
      const seg = text.slice(start, i).trim();
      if (seg) out.push(seg);
      start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

function formatReadableUriLocation(uriStr: string): string {
  try {
    const fsPath = uriStr.startsWith('file://') ? fileURLToPath(uriStr) : uriStr;
    const slashNorm = fsPath.replace(/\\/g, '/');
    const pkgIdx = slashNorm.toLowerCase().indexOf('/library/packagecache/');
    if (pkgIdx >= 0) {
      return `Packages/${slashNorm.slice(pkgIdx + '/library/packagecache/'.length)}`;
    }
    const assetsIdx = slashNorm.toLowerCase().indexOf('/assets/');
    if (assetsIdx >= 0) {
      return slashNorm.slice(assetsIdx + 1);
    }
    return path.basename(fsPath);
  } catch {
    return uriStr;
  }
}

export class ShaderSignatureHelpProvider {
  constructor(private readonly shaderGraph: IncludeDependencyGraph) {}

  public provideSignatureHelp(doc: vscode.TextDocument, position: vscode.Position): vscode.SignatureHelp | undefined {
    const startLine = Math.max(0, position.line - 40);
    const rawSnippet = doc.getText(new vscode.Range(new vscode.Position(startLine, 0), position));
    const snippet = stripCommentsAndStringsByLine(rawSnippet.split(/\r?\n/)).join('\n');
    const callContext = this.findEnclosingCall(snippet);
    if (!callContext) return undefined;

    this.shaderGraph.setOpenDocumentContent(doc.uri.toString(), doc.getText());
    const visible = this.shaderGraph.findSymbolsVisibleFrom(
      doc.uri.toString(),
      callContext.funcName,
      position.line,
    );
    const candidates: Array<{ label: string; doc: string; params: string[] }> = [];

    for (const sym of visible) {
      if ((sym.kind === 'function' || sym.kind === 'macro') && sym.signature) {
        const params = this.extractParamList(sym.signature);
        candidates.push({
          label: sym.signature,
          doc: `[UnitySense] 선언 위치: ${formatReadableUriLocation(sym.uri)}:${sym.line + 1}`,
          params,
        });
      }
    }

    const builtins = BUILTIN_HLSL_SIGNATURES[callContext.funcName] ?? [];
    for (const b of builtins) {
      if (!candidates.some((c) => c.label === b.label)) {
        candidates.push({
          label: b.label,
          doc: b.doc,
          params: this.extractParamList(b.label),
        });
      }
    }

    if (candidates.length === 0) return undefined;

    let bestSigIdx = 0;
    let bestParamDelta = Number.POSITIVE_INFINITY;
    let fallbackMaxIdx = 0;
    let maxParams = -1;
    for (let idx = 0; idx < candidates.length; idx++) {
      const len = candidates[idx].params.length;
      if (len > maxParams) {
        maxParams = len;
        fallbackMaxIdx = idx;
      }
      if (len > callContext.argIndex) {
        const delta = len - callContext.argIndex;
        if (delta < bestParamDelta) {
          bestParamDelta = delta;
          bestSigIdx = idx;
        }
      }
    }
    if (!Number.isFinite(bestParamDelta)) {
      bestSigIdx = fallbackMaxIdx;
    }

    const help = new vscode.SignatureHelp();
    help.signatures = candidates.map((cand) => {
      const sigInfo = new vscode.SignatureInformation(cand.label, cand.doc);
      sigInfo.parameters = cand.params.map((p) => new vscode.ParameterInformation(p));
      return sigInfo;
    });
    help.activeSignature = bestSigIdx;
    const paramCount = candidates[bestSigIdx].params.length;
    help.activeParameter = paramCount > 0 ? Math.min(callContext.argIndex, paramCount - 1) : 0;
    return help;
  }

  private findEnclosingCall(snippet: string): { funcName: string; argIndex: number } | null {
    let depth = 0;
    let commas = 0;
    for (let i = snippet.length - 1; i >= 0; i--) {
      const ch = snippet[i];
      if (ch === ')') {
        depth++;
      } else if (ch === '(') {
        if (depth === 0) {
          const before = snippet.slice(0, i);
          const match = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(before);
          if (!match) return null;
          return { funcName: match[1], argIndex: commas };
        }
        depth--;
      } else if (ch === ',' && depth === 0) {
        commas++;
      }
    }
    return null;
  }

  private extractParamList(signature: string): string[] {
    const open = signature.indexOf('(');
    const close = signature.lastIndexOf(')');
    if (open < 0 || close <= open) return [];
    const inner = signature.slice(open + 1, close).trim();
    if (!inner || inner === 'void') return [];
    return splitTopLevelParams(inner);
  }
}

function collectIdentifierMatches(
  text: string,
  symbolName: string,
): Array<{ line: number; col: number; isWrite: boolean; isDotAccess: boolean }> {
  const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wordRe = new RegExp(`\\b${escaped}\\b`, 'g');
  const codeLines = stripCommentsAndStringsByLine(text.split(/\r?\n/));
  const hits: Array<{ line: number; col: number; isWrite: boolean; isDotAccess: boolean }> = [];

  for (let lineIdx = 0; lineIdx < codeLines.length; lineIdx++) {
    const line = codeLines[lineIdx];
    wordRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = wordRe.exec(line)) !== null) {
      const col = m.index;
      const isDotAccess = col > 0 && line[col - 1] === '.';
      const after = line.slice(col + symbolName.length).trimStart();
      const isWrite = /^(?:\+=|-=|\*=|\/=|%=|=(?!=))/.test(after);
      hits.push({ line: lineIdx, col, isWrite, isDotAccess });
    }
  }
  return hits;
}

function resolveTargetStructName(
  doc: vscode.TextDocument,
  parsed: ParsedHlslFile,
  word: string,
  wordRange: vscode.Range | undefined,
  position: vscode.Position,
  shaderGraph: IncludeDependencyGraph,
): string | null {
  const declSym =
    parsed.symbols.find(
      (s) =>
        s.kind === 'field' &&
        s.name === word &&
        s.line === position.line &&
        position.character >= s.column &&
        position.character <= s.column + s.name.length,
    ) ??
    parsed.symbols.find(
      (s) => s.kind === 'field' && s.name === word && s.line === position.line,
    );
  if (declSym) {
    return declSym.containerName ?? null;
  }

  const lineText = doc.lineAt(position.line).text;
  const isDotCursor = Boolean(
    wordRange && wordRange.start.character > 0 && lineText[wordRange.start.character - 1] === '.',
  );
  if (isDotCursor && wordRange) {
    const chainExpr = extractMemberChainExpression(lineText.slice(0, wordRange.end.character));
    if (chainExpr) {
      const entryNorm = shaderGraph.normalizeFilePath(doc.uri.toString());
      const resolved = shaderGraph.resolveExpressionChain(entryNorm, chainExpr, position.line);
      return resolved.field?.containerName ?? resolved.ownerType ?? null;
    }
  }
  return null;
}

function filterFieldMatchesByStruct<T extends { line: number; col: number; isDotAccess: boolean }>(
  matches: readonly T[],
  fileLines: readonly string[],
  fileParsed: ParsedHlslFile,
  word: string,
  targetStructName: string,
  filePath: string,
  shaderGraph: IncludeDependencyGraph,
): T[] {
  return matches.filter((hit) => {
    if (hit.isDotAccess) {
      const hitLine = fileLines[hit.line] ?? '';
      const hitChain = extractMemberChainExpression(hitLine.slice(0, hit.col + word.length));
      if (!hitChain) return false;
      const hitResolved = shaderGraph.resolveExpressionChain(filePath, hitChain, hit.line);
      const hitOwner = hitResolved.field?.containerName ?? hitResolved.ownerType ?? null;
      return hitOwner === targetStructName;
    }
    return fileParsed.symbols.some(
      (s) =>
        s.kind === 'field' &&
        s.name === word &&
        s.line === hit.line &&
        s.containerName === targetStructName,
    );
  });
}

export class ShaderDocumentHighlightProvider {
  constructor(private readonly shaderGraph?: IncludeDependencyGraph) {}

  public provideDocumentHighlights(
    doc: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.DocumentHighlight[] {
    const wordRange = doc.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
    if (!wordRange) return [];
    const word = doc.getText(wordRange);
    if (!word || SHADER_KEYWORDS_SKIP.has(word)) return [];

    const lineText = doc.lineAt(position.line).text;
    const isDotCursor = wordRange.start.character > 0 && lineText[wordRange.start.character - 1] === '.';
    const text = doc.getText();
    const allMatches = collectIdentifierMatches(text, word);
    let matches: Array<{ line: number; col: number; isWrite: boolean; isDotAccess: boolean }>;

    if (this.shaderGraph) {
      const parsed = this.shaderGraph.setOpenDocumentContent(doc.uri.toString(), text);
      const cursorLine = position.line;
      const isFieldDeclCursor = parsed.symbols.some(
        (s) => s.kind === 'field' && s.name === word && s.line === cursorLine,
      );
      const isFieldCursor = isDotCursor || isFieldDeclCursor;

      if (isFieldCursor) {
        const targetStructName = resolveTargetStructName(
          doc,
          parsed,
          word,
          wordRange,
          position,
          this.shaderGraph,
        );
        if (targetStructName) {
          const entryNorm = this.shaderGraph.normalizeFilePath(doc.uri.toString());
          const lines = text.split(/\r?\n/);
          matches = filterFieldMatchesByStruct(
            allMatches,
            lines,
            parsed,
            word,
            targetStructName,
            entryNorm,
            this.shaderGraph,
          );
        } else {
          matches = allMatches.filter((hit) => {
            const isStructFieldDecl = parsed.symbols.some(
              (s) => s.kind === 'field' && s.name === word && s.line === hit.line,
            );
            return isDotCursor ? hit.isDotAccess : hit.isDotAccess || isStructFieldDecl;
          });
        }
      } else {
        const localScope = parsed.localVarScopes.find(
          (sc) => cursorLine >= sc.startLine && cursorLine <= sc.endLine && sc.declarations.has(word),
        );
        const decl = localScope?.declarations.get(word);
        if (localScope && decl && cursorLine >= decl.line) {
          matches = allMatches.filter(
            (hit) => !hit.isDotAccess && hit.line >= localScope.startLine && hit.line <= localScope.endLine,
          );
        } else {
          matches = allMatches.filter((hit) => !hit.isDotAccess);
        }
      }
    } else {
      matches = allMatches.filter((hit) => (isDotCursor ? hit.isDotAccess : !hit.isDotAccess));
    }

    return matches.map(
      (hit) =>
        new vscode.DocumentHighlight(
          new vscode.Range(hit.line, hit.col, hit.line, hit.col + word.length),
          hit.isWrite ? vscode.DocumentHighlightKind.Write : vscode.DocumentHighlightKind.Read,
        ),
    );
  }
}

function isTokenInCommentOrString(doc: vscode.TextDocument, wordRange: vscode.Range, word: string): boolean {
  const lines = doc.getText().split(/\r?\n/);
  const strippedLines = stripCommentsAndStringsByLine(lines);
  const strippedSlice = (strippedLines[wordRange.start.line] ?? '').slice(
    wordRange.start.character,
    wordRange.end.character,
  );
  return strippedSlice !== word;
}

function isVectorSwizzleToken(
  doc: vscode.TextDocument,
  wordRange: vscode.Range,
  word: string,
  shaderGraph?: IncludeDependencyGraph,
): boolean {
  if (!SWIZZLE_RE.test(word)) return false;
  const lineText = doc.lineAt(wordRange.start.line).text;
  if (wordRange.start.character <= 0 || lineText[wordRange.start.character - 1] !== '.') {
    return false;
  }
  if (!shaderGraph) return true;

  const uriStr = doc.uri.toString();
  shaderGraph.setOpenDocumentContent(uriStr, doc.getText());
  const chainExpr = extractMemberChainExpression(lineText.slice(0, wordRange.end.character));
  if (!chainExpr) return true;

  const entryNorm = shaderGraph.normalizeFilePath(uriStr);
  const resolved = shaderGraph.resolveExpressionChain(entryNorm, chainExpr, wordRange.start.line);
  if (resolved.field !== null) {
    return false;
  }
  if (!resolved.ownerType || resolved.type !== null) {
    return true;
  }
  return SCALAR_OR_VECTOR_TYPE_RE.test(resolved.ownerType.trim());
}

function collectCrossFileOccurrences(
  doc: vscode.TextDocument,
  word: string,
  shaderGraph: IncludeDependencyGraph,
  position: vscode.Position,
): Array<{ uri: vscode.Uri; filePath: string; line: number; col: number }> {
  const uriStr = doc.uri.toString();
  const entryKey = normalizePathKey(uriStr);
  const entryNorm = shaderGraph.normalizeFilePath(uriStr);
  const parsed = shaderGraph.setOpenDocumentContent(uriStr, doc.getText());
  const cursorLine = position.line;
  const lineText = doc.lineAt(cursorLine).text;
  const wordRange = doc.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
  const isDotCursor = Boolean(
    wordRange && wordRange.start.character > 0 && lineText[wordRange.start.character - 1] === '.',
  );
  const isFieldDeclCursor = parsed.symbols.some(
    (s) => s.kind === 'field' && s.name === word && s.line === cursorLine,
  );
  const isFieldCursor = isDotCursor || isFieldDeclCursor;

  // If cursor is on a local variable or function parameter (and not a `.member` access or struct field declaration), restrict to that function scope
  if (!isFieldCursor) {
    const localScope = parsed.localVarScopes.find(
      (sc) => cursorLine >= sc.startLine && cursorLine <= sc.endLine && sc.declarations.has(word),
    );
    const decl = localScope?.declarations.get(word);
    if (localScope && decl && cursorLine >= decl.line) {
      const matches = collectIdentifierMatches(doc.getText(), word);
      return matches
        .filter(
          (hit) => !hit.isDotAccess && hit.line >= localScope.startLine && hit.line <= localScope.endLine,
        )
        .map((hit) => ({
          uri: doc.uri,
          filePath: entryNorm,
          line: hit.line,
          col: hit.col,
        }));
    }
  }

  const openBuffersByKey = new Map<string, string>();
  for (const openDoc of vscode.workspace.textDocuments ?? []) {
    const openUriStr = openDoc.uri.toString();
    const openKey = normalizePathKey(openUriStr);
    const openText = openDoc.getText();
    openBuffersByKey.set(openKey, openText);
    if (
      openKey !== entryKey &&
      openUriStr.startsWith('file://') &&
      isShaderFilePath(openDoc.fileName || openUriStr)
    ) {
      shaderGraph.setOpenDocumentContent(openUriStr, openText);
    }
  }

  const walk = shaderGraph.collectReachableFiles(uriStr);
  const isShaderFile = /\.(shader|urtshader)$/i.test(entryNorm);
  const isShaderLabProp = parsed.properties.some((p) => p.name === word);
  const declaredInReachableHeader = walk.files
    .slice(1)
    .some((f) => f.symbols.some((s) => s.name === word));
  const restrictToCurrentShaderFile =
    isShaderFile && !isShaderLabProp && !declaredInReachableHeader && !isFieldCursor;

  const parents = restrictToCurrentShaderFile ? [] : [...shaderGraph.findParentIncludeFiles(uriStr)];
  if (!restrictToCurrentShaderFile) {
    for (const h of walk.files.slice(1)) {
      const declaresWord = isFieldCursor
        ? h.symbols.some((s) => s.kind === 'field' && s.name === word)
        : h.symbols.some((s) => s.name === word);
      if (declaresWord) {
        parents.push(...shaderGraph.findParentIncludeFiles(h.uri));
      }
    }
  }
  const candidates = restrictToCurrentShaderFile
    ? [parsed]
    : [...walk.files, ...parents];

  const symDeclInCurrent = parsed.symbols.find(
    (s) => s.name === word && s.kind !== 'property' && isLineVisibleInPass(parsed.blocks, s.line, cursorLine),
  );
  const targetStructName = isFieldCursor
    ? resolveTargetStructName(doc, parsed, word, wordRange, position, shaderGraph)
    : null;

  const visitedKeys = new Set<string>();
  const results: Array<{ uri: vscode.Uri; filePath: string; line: number; col: number }> = [];

  for (const file of candidates) {
    const fileKey = normalizePathKey(file.filePath);
    if (visitedKeys.has(fileKey)) continue;
    visitedKeys.add(fileKey);

    const isCurrent = fileKey === entryKey;
    let fileParsed = isCurrent ? parsed : file;
    let content = isCurrent ? doc.getText() : openBuffersByKey.get(fileKey);
    if (content !== undefined) {
      if (!isCurrent) {
        fileParsed = shaderGraph.setOpenDocumentContent(file.uri, content);
      }
    } else {
      try {
        content = fs.existsSync(file.filePath)
          ? fs.readFileSync(file.filePath, 'utf8')
          : file.virtualHlsl;
      } catch {
        content = file.virtualHlsl;
      }
    }

    const matches = collectIdentifierMatches(content, word);
    if (matches.length === 0) continue;

    const filteredMatches = isFieldCursor
      ? targetStructName
        ? filterFieldMatchesByStruct(
            matches,
            content.split(/\r?\n/),
            fileParsed,
            word,
            targetStructName,
            file.filePath,
            shaderGraph,
          )
        : matches.filter((hit) => {
            const isStructFieldDecl = fileParsed.symbols.some(
              (s) => s.kind === 'field' && s.name === word && s.line === hit.line,
            );
            return hit.isDotAccess || isStructFieldDecl;
          })
      : matches.filter((hit) => !hit.isDotAccess);

    for (const hit of filteredMatches) {
      if (
        isCurrent &&
        restrictToCurrentShaderFile &&
        symDeclInCurrent &&
        !isLineVisibleInPass(parsed.blocks, symDeclInCurrent.line, hit.line)
      ) {
        continue;
      }

      results.push({
        uri: vscode.Uri.parse(file.uri),
        filePath: file.filePath,
        line: hit.line,
        col: hit.col,
      });
    }
  }
  return results;
}

export class ShaderReferenceProvider {
  constructor(private readonly shaderGraph: IncludeDependencyGraph) {}

  public provideReferences(doc: vscode.TextDocument, position: vscode.Position): vscode.Location[] {
    const wordRange = doc.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
    if (!wordRange) return [];
    const word = doc.getText(wordRange);
    if (!word || SHADER_KEYWORDS_SKIP.has(word)) return [];

    return collectCrossFileOccurrences(doc, word, this.shaderGraph, position).map(
      (occ) =>
        new vscode.Location(occ.uri, new vscode.Range(occ.line, occ.col, occ.line, occ.col + word.length)),
    );
  }
}

export class ShaderRenameProvider {
  constructor(private readonly shaderGraph: IncludeDependencyGraph) {}

  public prepareRename(doc: vscode.TextDocument, position: vscode.Position): vscode.Range {
    const filePath = this.shaderGraph.normalizeFilePath(doc.uri.toString());
    if (filePath.replace(/\\/g, '/').toLowerCase().includes('/library/packagecache/')) {
      throw new Error('[UnitySense] 읽기 전용 PackageCache 셰이더 파일의 심볼은 이름을 변경할 수 없습니다.');
    }
    const wordRange = doc.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
    if (!wordRange) {
      throw new Error('[UnitySense] 이름을 변경할 심볼 위에 커서를 두세요.');
    }
    const word = doc.getText(wordRange);
    if (!word || SHADER_KEYWORDS_SKIP.has(word)) {
      throw new Error('[UnitySense] 셰이더 예약어는 이름을 변경할 수 없습니다.');
    }
    if (isTokenInCommentOrString(doc, wordRange, word)) {
      throw new Error('[UnitySense] 주석 또는 문자열 리터럴 내부에서는 이름을 변경할 수 없습니다.');
    }
    if (isVectorSwizzleToken(doc, wordRange, word, this.shaderGraph)) {
      throw new Error('[UnitySense] 벡터 스위즐 컴포넌트(.xyz, .rgba)는 이름을 변경할 수 없습니다.');
    }
    return wordRange;
  }

  public provideRenameEdits(
    doc: vscode.TextDocument,
    position: vscode.Position,
    newName: string,
  ): vscode.WorkspaceEdit | undefined {
    const trimmedNewName = newName.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmedNewName) || SHADER_KEYWORDS_SKIP.has(trimmedNewName)) {
      throw new Error(`[UnitySense] '${newName}'은(는) 유효한 HLSL/ShaderLab 식별자 이름이 아닙니다.`);
    }

    const filePath = this.shaderGraph.normalizeFilePath(doc.uri.toString());
    if (filePath.replace(/\\/g, '/').toLowerCase().includes('/library/packagecache/')) {
      return undefined;
    }

    const wordRange = doc.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
    if (!wordRange) return undefined;
    const word = doc.getText(wordRange);
    if (!word || SHADER_KEYWORDS_SKIP.has(word)) return undefined;
    if (isTokenInCommentOrString(doc, wordRange, word) || isVectorSwizzleToken(doc, wordRange, word, this.shaderGraph)) {
      return undefined;
    }

    const edit = new vscode.WorkspaceEdit();
    for (const occ of collectCrossFileOccurrences(doc, word, this.shaderGraph, position)) {
      // Never modify read-only Unity PackageCache headers during rename
      if (occ.filePath.replace(/\\/g, '/').toLowerCase().includes('/library/packagecache/')) {
        continue;
      }
      edit.replace(
        occ.uri,
        new vscode.Range(occ.line, occ.col, occ.line, occ.col + word.length),
        trimmedNewName,
      );
    }
    return edit;
  }
}

export class ShaderFoldingRangeProvider {
  public provideFoldingRanges(doc: vscode.TextDocument): vscode.FoldingRange[] {
    const lines = doc.getText().split(/\r?\n/);
    const strippedLines = stripCommentsAndStringsByLine(lines);
    const ranges: vscode.FoldingRange[] = [];
    const braceStack: number[] = [];
    const directiveStack: number[] = [];
    const regionStack: number[] = [];
    const programStack: Array<{ startLine: number; expectedEnd: 'ENDHLSL' | 'ENDCG' }> = [];

    let blockCommentStart: number | null = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let inString = false;
      for (let c = 0; c < line.length; c++) {
        const ch = line[c];
        const next = line[c + 1];
        if (blockCommentStart !== null) {
          if (ch === '*' && next === '/') {
            if (i > blockCommentStart) {
              ranges.push(new vscode.FoldingRange(blockCommentStart, i, vscode.FoldingRangeKind.Comment));
            }
            blockCommentStart = null;
            c++;
          }
          continue;
        }
        if (inString) {
          if (ch === '\\' && c + 1 < line.length) c++;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') {
          inString = true;
        } else if (ch === '/' && next === '/') {
          break;
        } else if (ch === '/' && next === '*') {
          blockCommentStart = i;
          c++;
        }
      }
    }

    const blockTokenRe = /\b(HLSLPROGRAM|HLSLINCLUDE|CGPROGRAM|CGINCLUDE|ENDHLSL|ENDCG)\b/g;
    for (let i = 0; i < strippedLines.length; i++) {
      const codeOnly = strippedLines[i];
      const trimmedCode = codeOnly.trim();
      const rawTrimmed = lines[i].trim();

      if (/^\/\/\s*#?region\b/i.test(rawTrimmed)) {
        regionStack.push(i);
      } else if (/^\/\/\s*#?endregion\b/i.test(rawTrimmed) && regionStack.length > 0) {
        const start = regionStack.pop()!;
        if (i > start) ranges.push(new vscode.FoldingRange(start, i, vscode.FoldingRangeKind.Region));
      }

      if (/^#\s*(?:if|ifdef|ifndef)\b/.test(trimmedCode)) {
        directiveStack.push(i);
      } else if (/^#\s*endif\b/.test(trimmedCode) && directiveStack.length > 0) {
        const start = directiveStack.pop()!;
        if (i > start) ranges.push(new vscode.FoldingRange(start, i, vscode.FoldingRangeKind.Region));
      }

      blockTokenRe.lastIndex = 0;
      let bm: RegExpExecArray | null;
      while ((bm = blockTokenRe.exec(codeOnly)) !== null) {
        const tok = bm[1];
        if (tok === 'ENDHLSL' || tok === 'ENDCG') {
          for (let k = programStack.length - 1; k >= 0; k--) {
            if (programStack[k].expectedEnd === tok) {
              const [{ startLine }] = programStack.splice(k, 1);
              if (i > startLine) {
                ranges.push(new vscode.FoldingRange(startLine, i, vscode.FoldingRangeKind.Region));
              }
              break;
            }
          }
        } else {
          programStack.push({
            startLine: i,
            expectedEnd: tok.startsWith('HLSL') ? 'ENDHLSL' : 'ENDCG',
          });
        }
      }

      for (const ch of codeOnly) {
        if (ch === '{') braceStack.push(i);
        else if (ch === '}' && braceStack.length > 0) {
          const start = braceStack.pop()!;
          if (i > start) ranges.push(new vscode.FoldingRange(start, i));
        }
      }
    }
    return ranges;
  }
}

export class ShaderDocumentColorProvider {
  public provideDocumentColors(doc: vscode.TextDocument): vscode.ColorInformation[] {
    const cleanLines = blankShaderCommentsPreservingLayout(doc.getText()).split(/\r?\n/);
    const infos: vscode.ColorInformation[] = [];
    const propColorRe =
      /\(\s*([0-9]*\.?[0-9]+)[fFhH]?\s*,\s*([0-9]*\.?[0-9]+)[fFhH]?\s*,\s*([0-9]*\.?[0-9]+)[fFhH]?\s*,\s*([0-9]*\.?[0-9]+)[fFhH]?\s*\)/g;
    const colorVarRe =
      /\b(?:float4|half4|real4|fixed4)\s+[A-Za-z0-9_]*(?:color|col|tint|albedo|diffuse|specular|emissive|emission|ambient)[A-Za-z0-9_]*\s*=\s*(?:float4|half4|real4|fixed4)?\s*\(/i;

    for (let i = 0; i < cleanLines.length; i++) {
      const line = cleanLines[i];
      const isShaderLabColor = /,\s*Color\s*\)\s*=/.test(line);
      const isColorVar = colorVarRe.test(line);
      if (!isShaderLabColor && !isColorVar) continue;

      propColorRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = propColorRe.exec(line)) !== null) {
        const r = Number.parseFloat(m[1]);
        const g = Number.parseFloat(m[2]);
        const b = Number.parseFloat(m[3]);
        const a = Number.parseFloat(m[4]);
        // Skip HDR colors (> 1.0) so VS Code's 0..1 ColorPicker does not clamp away HDR intensity
        if (r > 1.0 || g > 1.0 || b > 1.0 || a > 1.0 || r < 0 || g < 0 || b < 0 || a < 0) {
          continue;
        }
        const range = new vscode.Range(i, m.index, i, m.index + m[0].length);
        infos.push(new vscode.ColorInformation(range, new vscode.Color(r, g, b, a)));
      }
    }
    return infos;
  }

  public provideColorPresentations(color: vscode.Color): vscode.ColorPresentation[] {
    const fmt = (v: number) => Number(v.toFixed(3)).toString();
    return [
      new vscode.ColorPresentation(`(${fmt(color.red)}, ${fmt(color.green)}, ${fmt(color.blue)}, ${fmt(color.alpha)})`),
    ];
  }
}

const VALID_CULL_VALUES = new Set(['back', 'front', 'off']);
const VALID_ZWRITE_VALUES = new Set(['on', 'off']);
const VALID_ZTEST_VALUES = new Set([
  'less',
  'greater',
  'lequal',
  'gequal',
  'equal',
  'notequal',
  'always',
  'never',
  'off',
]);

export function collectComputeAndShaderLabDiagnostics(
  doc: vscode.TextDocument,
  shaderGraph: IncludeDependencyGraph,
): vscode.Diagnostic[] {
  const text = doc.getText();
  shaderGraph.setOpenDocumentContent(doc.uri.toString(), text);
  const filePath = shaderGraph.normalizeFilePath(doc.uri.toString());
  const virtualDoc = extractVirtualHlslDocument(text, filePath);
  const reachableWalk = shaderGraph.collectReachableFiles(doc.uri.toString());
  const diags: vscode.Diagnostic[] = [];
  const lines = text.split(/\r?\n/);

  // 1. Validate #pragma entry points (kernel, vertex, fragment, hull, domain, geometry)
  for (const ep of virtualDoc.pragmas.entryPoints) {
    const hits = shaderGraph.findSymbolsVisibleFrom(doc.uri.toString(), ep.name, ep.line);
    const hasFnOrMacro = hits.some((s) => s.kind === 'function' || s.kind === 'macro');
    if (!hasFnOrMacro) {
      const msg =
        ep.stage === 'kernel'
          ? `[UnitySense] Compute Shader 커널 함수 '${ep.name}'이(가) 정의되지 않았습니다.`
          : `[UnitySense] #pragma ${ep.stage} 엔트리 함수 '${ep.name}'이(가) 정의되지 않았습니다.`;
      diags.push(
        new vscode.Diagnostic(
          new vscode.Range(ep.line, ep.column, ep.line, ep.column + ep.name.length),
          msg,
          ep.stage === 'kernel' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
        ),
      );
    }
  }

  // 1-2. Validate HLSLPROGRAM/ENDHLSL, CGPROGRAM/ENDCG, and brace balance
  {
    const strippedForBlocks = stripCommentsAndStringsByLine(lines);
    const programStack: Array<{ tag: string; expectedEnd: string; line: number; col: number }> = [];
    let braceStack: Array<{ line: number; col: number }> = [];
    const preprocBranchStack: Array<{
      entryStack: Array<{ line: number; col: number }>;
      branchEndStacks: Array<Array<{ line: number; col: number }>>;
    }> = [];
    const blockTokRe = /\b(HLSLPROGRAM|HLSLINCLUDE|CGPROGRAM|CGINCLUDE|ENDHLSL|ENDCG)\b/g;

    let inDefineContinuation = false;
    for (let i = 0; i < strippedForBlocks.length; i++) {
      const sLine = strippedForBlocks[i];

      blockTokRe.lastIndex = 0;
      let bm: RegExpExecArray | null;
      while ((bm = blockTokRe.exec(sLine)) !== null) {
        const tok = bm[1];
        if (tok === 'ENDHLSL' || tok === 'ENDCG') {
          const top = programStack[programStack.length - 1];
          if (!top) {
            diags.push(
              new vscode.Diagnostic(
                new vscode.Range(i, bm.index, i, bm.index + tok.length),
                `[UnitySense] 대응하는 시작 블록 없이 '${tok}'이(가) 닫혔습니다.`,
                vscode.DiagnosticSeverity.Error,
              ),
            );
          } else if (top.expectedEnd !== tok) {
            diags.push(
              new vscode.Diagnostic(
                new vscode.Range(i, bm.index, i, bm.index + tok.length),
                `[UnitySense] '${top.tag}' 블록은 '${top.expectedEnd}'로 닫아야 합니다 ('${tok}' 사용됨).`,
                vscode.DiagnosticSeverity.Error,
              ),
            );
            programStack.pop();
          } else {
            programStack.pop();
          }
        } else {
          const expectedEnd = tok.startsWith('HLSL') ? 'ENDHLSL' : 'ENDCG';
          programStack.push({ tag: tok, expectedEnd, line: i, col: bm.index });
          if (tok === 'CGPROGRAM' || tok === 'CGINCLUDE') {
            const recommended = tok === 'CGPROGRAM' ? 'HLSLPROGRAM' : 'HLSLINCLUDE';
            diags.push(
              new vscode.Diagnostic(
                new vscode.Range(i, bm.index, i, bm.index + tok.length),
                `[UnitySense] 레거시 셰이더 블록 '${tok}'을(를) 사용 중입니다. 최신 Unity/SRP 환경에서는 '${recommended}' 사용을 권장합니다.`,
                vscode.DiagnosticSeverity.Warning,
              ),
            );
          }
        }
      }

      if (inDefineContinuation) {
        inDefineContinuation = sLine.trimEnd().endsWith('\\');
        continue;
      }

      const trimmedLine = sLine.trim();
      if (/^#\s*define\b/.test(trimmedLine)) {
        inDefineContinuation = sLine.trimEnd().endsWith('\\');
        continue;
      }

      if (/^#\s*(?:if|ifdef|ifndef)\b/.test(trimmedLine)) {
        preprocBranchStack.push({
          entryStack: [...braceStack],
          branchEndStacks: [],
        });
        continue;
      }
      if (/^#\s*(?:elif|else)\b/.test(trimmedLine) && preprocBranchStack.length > 0) {
        const top = preprocBranchStack[preprocBranchStack.length - 1];
        top.branchEndStacks.push([...braceStack]);
        braceStack = [...top.entryStack];
        continue;
      }
      if (/^#\s*endif\b/.test(trimmedLine) && preprocBranchStack.length > 0) {
        const top = preprocBranchStack.pop()!;
        top.branchEndStacks.push([...braceStack]);
        braceStack = [...top.branchEndStacks[0]];
        continue;
      }

      for (let c = 0; c < sLine.length; c++) {
        if (sLine[c] === '{') braceStack.push({ line: i, col: c });
        else if (sLine[c] === '}') {
          if (braceStack.length === 0) {
            diags.push(
              new vscode.Diagnostic(
                new vscode.Range(i, c, i, c + 1),
                '[UnitySense] 여는 중괄호 "{" 없이 닫는 중괄호 "}"가 있습니다.',
                vscode.DiagnosticSeverity.Error,
              ),
            );
          } else {
            braceStack.pop();
          }
        }
      }
    }

    for (const unclosed of programStack) {
      diags.push(
        new vscode.Diagnostic(
          new vscode.Range(unclosed.line, unclosed.col, unclosed.line, unclosed.col + unclosed.tag.length),
          `[UnitySense] '${unclosed.tag}' 블록이 '${unclosed.expectedEnd}'로 닫히지 않았습니다.`,
          vscode.DiagnosticSeverity.Error,
        ),
      );
    }
    for (const unclosedBrace of braceStack) {
      diags.push(
        new vscode.Diagnostic(
          new vscode.Range(unclosedBrace.line, unclosedBrace.col, unclosedBrace.line, unclosedBrace.col + 1),
          '[UnitySense] 닫히지 않은 여는 중괄호 "{"가 있습니다.',
          vscode.DiagnosticSeverity.Error,
        ),
      );
    }
  }

  // 1-3. Validate ShaderLab property usage, derived keywords, Render State refs, and SRP Batcher CBUFFER_START(UnityPerMaterial)
  const hlslRanges = virtualDoc.isShaderLab
    ? virtualDoc.blocks.map((b) => ({ start: b.startLine, end: b.endLine }))
    : [{ start: 0, end: Math.max(0, lines.length - 1) }];
  const strippedLines = stripCommentsAndStringsByLine(lines);

  const customEditorProps = new Set<string>();
  const resolvedEditors: string[] = [];
  if (virtualDoc.isShaderLab) {
    const customEditorDirectives = extractCustomEditorDirectives(text);
    const seenResolved = new Set<string>();
    for (const dir of customEditorDirectives) {
      const resolution = resolveCustomEditorProperties(shaderGraph.getResolver(), dir.name, filePath);
      if (resolution.resolved) {
        if (!seenResolved.has(dir.name)) {
          seenResolved.add(dir.name);
          resolvedEditors.push(dir.name);
        }
        for (const propName of resolution.referencedProperties) {
          customEditorProps.add(propName);
        }
      } else if (!isBuiltInCompiledShaderGui(dir.name)) {
        diags.push(
          new vscode.Diagnostic(
            new vscode.Range(dir.line, dir.startCol, dir.line, dir.endCol),
            `[UnitySense] CustomEditor 클래스 '${dir.name}'을(를) 프로젝트 또는 패키지에서 찾을 수 없습니다.`,
            vscode.DiagnosticSeverity.Warning,
          ),
        );
      }
    }
  }

  if (virtualDoc.isShaderLab && virtualDoc.properties.length > 0) {
    const cleanSources: Array<{ src: string; isShaderLibrary: boolean }> = [
      { src: blankShaderCommentsPreservingLayout(virtualDoc.virtualHlsl), isShaderLibrary: false },
    ];
    for (let fi = 1; fi < reachableWalk.files.length; fi++) {
      const f = reachableWalk.files[fi];
      let fileText = f.virtualHlsl;
      try {
        if (fs.existsSync(f.filePath)) {
          fileText = fs.readFileSync(f.filePath, 'utf8');
        }
      } catch {
        // Keep parsed virtualHlsl fallback
      }
      cleanSources.push({
        src: blankShaderCommentsPreservingLayout(fileText),
        isShaderLibrary: /[\\/]ShaderLibrary[\\/]/i.test(f.filePath),
      });
    }

    const unityPerMaterialRe = /CBUFFER_START\s*\(\s*UnityPerMaterial\s*\)([\s\S]*?)CBUFFER_END/g;
    const anyCbufferRe = /CBUFFER_START\s*\([^)]*\)[\s\S]*?CBUFFER_END/g;
    const dotsInstancingBlockRe =
      /UNITY_DOTS_INSTANCING_START\s*\([^)]*\)[\s\S]*?UNITY_DOTS_INSTANCING_END(?:\s*\([^)]*\))?/g;
    const gpuInstancingBlockRe =
      /UNITY_INSTANCING_BUFFER_START\s*\([^)]*\)[\s\S]*?UNITY_INSTANCING_BUFFER_END\s*\([^)]*\)/g;
    const instancedPropDeclRe =
      /\b(?:UNITY_DOTS_INSTANCED_PROP(?:_OVERRIDE_SUPPORTED|_OVERRIDE_REQUIRED|_FLOAT|_FLOAT2|_FLOAT3|_FLOAT4|_INT|_UINT|_MATRIX)?|UNITY_DEFINE_INSTANCED_PROP)\s*\([^)]*\)/g;
    const dotsAccessMacroRe =
      /\bUNITY_ACCESS_DOTS_INSTANCED_PROP(?:_WITH_DEFAULT|_WITH_CUSTOM_DEFAULT)?\s*\([^)]*\)/g;
    const stringLiteralRe = /"(?:\\.|[^"\\\r\n])*"/g;
    const instancedPropNames = new Set<string>();
    const propIdentRe = /\b(_[A-Za-z0-9_]+)\b/g;
    const collectInstancedPropNames = (chunk: string) => {
      propIdentRe.lastIndex = 0;
      let pm: RegExpExecArray | null;
      while ((pm = propIdentRe.exec(chunk)) !== null) {
        instancedPropNames.add(pm[1]);
      }
    };
    const maskInstancingAndCollect = (m: string) => {
      collectInstancedPropNames(m);
      return m.replace(/[^\n]/g, ' ');
    };
    const maskPreservingNewlines = (m: string) => m.replace(/[^\n]/g, ' ');
    const cbufferBodies: string[] = [];
    const preprocChunks: string[] = [];
    const hlslBodyChunks: string[] = [];
    const localHlslBodyChunks: string[] = [];

    for (const entry of cleanSources) {
      const src = entry.src;
      unityPerMaterialRe.lastIndex = 0;
      let cm: RegExpExecArray | null;
      while ((cm = unityPerMaterialRe.exec(src)) !== null) {
        cbufferBodies.push(cm[1]);
      }

      // Mask string literals, CBUFFER_START(...) ... CBUFFER_END, and DOTS/GPU instancing
      // metadata/access macros so they do not trigger false HLSL body or SRP Batcher warnings
      const withoutCbuffers = src
        .replace(stringLiteralRe, maskPreservingNewlines)
        .replace(anyCbufferRe, maskPreservingNewlines)
        .replace(dotsInstancingBlockRe, maskInstancingAndCollect)
        .replace(gpuInstancingBlockRe, maskInstancingAndCollect)
        .replace(instancedPropDeclRe, maskInstancingAndCollect)
        .replace(dotsAccessMacroRe, maskInstancingAndCollect);
      const srcLines = withoutCbuffers.split(/\r?\n/);
      const bodyLines: string[] = [];
      let inPreprocContinuation = false;

      for (const rawLine of srcLines) {
        if (inPreprocContinuation || /^\s*#/.test(rawLine)) {
          preprocChunks.push(rawLine);
          inPreprocContinuation = rawLine.trimEnd().endsWith('\\');
          bodyLines.push('');
        } else {
          bodyLines.push(rawLine);
        }
      }

      const joinedBody = bodyLines.join('\n');
      hlslBodyChunks.push(joinedBody);
      if (!entry.isShaderLibrary) {
        localHlslBodyChunks.push(joinedBody);
      }
    }

    const hasUnityPerMaterial = cbufferBodies.length > 0;
    const combinedCbufferBody = cbufferBodies.join('\n');
    const combinedPreproc = preprocChunks.join('\n');
    const combinedHlslBody = hlslBodyChunks.join('\n');
    const combinedLocalHlslBody = localHlslBodyChunks.join('\n');

    // Collect ShaderLab render state property references such as Cull [_Cull], Blend [_Src] [_Dst], ZWrite [_ZWrite]
    const renderStateRefs = new Set<string>();
    const propLineSet = new Set<number>(virtualDoc.properties.map((p) => p.line ?? -1));
    const stateRefRe = /\[(_[A-Za-z0-9_]+)\]/g;
    for (let i = 0; i < strippedLines.length; i++) {
      if (propLineSet.has(i)) continue;
      if (hlslRanges.some((r) => i >= r.start && i <= r.end)) continue;
      const lineText = strippedLines[i] ?? '';
      if (/\([^)]*\)\s*=/.test(lineText)) continue;
      stateRefRe.lastIndex = 0;
      let sm: RegExpExecArray | null;
      while ((sm = stateRefRe.exec(lineText)) !== null) {
        renderStateRefs.add(sm[1]);
      }
    }

    const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const extractDerivedKeywords = (propName: string, attrBlock: string): string[] => {
      const keywords: string[] = [];
      const upperName = propName.toUpperCase();

      const toggleRe = /\[\s*(?:Toggle|MaterialToggle)\s*(?:\(\s*([^)]*?)\s*\))?\s*\]/g;
      let tm: RegExpExecArray | null;
      while ((tm = toggleRe.exec(attrBlock)) !== null) {
        const explicit = tm[1]?.trim();
        keywords.push(explicit && explicit.length > 0 ? explicit : `${upperName}_ON`);
      }

      const toggleOffRe = /\[\s*ToggleOff\s*(?:\(\s*([^)]*?)\s*\))?\s*\]/g;
      let tom: RegExpExecArray | null;
      while ((tom = toggleOffRe.exec(attrBlock)) !== null) {
        const explicit = tom[1]?.trim();
        keywords.push(explicit && explicit.length > 0 ? explicit : `${upperName}_OFF`);
      }

      const kwEnumRe = /\[\s*KeywordEnum\s*\(\s*([^)]+)\s*\)\s*\]/g;
      let km: RegExpExecArray | null;
      while ((km = kwEnumRe.exec(attrBlock)) !== null) {
        for (const item of km[1].split(',')) {
          const normalized = item.trim().replace(/\s+/g, '_').toUpperCase();
          if (normalized) {
            keywords.push(`${upperName}_${normalized}`);
          }
        }
      }

      return keywords;
    };

    const texTypes = new Set(['2D', '2DArray', '3D', 'Cube', 'CubeArray', 'Any']);
    const isPropUsedInHlslBody = (bodyText: string, propName: string): boolean => {
      const escaped = escapeRegExp(propName);
      const paramDeclRe = new RegExp(
        `\\b(?:float|half|fixed|int|uint|bool|real|min16float|min10float)[1-4]?(?:x[1-4])?\\s+${escaped}\\s*(?=[,)])`,
        'g',
      );
      const withoutParams = bodyText.replace(paramDeclRe, '');
      const identRe = new RegExp(`(?<![.\\w])${escaped}\\b`);
      return identRe.test(withoutParams);
    };

    for (const prop of virtualDoc.properties) {
      if (texTypes.has(prop.type)) continue;
      const propLine = prop.line ?? 0;
      const propCol = prop.column ?? 0;

      const attrLines: string[] = [];
      for (let lookback = 0; lookback <= 8 && propLine - lookback >= 0; lookback++) {
        const checkLine = lines[propLine - lookback] ?? '';
        if (lookback > 0 && (checkLine.includes('=') || checkLine.includes('{') || checkLine.includes('}'))) {
          break;
        }
        attrLines.push(checkLine);
      }
      const attrBlock = attrLines.join('\n');

      const hasHideInInspector = /\[HideInInspector\]/.test(attrBlock);
      const hasPerRendererData = /\[PerRendererData\]/.test(attrBlock);
      const hasNonModifiable = /\[NonModifiableTextureData\]/.test(attrBlock);
      const derivedKeywords = extractDerivedKeywords(prop.name, attrBlock);

      const escapedProp = escapeRegExp(prop.name);
      const propRe = new RegExp(`\\b${escapedProp}\\b`);
      const isVarUsed = isPropUsedInHlslBody(combinedHlslBody, prop.name);
      const isVarUsedLocal = isPropUsedInHlslBody(combinedLocalHlslBody, prop.name);
      const hasLooseGlobalDecl = new RegExp(
        `^[ \\t]*(?:uniform\\s+)?(?:float|half|fixed|int|uint|bool|real|min16float|min10float)[1-4]?(?:x[1-4])?\\s+${escapedProp}\\s*(?:=|;|\\[)`,
        'm',
      ).test(combinedHlslBody);
      const isKeywordUsed = derivedKeywords.some((kw) =>
        new RegExp(`\\b${escapeRegExp(kw)}\\b`).test(combinedPreproc),
      );
      const isStateUsed = renderStateRefs.has(prop.name);
      const isCustomEditorUsed = customEditorProps.has(prop.name);
      const isInstancedUsed = instancedPropNames.has(prop.name);
      const inCBuffer = hasUnityPerMaterial && propRe.test(combinedCbufferBody);
      const isInternalEditorProp = prop.displayName.startsWith('__') && isCustomEditorUsed;

      if (isVarUsed) {
        if (
          hasUnityPerMaterial &&
          !inCBuffer &&
          !isInstancedUsed &&
          !hasPerRendererData &&
          !hasNonModifiable &&
          !hasHideInInspector &&
          (hasLooseGlobalDecl || (isVarUsedLocal && !isInternalEditorProp))
        ) {
          diags.push(
            new vscode.Diagnostic(
              new vscode.Range(propLine, propCol, propLine, propCol + prop.name.length),
              `[UnitySense] SRP Batcher: 프로퍼티 '${prop.name}'이(가) HLSL에서 사용되지만 CBUFFER_START(UnityPerMaterial)에 선언되어 있지 않습니다.`,
              vscode.DiagnosticSeverity.Warning,
            ),
          );
        }
      } else if (
        !isKeywordUsed &&
        !isStateUsed &&
        !isCustomEditorUsed &&
        !isInstancedUsed &&
        !hasHideInInspector
      ) {
        const message =
          resolvedEditors.length > 0
            ? `[UnitySense] 미사용 프로퍼티: '${prop.name}'이(가) HLSL 변수, 키워드, ShaderLab 렌더 상태 및 CustomEditor(${resolvedEditors.join(', ')}) 어디에서도 사용되지 않습니다.`
            : `[UnitySense] 미사용 프로퍼티: '${prop.name}'이(가) HLSL 변수, 키워드, ShaderLab 렌더 상태 어디에서도 사용되지 않습니다.`;
        diags.push(
          new vscode.Diagnostic(
            new vscode.Range(propLine, propCol, propLine, propCol + prop.name.length),
            message,
            vscode.DiagnosticSeverity.Warning,
          ),
        );
      }
    }
  }

  // 2. Validate [numthreads(x, y, z)] <= 1024 and ShaderLab render state values

  for (let i = 0; i < lines.length; i++) {
    const strippedLine = strippedLines[i] ?? '';
    const inHlsl = hlslRanges.some((r) => i >= r.start && i <= r.end);

    if (inHlsl) {
      const ntMatch = /\[\s*numthreads\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)\s*\]/.exec(
        strippedLine,
      );
      if (ntMatch) {
        const total =
          Number.parseInt(ntMatch[1], 10) *
          Number.parseInt(ntMatch[2], 10) *
          Number.parseInt(ntMatch[3], 10);
        if (total > 1024) {
          diags.push(
            new vscode.Diagnostic(
              new vscode.Range(i, ntMatch.index, i, ntMatch.index + ntMatch[0].length),
              `[UnitySense] [numthreads(${ntMatch[1]}, ${ntMatch[2]}, ${ntMatch[3]})] 총 스레드 수(${total})가 1024 한도를 초과합니다.`,
              vscode.DiagnosticSeverity.Error,
            ),
          );
        }
      }
      continue;
    }

    if (/\([^)]*\)\s*=/.test(strippedLine)) {
      continue;
    }

    const cullM = /(?<![\w\[])Cull\s+([A-Za-z0-9_]+)/.exec(strippedLine);
    if (cullM && !VALID_CULL_VALUES.has(cullM[1].toLowerCase())) {
      const col = cullM.index + cullM[0].indexOf(cullM[1]);
      diags.push(
        new vscode.Diagnostic(
          new vscode.Range(i, col, i, col + cullM[1].length),
          `[UnitySense] 잘못된 ShaderLab Cull 값 '${cullM[1]}'입니다 (Back, Front, Off만 허용).`,
          vscode.DiagnosticSeverity.Warning,
        ),
      );
    }
    const zwM = /(?<![\w\[])ZWrite\s+([A-Za-z0-9_]+)/.exec(strippedLine);
    if (zwM && !VALID_ZWRITE_VALUES.has(zwM[1].toLowerCase())) {
      const col = zwM.index + zwM[0].indexOf(zwM[1]);
      diags.push(
        new vscode.Diagnostic(
          new vscode.Range(i, col, i, col + zwM[1].length),
          `[UnitySense] 잘못된 ShaderLab ZWrite 값 '${zwM[1]}'입니다 (On, Off만 허용).`,
          vscode.DiagnosticSeverity.Warning,
        ),
      );
    }
    const ztM = /(?<![\w\[])ZTest\s+([A-Za-z0-9_]+)/.exec(strippedLine);
    if (ztM && !VALID_ZTEST_VALUES.has(ztM[1].toLowerCase())) {
      const col = ztM.index + ztM[0].indexOf(ztM[1]);
      diags.push(
        new vscode.Diagnostic(
          new vscode.Range(i, col, i, col + ztM[1].length),
          `[UnitySense] 잘못된 ShaderLab ZTest 값 '${ztM[1]}'입니다.`,
          vscode.DiagnosticSeverity.Warning,
        ),
      );
    }
  }

  return diags;
}
