import { CompletionItemKind, type CompletionItem, type Position } from 'vscode-languageserver';
import {
  extractMemberChainExpression,
  type IncludeDependencyGraph,
} from '../indexer/hlslIncludeGraph.ts';
import { UNITY_BUILTIN_MACROS } from '../parser/unityHlslMacroPrepass.ts';

const HLSL_PREPROCESSOR_DIRECTIVES = [
  {
    name: 'include',
    insertText: 'include "',
    detail: '[UnityBrain] HLSL / ShaderLab 헤더 파일 포함 (#include "...")',
  },
  {
    name: 'include_with_pragmas',
    insertText: 'include_with_pragmas "',
    detail: '[UnityBrain] Unity 6 #pragma 지시어 포함 헤더 (#include_with_pragmas "...")',
  },
  {
    name: 'pragma',
    insertText: 'pragma ',
    detail: '[UnityBrain] 셰이더 컴파일러 지시어 (#pragma vertex/fragment/multi_compile...)',
  },
  { name: 'define', insertText: 'define ', detail: '[UnityBrain] 전처리기 매크로 정의' },
  { name: 'if', insertText: 'if ', detail: '[UnityBrain] 전처리기 조건 분기 시작' },
  { name: 'ifdef', insertText: 'ifdef ', detail: '[UnityBrain] 매크로 정의 여부 조건 분기' },
  { name: 'ifndef', insertText: 'ifndef ', detail: '[UnityBrain] 매크로 미정의 여부 조건 분기' },
  { name: 'elif', insertText: 'elif ', detail: '[UnityBrain] 전처리기 추가 조건 분기' },
  { name: 'else', insertText: 'else', detail: '[UnityBrain] 전처리기 기본 분기' },
  { name: 'endif', insertText: 'endif', detail: '[UnityBrain] 전처리기 조건 분기 종료' },
  { name: 'undef', insertText: 'undef ', detail: '[UnityBrain] 전처리기 매크로 정의 해제' },
];

