import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { IncludeDependencyGraph } from '../../../shader-lsp/src/indexer/hlslIncludeGraph.ts';
import {
  ShaderDocumentHighlightProvider,
  ShaderDocumentSymbolProvider,
  ShaderReferenceProvider,
  ShaderSemanticTokensProvider,
  ShaderSignatureHelpProvider,
  SHADER_SEMANTIC_TOKEN_MODIFIERS,
  SHADER_SEMANTIC_TOKEN_TYPES,
} from '../../src/shader/shaderEditorProviders.ts';
import {
  analyzeShaderVariants,
  evaluateInactivePreprocessorRanges,
  ShaderKeywordContextStatusBar,
  ShaderVariantCodeLensProvider,
} from '../../src/shader/shaderKeywordContextStatusBar.ts';

afterEach(() => {
  vscode.__mock.reset();
});

describe('ShaderKeywordContextStatusBar & ShaderVariantCodeLensProvider', () => {
  it('calculates combinatorial variant counts across HLSLINCLUDE and multiple Passes', () => {
    const shaderSource = [
      'Shader "Custom/TestCharacter" {',
      '  SubShader {',
      '    HLSLINCLUDE',
      '    #pragma multi_compile_fog',
      '    ENDHLSL',
      '    Pass {',
      '      HLSLPROGRAM',
      '      #pragma multi_compile _ KEY_A KEY_B',
      '      #pragma shader_feature _RIM_LIGHT',
      '      ENDHLSL',
      '    }',
      '    Pass {',
      '      HLSLPROGRAM',
      '      #pragma shader_feature_local _NORMALMAP _SPECGLOSS',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const analysis = analyzeShaderVariants(shaderSource);
    expect(analysis.blocks.length).toBe(2);
    // Block 1: 2 (fog) * 3 (_, KEY_A, KEY_B) * 2 (_, _RIM_LIGHT) = 12
    expect(analysis.blocks[0].variantCount).toBe(12);
    // Block 2: 2 (fog) * 2 (_NORMALMAP, _SPECGLOSS) = 4
    expect(analysis.blocks[1].variantCount).toBe(4);
    expect(analysis.totalVariants).toBe(16);
    expect(analysis.allKeywords).toContain('KEY_A');
    expect(analysis.allKeywords).toContain('_RIM_LIGHT');
    expect(analysis.allKeywords).toContain('_NORMALMAP');
  });

  it('emits variant CodeLens with high-variant warning above 128 variants', () => {
    const lines = ['Shader "Custom/Heavy" {', '  SubShader {', '    Pass {', '      HLSLPROGRAM'];
    for (let i = 0; i < 8; i++) {
      lines.push(`      #pragma multi_compile _ FEATURE_${i}`);
    }
    lines.push('      ENDHLSL', '    }', '  }', '}');

    const doc = vscode.__mock.createTextDocument(
      vscode.Uri.file('Assets/Shaders/Heavy.shader'),
      lines.join('\n'),
      'unity-shaderlab',
    );

    const provider = new ShaderVariantCodeLensProvider();
    const lenses = provider.provideCodeLenses(doc);
    expect(lenses.length).toBe(1);
    expect(lenses[0].command?.title).toBe('$(layers) [UnityBrain] 셰이더 배리언트 256개 (배리언트 과다 주의!)');
    expect(lenses[0].command?.command).toBe('unityBrain.switchShaderKeywords');
    provider.dispose();
  });

  it('updates status bar text and invokes callback on unityBrain.switchShaderKeywords', async () => {
    const shaderUri = vscode.Uri.file('Assets/Shaders/LitCustom.shader');
    const shaderDoc = vscode.__mock.createTextDocument(
      shaderUri,
      [
        'Shader "Custom/Lit" {',
        '  SubShader {',
        '    Pass {',
        '      HLSLPROGRAM',
        '      #pragma shader_feature _ALPHATEST_ON',
        '      #pragma multi_compile _ _EMISSION',
        '      ENDHLSL',
        '    }',
        '  }',
        '}',
      ].join('\n'),
      'unity-shaderlab',
    );

    await vscode.window.showTextDocument(shaderDoc);

    const events: Array<{ uri?: string; keywords: string[] }> = [];
    const statusBar = new ShaderKeywordContextStatusBar({
      onKeywordsChanged: (uri, keywords) => {
        events.push({ uri: uri?.toString(), keywords });
      },
    });

    try {
      expect(statusBar.getStatusBarItem().text).toBe('$(symbol-keyword) [UnityBrain] 셰이더 키워드: (기본값)');

      await vscode.commands.executeCommand('unityBrain.switchShaderKeywords');
      expect(events.length).toBe(1);
      expect(events[0].keywords).toEqual(['_ALPHATEST_ON']);
      expect(statusBar.getStatusBarItem().text).toBe(
        '$(symbol-keyword) [UnityBrain] 셰이더 키워드: _ALPHATEST_ON',
      );

      await vscode.commands.executeCommand('unityBrain.switchShaderKeywords', [
        '_ALPHATEST_ON',
        '_EMISSION',
      ]);
      expect(events.length).toBe(2);
      expect(events[1].keywords).toEqual(['_ALPHATEST_ON', '_EMISSION']);
      expect(statusBar.getStatusBarItem().text).toBe(
        '$(symbol-keyword) [UnityBrain] 셰이더 키워드: _ALPHATEST_ON, _EMISSION',
      );
    } finally {
      statusBar.dispose();
    }
  });

  it('evaluates inactive preprocessor branches and dims based on active keywords', () => {
    const code = [
      '#pragma shader_feature _ALPHATEST_ON',
      '#ifdef _ALPHATEST_ON',
      '  clip(albedo.a - _Cutoff);',
      '#else',
      '  // opaque path',
      '#endif',
      '#ifndef GUARD_H',
      '#define GUARD_H',
      '  half4 Helper() { return 1; }',
      '#endif',
    ].join('\n');

    const defaultInactive = evaluateInactivePreprocessorRanges(code, new Set());
    expect(defaultInactive).toEqual([{ startLine: 2, endLine: 2 }]);

    const alphaActiveInactive = evaluateInactivePreprocessorRanges(code, new Set(['_ALPHATEST_ON']));
    expect(alphaActiveInactive).toEqual([{ startLine: 4, endLine: 4 }]);
  });

  it('provides Outline, SignatureHelp, DocumentHighlight, References, and clean SemanticTokens for shaders', () => {
    const projectRoot = path.resolve(process.cwd(), 'test-fixtures', 'SampleUnityProject');
    const graph = new IncludeDependencyGraph({
      projectRoot,
      editorVersion: '6000.0.23f1',
      editorInstallPath: null,
      cgIncludesPath: null,
      builtInPackagesPath: null,
      manifestPath: path.join(projectRoot, 'Packages', 'manifest.json'),
      packagesLockPath: null,
      cacheDir: path.join(projectRoot, 'Library', 'UnityBrainCache'),
    });

    const shaderText = [
      'Shader "Test/OutlineAndSig" {',
      '  Properties { _Color ("Color", Color) = (1,1,1,1) }',
      '  SubShader { Pass {',
      '    Name "Forward"',
      '    HLSLPROGRAM',
      '    #pragma vertex Vert',
      '    #pragma shader_feature _RIM_ON',
      '    struct Varyings { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };',
      '    float4 ComputeTint(float4 a, float b) { return a * b; }',
      '    Varyings Vert(float3 Name) {',
      '      Varyings o;',
      '      o.pos = ComputeTint(_Color, 0.5);',
      '      return o;',
      '    }',
      '    ENDHLSL',
      '  } }',
      '}',
    ].join('\n');

    const doc = vscode.__mock.createTextDocument(
      vscode.Uri.file(path.join(projectRoot, 'Assets', 'Shaders', 'InlineTest.shader')),
      shaderText,
      'unity-shaderlab',
    );

    const symProvider = new ShaderDocumentSymbolProvider(graph);
    const symbols = symProvider.provideDocumentSymbols(doc);
    expect(symbols.length).toBe(1);
    expect(symbols[0].name).toBe('Shader "Test/OutlineAndSig"');
    const varyingsSym = symbols[0].children.find((c) => c.name === 'Varyings');
    expect(varyingsSym?.children.map((c) => c.name)).toContain('uv');

    const sigProvider = new ShaderSignatureHelpProvider(graph);
    const callLine = shaderText.split('\n').findIndex((l) => l.includes('ComputeTint(_Color, 0.5)'));
    const commaCol = shaderText.split('\n')[callLine].indexOf(', ') + 2;
    const sigHelp = sigProvider.provideSignatureHelp(doc, new vscode.Position(callLine, commaCol));
    expect(sigHelp?.signatures[0].label).toContain('ComputeTint');
    expect(sigHelp?.activeParameter).toBe(1);

    const hlProvider = new ShaderDocumentHighlightProvider();
    const hlCol = shaderText.split('\n')[callLine].indexOf('ComputeTint') + 2;
    const highlights = hlProvider.provideDocumentHighlights(doc, new vscode.Position(callLine, hlCol));
    expect(highlights.length).toBe(2);

    const refProvider = new ShaderReferenceProvider(graph);
    const refs = refProvider.provideReferences(doc, new vscode.Position(callLine, hlCol));
    expect(refs.length).toBe(2);

    const legend = new vscode.SemanticTokensLegend(
      [...SHADER_SEMANTIC_TOKEN_TYPES],
      [...SHADER_SEMANTIC_TOKEN_MODIFIERS],
    );
    const semProvider = new ShaderSemanticTokensProvider(graph, legend);
    const semTokens = semProvider.provideDocumentSemanticTokens(doc);
    expect(semTokens && semTokens.data.length > 0).toBe(true);
  });
});
