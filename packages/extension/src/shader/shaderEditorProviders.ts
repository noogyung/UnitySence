import fs from 'node:fs';
import * as vscode from 'vscode';
import type { IncludeDependencyGraph } from '../../../shader-lsp/src/indexer/hlslIncludeGraph.ts';
import { extractVirtualHlslDocument } from '../../../shader-lsp/src/parser/shaderLabVirtualDoc.ts';

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

const SWIZZLE_RE = /^(?:[xyzw]{1,4}|[rgba]{1,4}|[uv]{1,2})$/;

const BUILTIN_HLSL_SIGNATURES: Record<string, Array<{ label: string; doc: string }>> = {
  lerp: [{ label: 'T lerp(T x, T y, T s)', doc: '[UnityBrain] x와 y 사이를 s 비율로 선형 보간합니다.' }],
  saturate: [{ label: 'T saturate(T x)', doc: '[UnityBrain] 값을 [0, 1] 범위로 클램프합니다.' }],
  clamp: [{ label: 'T clamp(T x, T min, T max)', doc: '[UnityBrain] 값을 [min, max] 범위로 제한합니다.' }],
  smoothstep: [{ label: 'T smoothstep(T min, T max, T x)', doc: '[UnityBrain] min~max 구간에서 부드러운 에르미트 보간을 수행합니다.' }],
  step: [{ label: 'T step(T edge, T x)', doc: '[UnityBrain] x >= edge이면 1, 아니면 0을 반환합니다.' }],
  dot: [{ label: 'scalar dot(vec a, vec b)', doc: '[UnityBrain] 두 벡터의 내적(dot product)을 계산합니다.' }],
  cross: [{ label: 'float3 cross(float3 a, float3 b)', doc: '[UnityBrain] 두 3D 벡터의 외적(cross product)을 계산합니다.' }],
  mul: [
    { label: 'float4 mul(float4x4 m, float4 v)', doc: '[UnityBrain] 행렬과 벡터 또는 두 행렬을 곱합니다.' },
    { label: 'float3 mul(float3x3 m, float3 v)', doc: '[UnityBrain] 3x3 회전/변환 행렬과 3D 벡터를 곱합니다.' },
  ],
  normalize: [{ label: 'T normalize(T v)', doc: '[UnityBrain] 벡터를 단위 길이(1)로 정규화합니다.' }],
  length: [{ label: 'float length(vec v)', doc: '[UnityBrain] 벡터의 유클리드 길이를 반환합니다.' }],
  distance: [{ label: 'float distance(vec a, vec b)', doc: '[UnityBrain] 두 점 사이의 거리를 반환합니다.' }],
  reflect: [{ label: 'T reflect(T i, T n)', doc: '[UnityBrain] 입사 벡터 i를 법선 n 기준으로 반사합니다.' }],
  refract: [{ label: 'T refract(T i, T n, float eta)', doc: '[UnityBrain] 굴절률 eta를 적용하여 굴절 벡터를 계산합니다.' }],
  pow: [{ label: 'T pow(T base, T exp)', doc: '[UnityBrain] 거듭제곱 base^exp를 계산합니다.' }],
  max: [{ label: 'T max(T a, T b)', doc: '[UnityBrain] 두 값 중 큰 값을 반환합니다.' }],
  min: [{ label: 'T min(T a, T b)', doc: '[UnityBrain] 두 값 중 작은 값을 반환합니다.' }],
  tex2D: [{ label: 'float4 tex2D(sampler2D s, float2 uv)', doc: '[UnityBrain] 레거시 2D 텍스처 샘플링을 수행합니다.' }],
  tex2Dlod: [{ label: 'float4 tex2Dlod(sampler2D s, float4 uv_lod)', doc: '[UnityBrain] 명시적 밉맵 LOD(.w)로 2D 텍스처를 샘플링합니다.' }],
  SAMPLE_TEXTURE2D: [{ label: 'half4 SAMPLE_TEXTURE2D(Texture2D tex, SamplerState smp, float2 uv)', doc: '[UnityBrain] URP/SRP 표준 2D 텍스처를 샘플링합니다.' }],
  SAMPLE_TEXTURE2D_LOD: [{ label: 'half4 SAMPLE_TEXTURE2D_LOD(Texture2D tex, SamplerState smp, float2 uv, float lod)', doc: '[UnityBrain] 지정된 mip 레벨(lod)로 2D 텍스처를 샘플링합니다.' }],
  TEXTURE2D: [{ label: 'TEXTURE2D(textureName)', doc: '[UnityBrain] SRP 플랫폼 호환 Texture2D 변수를 선언합니다.' }],
  SAMPLER: [{ label: 'SAMPLER(samplerName)', doc: '[UnityBrain] SRP 플랫폼 호환 SamplerState 변수를 선언합니다.' }],
  TransformObjectToHClip: [{ label: 'float4 TransformObjectToHClip(float3 positionOS)', doc: '[UnityBrain] 오브젝트 공간 좌표를 동차 클립 공간으로 변환합니다.' }],
  TransformObjectToWorld: [{ label: 'float3 TransformObjectToWorld(float3 positionOS)', doc: '[UnityBrain] 오브젝트 공간 좌표를 월드 공간으로 변환합니다.' }],
  TransformObjectToWorldNormal: [{ label: 'float3 TransformObjectToWorldNormal(float3 normalOS, bool doNormalize)', doc: '[UnityBrain] 오브젝트 공간 법선을 월드 공간 법선으로 변환합니다.' }],
  TransformWorldToHClip: [{ label: 'float4 TransformWorldToHClip(float3 positionWS)', doc: '[UnityBrain] 월드 공간 좌표를 클립 공간으로 변환합니다.' }],
  GetVertexPositionInputs: [{ label: 'VertexPositionInputs GetVertexPositionInputs(float3 positionOS)', doc: '[UnityBrain] positionWS/VS/CS/NDC를 한 번에 계산합니다.' }],
  GetVertexNormalInputs: [{ label: 'VertexNormalInputs GetVertexNormalInputs(float3 normalOS, float4 tangentOS)', doc: '[UnityBrain] TBN(tangentWS, bitangentWS, normalWS) 벡터를 계산합니다.' }],
  GetMainLight: [
    { label: 'Light GetMainLight()', doc: '[UnityBrain] 메인 방향성 라이트 정보를 반환합니다.' },
    { label: 'Light GetMainLight(float4 shadowCoord, float3 positionWS, half4 shadowMask)', doc: '[UnityBrain] 그림자 감쇠가 포함된 메인 라이트 정보를 반환합니다.' },
  ],
  GetAdditionalLight: [{ label: 'Light GetAdditionalLight(uint i, float3 positionWS)', doc: '[UnityBrain] 인덱스 i에 해당하는 추가 라이트(Point/Spot)를 반환합니다.' }],
  UniversalFragmentPBR: [{ label: 'half4 UniversalFragmentPBR(InputData inputData, SurfaceData surfaceData)', doc: '[UnityBrain] URP PBR 라이팅 최종 색상을 계산합니다.' }],
  MixFog: [{ label: 'half3 MixFog(half3 fragColor, float fogCoord)', doc: '[UnityBrain] 프래그먼트 색상에 씬 안개(Fog)를 혼합합니다.' }],
};

