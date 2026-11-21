import { CompletionItemKind, InsertTextFormat, type CompletionItem, type Position } from 'vscode-languageserver';
import {
  extractMemberChainExpression,
  type IncludeDependencyGraph,
} from '../indexer/hlslIncludeGraph.ts';
import {
  detectShaderLabContext,
  SHADERLAB_PROPERTY_ATTRIBUTES,
  SHADERLAB_PROPERTY_TYPES,
  SHADERLAB_RENDER_STATES,
  SHADERLAB_STENCIL_ITEMS,
  SHADERLAB_TAGS,
  type ShaderLabDocEntry,
} from '../parser/shaderLabContext.ts';
import { UNITY_BUILTIN_MACROS, type UnityMacroSpec } from '../parser/unityHlslMacroPrepass.ts';

const HLSL_PREPROCESSOR_DIRECTIVES = [
  {
    name: 'include',
    insertText: 'include "',
    detail: '[UnitySense] HLSL / ShaderLab 헤더 파일 포함 (#include "...")',
  },
  {
    name: 'include_with_pragmas',
    insertText: 'include_with_pragmas "',
    detail: '[UnitySense] Unity 6 #pragma 지시어 포함 헤더 (#include_with_pragmas "...")',
  },
  {
    name: 'pragma',
    insertText: 'pragma ',
    detail: '[UnitySense] 셰이더 컴파일러 지시어 (#pragma vertex/fragment/multi_compile...)',
  },
  { name: 'define', insertText: 'define ', detail: '[UnitySense] 전처리기 매크로 정의' },
  { name: 'if', insertText: 'if ', detail: '[UnitySense] 전처리기 조건 분기 시작' },
  { name: 'ifdef', insertText: 'ifdef ', detail: '[UnitySense] 매크로 정의 여부 조건 분기' },
  { name: 'ifndef', insertText: 'ifndef ', detail: '[UnitySense] 매크로 미정의 여부 조건 분기' },
  { name: 'elif', insertText: 'elif ', detail: '[UnitySense] 전처리기 추가 조건 분기' },
  { name: 'else', insertText: 'else', detail: '[UnitySense] 전처리기 기본 분기' },
  { name: 'endif', insertText: 'endif', detail: '[UnitySense] 전처리기 조건 분기 종료' },
  { name: 'undef', insertText: 'undef ', detail: '[UnitySense] 전처리기 매크로 정의 해제' },
];