const HLSL_SEMANTICS_AND_TYPES = [
  { label: 'SV_Position', kind: CompletionItemKind.Constant, detail: '[UnityBrain] HLSL 클립 공간 정점 출력 / 프래그먼트 위치 시맨틱' },
  { label: 'SV_Target', kind: CompletionItemKind.Constant, detail: '[UnityBrain] HLSL 프래그먼트 렌더 타겟 출력 시맨틱' },
  { label: 'SV_Depth', kind: CompletionItemKind.Constant, detail: '[UnityBrain] HLSL 프래그먼트 깊이 출력 시맨틱' },
  { label: 'SV_InstanceID', kind: CompletionItemKind.Constant, detail: '[UnityBrain] HLSL GPU 인스턴스 식별자 시맨틱' },
  { label: 'SV_DispatchThreadID', kind: CompletionItemKind.Constant, detail: '[UnityBrain] Compute 셰이더 전역 스레드 ID (uint3)' },
  { label: 'SV_GroupThreadID', kind: CompletionItemKind.Constant, detail: '[UnityBrain] Compute 스레드 그룹 내 로컬 ID (uint3)' },
  { label: 'SV_GroupID', kind: CompletionItemKind.Constant, detail: '[UnityBrain] Compute 스레드 그룹 ID (uint3)' },
  { label: 'SV_GroupIndex', kind: CompletionItemKind.Constant, detail: '[UnityBrain] Compute 스레드 그룹 내 1차원 인덱스 (uint)' },
  { label: 'SV_Barycentrics', kind: CompletionItemKind.Constant, detail: '[UnityBrain] SM 6.1 삼각형 무게중심 좌표 시맨틱' },
  { label: 'SV_ShadingRate', kind: CompletionItemKind.Constant, detail: '[UnityBrain] VRS(Variable Rate Shading) 셰이딩 레이트 시맨틱' },
  { label: 'SV_ViewID', kind: CompletionItemKind.Constant, detail: '[UnityBrain] XR/스테레오 뷰 인덱스 시맨틱' },
  { label: 'POSITION', kind: CompletionItemKind.Constant, detail: '[UnityBrain] 정점 애트리뷰트 위치(Position) 시맨틱' },
  { label: 'NORMAL', kind: CompletionItemKind.Constant, detail: '[UnityBrain] 정점 애트리뷰트 노멀(Normal) 시맨틱' },
  { label: 'TANGENT', kind: CompletionItemKind.Constant, detail: '[UnityBrain] 정점 애트리뷰트 탄젠트(Tangent) 시맨틱' },
  { label: 'TEXCOORD0', kind: CompletionItemKind.Constant, detail: '[UnityBrain] 텍스처 좌표 채널 0 시맨틱' },
  { label: 'TEXCOORD1', kind: CompletionItemKind.Constant, detail: '[UnityBrain] 텍스처 좌표 채널 1 시맨틱' },
  { label: 'float2', kind: CompletionItemKind.Keyword, detail: '[UnityBrain] HLSL 2성분 32비트 부동소수점 벡터' },
  { label: 'float3', kind: CompletionItemKind.Keyword, detail: '[UnityBrain] HLSL 3성분 32비트 부동소수점 벡터' },
  { label: 'float4', kind: CompletionItemKind.Keyword, detail: '[UnityBrain] HLSL 4성분 32비트 부동소수점 벡터' },
  { label: 'float16_t', kind: CompletionItemKind.Keyword, detail: '[UnityBrain] SM 6.2 네이티브 16비트 부동소수점 타입' },
  { label: 'uint16_t', kind: CompletionItemKind.Keyword, detail: '[UnityBrain] SM 6.2 네이티브 16비트 부호 없는 정수 타입' },
  { label: 'half', kind: CompletionItemKind.Keyword, detail: '[UnityBrain] 유니티 16비트 반정밀도 실수 타입' },
  { label: 'half3', kind: CompletionItemKind.Keyword, detail: '[UnityBrain] 유니티 3성분 반정밀도 벡터' },
  { label: 'half4', kind: CompletionItemKind.Keyword, detail: '[UnityBrain] 유니티 4성분 반정밀도 벡터' },
  { label: 'real3', kind: CompletionItemKind.Keyword, detail: '[UnityBrain] 유니티 정밀도 적응형 3D 벡터' },
  { label: 'real4', kind: CompletionItemKind.Keyword, detail: '[UnityBrain] 유니티 정밀도 적응형 4D 벡터' },
  { label: 'float4x4', kind: CompletionItemKind.Keyword, detail: '[UnityBrain] HLSL 4x4 행렬 타입' },
  { label: 'RaytracingAccelerationStructure', kind: CompletionItemKind.Keyword, detail: '[UnityBrain] DXR/Unity RayTracing 가속 구조체(TLAS)' },
  { label: 'RayDesc', kind: CompletionItemKind.Keyword, detail: '[UnityBrain] DXR 광선(Origin, TMin, Direction, TMax) 구조체' },
  { label: 'BuiltInTriangleIntersectionAttributes', kind: CompletionItemKind.Keyword, detail: '[UnityBrain] DXR 기본 삼각형 교차 무게중심(barycentrics) 구조체' },
  { label: 'TraceRay', kind: CompletionItemKind.Function, detail: '[UnityBrain] void TraceRay(RaytracingAccelerationStructure, uint RayFlags, ...)' },
  { label: 'DispatchRaysIndex', kind: CompletionItemKind.Function, detail: '[UnityBrain] uint3 DispatchRaysIndex() — 현재 RayTracing 스레드 좌표' },
  { label: 'WaveActiveSum', kind: CompletionItemKind.Function, detail: '[UnityBrain] T WaveActiveSum(T value) — SM 6.0 Wave 전체 합산' },
  { label: 'WaveReadLaneFirst', kind: CompletionItemKind.Function, detail: '[UnityBrain] T WaveReadLaneFirst(T value) — 첫 번째 활성 레인 값 브로드캐스트' },
  { label: 'asfloat', kind: CompletionItemKind.Function, detail: '[UnityBrain] float asfloat(uint/int x) — 비트 재해석 float 변환' },
  { label: 'asuint', kind: CompletionItemKind.Function, detail: '[UnityBrain] uint asuint(float x) — 비트 재해석 uint 변환' },
  { label: 'f16tof32', kind: CompletionItemKind.Function, detail: '[UnityBrain] float f16tof32(uint value) — 16비트 half를 32비트 float로 언팩' },
  { label: 'f32tof16', kind: CompletionItemKind.Function, detail: '[UnityBrain] uint f32tof16(float value) — 32비트 float를 16비트 half 비트로 팩' },
  { label: 'NonUniformResourceIndex', kind: CompletionItemKind.Function, detail: '[UnityBrain] uint NonUniformResourceIndex(uint index) — Bindless 리소스 인덱싱' },
];

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
    const linePrefix = (lines[position.line] ?? '').slice(0, position.character);

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
          insertText: d.insertText,
        }));
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
          detail: `[UnityBrain] 셰이더 경로 (${e.virtualPath})`,
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
                detail: `[UnityBrain] ${cleanType} 구조체 멤버 · ${f.signature ?? `${f.returnType ?? ''} ${f.name}`.trim()}`,
                documentation: `[UnityBrain] 구조체 ${cleanType}의 필드입니다.`,
              }));
          }

          const vecMatch = /^(float|half|real|min16float|int|uint)([234])$/.exec(cleanType);
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
                detail: `[UnityBrain] ${cleanType} 벡터 스위즐 (${scalarType}${sw.length === 1 ? '' : sw.length})`,
              }));
          }
        }
      }
      return [];
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
          detail: `[UnityBrain] ${decl.kind === 'parameter' ? '함수 파라미터' : '로컬 변수'} · ${decl.signature}`,
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
        detail: `[UnityBrain] HLSL 심볼 · ${sym.signature ?? sym.returnType ?? sym.name}`,
        documentation: sym.documentation
          ? `[UnityBrain] ${sym.documentation}`
          : `[UnityBrain] ${sym.kind} 심볼입니다.`,
      });
    }

    for (const macro of UNITY_BUILTIN_MACROS) {
      if (seenLabels.has(macro.name)) continue;
      if (prefix && !macro.name.toLowerCase().startsWith(prefix)) continue;
      seenLabels.add(macro.name);
      items.push({
        label: macro.name,
        kind: CompletionItemKind.Snippet,
        detail: `[UnityBrain] [${macro.pipeline}] ${macro.signature}`,
        documentation: `[UnityBrain] ${macro.description}`,
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
