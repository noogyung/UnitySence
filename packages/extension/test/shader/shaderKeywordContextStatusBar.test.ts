import { afterEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  analyzeShaderVariants,
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
    expect(lenses[0].command?.title).toBe('$(layers) 256 Shader Variants (High Variant Count!)');
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
      expect(statusBar.getStatusBarItem().text).toBe('$(symbol-keyword) Shader Keywords: (default)');

      await vscode.commands.executeCommand('unityBrain.switchShaderKeywords');
      expect(events.length).toBe(1);
      expect(events[0].keywords).toEqual(['_ALPHATEST_ON']);
      expect(statusBar.getStatusBarItem().text).toBe(
        '$(symbol-keyword) Shader Keywords: _ALPHATEST_ON',
      );

      await vscode.commands.executeCommand('unityBrain.switchShaderKeywords', [
        '_ALPHATEST_ON',
        '_EMISSION',
      ]);
      expect(events.length).toBe(2);
      expect(events[1].keywords).toEqual(['_ALPHATEST_ON', '_EMISSION']);
      expect(statusBar.getStatusBarItem().text).toBe(
        '$(symbol-keyword) Shader Keywords: _ALPHATEST_ON, _EMISSION',
      );
    } finally {
      statusBar.dispose();
    }
  });
});