const HLSL_SEMANTICS_AND_TYPES = [
  { label: 'SV_Position', kind: CompletionItemKind.Constant, detail: '[UnitySense] HLSL 클립 공간 정점 출력 / 프래그먼트 위치 시맨틱' },
  { label: 'SV_Target', kind: CompletionItemKind.Constant, detail: '[UnitySense] HLSL 프래그먼트 렌더 타겟 출력 시맨틱' },
  { label: 'SV_Depth', kind: CompletionItemKind.Constant, detail: '[UnitySense] HLSL 프래그먼트 깊이 출력 시맨틱' },
  { label: 'SV_InstanceID', kind: CompletionItemKind.Constant, detail: '[UnitySense] HLSL GPU 인스턴스 식별자 시맨틱' },
  { label: 'SV_DispatchThreadID', kind: CompletionItemKind.Constant, detail: '[UnitySense] Compute 셰이더 전역 스레드 ID (uint3)' },
  { label: 'SV_GroupThreadID', kind: CompletionItemKind.Constant, detail: '[UnitySense] Compute 스레드 그룹 내 로컬 ID (uint3)' },
  { label: 'SV_GroupID', kind: CompletionItemKind.Constant, detail: '[UnitySense] Compute 스레드 그룹 ID (uint3)' },
  { label: 'SV_GroupIndex', kind: CompletionItemKind.Constant, detail: '[UnitySense] Compute 스레드 그룹 내 1차원 인덱스 (uint)' },
  { label: 'SV_Barycentrics', kind: CompletionItemKind.Constant, detail: '[UnitySense] SM 6.1 삼각형 무게중심 좌표 시맨틱' },
  { label: 'SV_ShadingRate', kind: CompletionItemKind.Constant, detail: '[UnitySense] VRS(Variable Rate Shading) 셰이딩 레이트 시맨틱' },
  { label: 'SV_ViewID', kind: CompletionItemKind.Constant, detail: '[UnitySense] XR/스테레오 뷰 인덱스 시맨틱' },
  { label: 'POSITION', kind: CompletionItemKind.Constant, detail: '[UnitySense] 정점 애트리뷰트 위치(Position) 시맨틱' },
  { label: 'NORMAL', kind: CompletionItemKind.Constant, detail: '[UnitySense] 정점 애트리뷰트 노멀(Normal) 시맨틱' },
  { label: 'TANGENT', kind: CompletionItemKind.Constant, detail: '[UnitySense] 정점 애트리뷰트 탄젠트(Tangent) 시맨틱' },
  { label: 'TEXCOORD0', kind: CompletionItemKind.Constant, detail: '[UnitySense] 텍스처 좌표 채널 0 시맨틱' },
  { label: 'TEXCOORD1', kind: CompletionItemKind.Constant, detail: '[UnitySense] 텍스처 좌표 채널 1 시맨틱' },
  { label: 'float2', kind: CompletionItemKind.Keyword, detail: '[UnitySense] HLSL 2성분 32비트 부동소수점 벡터' },
  { label: 'float3', kind: CompletionItemKind.Keyword, detail: '[UnitySense] HLSL 3성분 32비트 부동소수점 벡터' },
  { label: 'float4', kind: CompletionItemKind.Keyword, detail: '[UnitySense] HLSL 4성분 32비트 부동소수점 벡터' },
  { label: 'float16_t', kind: CompletionItemKind.Keyword, detail: '[UnitySense] SM 6.2 네이티브 16비트 부동소수점 타입' },
  { label: 'uint16_t', kind: CompletionItemKind.Keyword, detail: '[UnitySense] SM 6.2 네이티브 16비트 부호 없는 정수 타입' },
  { label: 'half', kind: CompletionItemKind.Keyword, detail: '[UnitySense] 유니티 16비트 반정밀도 실수 타입' },
  { label: 'half3', kind: CompletionItemKind.Keyword, detail: '[UnitySense] 유니티 3성분 반정밀도 벡터' },
  { label: 'half4', kind: CompletionItemKind.Keyword, detail: '[UnitySense] 유니티 4성분 반정밀도 벡터' },
  { label: 'real3', kind: CompletionItemKind.Keyword, detail: '[UnitySense] 유니티 정밀도 적응형 3D 벡터' },
  { label: 'real4', kind: CompletionItemKind.Keyword, detail: '[UnitySense] 유니티 정밀도 적응형 4D 벡터' },
  { label: 'float4x4', kind: CompletionItemKind.Keyword, detail: '[UnitySense] HLSL 4x4 행렬 타입' },
  { label: 'RaytracingAccelerationStructure', kind: CompletionItemKind.Keyword, detail: '[UnitySense] DXR/Unity RayTracing 가속 구조체(TLAS)' },
  { label: 'RayDesc', kind: CompletionItemKind.Keyword, detail: '[UnitySense] DXR 광선(Origin, TMin, Direction, TMax) 구조체' },
  { label: 'BuiltInTriangleIntersectionAttributes', kind: CompletionItemKind.Keyword, detail: '[UnitySense] DXR 기본 삼각형 교차 무게중심(barycentrics) 구조체' },
  { label: 'TraceRay', kind: CompletionItemKind.Function, detail: '[UnitySense] void TraceRay(RaytracingAccelerationStructure, uint RayFlags, ...)' },
  { label: 'DispatchRaysIndex', kind: CompletionItemKind.Function, detail: '[UnitySense] uint3 DispatchRaysIndex() — 현재 RayTracing 스레드 좌표' },
  { label: 'WaveActiveSum', kind: CompletionItemKind.Function, detail: '[UnitySense] T WaveActiveSum(T value) — SM 6.0 Wave 전체 합산' },
  { label: 'WaveReadLaneFirst', kind: CompletionItemKind.Function, detail: '[UnitySense] T WaveReadLaneFirst(T value) — 첫 번째 활성 레인 값 브로드캐스트' },
  { label: 'asfloat', kind: CompletionItemKind.Function, detail: '[UnitySense] float asfloat(uint/int x) — 비트 재해석 float 변환' },
  { label: 'asint', kind: CompletionItemKind.Function, detail: '[UnitySense] int asint(float/uint x) — 비트 재해석 부호 있는 int 변환' },
  { label: 'asuint', kind: CompletionItemKind.Function, detail: '[UnitySense] uint asuint(float x) — 비트 재해석 uint 변환' },
  { label: 'f16tof32', kind: CompletionItemKind.Function, detail: '[UnitySense] float f16tof32(uint value) — 16비트 half를 32비트 float로 언팩' },
  { label: 'f32tof16', kind: CompletionItemKind.Function, detail: '[UnitySense] uint f32tof16(float value) — 32비트 float를 16비트 half 비트로 팩' },
  { label: 'NonUniformResourceIndex', kind: CompletionItemKind.Function, detail: '[UnitySense] uint NonUniformResourceIndex(uint index) — Bindless 리소스 인덱싱' },
  { label: 'lerp', kind: CompletionItemKind.Function, detail: '[UnitySense] T lerp(T x, T y, T s) — 선형 보간 (x + s * (y - x))' },
  { label: 'saturate', kind: CompletionItemKind.Function, detail: '[UnitySense] T saturate(T x) — [0, 1] 범위로 클램프' },
  { label: 'clamp', kind: CompletionItemKind.Function, detail: '[UnitySense] T clamp(T x, T minVal, T maxVal) — [min, max] 범위 제한' },
  { label: 'dot', kind: CompletionItemKind.Function, detail: '[UnitySense] scalar dot(vec a, vec b) — 두 벡터의 내적' },
  { label: 'cross', kind: CompletionItemKind.Function, detail: '[UnitySense] float3 cross(float3 a, float3 b) — 두 3D 벡터의 외적' },
  { label: 'mul', kind: CompletionItemKind.Function, detail: '[UnitySense] mul(m, v) — 행렬-벡터 또는 행렬-행렬 곱셈' },
  { label: 'normalize', kind: CompletionItemKind.Function, detail: '[UnitySense] T normalize(T v) — 단위 벡터 정규화' },
  { label: 'length', kind: CompletionItemKind.Function, detail: '[UnitySense] float length(vec v) — 벡터 유클리드 길이' },
  { label: 'distance', kind: CompletionItemKind.Function, detail: '[UnitySense] float distance(vec a, vec b) — 두 점 사이 거리' },
  { label: 'reflect', kind: CompletionItemKind.Function, detail: '[UnitySense] T reflect(T i, T n) — 입사 벡터 반사' },
  { label: 'refract', kind: CompletionItemKind.Function, detail: '[UnitySense] T refract(T i, T n, float eta) — 스넬 법칙 굴절 벡터' },
  { label: 'pow', kind: CompletionItemKind.Function, detail: '[UnitySense] T pow(T base, T exp) — 거듭제곱 base^exp' },
  { label: 'exp', kind: CompletionItemKind.Function, detail: '[UnitySense] T exp(T x) — 자연지수 e^x' },
  { label: 'exp2', kind: CompletionItemKind.Function, detail: '[UnitySense] T exp2(T x) — 2^x' },
  { label: 'log', kind: CompletionItemKind.Function, detail: '[UnitySense] T log(T x) — 자연로그 ln(x)' },
  { label: 'log2', kind: CompletionItemKind.Function, detail: '[UnitySense] T log2(T x) — 밑이 2인 로그' },
  { label: 'sin', kind: CompletionItemKind.Function, detail: '[UnitySense] T sin(T x) — 라디안 각도의 사인값' },
  { label: 'cos', kind: CompletionItemKind.Function, detail: '[UnitySense] T cos(T x) — 라디안 각도의 코사인값' },
  { label: 'tan', kind: CompletionItemKind.Function, detail: '[UnitySense] T tan(T x) — 라디안 각도의 탄젠트값' },
  { label: 'asin', kind: CompletionItemKind.Function, detail: '[UnitySense] T asin(T x) — [-1, 1] 아크사인' },
  { label: 'acos', kind: CompletionItemKind.Function, detail: '[UnitySense] T acos(T x) — [-1, 1] 아크코사인' },
  { label: 'atan', kind: CompletionItemKind.Function, detail: '[UnitySense] T atan(T x) — 아크탄젠트' },
  { label: 'atan2', kind: CompletionItemKind.Function, detail: '[UnitySense] T atan2(T y, T x) — y/x의 아크탄젠트' },
  { label: 'abs', kind: CompletionItemKind.Function, detail: '[UnitySense] T abs(T x) — 절댓값' },
  { label: 'sign', kind: CompletionItemKind.Function, detail: '[UnitySense] T sign(T x) — 부호 (-1, 0, 1)' },
  { label: 'floor', kind: CompletionItemKind.Function, detail: '[UnitySense] T floor(T x) — 내림 정수' },
  { label: 'ceil', kind: CompletionItemKind.Function, detail: '[UnitySense] T ceil(T x) — 올림 정수' },
  { label: 'round', kind: CompletionItemKind.Function, detail: '[UnitySense] T round(T x) — 가장 가까운 정수로 반올림' },
  { label: 'frac', kind: CompletionItemKind.Function, detail: '[UnitySense] T frac(T x) — 소수부 반환 (x - floor(x))' },
  { label: 'fmod', kind: CompletionItemKind.Function, detail: '[UnitySense] T fmod(T x, T y) — 부동소수점 나머지' },
  { label: 'step', kind: CompletionItemKind.Function, detail: '[UnitySense] T step(T edge, T x) — x >= edge 이면 1, 아니면 0' },
  { label: 'smoothstep', kind: CompletionItemKind.Function, detail: '[UnitySense] T smoothstep(T minVal, T maxVal, T x) — 부드러운 에르미트 보간' },
  { label: 'max', kind: CompletionItemKind.Function, detail: '[UnitySense] T max(T a, T b) — 두 값 중 큰 값' },
  { label: 'min', kind: CompletionItemKind.Function, detail: '[UnitySense] T min(T a, T b) — 두 값 중 작은 값' },
  { label: 'sqrt', kind: CompletionItemKind.Function, detail: '[UnitySense] T sqrt(T x) — 제곱근' },
  { label: 'rsqrt', kind: CompletionItemKind.Function, detail: '[UnitySense] T rsqrt(T x) — 역제곱근 (1 / sqrt(x))' },
  { label: 'ddx', kind: CompletionItemKind.Function, detail: '[UnitySense] T ddx(T x) — 픽셀 셰이더 화면 X축 편미분' },
  { label: 'ddy', kind: CompletionItemKind.Function, detail: '[UnitySense] T ddy(T x) — 픽셀 셰이더 화면 Y축 편미분' },
  { label: 'fwidth', kind: CompletionItemKind.Function, detail: '[UnitySense] T fwidth(T x) — abs(ddx(x)) + abs(ddy(x))' },
  { label: 'clip', kind: CompletionItemKind.Function, detail: '[UnitySense] void clip(T x) — x < 0이면 현재 픽셀 폐기(discard)' },
  { label: 'discard', kind: CompletionItemKind.Keyword, detail: '[UnitySense] HLSL discard — 현재 프래그먼트 픽셀 폐기' },
  { label: 'tex2D', kind: CompletionItemKind.Function, detail: '[UnitySense] float4 tex2D(sampler2D s, float2 uv) — 레거시 2D 텍스처 샘플링' },
  { label: 'tex2Dlod', kind: CompletionItemKind.Function, detail: '[UnitySense] float4 tex2Dlod(sampler2D s, float4 uv_lod) — 명시적 MIP LOD 2D 샘플링' },
  { label: 'texCUBE', kind: CompletionItemKind.Function, detail: '[UnitySense] float4 texCUBE(samplerCUBE s, float3 dir) — 큐브맵 샘플링' },
  { label: 'all', kind: CompletionItemKind.Function, detail: '[UnitySense] bool all(T x) — 모든 성분이 0이 아니면 true' },
  { label: 'any', kind: CompletionItemKind.Function, detail: '[UnitySense] bool any(T x) — 하나 이상의 성분이 0이 아니면 true' },
  { label: 'mad', kind: CompletionItemKind.Function, detail: '[UnitySense] T mad(T a, T b, T c) — 곱셈-덧셈 융합 연산 (a * b + c)' },
  { label: 'rcp', kind: CompletionItemKind.Function, detail: '[UnitySense] T rcp(T x) — 역수 (1 / x)' },
];

