import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import type { UnityProjectContext } from '../../src/contracts/index.ts';
import { IncludeDependencyGraph } from '../../../shader-lsp/src/indexer/hlslIncludeGraph.ts';
import {
  collectComputeAndShaderLabDiagnostics,
  ShaderDocumentHighlightProvider,
  ShaderDocumentSymbolProvider,
  ShaderReferenceProvider,
  ShaderRenameProvider,
  ShaderSemanticTokensProvider,
  ShaderSignatureHelpProvider,
  SHADER_SEMANTIC_TOKEN_MODIFIERS,
  SHADER_SEMANTIC_TOKEN_TYPES,
} from '../../src/shader/shaderEditorProviders.ts';
import { formatShaderText, ShaderFormattingProvider } from '../../src/shader/shaderFormatter.ts';
import { analyzeShaderPerformance, runShaderLiveTest } from '../../src/shader/shaderLiveTester.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');
const tempDirs: string[] = [];

function createTempProject(): UnityProjectContext {
  const baseOut = path.join(REPO_ROOT, 'test-output');
  fs.mkdirSync(baseOut, { recursive: true });
  const root = fs.mkdtempSync(path.join(baseOut, 'ub-omni-ext-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'Assets', 'Shaders'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Packages'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Packages', 'manifest.json'), '{"dependencies":{}}', 'utf8');
  return {
    projectRoot: root,
    editorVersion: '6000.0.1f1',
    editorInstallPath: null,
    cgIncludesPath: null,
    builtInPackagesPath: null,
    manifestPath: path.join(root, 'Packages', 'manifest.json'),
    packagesLockPath: null,
    cacheDir: path.join(root, 'Library', 'UnityBrainCache'),
  };
}

function makeDoc(filePath: string, content: string, languageId = 'unity-shaderlab'): vscode.TextDocument {
  const lines = content.split(/\r?\n/);
  const uri = vscode.Uri.file(filePath);
  return {
    uri,
    fileName: filePath,
    languageId,
    version: 1,
    lineCount: lines.length,
    getText: (range?: vscode.Range) => {
      if (!range) return content;
      const sliced = lines.slice(range.start.line, range.end.line + 1);
      if (sliced.length === 0) return '';
      if (sliced.length === 1) {
        return sliced[0].slice(range.start.character, range.end.character);
      }
      sliced[0] = sliced[0].slice(range.start.character);
      sliced[sliced.length - 1] = sliced[sliced.length - 1].slice(0, range.end.character);
      return sliced.join('\n');
    },
    lineAt: (line: number) => ({
      lineNumber: line,
      text: lines[line] ?? '',
      range: new vscode.Range(line, 0, line, (lines[line] ?? '').length),
    }),
    getWordRangeAtPosition: (pos: vscode.Position, regex = /[A-Za-z_][A-Za-z0-9_]*/) => {
      const lineText = lines[pos.line] ?? '';
      const re = new RegExp(regex.source, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(lineText)) !== null) {
        if (pos.character >= m.index && pos.character <= m.index + m[0].length) {
          return new vscode.Range(pos.line, m.index, pos.line, m.index + m[0].length);
        }
      }
      return undefined;
    },
  } as unknown as vscode.TextDocument;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Omni Shader Integrated Capabilities', () => {
  it('emits semantic tokens for #include_with_pragmas and #if defined macros', () => {
    const ctx = createTempProject();
    const graph = new IncludeDependencyGraph(ctx);
    const legend = new vscode.SemanticTokensLegend(
      [...SHADER_SEMANTIC_TOKEN_TYPES],
      [...SHADER_SEMANTIC_TOKEN_MODIFIERS],
    );
    const provider = new ShaderSemanticTokensProvider(graph, legend);
    const shaderPath = path.join(ctx.projectRoot, 'Assets', 'Shaders', 'Highlight.hlsl');
    const doc = makeDoc(
      shaderPath,
      ['#include_with_pragmas "Packages/fake/Foo.hlsl"', '#if defined(UNITY_PASS_SHADOWCASTER)', '#endif'].join('\n'),
      'hlsl',
    );
    const tokens = provider.provideDocumentSemanticTokens(doc);
    expect(tokens).toBeDefined();
    // Each semantic token is 5 ints: [deltaLine, deltaStartChar, length, tokenType, tokenModifiers]
    expect(tokens!.data.length).toBeGreaterThanOrEqual(10);
  });

  it('builds hierarchical SubShader -> Pass -> Function outline and resolves multiline/intrinsic signature help', () => {
    const ctx = createTempProject();
    const graph = new IncludeDependencyGraph(ctx);
    const symProvider = new ShaderDocumentSymbolProvider(graph);
    const sigProvider = new ShaderSignatureHelpProvider(graph);
    const shaderPath = path.join(ctx.projectRoot, 'Assets', 'Shaders', 'MultiPass.shader');
    const content = [
      'Shader "Custom/MultiPass"',
      '{',
      '    SubShader',
      '    {',
      '        Pass',
      '        {',
      '            Name "ForwardLit"',
      '            HLSLPROGRAM',
      '            float4 vert(float4 p : POSITION) : SV_POSITION',
      '            {',
      '                float s = sin(',
      '                    p.x',
      '                );',
      '                float l = lerp(',
      '                    0.0,',
      '                    1.0,',
      '                    0.5,',
      '                    0.0,',
      '                    0.0,',
      '                    s',
      '                );',
      '                return p;',
      '            }',
      '            ENDHLSL',
      '        }',
      '    }',
      '}',
    ].join('\n');
    const doc = makeDoc(shaderPath, content);

    const symbols = symProvider.provideDocumentSymbols(doc);
    expect(symbols.length).toBe(1);
    const subShader = symbols[0].children.find((c) => c.name.startsWith('SubShader'));
    expect(subShader).toBeDefined();
    const passNode = subShader?.children.find((c) => c.name === 'Pass "ForwardLit"');
    expect(passNode).toBeDefined();
    expect(passNode?.children.some((c) => c.name === 'vert')).toBe(true);

    const sinSig = sigProvider.provideSignatureHelp(doc, new vscode.Position(11, 20));
    expect(sinSig?.signatures[0]?.label).toContain('sin(T x)');

    const multilineLerp = sigProvider.provideSignatureHelp(doc, new vscode.Position(19, 21));
    expect(multilineLerp?.signatures[0]?.label).toContain('lerp(');
  });

  it('isolates local variable References and Rename to the enclosing function scope', () => {
    const ctx = createTempProject();
    const graph = new IncludeDependencyGraph(ctx);
    const refProvider = new ShaderReferenceProvider(graph);
    const renameProvider = new ShaderRenameProvider(graph);
    const hlslPath = path.join(ctx.projectRoot, 'Assets', 'Shaders', 'Scope.hlsl');
    const content = [
      'float4 funcA(float2 inUv)',
      '{',
      '    float2 uv = inUv * 2.0;',
      '    return float4(uv, 0.0, 1.0);',
      '}',
      'float4 funcB(float2 inUv)',
      '{',
      '    float2 uv = inUv * 0.5;',
      '    return float4(uv, 0.0, 1.0);',
      '}',
    ].join('\n');
    const doc = makeDoc(hlslPath, content, 'hlsl');

    const refs = refProvider.provideReferences(doc, new vscode.Position(2, 12));
    expect(refs.length).toBe(2);
    expect(refs.every((r) => r.range.start.line <= 4)).toBe(true);

    const edit = renameProvider.provideRenameEdits(doc, new vscode.Position(2, 12), 'uvScaled');
    const edits = edit?.get(doc.uri) ?? [];
    expect(edits.length).toBe(2);
    expect(edits.every((e) => e.range.start.line <= 4)).toBe(true);
  });

  it('reports missing #pragma vertex, unclosed HLSLPROGRAM, brace mismatch, and SRP Batcher CBUFFER omissions', () => {
    const ctx = createTempProject();
    const graph = new IncludeDependencyGraph(ctx);
    const shaderPath = path.join(ctx.projectRoot, 'Assets', 'Shaders', 'Broken.shader');
    const content = [
      'Shader "Custom/Broken"',
      '{',
      '    Properties',
      '    {',
      '        _MissingInCBuffer ("Missing", Float) = 1.0',
      '    }',
      '    SubShader',
      '    {',
      '        Pass',
      '        {',
      '            HLSLPROGRAM',
      '            #pragma vertex MissingVert',
      '            CBUFFER_START(UnityPerMaterial)',
      '                float _Other;',
      '            CBUFFER_END',
      '        }',
      '    }',
      '}',
    ].join('\n');
    const doc = makeDoc(shaderPath, content);
    const diags = collectComputeAndShaderLabDiagnostics(doc, graph);

    expect(diags.some((d) => d.message.includes('MissingVert'))).toBe(true);
    expect(diags.some((d) => d.message.includes('ENDHLSL'))).toBe(true);
    expect(diags.some((d) => d.message.includes('_MissingInCBuffer'))).toBe(true);
  });

  it('formats ShaderLab/HLSL idempotently and populates ShaderExplorer & LiveTest', () => {
    const ctx = createTempProject();
    const shaderPath = path.join(ctx.projectRoot, 'Assets', 'Shaders', 'Good.shader');
    const raw = 'Shader "Custom/Good"\n{\nProperties\n{\n_Color ("Color", Color) = (1,1,1,1)\n}\nSubShader\n{\nPass\n{\nHLSLPROGRAM\n#pragma multi_compile _ _FOG_ON\nfloat4 vert() : SV_POSITION { return 0; }\nENDHLSL\n}\n}\n}\n';
    const formatted1 = formatShaderText(raw, { tabSize: 4, insertSpaces: true });
    const formatted2 = formatShaderText(formatted1, { tabSize: 4, insertSpaces: true });
    expect(formatted1).toBe(formatted2);
    expect(formatted1).toContain('    Properties');
    expect(formatted1).toContain('        _Color ("Color", Color) = (1,1,1,1)');

    fs.writeFileSync(shaderPath, formatted1, 'utf8');
    const graph = new IncludeDependencyGraph(ctx);

    const doc = makeDoc(shaderPath, formatted1);
    const live = runShaderLiveTest(doc, graph);
    expect(live.errorCount).toBe(0);
    expect(live.totalVariants).toBe(2);
    expect(live.performance.loadGrade).toBe('LOW');

    const heavyText = [
      'for (int i = 0; i < 8; i++) {',
      '    half4 c = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, uv);',
      '    float s = sin(c.x) + pow(c.y, 2.0);',
      '}',
    ].join('\n');
    const heavyPerf = analyzeShaderPerformance(heavyText);
    expect(heavyPerf.loadGrade).toBe('CRITICAL');
    expect(heavyPerf.textureSampleInLoopCount).toBe(1);
    expect(heavyPerf.heavyReasons.some((r) => r.includes('반복문'))).toBe(true);

    const fmtProvider = new ShaderFormattingProvider();
    const unindentedDoc = makeDoc(shaderPath, 'Shader "A"\n{\n        }');
    const onTypeEdits = fmtProvider.provideOnTypeFormattingEdits(
      unindentedDoc,
      new vscode.Position(2, 9),
      '}',
      { tabSize: 4, insertSpaces: true },
    );
    expect(onTypeEdits.length).toBe(1);
    expect(onTypeEdits[0].newText).toBe('}');
  });

  it('finds and renames both struct field declaration and .field accesses when cursor is on declaration (P1-S4)', () => {
    const ctx = createTempProject();
    const graph = new IncludeDependencyGraph(ctx);
    const refProvider = new ShaderReferenceProvider(graph);
    const renameProvider = new ShaderRenameProvider(graph);
    const hlslPath = path.join(ctx.projectRoot, 'Assets', 'Shaders', 'StructFieldRefs.hlsl');
    const content = [
      'struct Varyings',
      '{',
      '    float2 uv : TEXCOORD0;',
      '};',
      'float4 frag(Varyings i, float2 uv) : SV_Target',
      '{',
      '    float2 sampleUv = i.uv + uv;',
      '    return float4(sampleUv, 0.0, 1.0);',
      '}',
    ].join('\n');
    const doc = makeDoc(hlslPath, content, 'hlsl');

    // Cursor on `uv` inside `float2 uv : TEXCOORD0;` (line 2, col 11)
    const declPos = new vscode.Position(2, 11);
    const refsFromDecl = refProvider.provideReferences(doc, declPos);
    expect(refsFromDecl.map((r) => ({ line: r.range.start.line, col: r.range.start.character }))).toEqual([
      { line: 2, col: 11 },
      { line: 6, col: 24 },
    ]);

    // Symmetric with cursor on `i.uv` (line 6, col 24)
    const dotPos = new vscode.Position(6, 24);
    const refsFromDot = refProvider.provideReferences(doc, dotPos);
    expect(refsFromDot.map((r) => ({ line: r.range.start.line, col: r.range.start.character }))).toEqual([
      { line: 2, col: 11 },
      { line: 6, col: 24 },
    ]);

    const renameEdit = renameProvider.provideRenameEdits(doc, declPos, 'texcoord');
    const edits = renameEdit?.get(doc.uri) ?? [];
    expect(edits.map((e) => ({ line: e.range.start.line, col: e.range.start.character }))).toEqual([
      { line: 2, col: 11 },
      { line: 6, col: 24 },
    ]);
  });

  it('updates brace depth when code follows closing block comment on the same line (P1-S5)', () => {
    const raw = [
      '/*',
      '* header comment',
      '*/ void foo() {',
      'return 0;',
      '/* closing',
      '*/ }',
    ].join('\n');

    const formatted = formatShaderText(raw, { tabSize: 4, insertSpaces: true });
    expect(formatted).toBe([
      '/*',
      '* header comment',
      '*/ void foo() {',
      '    return 0;',
      '    /* closing',
      '*/ }',
    ].join('\n'));
  });

  it('disambiguates struct field References, Rename, and DocumentHighlight across structs sharing field names (Step8SurfaceDemo pattern)', () => {
    const ctx = createTempProject();
    const graph = new IncludeDependencyGraph(ctx);
    const refProvider = new ShaderReferenceProvider(graph);
    const renameProvider = new ShaderRenameProvider(graph);
    const highlightProvider = new ShaderDocumentHighlightProvider(graph);
    const shaderPath = path.join(ctx.projectRoot, 'Assets', 'Shaders', 'Step8SurfaceDemo.shader');
    const content = [
      'Shader "UnityBrain/Step8SurfaceDemo"',
      '{',
      '    SubShader',
      '    {',
      '        Pass',
      '        {',
      '            HLSLPROGRAM',
      '            #pragma vertex Vert',
      '            #pragma fragment Frag',
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
      '                output.positionHCS = float4(input.positionOS.xyz, 1.0);',
      '                output.texcoord = input.texcoord;',
      '                return output;',
      '            }',
      '            half4 Frag(Step8Varyings input) : SV_Target',
      '            {',
      '                half4 sampled = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, input.texcoord);',
      '                half rChannel = _MainTex.Sample(sampler_MainTex, input.texcoord).r;',
      '                return sampled * rChannel;',
      '            }',
      '            ENDHLSL',
      '        }',
      '    }',
      '}',
    ].join('\n');
    const doc = makeDoc(shaderPath, content);
    const lines = content.split('\n');

    const attrTexLine = lines.findIndex((l, idx) => idx < 15 && l.includes('float2 texcoord'));
    const attrTexCol = lines[attrTexLine].indexOf('texcoord');
    const varyTexLine = lines.findIndex((l, idx) => idx > 15 && l.includes('float2 texcoord'));
    const varyTexCol = lines[varyTexLine].indexOf('texcoord');
    const vertAssignLine = lines.findIndex((l) => l.includes('output.texcoord = input.texcoord;'));
    const vertOutCol = lines[vertAssignLine].indexOf('texcoord');
    const vertInCol = lines[vertAssignLine].lastIndexOf('texcoord');
    const fragSampleLine1 = lines.findIndex((l) => l.includes('SAMPLE_TEXTURE2D'));
    const fragSampleCol1 = lines[fragSampleLine1].indexOf('texcoord');
    const fragSampleLine2 = lines.findIndex((l) => l.includes('_MainTex.Sample'));
    const fragSampleCol2 = lines[fragSampleLine2].indexOf('texcoord');

    const expectedAttrCoords = [
      { line: attrTexLine, col: attrTexCol },
      { line: vertAssignLine, col: vertInCol },
    ];
    const expectedVaryCoords = [
      { line: varyTexLine, col: varyTexCol },
      { line: vertAssignLine, col: vertOutCol },
      { line: fragSampleLine1, col: fragSampleCol1 },
      { line: fragSampleLine2, col: fragSampleCol2 },
    ];

    const toCoords = (locs: Array<{ range: vscode.Range }>) =>
      locs.map((l) => ({ line: l.range.start.line, col: l.range.start.character }));

    // 1. References & Rename on Step8Attributes.texcoord (decl + Vert input.texcoord) -> ONLY 2 locations
    for (const pos of [
      new vscode.Position(attrTexLine, attrTexCol + 2),
      new vscode.Position(vertAssignLine, vertInCol + 2),
    ]) {
      const refs = refProvider.provideReferences(doc, pos);
      expect(toCoords(refs)).toEqual(expectedAttrCoords);

      const edit = renameProvider.provideRenameEdits(doc, pos, 'uvIn');
      expect(toCoords(edit?.get(doc.uri) ?? [])).toEqual(expectedAttrCoords);

      const highlights = highlightProvider.provideDocumentHighlights(doc, pos);
      expect(toCoords(highlights)).toEqual(expectedAttrCoords);
      expect(highlights.every((h) => h.kind === vscode.DocumentHighlightKind.Read)).toBe(true);
    }

    // 2. References & Rename & Highlight on Step8Varyings.texcoord (decl + output.texcoord + Frag 2x input.texcoord) -> ONLY 4 locations
    for (const pos of [
      new vscode.Position(varyTexLine, varyTexCol + 2),
      new vscode.Position(vertAssignLine, vertOutCol + 2),
      new vscode.Position(fragSampleLine1, fragSampleCol1 + 2),
      new vscode.Position(fragSampleLine2, fragSampleCol2 + 2),
    ]) {
      const refs = refProvider.provideReferences(doc, pos);
      expect(toCoords(refs)).toEqual(expectedVaryCoords);

      const edit = renameProvider.provideRenameEdits(doc, pos, 'uvOut');
      expect(toCoords(edit?.get(doc.uri) ?? [])).toEqual(expectedVaryCoords);

      const highlights = highlightProvider.provideDocumentHighlights(doc, pos);
      expect(toCoords(highlights)).toEqual(expectedVaryCoords);
      expect(highlights.find((h) => h.range.start.line === vertAssignLine)?.kind).toBe(
        vscode.DocumentHighlightKind.Write,
      );
    }

    // 3. DocumentHighlight isolates Vert's `input` parameter from Frag's `input` parameter
    const vertFnLine = lines.findIndex((l) => l.includes('Step8Varyings Vert('));
    const vertParamCol = lines[vertFnLine].indexOf('input');
    const fragFnLine = lines.findIndex((l) => l.includes('half4 Frag('));
    const fragParamCol = lines[fragFnLine].indexOf('input');

    const vertInputHighlights = highlightProvider.provideDocumentHighlights(
      doc,
      new vscode.Position(vertFnLine, vertParamCol + 1),
    );
    expect(vertInputHighlights.length).toBe(3);
    expect(vertInputHighlights.every((h) => h.range.start.line >= vertFnLine && h.range.start.line < fragFnLine)).toBe(
      true,
    );

    const fragInputHighlights = highlightProvider.provideDocumentHighlights(
      doc,
      new vscode.Position(fragFnLine, fragParamCol + 1),
    );
    expect(fragInputHighlights.length).toBe(3);
    expect(fragInputHighlights.every((h) => h.range.start.line >= fragFnLine)).toBe(true);
  });

  it('disambiguates struct field References across included HLSL files', () => {
    const ctx = createTempProject();
    const includePath = path.join(ctx.projectRoot, 'Assets', 'Shaders', 'CommonStructs.hlsl');
    const includeContent = [
      'struct SharedInput',
      '{',
      '    float2 texcoord : TEXCOORD0;',
      '};',
      'struct OtherStruct',
      '{',
      '    float2 texcoord : TEXCOORD1;',
      '};',
    ].join('\n');
    fs.writeFileSync(includePath, includeContent, 'utf8');

    const shaderPath = path.join(ctx.projectRoot, 'Assets', 'Shaders', 'CrossFileField.shader');
    const shaderContent = [
      'Shader "Custom/CrossFileField"',
      '{',
      '    SubShader',
      '    {',
      '        Pass',
      '        {',
      '            HLSLPROGRAM',
      '            #include "CommonStructs.hlsl"',
      '            float2 useIt(SharedInput a, OtherStruct b)',
      '            {',
      '                return a.texcoord + b.texcoord;',
      '            }',
      '            ENDHLSL',
      '        }',
      '    }',
      '}',
    ].join('\n');
    fs.writeFileSync(shaderPath, shaderContent, 'utf8');

    const graph = new IncludeDependencyGraph(ctx);
    const refProvider = new ShaderReferenceProvider(graph);
    const renameProvider = new ShaderRenameProvider(graph);
    const shaderDoc = makeDoc(shaderPath, shaderContent);
    const useLine = shaderContent.split('\n').findIndex((l) => l.includes('a.texcoord + b.texcoord'));
    const aTexCol = shaderContent.split('\n')[useLine].indexOf('texcoord');

    const refs = refProvider.provideReferences(shaderDoc, new vscode.Position(useLine, aTexCol + 2));
    expect(refs.length).toBe(2);
    expect(refs.some((r) => path.basename(r.uri.fsPath) === 'CommonStructs.hlsl' && r.range.start.line === 2)).toBe(
      true,
    );
    expect(refs.some((r) => path.basename(r.uri.fsPath) === 'CommonStructs.hlsl' && r.range.start.line === 6)).toBe(
      false,
    );
    expect(refs.some((r) => path.basename(r.uri.fsPath) === 'CrossFileField.shader' && r.range.start.line === useLine && r.range.start.character === aTexCol)).toBe(
      true,
    );

    const renameEdit = renameProvider.provideRenameEdits(shaderDoc, new vscode.Position(useLine, aTexCol + 2), 'uv0');
    const includeUri = vscode.Uri.file(includePath);
    expect(renameEdit?.get(includeUri)?.map((e) => e.range.start.line)).toEqual([2]);
    expect(renameEdit?.get(shaderDoc.uri)?.map((e) => e.range.start.character)).toEqual([aTexCol]);
  });
});
