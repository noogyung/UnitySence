import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { activate, deactivate } from '../../src/extension.ts';
import { CompletionItemKind } from 'vscode-languageserver';
import { IncludeDependencyGraph } from '../../../shader-lsp/src/indexer/hlslIncludeGraph.ts';
import { parseShaderPragmas } from '../../../shader-lsp/src/parser/shaderLabVirtualDoc.ts';
import {
  UNITY_BUILTIN_MACROS,
  UnityHlslMacroPrepass,
} from '../../../shader-lsp/src/parser/unityHlslMacroPrepass.ts';
import { ShaderCompletionProvider } from '../../../shader-lsp/src/providers/completionProvider.ts';
import { ShaderHoverProvider } from '../../../shader-lsp/src/providers/hoverProvider.ts';
import {
  collectComputeAndShaderLabDiagnostics,
  ShaderDocumentColorProvider,
  ShaderDocumentHighlightProvider,
  ShaderDocumentSymbolProvider,
  ShaderFoldingRangeProvider,
  ShaderReferenceProvider,
  ShaderRenameProvider,
  ShaderSemanticTokensProvider,
  ShaderSignatureHelpProvider,
  SHADER_SEMANTIC_TOKEN_MODIFIERS,
  SHADER_SEMANTIC_TOKEN_TYPES,
} from '../../src/shader/shaderEditorProviders.ts';
import {
  analyzeShaderVariants,
  buildShaderPreprocessorKeywordCompletions,
  evaluateInactivePreprocessorRanges,
  ShaderKeywordContextStatusBar,
  ShaderVariantCodeLensProvider,
} from '../../src/shader/shaderKeywordContextStatusBar.ts';

const tempDirs: string[] = [];