function stripRedundantClosingDelim(insertText: string | undefined, lineSuffix: string): string | undefined {
  if (!insertText) return insertText;
  if (lineSuffix.startsWith('"') && insertText.endsWith('"')) {
    return insertText.slice(0, -1);
  }
  if (lineSuffix.startsWith(')') && insertText.endsWith(')')) {
    return insertText.slice(0, -1);
  }
  return insertText;
}

function buildMacroSnippetInsertText(macro: UnityMacroSpec): string | undefined {
  if (macro.name === 'CBUFFER_START') {
    return 'CBUFFER_START(${1:UnityPerMaterial})\n\t$0\nCBUFFER_END';
  }
  if (macro.name === 'UNITY_INSTANCING_BUFFER_START') {
    return 'UNITY_INSTANCING_BUFFER_START(${1:Props})\n\t$0\nUNITY_INSTANCING_BUFFER_END(${1:Props})';
  }
  if (macro.name === 'UNITY_DOTS_INSTANCING_START') {
    return 'UNITY_DOTS_INSTANCING_START(${1:MaterialPropertyMetadata})\n\t$0\nUNITY_DOTS_INSTANCING_END(${1:MaterialPropertyMetadata})';
  }
  const paramMatch = /\(([^)]*)\)/.exec(macro.signature);
  if (!paramMatch) return undefined;
  const rawParams = paramMatch[1]
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (rawParams.length === 0) return `${macro.name}()`;
  const placeholders = rawParams.map((p, idx) => `\${${idx + 1}:${p}}`).join(', ');
  return `${macro.name}(${placeholders})`;
}

