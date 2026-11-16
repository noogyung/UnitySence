import { CompletionItemKind, type CompletionItem, type Position } from 'vscode-languageserver';
import type { IncludeDependencyGraph } from '../indexer/hlslIncludeGraph.ts';
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

    // Case 1: #include "..." path completion
    const incMatch = /^\s*#\s*include\s+"([^"]*)$/.exec(linePrefix);
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

    // Case 2: Struct member completion (varName.)
    const memberMatch = /([A-Za-z_][A-Za-z0-9_]*)\s*\.([A-Za-z0-9_]*)$/.exec(linePrefix);
    if (memberMatch) {
      const varName = memberMatch[1];
      const fieldPrefix = memberMatch[2].toLowerCase();
      const varType = this.graph.inferVariableType(filePath, varName, position.line);
      if (varType) {
        const cleanType = varType.replace(/<.*>$/, '').trim();
        const fields = this.graph.findStructFields(filePath, cleanType);
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
      }
      return [];
    }

    // Case 3: General HLSL symbols + Unity macros + Semantics
    const identMatch = /([A-Za-z_][A-Za-z0-9_]*)?$/.exec(linePrefix);
    const prefix = (identMatch?.[1] ?? '').toLowerCase();
    const visibleSymbols = this.graph.findAllVisibleSymbols(filePath);
    const seenLabels = new Set<string>();
    const items: CompletionItem[] = [];

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
