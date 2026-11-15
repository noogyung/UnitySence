import { CompletionItemKind, type CompletionItem, type Position } from 'vscode-languageserver';
import type { IncludeDependencyGraph } from '../indexer/hlslIncludeGraph.ts';
import { UNITY_BUILTIN_MACROS } from '../parser/unityHlslMacroPrepass.ts';

const HLSL_SEMANTICS_AND_TYPES = [
  { label: 'SV_Position', kind: CompletionItemKind.Constant, detail: 'HLSL Clip-space vertex output / fragment position semantic' },
  { label: 'SV_Target', kind: CompletionItemKind.Constant, detail: 'HLSL Fragment render target output semantic' },
  { label: 'SV_Depth', kind: CompletionItemKind.Constant, detail: 'HLSL Fragment depth output semantic' },
  { label: 'SV_InstanceID', kind: CompletionItemKind.Constant, detail: 'HLSL GPU instance identifier semantic' },
  { label: 'POSITION', kind: CompletionItemKind.Constant, detail: 'Vertex attribute position semantic' },
  { label: 'NORMAL', kind: CompletionItemKind.Constant, detail: 'Vertex attribute normal semantic' },
  { label: 'TANGENT', kind: CompletionItemKind.Constant, detail: 'Vertex attribute tangent semantic' },
  { label: 'TEXCOORD0', kind: CompletionItemKind.Constant, detail: 'Texture coordinate channel 0 semantic' },
  { label: 'TEXCOORD1', kind: CompletionItemKind.Constant, detail: 'Texture coordinate channel 1 semantic' },
  { label: 'float2', kind: CompletionItemKind.Keyword, detail: 'HLSL 2-component 32-bit float vector' },
  { label: 'float3', kind: CompletionItemKind.Keyword, detail: 'HLSL 3-component 32-bit float vector' },
  { label: 'float4', kind: CompletionItemKind.Keyword, detail: 'HLSL 4-component 32-bit float vector' },
  { label: 'half', kind: CompletionItemKind.Keyword, detail: 'Unity 16-bit half-precision float' },
  { label: 'half3', kind: CompletionItemKind.Keyword, detail: 'Unity 3-component half vector' },
  { label: 'half4', kind: CompletionItemKind.Keyword, detail: 'Unity 4-component half vector' },
  { label: 'real3', kind: CompletionItemKind.Keyword, detail: 'Unity precision-adaptive 3D vector' },
  { label: 'real4', kind: CompletionItemKind.Keyword, detail: 'Unity precision-adaptive 4D vector' },
  { label: 'float4x4', kind: CompletionItemKind.Keyword, detail: 'HLSL 4x4 matrix' },
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
          detail: e.virtualPath,
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
              detail: f.signature ?? `${f.returnType ?? ''} ${f.name}`.trim(),
              documentation: `Member of struct ${cleanType}`,
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
        detail: sym.signature ?? sym.returnType,
        documentation: sym.documentation,
      });
    }

    for (const macro of UNITY_BUILTIN_MACROS) {
      if (seenLabels.has(macro.name)) continue;
      if (prefix && !macro.name.toLowerCase().startsWith(prefix)) continue;
      seenLabels.add(macro.name);
      items.push({
        label: macro.name,
        kind: CompletionItemKind.Snippet,
        detail: `[${macro.pipeline}] ${macro.signature}`,
        documentation: macro.description,
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