function toShaderLabCompletionItems(
  entries: readonly ShaderLabDocEntry[],
  prefix: string,
  kind: CompletionItemKind,
  lineSuffix = '',
): CompletionItem[] {
  return entries
    .filter((e) => !prefix || e.label.toLowerCase().startsWith(prefix))
    .map((e) => ({
      label: e.label,
      kind,
      detail: e.detail,
      documentation: e.documentation,
      insertText: stripRedundantClosingDelim(e.insertText, lineSuffix),
      insertTextFormat: e.isSnippet ? InsertTextFormat.Snippet : InsertTextFormat.PlainText,
    }));
}

const SHADERLAB_VALUE_MAP: Record<string, readonly ShaderLabDocEntry[]> = {
  Cull: [
    { label: 'Back', detail: '[UnitySense] Cull Mode', documentation: '뒷면 폴리곤을 컬링합니다 (기본값).' },
    { label: 'Front', detail: '[UnitySense] Cull Mode', documentation: '앞면 폴리곤을 컬링합니다.' },
    { label: 'Off', detail: '[UnitySense] Cull Mode', documentation: '양면을 모두 렌더링합니다.' },
  ],
  ZWrite: [
    { label: 'On', detail: '[UnitySense] ZWrite Mode', documentation: '깊이 버퍼에 기록합니다 (불투명 기본값).' },
    { label: 'Off', detail: '[UnitySense] ZWrite Mode', documentation: '깊이 버퍼에 기록하지 않습니다 (투명/이펙트).' },
  ],
  ZTest: [
    { label: 'LEqual', detail: '[UnitySense] ZTest Mode', documentation: '기존 깊이보다 작거나 같으면 통과합니다 (기본값).' },
    { label: 'Less', detail: '[UnitySense] ZTest Mode', documentation: '기존 깊이보다 작으면 통과합니다.' },
    { label: 'Greater', detail: '[UnitySense] ZTest Mode', documentation: '기존 깊이보다 크면 통과합니다.' },
    { label: 'GEqual', detail: '[UnitySense] ZTest Mode', documentation: '기존 깊이보다 크거나 같으면 통과합니다.' },
    { label: 'Equal', detail: '[UnitySense] ZTest Mode', documentation: '기존 깊이와 같으면 통과합니다.' },
    { label: 'NotEqual', detail: '[UnitySense] ZTest Mode', documentation: '기존 깊이와 다르면 통과합니다.' },
    { label: 'Always', detail: '[UnitySense] ZTest Mode', documentation: '깊이 테스트를 항상 통과합니다.' },
    { label: 'Never', detail: '[UnitySense] ZTest Mode', documentation: '깊이 테스트를 항상 실패합니다.' },
  ],
  Blend: [
    { label: 'SrcAlpha OneMinusSrcAlpha', detail: '[UnitySense] Alpha Blend', documentation: '표준 알파 블렌딩.' },
    { label: 'One One', detail: '[UnitySense] Additive Blend', documentation: '가산(Additive) 블렌딩.' },
    { label: 'One OneMinusSrcAlpha', detail: '[UnitySense] Premultiplied Blend', documentation: 'Premultiplied 알파 블렌딩.' },
    { label: 'DstColor Zero', detail: '[UnitySense] Multiplicative Blend', documentation: '곱셈(Multiply) 블렌딩.' },
    { label: 'Off', detail: '[UnitySense] Blend Off', documentation: '블렌딩을 비활성화합니다.' },
  ],
  BlendOp: [
    { label: 'Add', detail: '[UnitySense] BlendOp', documentation: 'Source + Destination' },
    { label: 'Sub', detail: '[UnitySense] BlendOp', documentation: 'Source - Destination' },
    { label: 'RevSub', detail: '[UnitySense] BlendOp', documentation: 'Destination - Source' },
    { label: 'Min', detail: '[UnitySense] BlendOp', documentation: 'min(Source, Destination)' },
    { label: 'Max', detail: '[UnitySense] BlendOp', documentation: 'max(Source, Destination)' },
  ],
  ColorMask: [
    { label: 'RGBA', detail: '[UnitySense] ColorMask', documentation: '모든 컬러 채널 기록 (기본값).' },
    { label: 'RGB', detail: '[UnitySense] ColorMask', documentation: '알파 제외 RGB 채널만 기록.' },
    { label: 'A', detail: '[UnitySense] ColorMask', documentation: '알파 채널만 기록.' },
    { label: '0', detail: '[UnitySense] ColorMask', documentation: '컬러 버퍼 기록 안 함 (ShadowCaster/DepthOnly).' },
  ],
  Comp: [
    { label: 'Always', detail: '[UnitySense] Stencil Comp', documentation: '항상 통과' },
    { label: 'Equal', detail: '[UnitySense] Stencil Comp', documentation: 'Ref == StencilBuffer' },
    { label: 'NotEqual', detail: '[UnitySense] Stencil Comp', documentation: 'Ref != StencilBuffer' },
    { label: 'Less', detail: '[UnitySense] Stencil Comp', documentation: 'Ref < StencilBuffer' },
    { label: 'LEqual', detail: '[UnitySense] Stencil Comp', documentation: 'Ref <= StencilBuffer' },
    { label: 'Greater', detail: '[UnitySense] Stencil Comp', documentation: 'Ref > StencilBuffer' },
    { label: 'GEqual', detail: '[UnitySense] Stencil Comp', documentation: 'Ref >= StencilBuffer' },
    { label: 'Never', detail: '[UnitySense] Stencil Comp', documentation: '항상 실패' },
  ],
  Pass: [
    { label: 'Keep', detail: '[UnitySense] Stencil Op', documentation: '현재 스텐실 값 유지' },
    { label: 'Replace', detail: '[UnitySense] Stencil Op', documentation: 'Ref 값으로 대체' },
    { label: 'Zero', detail: '[UnitySense] Stencil Op', documentation: '0으로 설정' },
    { label: 'Invert', detail: '[UnitySense] Stencil Op', documentation: '비트 반전' },
    { label: 'IncrSat', detail: '[UnitySense] Stencil Op', documentation: '1 증가 (포화)' },
    { label: 'DecrSat', detail: '[UnitySense] Stencil Op', documentation: '1 감소 (포화)' },
  ],
};
SHADERLAB_VALUE_MAP.Fail = SHADERLAB_VALUE_MAP.Pass;
SHADERLAB_VALUE_MAP.ZFail = SHADERLAB_VALUE_MAP.Pass;