export function stripCommentsAndStringsByLine(lines: readonly string[]): string[] {
  const out: string[] = [];
  let inBlockComment = false;
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx];
    const chars = Array.from(rawLine);
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
    const fieldNames = new Set<string>();

    for (const f of walk.files) {
      for (const sym of f.symbols) {
        if (sym.kind === 'struct') structNames.add(sym.name);
        else if (sym.kind === 'function') functionNames.add(sym.name);
        else if (sym.kind === 'property') propertyNames.add(sym.name);
        else if (sym.kind === 'macro') macroNames.add(sym.name);
        else if (sym.kind === 'variable' || sym.kind === 'cbuffer') globalVarNames.add(sym.name);
        else if (sym.kind === 'field') fieldNames.add(sym.name);
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
        if (/^#\s*pragma\b/.test(trimmed)) {
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
        } else if (fieldNames.has(ident)) {
          builder.push(lineIdx, col, ident.length, 4, 0);
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
      const firstPropLine = parsed.properties[0].line;
      const lastPropLine = parsed.properties[parsed.properties.length - 1].line;
      const propsGroup = new vscode.DocumentSymbol(
        'Properties',
        `셰이더 프로퍼티 ${parsed.properties.length}개`,
        vscode.SymbolKind.Namespace,
        safeRange(firstPropLine, 0, lastPropLine, doc.lineAt(Math.min(lastPropLine, docLineCount - 1)).text.length),
        safeRange(firstPropLine, 0, firstPropLine, 10),
      );
      for (const prop of parsed.properties) {
        const lineLen = doc.lineAt(Math.min(prop.line, docLineCount - 1)).text.length;
        propsGroup.children.push(
          new vscode.DocumentSymbol(
            prop.name,
            `${prop.displayName} (${prop.type})`,
            vscode.SymbolKind.Property,
            safeRange(prop.line, prop.column, prop.line, lineLen),
            safeRange(prop.line, prop.column, prop.line, prop.column + prop.name.length),
          ),
        );
      }
      topSymbols.push(propsGroup);
    }

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
        const fields = parsed.structFieldsByStruct.get(sym.name) ?? [];
        for (const f of fields) {
          const fRange = safeRange(f.line, f.column, f.line, f.column + f.name.length);
          node.children.push(
            new vscode.DocumentSymbol(f.name, f.returnType ?? 'field', vscode.SymbolKind.Field, fRange, fRange),
          );
        }
      }
      topSymbols.push(node);
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

export class ShaderSignatureHelpProvider {
  constructor(private readonly shaderGraph: IncludeDependencyGraph) {}

  public provideSignatureHelp(doc: vscode.TextDocument, position: vscode.Position): vscode.SignatureHelp | undefined {
    const startLine = Math.max(0, position.line - 5);
    const snippet = doc.getText(new vscode.Range(new vscode.Position(startLine, 0), position));
    const callContext = this.findEnclosingCall(snippet);
    if (!callContext) return undefined;

    this.shaderGraph.setOpenDocumentContent(doc.uri.toString(), doc.getText());
    const visible = this.shaderGraph.findSymbolsVisibleFrom(doc.uri.toString(), callContext.funcName);
    const candidates: Array<{ label: string; doc: string; params: string[] }> = [];

    for (const sym of visible) {
      if ((sym.kind === 'function' || sym.kind === 'macro') && sym.signature) {
        const params = this.extractParamList(sym.signature);
        candidates.push({
          label: sym.signature,
          doc: `[UnityBrain] 선언 위치: ${sym.uri}`,
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

    const help = new vscode.SignatureHelp();
    help.signatures = candidates.map((cand) => {
      const sigInfo = new vscode.SignatureInformation(cand.label, cand.doc);
      sigInfo.parameters = cand.params.map((p) => new vscode.ParameterInformation(p));
      return sigInfo;
    });
    help.activeSignature = 0;
    const paramCount = candidates[0].params.length;
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
    return inner.split(',').map((s) => s.trim()).filter(Boolean);
  }
}

function collectIdentifierMatches(
  text: string,
  symbolName: string,
): Array<{ line: number; col: number; isWrite: boolean }> {
  const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wordRe = new RegExp(`\\b${escaped}\\b`, 'g');
  const codeLines = stripCommentsAndStringsByLine(text.split(/\r?\n/));
  const hits: Array<{ line: number; col: number; isWrite: boolean }> = [];

  for (let lineIdx = 0; lineIdx < codeLines.length; lineIdx++) {
    const line = codeLines[lineIdx];
    wordRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = wordRe.exec(line)) !== null) {
      const after = line.slice(m.index + symbolName.length).trimStart();
      const isWrite = /^(?:\+=|-=|\*=|\/=|%=|=(?!=))/.test(after);
      hits.push({ line: lineIdx, col: m.index, isWrite });
    }
  }
  return hits;
}

export class ShaderDocumentHighlightProvider {
  public provideDocumentHighlights(
    doc: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.DocumentHighlight[] {
    const wordRange = doc.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
    if (!wordRange) return [];
    const word = doc.getText(wordRange);
    if (!word || SHADER_KEYWORDS_SKIP.has(word)) return [];

    const matches = collectIdentifierMatches(doc.getText(), word);
    return matches.map(
      (hit) =>
        new vscode.DocumentHighlight(
          new vscode.Range(hit.line, hit.col, hit.line, hit.col + word.length),
          hit.isWrite ? vscode.DocumentHighlightKind.Write : vscode.DocumentHighlightKind.Read,
        ),
    );
  }
}

export class ShaderReferenceProvider {
  constructor(private readonly shaderGraph: IncludeDependencyGraph) {}

  public provideReferences(doc: vscode.TextDocument, position: vscode.Position): vscode.Location[] {
    const wordRange = doc.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
    if (!wordRange) return [];
    const word = doc.getText(wordRange);
    if (!word || SHADER_KEYWORDS_SKIP.has(word)) return [];

    const uriStr = doc.uri.toString();
    const entryNorm = this.shaderGraph.normalizeFilePath(uriStr);
    this.shaderGraph.setOpenDocumentContent(uriStr, doc.getText());
    const walk = this.shaderGraph.collectReachableFiles(uriStr);
    const parents = this.shaderGraph.findParentIncludeFiles(uriStr);

    const visitedFiles = new Set<string>();
    const locations: vscode.Location[] = [];
    const candidates = [...walk.files, ...parents];

    for (const file of candidates) {
      if (visitedFiles.has(file.filePath)) continue;
      visitedFiles.add(file.filePath);

      const content =
        file.filePath === entryNorm
          ? doc.getText()
          : fs.existsSync(file.filePath)
            ? fs.readFileSync(file.filePath, 'utf8')
            : file.virtualHlsl;
      const matches = collectIdentifierMatches(content, word);
      for (const hit of matches) {
        locations.push(
          new vscode.Location(
            vscode.Uri.parse(file.uri),
            new vscode.Range(hit.line, hit.col, hit.line, hit.col + word.length),
          ),
        );
      }
    }

    return locations;
  }
}
