import { CompletionItemKind, type CompletionItem, type Position } from 'vscode-languageserver';
import {
  extractMemberChainExpression,
  type IncludeDependencyGraph,
} from '../indexer/hlslIncludeGraph.ts';
import { UNITY_BUILTIN_MACROS } from '../parser/unityHlslMacroPrepass.ts';

const HLSL_SEMANTICS_AND_TYPES = [
  { label: 'SV_Position', kind: CompletionItemKind.Constant, detail: '[UnityBrain] HLSL 클립 공간 정점 출력 / 프래그먼트 위치 시맨틱' },
  { label: 'SV_Target', kind: CompletionItemKind.Constant, detail: '[UnityBrain] HLSL 프래그먼트 렌더 타겟 출력 시맨틱' },
  { label: 'SV_Depth', kind: CompletionItemKind.Constant, detail: '[UnityBrain] HLSL 프래그먼트 깊이 출력 시맨틱' },
  { label: 'SV_InstanceID', kind: CompletionItemKind.Constant, detail: '[UnityBrain] HLSL GPU 인스턴스 식별자 시맨틱' },
  { label: 'POSITION', kind: CompletionItemKind.Constant, detail: '[UnityBrain] 정점 애트리뷰트 위치(Position) 시맨틱' },
  { label: 'NORMAL', kind: CompletionItemKind.Constant, detail: '[UnityBrain] 정점 애트리뷰트 노멀(Normal) 시맨틱' },
  { label: 'TANGENT', kind: CompletionItemKind.Constant, detail: '[UnityBrain] 정점 애트리뷰트 탄젠트(Tangent) 시맨틱' },
  { label: 'TEXCOORD0', kind: CompletionItemKind.Constant, detail: '[UnityBrain] 텍스처 좌표 채널 0 시맨틱' },
  { label: 'TEXCOORD1', kind: CompletionItemKind.Constant, detail: '[UnityBrain] 텍스처 좌표 채널 1 시맨틱' },
  { label: 'float2', kind: CompletionItemKind.Keyword, detail: '[UnityBrain] HLSL 2성분 32비트 부동소수점 벡터' },
  { label: 'float3', kind: CompletionItemKind.Keyword, detail: '[UnityBrain] HLSL 3성분 32비트 부동소수점 벡터' },
  { label: 'float4', kind: CompletionItemKind.Keyword, detail: '[UnityBrain] HLSL 4성분 32비트 부동소수점 벡터' },
  { label: 'half', kind: CompletionItemKind.Keyword, detail: '[UnityBrain] 유니티 16비트 반정밀도 실수 타입' },
  { label: 'half3', kind: CompletionItemKind.Keyword, detail: '[UnityBrain] 유니티 3성분 반정밀도 벡터' },
  { label: 'half4', kind: CompletionItemKind.Keyword, detail: '[UnityBrain] 유니티 4성분 반정밀도 벡터' },
  { label: 'real3', kind: CompletionItemKind.Keyword, detail: '[UnityBrain] 유니티 정밀도 적응형 3D 벡터' },
  { label: 'real4', kind: CompletionItemKind.Keyword, detail: '[UnityBrain] 유니티 정밀도 적응형 4D 벡터' },
  { label: 'float4x4', kind: CompletionItemKind.Keyword, detail: '[UnityBrain] HLSL 4x4 행렬 타입' },
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