export class ShaderCompletionProvider {
  private readonly graph: IncludeDependencyGraph;

  constructor(graph: IncludeDependencyGraph) {
    this.graph = graph;
  }

  public provideCompletionItems(
    documentUri: string,
    position: Position,
    documentText: string,
  ): CompletionItem[] {
    this.graph.setOpenDocumentContent(documentUri, documentText);
    const filePath = this.graph.normalizeFilePath(documentUri);
    const lines = documentText.split(/\r?\n/);
    const currentLineText = lines[position.line] ?? '';
    const linePrefix = currentLineText.slice(0, position.character);
    const lineSuffix = currentLineText.slice(position.character);

    // Case 0: Preprocessor directive completion (`#`, `#in`, `#include_`, `#prag`, etc.)
    const directiveMatch = /^\s*#\s*([A-Za-z_]*)$/.exec(linePrefix);
    if (directiveMatch) {
      const dirPrefix = directiveMatch[1].toLowerCase();
      return HLSL_PREPROCESSOR_DIRECTIVES
        .filter((d) => !dirPrefix || d.name.startsWith(dirPrefix))
        .map((d) => ({
          label: `#${d.name}`,
          filterText: d.name,
          kind: CompletionItemKind.Keyword,
          detail: d.detail,
          insertText: stripRedundantClosingDelim(d.insertText, lineSuffix),
        }));
    }

    // Case 0.5: #pragma vertex/fragment/hull/domain/geometry/kernel <functionName> completion
    const pragmaEntryMatch = /^\s*#\s*pragma\s+(vertex|fragment|hull|domain|geometry|kernel)\s+([A-Za-z0-9_]*)$/.exec(
      linePrefix,
    );
    if (pragmaEntryMatch) {
      const fnPrefix = pragmaEntryMatch[2].toLowerCase();
      const visible = this.graph.findAllVisibleSymbols(filePath, position.line);
      const seenFns = new Set<string>();
      const fnItems: CompletionItem[] = [];
      for (const sym of visible) {
        if (sym.kind !== 'function') continue;
        if (seenFns.has(sym.name)) continue;
        if (fnPrefix && !sym.name.toLowerCase().startsWith(fnPrefix)) continue;
        seenFns.add(sym.name);
        fnItems.push({
          label: sym.name,
          kind: CompletionItemKind.Function,
          detail: `[UnitySense] #pragma ${pragmaEntryMatch[1]} 후보 · ${sym.signature ?? sym.name}`,
          documentation: sym.documentation ?? `[UnitySense] ${pragmaEntryMatch[1]} 엔트리 함수입니다.`,
        });
      }
      return fnItems;
    }

