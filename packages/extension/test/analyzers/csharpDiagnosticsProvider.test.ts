import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  classifyTypeFromHoverText,
  collectUnityCSharpDiagnostics,
} from '../../src/analyzers/csharpDiagnosticsProvider.ts';
import type { ProjectSettingsCache } from '../../src/contracts/index.ts';

function makeCache(): ProjectSettingsCache {
  return {
    tags: ['Untagged', 'Player', 'Enemy'],
    layers: [
      { index: 0, name: 'Default' },
      { index: 8, name: 'Hitbox' },
    ],
    sortingLayers: [],
    buildScenes: [
      { name: 'MainMenu', path: 'Assets/Scenes/MainMenu.unity', enabled: true, buildIndex: 0 },
      { name: 'DisabledScene', path: 'Assets/Scenes/DisabledScene.unity', enabled: false, buildIndex: -1 },
    ],
    inputAxes: [],
    animators: [],
  };
}

describe('collectUnityCSharpDiagnostics', () => {
  it('detects UB1002, UB1003, UB3002, UB3003 without touching Directory.Build.props', async () => {
    const code = [
      'using UnityEngine;',
      'using UnityEngine.SceneManagement;',
      'public class Sample : MonoBehaviour',
      '{',
      '    void Update()',
      '    {',
      '        var rb = GetComponent<Rigidbody>();',
      '        var cam = Camera.main;',
      '        mat.SetFloat("_Glossiness", 1f);',
      '        if (CompareTag("UnknownTag")) {}',
      '        int layer = LayerMask.NameToLayer("MissingLayer");',
      '        SceneManager.LoadScene("DisabledScene");',
      '    }',
      '}',
    ].join('\n');

    const doc = vscode.__mock.createTextDocument(
      vscode.Uri.file('Assets/Scripts/Sample.cs'),
      code,
      'csharp',
    );
    const diags = await collectUnityCSharpDiagnostics(doc, makeCache());
    const codes = diags.map((d) => d.code);

    expect(codes).toContain('UB1002');
    expect(codes).toContain('UB1003');
    expect(codes).toContain('UB3002');
    expect(codes).toContain('UB3003');
  });

  it('detects BurstCompile violations using built-in lists and C# LSP hover resolver', async () => {
    const code = [
      'using Unity.Burst;',
      '[BurstCompile]',
      'public struct MyJob',
      '{',
      '    public CustomRefClass badField;',
      '    public CustomValStruct goodField;',
      '    public void Execute()',
      '    {',
      '        string s = "oops";',
      '        var x = new CustomRefClass();',
      '        var boxed = (IMyInterface)goodField;',
      '        try { } catch { }',
      '    }',
      '    [BurstDiscard]',
      '    private void DebugLog() { string ok = "allowed"; }',
      '}',
    ].join('\n');

    const doc = vscode.__mock.createTextDocument(
      vscode.Uri.file('Assets/Scripts/MyJob.cs'),
      code,
      'csharp',
    );

    const mockHoverResolver = async (_d: vscode.TextDocument, _p: vscode.Position, typeName: string) => {
      if (typeName === 'CustomRefClass') return classifyTypeFromHoverText('```csharp\nclass Game.CustomRefClass\n```');
      if (typeName === 'CustomValStruct') return classifyTypeFromHoverText('```csharp\nstruct Game.CustomValStruct\n```');
      if (typeName === 'IMyInterface') return classifyTypeFromHoverText('```csharp\ninterface Game.IMyInterface\n```');
      return 'unknown' as const;
    };

    const diags = await collectUnityCSharpDiagnostics(doc, makeCache(), mockHoverResolver);

    expect(diags.some((d) => d.code === 'UB2001' && d.message.includes('CustomRefClass'))).toBe(true);
    expect(diags.some((d) => d.message.includes('CustomValStruct'))).toBe(false);
    expect(diags.some((d) => d.code === 'UB2002' && d.message.includes('IMyInterface'))).toBe(true);
    expect(diags.some((d) => d.code === 'UB2003')).toBe(true);
    expect(diags.some((d) => d.code === 'UB2004')).toBe(true);
    // [BurstDiscard] line (line 14) must be excluded
    expect(diags.some((d) => d.range.start.line === 14)).toBe(false);
  });
});