afterEach(() => {
  deactivate();
  vscode.__mock.reset();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
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
    const findSymbol = (nodes: vscode.DocumentSymbol[], targetName: string): vscode.DocumentSymbol | undefined => {
      for (const n of nodes) {
        if (n.name === targetName) return n;
        const nested = findSymbol(n.children, targetName);
        if (nested) return nested;
      }
      return undefined;
    };
    const varyingsSym = findSymbol(symbols[0].children, 'Varyings');
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

    // FoldingRange, ColorPicker, Rename, Compute & ShaderLab diagnostics
    const foldProvider = new ShaderFoldingRangeProvider();
    const folds = foldProvider.provideFoldingRanges(doc);
    expect(folds.length).toBeGreaterThanOrEqual(4);

    const colorProvider = new ShaderDocumentColorProvider();
    const colors = colorProvider.provideDocumentColors(doc);
    expect(colors.length).toBe(1);
    expect(colorProvider.provideColorPresentations(colors[0].color)[0].label).toBe('(1, 1, 1, 1)');

    const renameProvider = new ShaderRenameProvider(graph);
    const renameEdit = renameProvider.provideRenameEdits(doc, new vscode.Position(callLine, hlCol), 'TintColor');
    expect(renameEdit?.entries()[0][1].length).toBe(2);

    const computeDoc = vscode.__mock.createTextDocument(
      vscode.Uri.file(path.join(projectRoot, 'Assets', 'Shaders', 'BadCompute.compute')),
      [
        '#pragma kernel MissingKernel',
        '[numthreads(32, 32, 2)]',
        'void OtherKernel() {}',
      ].join('\n'),
      'hlsl',
    );
    const compDiags = collectComputeAndShaderLabDiagnostics(computeDoc, graph);
    expect(compDiags.some((d) => d.message.includes('MissingKernel'))).toBe(true);
    expect(compDiags.some((d) => d.message.includes('1024'))).toBe(true);

    const badRenderStateDoc = vscode.__mock.createTextDocument(
      vscode.Uri.file(path.join(projectRoot, 'Assets', 'Shaders', 'BadState.shader')),
      'Shader "Bad/State" { SubShader { Pass { Cull Bogus\n HLSLPROGRAM\n ENDHLSL } } }',
      'unity-shaderlab',
    );
    const stateDiags = collectComputeAndShaderLabDiagnostics(badRenderStateDoc, graph);
    expect(stateDiags.some((d) => d.message.includes('Cull'))).toBe(true);

    // Commented out [numthreads(32, 32, 2)] must NOT produce diagnostics
    const commentedComputeDoc = vscode.__mock.createTextDocument(
      vscode.Uri.file(path.join(projectRoot, 'Assets', 'Shaders', 'OkCompute.compute')),
      [
        '#pragma kernel CSMain',
        '// [numthreads(32, 32, 2)]',
        '[numthreads(8, 8, 1)]',
        'void CSMain() {}',
      ].join('\n'),
      'hlsl',
    );
    const okDiags = collectComputeAndShaderLabDiagnostics(commentedComputeDoc, graph);
    expect(okDiags.length).toBe(0);
  });

  it('toggles shader preprocessor keywords On/Off via Ctrl+Space completions on #if defined(...) and #pragma lines', async () => {
    const shaderUri = vscode.Uri.file('Assets/Shaders/Step8RimDemo.shader');
    const shaderText = [
      'Shader "UnityBrain/RimDemo" {',
      '  SubShader {',
      '    Pass {',
      '      HLSLPROGRAM',
      '      #pragma shader_feature_local _RIM_LIGHT_ON',
      '      half4 Frag() : SV_Target {',
      '        half4 col = 1;',
      '        #if defined(_RIM_LIGHT_ON) \\',
      '            || defined(STEP8_FORCE_RIM)',
      '        col = col * 2.0;',
      '        #endif',
      '        return col;',
      '      }',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const doc = vscode.__mock.createTextDocument(shaderUri, shaderText, 'unity-shaderlab');
    await vscode.window.showTextDocument(doc);

    const statusBar = new ShaderKeywordContextStatusBar();
    try {
      const lines = shaderText.split('\n');
      const pragmaLine = lines.findIndex((l) => l.includes('#pragma shader_feature_local _RIM_LIGHT_ON'));
      const ifLine = lines.findIndex((l) => l.includes('#if defined(_RIM_LIGHT_ON)'));
      const contLine = lines.findIndex((l) => l.includes('|| defined(STEP8_FORCE_RIM)'));
      const codeLine = lines.findIndex((l) => l.includes('half4 col = 1;'));

      // Non-preprocessor line returns null
      expect(
        buildShaderPreprocessorKeywordCompletions(
          doc,
          new vscode.Position(codeLine, lines[codeLine].indexOf('col')),
          statusBar,
        ),
      ).toBeNull();

      // Initially OFF: #if body (line 9: `col = col * 2.0;`) is dimmed
      expect(evaluateInactivePreprocessorRanges(shaderText, new Set(statusBar.getActiveKeywords(shaderUri)))).toEqual([
        { startLine: ifLine + 2, endLine: ifLine + 2 },
      ]);

      // 1. Ctrl+Space inside `_RIM_LIGHT_ON` on `#if defined(_RIM_LIGHT_ON) \`
      const rimCol = lines[ifLine].indexOf('_RIM_LIGHT_ON') + 4;
      const offItems = buildShaderPreprocessorKeywordCompletions(
        doc,
        new vscode.Position(ifLine, rimCol),
        statusBar,
      );
      expect(offItems).not.toBeNull();
      expect(offItems!.length).toBe(4);
      const firstToggleOn = offItems![0];
      expect(String(firstToggleOn.label)).toContain('[ON] _RIM_LIGHT_ON');
      expect(firstToggleOn.preselect).toBe(true);
      expect(firstToggleOn.insertText).toBe('_RIM_LIGHT_ON');
      expect(firstToggleOn.filterText).toContain('_RIM_LIGHT_ON');
      expect(firstToggleOn.command?.command).toBe('unityBrain.toggleShaderKeyword');

      await vscode.commands.executeCommand(
        firstToggleOn.command!.command,
        ...(firstToggleOn.command!.arguments ?? []),
      );

      expect(statusBar.getActiveKeywords(shaderUri)).toEqual(['_RIM_LIGHT_ON']);
      expect(statusBar.getStatusBarItem().text).toBe(
        '$(symbol-keyword) [UnityBrain] 셰이더 키워드: _RIM_LIGHT_ON',
      );
      expect(
        evaluateInactivePreprocessorRanges(shaderText, new Set(statusBar.getActiveKeywords(shaderUri))),
      ).toEqual([]);

      // 2. Ctrl+Space again when ON: preselects `[OFF] _RIM_LIGHT_ON` and preserves `#pragma` / continuation support
      const pragmaItems = buildShaderPreprocessorKeywordCompletions(
        doc,
        new vscode.Position(pragmaLine, lines[pragmaLine].indexOf('_RIM_LIGHT_ON') + 2),
        statusBar,
      );
      expect(String(pragmaItems![0].label)).toContain('[OFF] _RIM_LIGHT_ON');

      const contItems = buildShaderPreprocessorKeywordCompletions(
        doc,
        new vscode.Position(contLine, lines[contLine].indexOf('STEP8_FORCE_RIM') + 2),
        statusBar,
      );
      expect(String(contItems![0].label)).toContain('[ON] STEP8_FORCE_RIM');

      const onItems = buildShaderPreprocessorKeywordCompletions(
        doc,
        new vscode.Position(ifLine, rimCol),
        statusBar,
      );
      const firstToggleOff = onItems![0];
      expect(String(firstToggleOff.label)).toContain('[OFF] _RIM_LIGHT_ON');
      expect(firstToggleOff.preselect).toBe(true);

      await vscode.commands.executeCommand(
        firstToggleOff.command!.command,
        ...(firstToggleOff.command!.arguments ?? []),
      );

      expect(statusBar.getActiveKeywords(shaderUri)).toEqual([]);
      expect(statusBar.getStatusBarItem().text).toBe(
        '$(symbol-keyword) [UnityBrain] 셰이더 키워드: (기본값)',
      );
      expect(
        evaluateInactivePreprocessorRanges(shaderText, new Set(statusBar.getActiveKeywords(shaderUri))),
      ).toEqual([{ startLine: ifLine + 2, endLine: ifLine + 2 }]);
    } finally {
      statusBar.dispose();
    }
  });

  it('supports Unity 6 #include_with_pragmas, #pragma dynamic_branch_local, SAMPLE_TEXTURE2D/DOTS swizzle completion & hover, #if defined hover (ON/OFF), and local var/param completion', async () => {
    const projectRoot = path.resolve(process.cwd(), 'test-fixtures', 'SampleUnityProject');
    const graph = new IncludeDependencyGraph({
      projectRoot,
      editorVersion: '6000.0.23f1',
      editorInstallPath: null,
      cgIncludesPath: null,
      builtInPackagesPath: null,
      manifestPath: path.join(projectRoot, 'Packages', 'manifest.json'),
      packagesLockPath: path.join(projectRoot, 'Packages', 'packages-lock.json'),
      cacheDir: path.join(projectRoot, 'Library', 'UnityBrainCache'),
    });
    const completionProvider = new ShaderCompletionProvider(graph);
    const hoverProvider = new ShaderHoverProvider(graph);

    const shaderPath = path.join(projectRoot, 'Assets', 'Shaders', 'Unity6SrpFeatures.shader');
    const shaderUri = pathToFileURL(shaderPath).toString();
    const shaderText = [
      'Shader "UnityBrain/Unity6SrpFeatures" {',
      '  Properties {',
      '    _BaseMap ("Base Map", 2D) = "white" {}',
      '    _DotsTint ("DOTS Tint", Color) = (1,1,1,1)',
      '  }',
      '  SubShader { Pass {',
      '    HLSLPROGRAM',
      '    #pragma vertex Vert',
      '    #pragma fragment Frag',
      '    #pragma dynamic_branch_local _DETAIL_ALBEDO_ON',
      '    #include_with_pragmas "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"',
      '    TEXTURE2D(_BaseMap);',
      '    SAMPLER(sampler_BaseMap);',
      '    UNITY_DOTS_INSTANCING_START(MaterialPropertyMetadata)',
      '      UNITY_DOTS_INSTANCED_PROP(float4, _DotsTint)',
      '    UNITY_DOTS_INSTANCING_END(MaterialPropertyMetadata)',
      '    struct Varyings {',
      '      float4 positionCS : SV_POSITION;',
      '      float2 uv : TEXCOORD0;',
      '    };',
      '    half4 Frag(Varyings input, float fadeWeight) : SV_Target {',
      '      half4 col = SAMPLE_TEXTURE2D(_BaseMap, sampler_BaseMap, input.uv);',
      '      float3 sampledRgb = SAMPLE_TEXTURE2D(_BaseMap, sampler_BaseMap, input.uv).rgb;',
      '      float3 dotsRgb = UNITY_ACCESS_DOTS_INSTANCED_PROP_WITH_DEFAULT(float4, _DotsTint).rgb;',
      '      #if defined(_DETAIL_ALBEDO_ON)',
      '      sampledRgb *= dotsRgb;',
      '      #endif',
      '      float2 uvCheck = input.uv;',
      '      float laterDeclared = 1.0;',
      '      return half4(sampledRgb * fadeWeight, col.a);',
      '    }',
      '    ENDHLSL',
      '  } }',
      '}',
    ].join('\n');

    const lines = shaderText.split('\n');
    const dynPragmaLine = lines.findIndex((l) => l.includes('#pragma dynamic_branch_local'));
    const sampledRgbLine = lines.findIndex((l) => l.includes('float3 sampledRgb ='));
    const dotsAccessLine = lines.findIndex((l) => l.includes('float3 dotsRgb ='));
    const ifDefLine = lines.findIndex((l) => l.includes('#if defined(_DETAIL_ALBEDO_ON)'));
    const uvCheckLine = lines.findIndex((l) => l.includes('float2 uvCheck ='));
    const returnLine = lines.findIndex((l) => l.includes('return half4(sampledRgb'));

    // 1. Unity 6 #include_with_pragmas graph traversal & path completion
    graph.setOpenDocumentContent(shaderUri, shaderText);
    const walk = graph.collectReachableFiles(shaderPath);
    expect(walk.files.some((f) => path.basename(f.filePath) === 'Core.hlsl')).toBe(true);

    const incCompletionText = `${shaderText}\n#include_with_pragmas "Packages/com.unity.render-pipelines.universal/ShaderLibrary/`;
    const incLines = incCompletionText.split('\n');
    const incLastLine = incLines.length - 1;
    const incItems = completionProvider.provideCompletionItems(
      shaderUri,
      { line: incLastLine, character: incLines[incLastLine].length },
      incCompletionText,
    );
    expect(incItems.some((item) => item.label === 'Core.hlsl')).toBe(true);
    expect(incItems.some((item) => item.label === 'Lighting.hlsl')).toBe(true);

    // 2. #pragma dynamic_branch_local variant parsing + Ctrl+Space toggle
    const pragmas = parseShaderPragmas(shaderText);
    expect(pragmas.keywordGroups.some((g) => g.directive === 'dynamic_branch_local' && g.keywords.includes('_DETAIL_ALBEDO_ON'))).toBe(true);
    const variantAnalysis = analyzeShaderVariants(shaderText);
    expect(variantAnalysis.allKeywords).toContain('_DETAIL_ALBEDO_ON');
    expect(variantAnalysis.blocks[0].variantCount).toBe(2);

    const doc = vscode.__mock.createTextDocument(vscode.Uri.file(shaderPath), shaderText, 'unity-shaderlab');
    await vscode.window.showTextDocument(doc);
    const statusBar = new ShaderKeywordContextStatusBar();
    try {
      const pragmaToggleItems = buildShaderPreprocessorKeywordCompletions(
        doc,
        new vscode.Position(dynPragmaLine, lines[dynPragmaLine].indexOf('_DETAIL_ALBEDO_ON') + 3),
        statusBar,
      );
      expect(pragmaToggleItems).not.toBeNull();
      expect(String(pragmaToggleItems![0].label)).toContain('[ON] _DETAIL_ALBEDO_ON');
    } finally {
      statusBar.dispose();
    }

    // 3. Unity 6 SRP/DOTS/XR macro table + DOTS prop prepass + return type inference
    for (const macroName of [
      'SAMPLE_TEXTURE2D_X',
      'SAMPLE_TEXTURE2D_X_LOD',
      'LOAD_TEXTURE2D',
      'LOAD_TEXTURE2D_X',
      'UNITY_DOTS_INSTANCING_START',
      'UNITY_DOTS_INSTANCING_END',
      'UNITY_DOTS_INSTANCED_PROP',
      'UNITY_ACCESS_DOTS_INSTANCED_PROP_WITH_DEFAULT',
    ]) {
      expect(UNITY_BUILTIN_MACROS.some((m) => m.name === macroName)).toBe(true);
    }

    const prepassRes = new UnityHlslMacroPrepass().preprocess(shaderText, shaderUri);
    expect(prepassRes.normalizedText.split('\n').length).toBe(lines.length);
    expect(prepassRes.synthesizedSymbols.some((s) => s.name === '_DotsTint' && s.kind === 'variable' && s.returnType === 'float4')).toBe(true);

    graph.setOpenDocumentContent(shaderUri, shaderText);
    expect(
      graph.resolveExpressionChain(shaderPath, 'SAMPLE_TEXTURE2D(_BaseMap, sampler_BaseMap, input.uv).rgb', sampledRgbLine).type,
    ).toBe('float3');
    expect(
      graph.resolveExpressionChain(shaderPath, 'SAMPLE_TEXTURE2D_SHADOW(_BaseMap, sampler_BaseMap, float3(input.uv, 0)).r', sampledRgbLine).type,
    ).toBe('float');
    expect(
      graph.resolveExpressionChain(shaderPath, 'SAMPLE_TEXTURE2D_X(_BaseMap, sampler_BaseMap, input.uv).rgba', sampledRgbLine).type,
    ).toBe('float4');
    expect(
      graph.resolveExpressionChain(shaderPath, 'LOAD_TEXTURE2D_X(_BaseMap, int2(0, 0)).rg', sampledRgbLine).type,
    ).toBe('float2');
    expect(
      graph.resolveExpressionChain(shaderPath, 'UNITY_ACCESS_DOTS_INSTANCED_PROP_WITH_DEFAULT(float4, _DotsTint).rgb', dotsAccessLine).type,
    ).toBe('float3');

    // 4. Vector swizzle completion (SAMPLE_TEXTURE2D(...). and float2.) & hover
    const sampleDotLines = [...lines];
    sampleDotLines[uvCheckLine] = '      float3 swz = SAMPLE_TEXTURE2D(_BaseMap, sampler_BaseMap, input.uv).';
    const sampleDotText = sampleDotLines.join('\n');
    const sampleSwizzleItems = completionProvider.provideCompletionItems(
      shaderUri,
      { line: uvCheckLine, character: sampleDotLines[uvCheckLine].length },
      sampleDotText,
    );
    const rgbItem = sampleSwizzleItems.find((i) => i.label === 'rgb');
    expect(rgbItem).toBeDefined();
    expect(rgbItem?.kind).toBe(CompletionItemKind.Field);
    expect(rgbItem?.detail).toBe('[UnityBrain] float4 벡터 스위즐 (float3)');
    expect(sampleSwizzleItems.some((i) => i.label === 'xyzw')).toBe(true);

    const vec2DotLines = [...lines];
    vec2DotLines[uvCheckLine] = '      float2 swz2 = input.uv.';
    const vec2Items = completionProvider.provideCompletionItems(
      shaderUri,
      { line: uvCheckLine, character: vec2DotLines[uvCheckLine].length },
      vec2DotLines.join('\n'),
    );
    const vec2Labels = vec2Items.map((i) => i.label);
    expect(vec2Labels).toContain('x');
    expect(vec2Labels).toContain('y');
    expect(vec2Labels).toContain('xy');
    expect(vec2Labels).toContain('r');
    expect(vec2Labels).toContain('g');
    expect(vec2Labels).not.toContain('z');
    expect(vec2Labels).not.toContain('w');
    expect(vec2Labels).not.toContain('b');
    expect(vec2Labels).not.toContain('a');

    const rgbHover = hoverProvider.provideHover(
      shaderUri,
      { line: sampledRgbLine, character: lines[sampledRgbLine].lastIndexOf('.rgb') + 2 },
      shaderText,
      projectRoot,
    );
    const rgbHoverMd = typeof rgbHover?.contents === 'string' ? rgbHover.contents : rgbHover?.contents.value;
    expect(rgbHoverMd).toContain('```hlsl\nfloat3 .rgb\n```');
    expect(rgbHoverMd).toContain('[UnityBrain] 벡터 스위즐 (float3)');

    const colAlphaHover = hoverProvider.provideHover(
      shaderUri,
      { line: returnLine, character: lines[returnLine].lastIndexOf('col.a') + 4 },
      shaderText,
      projectRoot,
    );
    const colAlphaMd = typeof colAlphaHover?.contents === 'string' ? colAlphaHover.contents : colAlphaHover?.contents.value;
    expect(colAlphaMd).toContain('```hlsl\nfloat .a\n```');
    expect(colAlphaMd).toContain('[UnityBrain] 벡터 스위즐 (float)');

    // 5. #if defined(...) and #pragma dynamic_branch_local hover (OFF when empty, ON when active, null on keywords like defined/if)
    const offIfHover = hoverProvider.provideHover(
      shaderUri,
      { line: ifDefLine, character: lines[ifDefLine].indexOf('_DETAIL_ALBEDO_ON') + 3 },
      shaderText,
      projectRoot,
    );
    const offIfMd = typeof offIfHover?.contents === 'string' ? offIfHover.contents : offIfHover?.contents.value;
    expect(offIfMd).toContain('_DETAIL_ALBEDO_ON');
    expect(offIfMd).toContain('OFF (비활성)');

    expect(
      hoverProvider.provideHover(
        shaderUri,
        { line: ifDefLine, character: lines[ifDefLine].indexOf('defined') + 2 },
        shaderText,
        projectRoot,
      ),
    ).toBeNull();
    expect(
      hoverProvider.provideHover(
        shaderUri,
        { line: ifDefLine, character: lines[ifDefLine].indexOf('if') + 1 },
        shaderText,
        projectRoot,
      ),
    ).toBeNull();

    hoverProvider.setActiveKeywords(['_DETAIL_ALBEDO_ON']);
    const onIfHover = hoverProvider.provideHover(
      shaderUri,
      { line: ifDefLine, character: lines[ifDefLine].indexOf('_DETAIL_ALBEDO_ON') + 3 },
      shaderText,
      projectRoot,
    );
    const onIfMd = typeof onIfHover?.contents === 'string' ? onIfHover.contents : onIfHover?.contents.value;
    expect(onIfMd).toContain('ON (활성)');

    const onPragmaHover = hoverProvider.provideHover(
      shaderUri,
      { line: dynPragmaLine, character: lines[dynPragmaLine].indexOf('_DETAIL_ALBEDO_ON') + 3 },
      shaderText,
      projectRoot,
    );
    const onPragmaMd = typeof onPragmaHover?.contents === 'string' ? onPragmaHover.contents : onPragmaHover?.contents.value;
    expect(onPragmaMd).toContain('ON (활성)');

    // 6. Local variable & function parameter completion inside Frag
    const localCompLines = [...lines];
    localCompLines[uvCheckLine] = '      col';
    const localColItems = completionProvider.provideCompletionItems(
      shaderUri,
      { line: uvCheckLine, character: localCompLines[uvCheckLine].length },
      localCompLines.join('\n'),
    );
    const colItem = localColItems.find((i) => i.label === 'col');
    expect(colItem?.kind).toBe(CompletionItemKind.Variable);
    expect(colItem?.detail).toContain('로컬 변수');

    const paramCompLines = [...lines];
    paramCompLines[uvCheckLine] = '      inp';
    const paramItems = completionProvider.provideCompletionItems(
      shaderUri,
      { line: uvCheckLine, character: paramCompLines[uvCheckLine].length },
      paramCompLines.join('\n'),
    );
    const inputItem = paramItems.find((i) => i.label === 'input');
    expect(inputItem?.kind).toBe(CompletionItemKind.Variable);
    expect(inputItem?.detail).toBe('[UnityBrain] 함수 파라미터 · Varyings input');

    const fadeCompLines = [...lines];
    fadeCompLines[uvCheckLine] = '      fade';
    const fadeItems = completionProvider.provideCompletionItems(
      shaderUri,
      { line: uvCheckLine, character: fadeCompLines[uvCheckLine].length },
      fadeCompLines.join('\n'),
    );
    const fadeItem = fadeItems.find((i) => i.label === 'fadeWeight');
    expect(fadeItem?.kind).toBe(CompletionItemKind.Variable);
    expect(fadeItem?.detail).toBe('[UnityBrain] 함수 파라미터 · float fadeWeight');

    const beforeDeclLines = [...lines];
    beforeDeclLines[uvCheckLine] = '      laterDec';
    const beforeDeclItems = completionProvider.provideCompletionItems(
      shaderUri,
      { line: uvCheckLine, character: beforeDeclLines[uvCheckLine].length },
      beforeDeclLines.join('\n'),
    );
    expect(beforeDeclItems.some((i) => i.label === 'laterDeclared')).toBe(false);
  });

  it('aggregates #include_with_pragmas header variants and syncs Hover keywords on tab switch', async () => {
    const shaderText = [
      'Shader "UnityBrain/IncludePragmas" {',
      '  SubShader {',
      '    Pass {',
      '      HLSLPROGRAM',
      '      #include_with_pragmas "Packages/com.unity.render-pipelines.universal/ShaderLibrary/RenderingLayers.hlsl"',
      '      #pragma shader_feature_local _LOCAL_FX',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const analysis = analyzeShaderVariants(shaderText, {
      resolveIncludeText: (inc) =>
        inc.endsWith('RenderingLayers.hlsl')
          ? '#pragma multi_compile _ _WRITE_RENDERING_LAYERS _RENDERING_LAYERS_HIGH\n'
          : undefined,
    });
    expect(analysis.totalVariants).toBe(6);
    expect(analysis.allKeywords).toContain('_WRITE_RENDERING_LAYERS');
    expect(analysis.allKeywords).toContain('_LOCAL_FX');

    const syncedEvents: Array<{ uri: string; keywords: string[] }> = [];
    const statusBar = new ShaderKeywordContextStatusBar({
      onKeywordsChanged: (uri, keywords) => {
        if (uri) syncedEvents.push({ uri: uri.toString(), keywords });
      },
    });
    const docA = vscode.__mock.createTextDocument(
      vscode.Uri.file('Assets/Shaders/ShaderA.shader'),
      'Shader "A" { SubShader { Pass { HLSLPROGRAM\n#pragma shader_feature _KW_A\nENDHLSL } } }',
      'unity-shaderlab',
    );
    const docB = vscode.__mock.createTextDocument(
      vscode.Uri.file('Assets/Shaders/ShaderB.shader'),
      'Shader "B" { SubShader { Pass { HLSLPROGRAM\n#pragma shader_feature _KW_B\nENDHLSL } } }',
      'unity-shaderlab',
    );
    await statusBar.setActiveKeywords(docA.uri, ['_KW_A']);
    await statusBar.setActiveKeywords(docB.uri, ['_KW_B']);
    syncedEvents.length = 0;

    vscode.__mock.emitters.onDidChangeActiveTextEditor.fire({
      document: docA,
      selection: new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0)),
    });
    expect(syncedEvents.some((e) => e.uri === docA.uri.toString() && e.keywords.includes('_KW_A'))).toBe(true);
    statusBar.dispose();
  });

  it('excludes current file #define include guards from getDefinedMacros while keeping included header macros (P0-1)', async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    const baseOut = path.join(repoRoot, 'test-output');
    fs.mkdirSync(baseOut, { recursive: true });
    const projectRoot = fs.mkdtempSync(path.join(baseOut, 'ub-p0-1-'));
    tempDirs.push(projectRoot);
    fs.mkdirSync(path.join(projectRoot, 'Assets', 'Shaders'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'ProjectSettings'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'Packages'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0.23f1\n', 'utf8');
    fs.writeFileSync(path.join(projectRoot, 'Packages', 'manifest.json'), '{"dependencies":{}}', 'utf8');

    const headerPath = path.join(projectRoot, 'Assets', 'Shaders', 'ExtraDefines.hlsl');
    fs.writeFileSync(headerPath, '#define FROM_INCLUDED_HEADER 1\n', 'utf8');

    const targetPath = path.join(projectRoot, 'Assets', 'Shaders', 'GuardHeader.hlsl');
    const targetText = [
      '#ifndef FOO_INCLUDED',
      '#define FOO_INCLUDED',
      '#include "./ExtraDefines.hlsl"',
      'half4 Foo() { return 1; }',
      '#endif',
      '#ifndef FROM_INCLUDED_HEADER',
      'half4 FallbackFn() { return 0; }',
      '#endif',
    ].join('\n');
    fs.writeFileSync(targetPath, targetText, 'utf8');

    const extensionPath = path.join(repoRoot, 'packages', 'extension');
    const storageDir = path.join(projectRoot, '.storage');
    const mockCtx: vscode.ExtensionContext = {
      subscriptions: [],
      extensionPath,
      extensionUri: vscode.Uri.file(extensionPath),
      globalStorageUri: vscode.Uri.file(storageDir),
      storageUri: vscode.Uri.file(storageDir),
      extensionMode: vscode.ExtensionMode.Test,
      asAbsolutePath: (rel: string) => path.resolve(extensionPath, rel),
    } as unknown as vscode.ExtensionContext;

    const api = await activate(mockCtx, { workspaceRoot: projectRoot, enableWatchers: false });
    const doc = vscode.__mock.createTextDocument(vscode.Uri.file(targetPath), targetText, 'hlsl');
    let decoratedRanges: vscode.Range[] = [];
    const mockEditor = {
      document: doc,
      selection: new vscode.Selection(0, 0, 0, 0),
      setDecorations: (_type: vscode.TextEditorDecorationType, ranges: vscode.Range[]) => {
        decoratedRanges = ranges;
      },
    } as unknown as vscode.TextEditor;

    api.shaderKeywordStatusBar.applyInactiveDecorations(mockEditor);
    // Guard body (lines 1..3) must NOT be dimmed; only #ifndef FROM_INCLUDED_HEADER body (line 6) is dimmed.
    expect(decoratedRanges.map((r) => ({ start: r.start.line, end: r.end.line }))).toEqual([
      { start: 6, end: 6 },
    ]);
  });

  it('does not include multiline #elif directive lines in inactive preprocessor ranges (P1-S6)', () => {
    const code = [
      '#ifdef UNDEFINED_BRANCH',
      '  float inactiveVar = 0;',
      '#elif defined(FEATURE_A) \\',
      '   || defined(FEATURE_B)',
      '  float activeVar = 1;',
      '#endif',
    ].join('\n');

    const ranges = evaluateInactivePreprocessorRanges(code, new Set(['FEATURE_A']));
    expect(ranges).toEqual([{ startLine: 1, endLine: 1 }]);
  });

  it('highlights ShaderLab property types Color, 2D, Float in tmLanguage grammar without blocking on closing paren (P2-S1)', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    const grammarPath = path.join(repoRoot, 'packages', 'extension', 'syntaxes', 'unity-shaderlab.tmLanguage.json');
    const grammar = JSON.parse(fs.readFileSync(grammarPath, 'utf8')) as {
      repository: {
        'shaderlab-commands': {
          patterns: Array<{ name: string; match: string }>;
        };
      };
    };
    const propTypeRule = grammar.repository['shaderlab-commands'].patterns.find(
      (p) => p.name === 'support.type.shaderlab.property',
    );
    expect(propTypeRule).toBeDefined();
    expect(propTypeRule!.match).not.toContain('\\)|');

    // Convert Oniguruma negative lookbehind/lookahead to JS RegExp (compatible here)
    const jsRe = new RegExp(propTypeRule!.match);
    expect(jsRe.exec('_Color ("Color", Color) = (1,1,1,1)')?.[1]).toBe('Color');
    expect(jsRe.exec('_MainTex ("Albedo", 2D) = "white" {}')?.[1]).toBe('2D');
    expect(jsRe.exec('_Glossiness ("Smoothness", Float) = 0.5')?.[1]).toBe('Float');
    expect(jsRe.exec('_Cutoff ("Alpha", Range(0, 1)) = 0.5')?.[1]).toBe('Range');
    expect(jsRe.exec('float4 Color = 1;')).toBeNull();
    expect(jsRe.exec('c.Color')).toBeNull();
  });
});