    // Case 1: #include "..." or #include_with_pragmas "..." path completion
    const incMatch = /^\s*#\s*include(?:_with_pragmas)?\s+"([^"]*)$/.exec(linePrefix);
    if (incMatch) {
      const rawPrefix = incMatch[1];
      const lastSlash = rawPrefix.lastIndexOf('/');
      const dirPrefix = lastSlash >= 0 ? rawPrefix.slice(0, lastSlash + 1) : '';
      const filterText = lastSlash >= 0 ? rawPrefix.slice(lastSlash + 1).toLowerCase() : rawPrefix.toLowerCase();

      const entries = this.graph.getResolver().listVirtualDirectory(dirPrefix, filePath);
      return entries
        .filter((e) => !filterText || e.name.toLowerCase().startsWith(filterText))
        .map((e) => ({
          label: e.name,
          kind: e.isDirectory ? CompletionItemKind.Folder : CompletionItemKind.File,
          detail: `[UnitySense] 셰이더 경로 (${e.virtualPath})`,
          insertText: e.isDirectory ? `${e.name}/` : e.name,
        }));
    }

    // Case 2: Chained struct member completion (`a.`, `a.b.`, `_Lights[0].`, `GetMainLight().`)
    const memberPrefixMatch = /\.\s*([A-Za-z0-9_]*)$/.exec(linePrefix);
    if (memberPrefixMatch) {
      const dotIdx = linePrefix.lastIndexOf('.');
      const chainExpr = extractMemberChainExpression(linePrefix.slice(0, dotIdx));
      const fieldPrefix = memberPrefixMatch[1].toLowerCase();
      if (chainExpr) {
        const resolved = this.graph.resolveExpressionChain(filePath, chainExpr, position.line);
        if (resolved.type) {
          const cleanType = resolved.type.replace(/<.*>$/, '').replace(/\[[^\]]*\]$/, '').trim();
          const fields = this.graph.findStructFields(filePath, cleanType, position.line);
          if (fields.length > 0) {
            return fields
              .filter((f) => !fieldPrefix || f.name.toLowerCase().startsWith(fieldPrefix))
              .map((f) => ({
                label: f.name,
                kind: CompletionItemKind.Field,
                detail: `[UnitySense] ${cleanType} 구조체 멤버 · ${f.signature ?? `${f.returnType ?? ''} ${f.name}`.trim()}`,
                documentation: `[UnitySense] 구조체 ${cleanType}의 필드입니다.`,
              }));
          }

          const vecMatch = /^(float|half|real|min16float|fixed|int|uint|bool)([234])$/.exec(cleanType);
          if (vecMatch) {
            const scalarType = vecMatch[1];
            const compCount = Number(vecMatch[2]);
            const swizzlesByDim: Record<number, readonly string[]> = {
              2: ['x', 'y', 'xy', 'r', 'g', 'rg'],
              3: ['x', 'y', 'z', 'xy', 'xyz', 'r', 'g', 'b', 'rg', 'rgb'],
              4: ['x', 'y', 'z', 'w', 'xy', 'xyz', 'xyzw', 'r', 'g', 'b', 'a', 'rg', 'rgb', 'rgba'],
            };
            const candidates = swizzlesByDim[compCount] ?? [];
            return candidates
              .filter((sw) => !fieldPrefix || sw.startsWith(fieldPrefix))
              .map((sw) => ({
                label: sw,
                kind: CompletionItemKind.Field,
                detail: `[UnitySense] ${cleanType} 벡터 스위즐 (${scalarType}${sw.length === 1 ? '' : sw.length})`,
              }));
          }
        }
      }
      return [];
    }

    // Case 2.5: ShaderLab DSL context outside HLSLPROGRAM/CGPROGRAM blocks
    const shaderLabCtx = detectShaderLabContext(documentText, position.line, position.character, filePath);
    if (shaderLabCtx !== 'hlsl') {
      const stateValMatch = /^\s*(Cull|ZWrite|ZTest|Blend|BlendOp|ColorMask|Comp|Pass|Fail|ZFail)\s+([A-Za-z0-9_]*)$/.exec(
        linePrefix,
      );
      if (stateValMatch) {
        const candidates = SHADERLAB_VALUE_MAP[stateValMatch[1]] ?? [];
        const valPrefix = stateValMatch[2].toLowerCase();
        return toShaderLabCompletionItems(candidates, valPrefix, CompletionItemKind.EnumMember, lineSuffix);
      }

      const slIdentMatch = /([A-Za-z_][A-Za-z0-9_]*)?$/.exec(linePrefix);
      const slPrefix = (slIdentMatch?.[1] ?? '').toLowerCase();
      if (shaderLabCtx === 'propertyAttribute') {
        return toShaderLabCompletionItems(SHADERLAB_PROPERTY_ATTRIBUTES, slPrefix, CompletionItemKind.Property, lineSuffix);
      }
      if (shaderLabCtx === 'properties') {
        const propTypePrefix = (/([A-Za-z0-9_]*)$/.exec(linePrefix)?.[1] ?? '').toLowerCase();
        const missingDisplayName = /\(\s*[A-Za-z0-9_]*$/.test(linePrefix);
        const typeEntries = missingDisplayName
          ? SHADERLAB_PROPERTY_TYPES.map((t) => ({
              ...t,
              insertText: `"\${1:Display Name}", ${t.insertText ?? t.label}`,
              isSnippet: true,
            }))
          : SHADERLAB_PROPERTY_TYPES;
        const attrItems = toShaderLabCompletionItems(SHADERLAB_PROPERTY_ATTRIBUTES, slPrefix, CompletionItemKind.Property, lineSuffix);
        const typeItems = toShaderLabCompletionItems(typeEntries, propTypePrefix, CompletionItemKind.TypeParameter, lineSuffix);
        return [...typeItems, ...attrItems];
      }
      if (shaderLabCtx === 'tags') {
        const tagValMatch = /"([A-Za-z0-9_]+)"\s*=\s*"([^"]*)$/.exec(linePrefix);
        if (tagValMatch) {
          const tagValuesByKey: Record<string, readonly string[]> = {
            Queue: ['Background', 'Geometry', 'AlphaTest', 'Transparent', 'Overlay'],
            RenderType: ['Opaque', 'Transparent', 'TransparentCutout', 'Background', 'Overlay'],
            RenderPipeline: ['UniversalPipeline', 'HDRenderPipeline'],
            LightMode: ['UniversalForward', 'UniversalForwardOnly', 'ShadowCaster', 'DepthOnly', 'DepthNormals', 'Meta', 'SRPDefaultUnlit'],
            IgnoreProjector: ['True', 'False'],
            DisableBatching: ['True', 'False', 'LODFading'],
            PreviewType: ['Sphere', 'Plane', 'Skybox'],
          };
          const vals = tagValuesByKey[tagValMatch[1]] ?? [];
          const vPrefix = tagValMatch[2].toLowerCase();
          return vals
            .filter((v) => !vPrefix || v.toLowerCase().startsWith(vPrefix))
            .map((v) => ({
              label: v,
              kind: CompletionItemKind.EnumMember,
              detail: `[UnitySense] ${tagValMatch[1]} Tag Value`,
            }));
        }
        const hasOpeningQuote = /"[^"=]*$/.test(linePrefix);
        if (hasOpeningQuote) {
          return SHADERLAB_TAGS
            .filter((t) => !slPrefix || t.label.toLowerCase().startsWith(slPrefix))
            .map((t) => {
              const strippedInsert = t.insertText?.startsWith('"')
                ? t.insertText.slice(1)
                : t.insertText;
              return {
                label: t.label,
                kind: CompletionItemKind.Property,
                detail: t.detail,
                documentation: t.documentation,
                insertText: stripRedundantClosingDelim(strippedInsert, lineSuffix),
                insertTextFormat: t.isSnippet ? InsertTextFormat.Snippet : InsertTextFormat.PlainText,
              };
            });
        }
        return toShaderLabCompletionItems(SHADERLAB_TAGS, slPrefix, CompletionItemKind.Property, lineSuffix);
      }
      if (shaderLabCtx === 'stencil') {
        return toShaderLabCompletionItems(SHADERLAB_STENCIL_ITEMS, slPrefix, CompletionItemKind.Keyword, lineSuffix);
      }
      if (shaderLabCtx === 'pass' || shaderLabCtx === 'subshader' || shaderLabCtx === 'renderState' || shaderLabCtx === 'root') {
        const stateItems = toShaderLabCompletionItems(SHADERLAB_RENDER_STATES, slPrefix, CompletionItemKind.Keyword, lineSuffix);
        const rootBlocks: ShaderLabDocEntry[] =
          shaderLabCtx === 'root' || shaderLabCtx === 'subshader'
            ? [
                { label: 'Properties', insertText: 'Properties\n{\n\t$0\n}', isSnippet: true, detail: '[UnitySense] ShaderLab Block', documentation: '머티리얼 인스펙터 프로퍼티 선언 블록입니다.' },
                { label: 'SubShader', insertText: 'SubShader\n{\n\tTags { "RenderPipeline" = "UniversalPipeline" "RenderType" = "Opaque" }\n\t$0\n}', isSnippet: true, detail: '[UnitySense] ShaderLab Block', documentation: '셰이더 서브 구현 블록입니다.' },
                { label: 'Pass', insertText: 'Pass\n{\n\tName "${1:ForwardLit}"\n\tHLSLPROGRAM\n\t$0\n\tENDHLSL\n}', isSnippet: true, detail: '[UnitySense] ShaderLab Block', documentation: '렌더 패스 블록입니다.' },
              ]
            : [];
        return [
          ...toShaderLabCompletionItems(rootBlocks, slPrefix, CompletionItemKind.Snippet, lineSuffix),
          ...stateItems,
        ];
      }
    }

    // Case 3: General HLSL symbols + Unity macros + Semantics (Pass-scoped)
    const identMatch = /([A-Za-z_][A-Za-z0-9_]*)?$/.exec(linePrefix);
    const prefix = (identMatch?.[1] ?? '').toLowerCase();
    const visibleSymbols = this.graph.findAllVisibleSymbols(filePath, position.line);
    const seenLabels = new Set<string>();
    const items: CompletionItem[] = [];

    const parsed = this.graph.getOrParseFile(filePath);
    for (const scope of parsed?.localVarScopes ?? []) {
      if (position.line < scope.startLine || position.line > scope.endLine) continue;
      for (const [name, decl] of scope.declarations.entries()) {
        if (decl.line > position.line) continue;
        if (seenLabels.has(name)) continue;
        if (prefix && !name.toLowerCase().startsWith(prefix)) continue;
        seenLabels.add(name);
        items.push({
          label: name,
          kind: CompletionItemKind.Variable,
          detail: `[UnitySense] ${decl.kind === 'parameter' ? '함수 파라미터' : '로컬 변수'} · ${decl.signature}`,
        });
      }
    }

    for (const sym of visibleSymbols) {
      if (sym.kind === 'field') continue;
      if (seenLabels.has(sym.name)) continue;
      if (prefix && !sym.name.toLowerCase().startsWith(prefix)) continue;
      seenLabels.add(sym.name);

      const kindMap: Record<string, number> = {
        function: CompletionItemKind.Function,
        struct: CompletionItemKind.Struct,
        macro: CompletionItemKind.Constant,
        cbuffer: CompletionItemKind.Module,
        variable: CompletionItemKind.Variable,
        property: CompletionItemKind.Property,
      };
      items.push({
        label: sym.name,
        kind: kindMap[sym.kind] ?? CompletionItemKind.Text,
        detail: `[UnitySense] HLSL 심볼 · ${sym.signature ?? sym.returnType ?? sym.name}`,
        documentation: sym.documentation
          ? `[UnitySense] ${sym.documentation}`
          : `[UnitySense] ${sym.kind} 심볼입니다.`,
      });
    }

    for (const macro of UNITY_BUILTIN_MACROS) {
      if (seenLabels.has(macro.name)) continue;
      if (prefix && !macro.name.toLowerCase().startsWith(prefix)) continue;
      seenLabels.add(macro.name);
      const snippetText = stripRedundantClosingDelim(buildMacroSnippetInsertText(macro), lineSuffix);
      items.push({
        label: macro.name,
        kind: CompletionItemKind.Snippet,
        detail: `[UnitySense] [${macro.pipeline}] ${macro.signature}`,
        documentation: `[UnitySense] ${macro.description}`,
        ...(snippetText
          ? { insertText: snippetText, insertTextFormat: InsertTextFormat.Snippet }
          : {}),
      });
    }

    for (const kw of HLSL_SEMANTICS_AND_TYPES) {
      if (seenLabels.has(kw.label)) continue;
      if (prefix && !kw.label.toLowerCase().startsWith(prefix)) continue;
      seenLabels.add(kw.label);
      items.push({
        label: kw.label,
        kind: kw.kind,
        detail: kw.detail,
      });
    }

    return items;
  }
}
