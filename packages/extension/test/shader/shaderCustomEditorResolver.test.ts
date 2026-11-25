import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import type { UnityProjectContext } from '../../src/contracts/index.ts';
import { IncludeDependencyGraph } from '../../../shader-lsp/src/indexer/hlslIncludeGraph.ts';
import {
  extractCustomEditorNames,
  findCustomEditorAtPosition,
  invalidateCustomEditorCache,
  resolveCustomEditorDefinition,
  resolveCustomEditorProperties,
} from '../../src/shader/shaderCustomEditorResolver.ts';
import {
  findFallbackOrUsePassAtPosition,
  invalidateShaderNameCache,
  resolveShaderDefinitionByName,
} from '../../src/shader/shaderFallbackResolver.ts';
import { collectComputeAndShaderLabDiagnostics } from '../../src/shader/shaderEditorProviders.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');
const tempDirs: string[] = [];

function createTempProject(): UnityProjectContext {
  const baseOut = path.join(REPO_ROOT, 'test-output');
  fs.mkdirSync(baseOut, { recursive: true });
  const root = fs.mkdtempSync(path.join(baseOut, 'ub-custom-editor-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'Assets', 'Shaders'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Editor'), { recursive: true });
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
  } as unknown as vscode.TextDocument;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    invalidateCustomEditorCache(dir);
    invalidateShaderNameCache(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Shader CustomEditor resolver & unused property diagnostics', () => {
  it('extracts CustomEditor and CustomEditorForRenderPipeline while ignoring comments and HLSL blocks', () => {
    const shader = [
      'Shader "Custom/Test"',
      '{',
      '    // CustomEditor "CommentedOutEditor"',
      '    /* CustomEditorForRenderPipeline "BlockCommentEditor" "RP" */',
      '    SubShader',
      '    {',
      '        Pass',
      '        {',
      '            HLSLPROGRAM',
      '            // CustomEditor "InsideHlslEditor"',
      '            float4 Vert() : SV_POSITION { return 0; }',
      '            ENDHLSL',
      '        }',
      '    }',
      '    CustomEditorForRenderPipeline "UnityEditor.Rendering.Universal.ShaderGUI.LitShader" "UnityEngine.Rendering.Universal.UniversalRenderPipelineAsset"',
      '    CustomEditor "MyLocalShaderGUI"',
      '}',
    ].join('\n');

    expect(extractCustomEditorNames(shader)).toEqual([
      'UnityEditor.Rendering.Universal.ShaderGUI.LitShader',
      'MyLocalShaderGUI',
    ]);
  });

  it('suppresses unused-property warnings when referenced in local Assets/Editor CustomEditor and reports editor name for dead props', () => {
    const ctx = createTempProject();
    const editorPath = path.join(ctx.projectRoot, 'Assets', 'Editor', 'MyShaderGUI.cs');
    fs.writeFileSync(
      editorPath,
      [
        'using UnityEditor;',
        'public class MyShaderGUI : ShaderGUI',
        '{',
        '    public override void OnGUI(MaterialEditor materialEditor, MaterialProperty[] properties)',
        '    {',
        '        var surface = FindProperty("_Surface", properties, false);',
        '        var custom = FindProperty("NoUnderscoreProp", properties, false);',
        '        // "_CommentedOutProp" should not count',
        '    }',
        '}',
      ].join('\n'),
      'utf8',
    );

    const shaderPath = path.join(ctx.projectRoot, 'Assets', 'Shaders', 'LocalGui.shader');
    const shaderText = [
      'Shader "Custom/LocalGui"',
      '{',
      '    Properties',
      '    {',
      '        _Surface ("Surface Type", Float) = 0',
      '        NoUnderscoreProp ("No Underscore", Float) = 1',
      '        _UnusedProp ("Dead Prop", Float) = 0',
      '        _CommentedOutProp ("Commented Out In CS", Float) = 0',
      '    }',
      '    SubShader',
      '    {',
      '        Pass',
      '        {',
      '            HLSLPROGRAM',
      '            #pragma vertex Vert',
      '            #pragma fragment Frag',
      '            float4 Vert() : SV_POSITION { return 0; }',
      '            half4 Frag() : SV_Target { return 1; }',
      '            ENDHLSL',
      '        }',
      '    }',
      '    CustomEditor "MyShaderGUI"',
      '}',
    ].join('\n');

    const graph = new IncludeDependencyGraph(ctx);
    const diags = collectComputeAndShaderLabDiagnostics(makeDoc(shaderPath, shaderText), graph);

    expect(diags.some((d) => d.message.includes('_Surface'))).toBe(false);
    expect(diags.some((d) => d.message.includes('NoUnderscoreProp'))).toBe(false);
    expect(
      diags.some(
        (d) =>
          d.message.includes('_UnusedProp') &&
          d.message.includes('CustomEditor(MyShaderGUI)'),
      ),
    ).toBe(true);
    expect(
      diags.some((d) => d.message.includes('_CommentedOutProp') && d.message.includes('미사용 프로퍼티')),
    ).toBe(true);
  });

  it('traverses namespaced base classes and static GUI helper classes', () => {
    const ctx = createTempProject();
    const editorDir = path.join(ctx.projectRoot, 'Assets', 'Editor', 'CustomGui');
    fs.mkdirSync(editorDir, { recursive: true });

    fs.writeFileSync(
      path.join(editorDir, 'BaseLitGUI.cs'),
      [
        'namespace MyCompany.Shaders.Editor',
        '{',
        '    public abstract class BaseLitGUI : UnityEditor.ShaderGUI',
        '    {',
        '        protected static readonly string kQueueOffset = "_QueueOffset";',
        '    }',
        '}',
      ].join('\n'),
      'utf8',
    );

    fs.writeFileSync(
      path.join(editorDir, 'LitHelperGUI.cs'),
      [
        'namespace MyCompany.Shaders.Editor',
        '{',
        '    internal static class LitHelperGUI',
        '    {',
        '        public static void DoPopup() { var s = "_BlendMode"; }',
        '    }',
        '}',
      ].join('\n'),
      'utf8',
    );

    fs.writeFileSync(
      path.join(editorDir, 'CustomLitGUI.cs'),
      [
        'namespace MyCompany.Shaders.Editor',
        '{',
        '    public class CustomLitGUI : BaseLitGUI',
        '    {',
        '        public void Draw() { LitHelperGUI.DoPopup(); }',
        '    }',
        '}',
      ].join('\n'),
      'utf8',
    );

    const graph = new IncludeDependencyGraph(ctx);
    const res = resolveCustomEditorProperties(
      graph.getResolver(),
      'MyCompany.Shaders.Editor.CustomLitGUI',
    );

    expect(res.resolved).toBe(true);
    expect(res.referencedProperties.has('_QueueOffset')).toBe(true);
    expect(res.referencedProperties.has('_BlendMode')).toBe(true);
  });

  it('resolves external UPM packages in Library/PackageCache for CustomEditorForRenderPipeline', () => {
    const ctx = createTempProject();
    const urpCacheDir = path.join(
      ctx.projectRoot,
      'Library',
      'PackageCache',
      'com.unity.render-pipelines.universal@14.0.10',
    );
    const urpGuiDir = path.join(urpCacheDir, 'Editor', 'ShaderGUI');
    fs.mkdirSync(urpGuiDir, { recursive: true });

    fs.writeFileSync(
      path.join(ctx.projectRoot, 'Packages', 'manifest.json'),
      JSON.stringify({
        dependencies: {
          'com.unity.render-pipelines.universal': '14.0.10',
        },
      }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(ctx.projectRoot, 'Packages', 'packages-lock.json'),
      JSON.stringify({
        dependencies: {
          'com.unity.render-pipelines.universal': {
            version: '14.0.10',
            source: 'registry',
          },
        },
      }),
      'utf8',
    );

    fs.writeFileSync(
      path.join(urpGuiDir, 'BaseShaderGUI.cs'),
      [
        'namespace UnityEditor.Rendering.Universal',
        '{',
        '    public abstract class BaseShaderGUI : ShaderGUI',
        '    {',
        '        public static class PropertyNames',
        '        {',
        '            public static readonly string SurfaceType = "_Surface";',
        '            public static readonly string QueueOffset = "_QueueOffset";',
        '        }',
        '    }',
        '}',
      ].join('\n'),
      'utf8',
    );

    fs.writeFileSync(
      path.join(urpGuiDir, 'LitShader.cs'),
      [
        'namespace UnityEditor.Rendering.Universal.ShaderGUI',
        '{',
        '    internal class LitShader : BaseShaderGUI',
        '    {',
        '        public override void OnGUI(MaterialEditor editor, MaterialProperty[] props) {}',
        '    }',
        '}',
      ].join('\n'),
      'utf8',
    );

    const shaderPath = path.join(ctx.projectRoot, 'Assets', 'Shaders', 'UrpLitLike.shader');
    const shaderText = [
      'Shader "Custom/UrpLitLike"',
      '{',
      '    Properties',
      '    {',
      '        _Surface ("Surface", Float) = 0',
      '        _QueueOffset ("Queue Offset", Float) = 0',
      '        _DeadProp ("Dead Prop", Float) = 0',
      '    }',
      '    SubShader { Pass { HLSLPROGRAM float4 v():SV_POSITION{return 0;} ENDHLSL } }',
      '    CustomEditorForRenderPipeline "UnityEditor.Rendering.Universal.ShaderGUI.LitShader" "UnityEngine.Rendering.Universal.UniversalRenderPipelineAsset"',
      '}',
    ].join('\n');

    const graph = new IncludeDependencyGraph(ctx);
    const diags = collectComputeAndShaderLabDiagnostics(makeDoc(shaderPath, shaderText), graph);

    expect(diags.some((d) => d.message.includes('_Surface'))).toBe(false);
    expect(diags.some((d) => d.message.includes('_QueueOffset'))).toBe(false);
    expect(
      diags.some(
        (d) =>
          d.message.includes('_DeadProp') &&
          d.message.includes('UnityEditor.Rendering.Universal.ShaderGUI.LitShader'),
      ),
    ).toBe(true);
  });

  it('automatically invalidates cache when package version changes in packages-lock.json and Library/PackageCache', () => {
    const ctx = createTempProject();
    const lockPath = path.join(ctx.projectRoot, 'Packages', 'packages-lock.json');
    ctx.packagesLockPath = lockPath;

    const v1Dir = path.join(
      ctx.projectRoot,
      'Library',
      'PackageCache',
      'com.unity.render-pipelines.universal@14.0.10',
      'Editor',
      'ShaderGUI',
    );
    fs.mkdirSync(v1Dir, { recursive: true });
    fs.writeFileSync(
      path.join(ctx.projectRoot, 'Packages', 'manifest.json'),
      JSON.stringify({ dependencies: { 'com.unity.render-pipelines.universal': '14.0.10' } }),
      'utf8',
    );
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        dependencies: {
          'com.unity.render-pipelines.universal': { version: '14.0.10', source: 'registry' },
        },
      }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(v1Dir, 'LitShader.cs'),
      'namespace UnityEditor.Rendering.Universal.ShaderGUI { internal class LitShader { string a = "_OldVersionProp"; } }',
      'utf8',
    );

    const graph = new IncludeDependencyGraph(ctx);
    const resolver = graph.getResolver();

    const r1 = resolveCustomEditorProperties(
      resolver,
      'UnityEditor.Rendering.Universal.ShaderGUI.LitShader',
    );
    expect(r1.resolved).toBe(true);
    expect(r1.referencedProperties.has('_OldVersionProp')).toBe(true);
    expect(r1.referencedProperties.has('_NewVersionProp')).toBe(false);

    // Upgrade package to 14.0.11 without calling invalidateCustomEditorCache manually
    const v2Dir = path.join(
      ctx.projectRoot,
      'Library',
      'PackageCache',
      'com.unity.render-pipelines.universal@14.0.11',
      'Editor',
      'ShaderGUI',
    );
    fs.mkdirSync(v2Dir, { recursive: true });
    fs.rmSync(
      path.join(
        ctx.projectRoot,
        'Library',
        'PackageCache',
        'com.unity.render-pipelines.universal@14.0.10',
      ),
      { recursive: true, force: true },
    );
    fs.writeFileSync(
      path.join(v2Dir, 'LitShader.cs'),
      'namespace UnityEditor.Rendering.Universal.ShaderGUI { internal class LitShader { string b = "_NewVersionProp"; } }',
      'utf8',
    );
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        dependencies: {
          'com.unity.render-pipelines.universal': { version: '14.0.11', source: 'registry' },
        },
      }),
      'utf8',
    );
    resolver.refreshPackageMap(true);

    const r2 = resolveCustomEditorProperties(
      resolver,
      'UnityEditor.Rendering.Universal.ShaderGUI.LitShader',
    );
    expect(r2.resolved).toBe(true);
    expect(r2.referencedProperties.has('_NewVersionProp')).toBe(true);
    expect(r2.referencedProperties.has('_OldVersionProp')).toBe(false);
  });

  it('automatically detects local .cs file edits via mtime/size check without manual invalidation', () => {
    const ctx = createTempProject();
    const editorPath = path.join(ctx.projectRoot, 'Assets', 'Editor', 'DynamicGui.cs');
    fs.writeFileSync(
      editorPath,
      'public class DynamicGui : UnityEditor.ShaderGUI { string p = "_InitialProp"; }',
      'utf8',
    );

    const graph = new IncludeDependencyGraph(ctx);
    const shaderPath = path.join(ctx.projectRoot, 'Assets', 'Shaders', 'Dynamic.shader');
    const shaderText = [
      'Shader "Custom/Dynamic"',
      '{',
      '    Properties { _Surface ("Surface", Float) = 0 }',
      '    SubShader { Pass { HLSLPROGRAM float4 v():SV_POSITION{return 0;} ENDHLSL } }',
      '    CustomEditor "DynamicGui"',
      '}',
    ].join('\n');

    const diags1 = collectComputeAndShaderLabDiagnostics(makeDoc(shaderPath, shaderText), graph);
    expect(diags1.some((d) => d.message.includes('_Surface'))).toBe(true);

    // Edit local .cs file to add "_Surface" (changes both size and mtime)
    fs.writeFileSync(
      editorPath,
      'public class DynamicGui : UnityEditor.ShaderGUI { string p = "_InitialProp"; string s = "_Surface"; }',
      'utf8',
    );
    const bumpTime = new Date(Date.now() + 2000);
    fs.utimesSync(editorPath, bumpTime, bumpTime);

    const diags2 = collectComputeAndShaderLabDiagnostics(makeDoc(shaderPath, shaderText), graph);
    expect(diags2.some((d) => d.message.includes('_Surface'))).toBe(false);
  });

  it('warns when CustomEditor class does not exist yet, while allowing built-in compiled ShaderGUIs', () => {
    const ctx = createTempProject();
    const graph = new IncludeDependencyGraph(ctx);

    const missingShaderPath = path.join(ctx.projectRoot, 'Assets', 'Shaders', 'MissingGui.shader');
    const missingText = [
      'Shader "Custom/MissingGui"',
      '{',
      '    SubShader { Pass { HLSLPROGRAM float4 v():SV_POSITION{return 0;} ENDHLSL } }',
      '    CustomEditor "TestShaderGUI"',
      '}',
    ].join('\n');

    const missingDiags = collectComputeAndShaderLabDiagnostics(
      makeDoc(missingShaderPath, missingText),
      graph,
    );
    const missingWarn = missingDiags.find((d) => d.message.includes('TestShaderGUI'));
    expect(missingWarn).toBeDefined();
    expect(missingWarn!.severity).toBe(vscode.DiagnosticSeverity.Warning);
    expect(missingWarn!.range.start.line).toBe(3);

    const builtinShaderPath = path.join(ctx.projectRoot, 'Assets', 'Shaders', 'BuiltinGui.shader');
    const builtinText = [
      'Shader "Custom/BuiltinGui"',
      '{',
      '    SubShader { Pass { HLSLPROGRAM float4 v():SV_POSITION{return 0;} ENDHLSL } }',
      '    CustomEditor "StandardShaderGUI"',
      '}',
    ].join('\n');

    const builtinDiags = collectComputeAndShaderLabDiagnostics(
      makeDoc(builtinShaderPath, builtinText),
      graph,
    );
    expect(builtinDiags.some((d) => d.message.includes('StandardShaderGUI'))).toBe(false);
  });

  it('resolves F12 Go to Definition for local CustomEditor and external URP LitShader in Library/PackageCache', () => {
    const ctx = createTempProject();
    const localCs = path.join(ctx.projectRoot, 'Assets', 'Editor', 'TestShaderGUI.cs');
    fs.writeFileSync(
      localCs,
      ['using UnityEditor;', 'public class TestShaderGUI : ShaderGUI', '{', '}'].join('\n'),
      'utf8',
    );

    const urpDir = path.join(
      ctx.projectRoot,
      'Library',
      'PackageCache',
      'com.unity.render-pipelines.universal@14.0.10',
      'Editor',
      'ShaderGUI',
    );
    fs.mkdirSync(urpDir, { recursive: true });
    fs.writeFileSync(
      path.join(ctx.projectRoot, 'Packages', 'manifest.json'),
      JSON.stringify({ dependencies: { 'com.unity.render-pipelines.universal': '14.0.10' } }),
      'utf8',
    );
    const urpLitCs = path.join(urpDir, 'LitShader.cs');
    fs.writeFileSync(
      urpLitCs,
      [
        'namespace UnityEditor.Rendering.Universal.ShaderGUI',
        '{',
        '    internal class LitShader : BaseShaderGUI',
        '    {',
        '    }',
        '}',
      ].join('\n'),
      'utf8',
    );

    const graph = new IncludeDependencyGraph(ctx);
    const shaderText = [
      'Shader "Custom/Nav"',
      '{',
      '    CustomEditor "TestShaderGUI"',
      '    CustomEditor "UnityEditor.Rendering.Universal.ShaderGUI.LitShader"',
      '}',
    ].join('\n');

    const localTarget = findCustomEditorAtPosition(shaderText, 2, 20);
    expect(localTarget?.name).toBe('TestShaderGUI');
    const localLocs = resolveCustomEditorDefinition(graph.getResolver(), localTarget!.name);
    expect(localLocs.length).toBe(1);
    expect(path.resolve(localLocs[0].filePath)).toBe(path.resolve(localCs));
    expect(localLocs[0].line).toBe(1);

    const urpTarget = findCustomEditorAtPosition(shaderText, 3, 30);
    expect(urpTarget?.name).toBe('UnityEditor.Rendering.Universal.ShaderGUI.LitShader');
    const urpLocs = resolveCustomEditorDefinition(graph.getResolver(), urpTarget!.name);
    expect(urpLocs.length).toBe(1);
    expect(path.resolve(urpLocs[0].filePath)).toBe(path.resolve(urpLitCs));
    expect(urpLocs[0].line).toBe(2);
  });

  it('resolves F12 Go to Definition for Fallback (case-insensitive) and UsePass across Assets and PackageCache', () => {
    const ctx = createTempProject();
    const baseShaderPath = path.join(ctx.projectRoot, 'Assets', 'Shaders', 'BaseLit.shader');
    fs.writeFileSync(
      baseShaderPath,
      [
        'Shader "Custom/Base"',
        '{',
        '    SubShader',
        '    {',
        '        Pass',
        '        {',
        '            Name "ShadowCaster"',
        '            HLSLPROGRAM float4 v():SV_POSITION{return 0;} ENDHLSL',
        '        }',
        '    }',
        '}',
      ].join('\n'),
      'utf8',
    );

    const urpShadersDir = path.join(
      ctx.projectRoot,
      'Library',
      'PackageCache',
      'com.unity.render-pipelines.universal@14.0.10',
      'Shaders',
    );
    fs.mkdirSync(urpShadersDir, { recursive: true });
    fs.writeFileSync(
      path.join(ctx.projectRoot, 'Packages', 'manifest.json'),
      JSON.stringify({ dependencies: { 'com.unity.render-pipelines.universal': '14.0.10' } }),
      'utf8',
    );
    const fallbackErrorPath = path.join(urpShadersDir, 'FallbackError.shader');
    fs.writeFileSync(
      fallbackErrorPath,
      ['Shader "Hidden/Universal Render Pipeline/FallbackError"', '{', '}'].join('\n'),
      'utf8',
    );

    const graph = new IncludeDependencyGraph(ctx);
    const shaderText = [
      'Shader "Custom/Child"',
      '{',
      '    SubShader { UsePass "Custom/Base/ShadowCaster" }',
      '    FallBack "Custom/Base"',
      '    Fallback "Hidden/Universal Render Pipeline/FallbackError"',
      '    Fallback Off',
      '}',
    ].join('\n');

    const usePassTarget = findFallbackOrUsePassAtPosition(shaderText, 2, 30);
    expect(usePassTarget).toMatchObject({
      kind: 'UsePass',
      shaderName: 'Custom/Base',
      passName: 'ShadowCaster',
    });
    const usePassLoc = resolveShaderDefinitionByName(
      graph.getResolver(),
      usePassTarget!.shaderName,
      usePassTarget!.passName,
    );
    expect(usePassLoc).not.toBeNull();
    expect(path.resolve(usePassLoc!.filePath)).toBe(path.resolve(baseShaderPath));
    expect(usePassLoc!.line).toBe(6);

    const localFallback = findFallbackOrUsePassAtPosition(shaderText, 3, 18);
    expect(localFallback?.shaderName).toBe('Custom/Base');
    const localFallbackLoc = resolveShaderDefinitionByName(
      graph.getResolver(),
      localFallback!.shaderName,
    );
    expect(path.resolve(localFallbackLoc!.filePath)).toBe(path.resolve(baseShaderPath));
    expect(localFallbackLoc!.line).toBe(0);

    const pkgFallback = findFallbackOrUsePassAtPosition(shaderText, 4, 25);
    expect(pkgFallback?.shaderName).toBe('Hidden/Universal Render Pipeline/FallbackError');
    const pkgFallbackLoc = resolveShaderDefinitionByName(
      graph.getResolver(),
      pkgFallback!.shaderName,
    );
    expect(path.resolve(pkgFallbackLoc!.filePath)).toBe(path.resolve(fallbackErrorPath));

    expect(findFallbackOrUsePassAtPosition(shaderText, 5, 14)).toBeNull();
  });

  it('matches CustomEditor and FallBack anywhere on the line, handles apostrophes, and resolves from PackageCache shader path', () => {
    const ctx = createTempProject();
    const urpBase = path.join(
      ctx.projectRoot,
      'Library',
      'PackageCache',
      'com.unity.render-pipelines.universal@d7774c218bdf',
    );
    const urpGuiDir = path.join(urpBase, 'Editor', 'ShaderGUI', 'Shaders');
    const urpShaderDir = path.join(urpBase, 'Shaders');
    fs.mkdirSync(urpGuiDir, { recursive: true });
    fs.mkdirSync(urpShaderDir, { recursive: true });

    const litCs = path.join(urpGuiDir, 'LitShader.cs');
    fs.writeFileSync(
      litCs,
      'namespace UnityEditor.Rendering.Universal.ShaderGUI { internal class LitShader : BaseShaderGUI {} }',
      'utf8',
    );
    const fallbackErr = path.join(urpShaderDir, 'FallbackError.shader');
    fs.writeFileSync(
      fallbackErr,
      'Shader "Hidden/Universal Render Pipeline/FallbackError" {}',
      'utf8',
    );

    const litShaderFile = path.join(urpShaderDir, 'Lit.shader');
    const litShaderText = [
      'Shader "Universal Render Pipeline/Lit"',
      '{',
      '    Properties',
      '    {',
      '        [Header(Don\'t Change This)] _Foo ("Foo", Float) = 0',
      '    }',
      '    FallBack "Hidden/Universal Render Pipeline/FallbackError"',
      '    CustomEditor "UnityEditor.Rendering.Universal.ShaderGUI.LitShader"',
      '}',
    ].join('\n');

    // Cursor on "FallBack" keyword itself (col 4) and "CustomEditor" keyword itself (col 4)
    const fbTarget = findFallbackOrUsePassAtPosition(litShaderText, 6, 4);
    expect(fbTarget?.shaderName).toBe('Hidden/Universal Render Pipeline/FallbackError');

    const ceTarget = findCustomEditorAtPosition(litShaderText, 7, 4);
    expect(ceTarget?.name).toBe('UnityEditor.Rendering.Universal.ShaderGUI.LitShader');

    const graph = new IncludeDependencyGraph(ctx);
    const ceLocs = resolveCustomEditorDefinition(
      graph.getResolver(),
      ceTarget!.name,
      litShaderFile,
    );
    expect(ceLocs.length).toBe(1);
    expect(path.resolve(ceLocs[0].filePath)).toBe(path.resolve(litCs));

    const fbLoc = resolveShaderDefinitionByName(
      graph.getResolver(),
      fbTarget!.shaderName,
      fbTarget!.passName,
      litShaderFile,
    );
    expect(fbLoc).not.toBeNull();
    expect(path.resolve(fbLoc!.filePath)).toBe(path.resolve(fallbackErr));
  });

  it('resolves CustomEditor immediately after TestShaderGUI.cs is created/moved without manual cache invalidation', () => {
    const ctx = createTempProject();
    const graph = new IncludeDependencyGraph(ctx);
    const shaderPath = path.join(ctx.projectRoot, 'Assets', 'Shaders', 'TestGui.shader');
    const shaderText = [
      'Shader "Custom/TestGui"',
      '{',
      '    Properties { _Surface ("Surface", Float) = 0 }',
      '    SubShader { Pass { HLSLPROGRAM float4 v():SV_POSITION{return 0;} ENDHLSL } }',
      '    CustomEditor "TestShaderGUI"',
      '}',
    ].join('\n');

    // Analyze BEFORE TestShaderGUI.cs exists (must NOT poison negative cache)
    const diagsBefore = collectComputeAndShaderLabDiagnostics(makeDoc(shaderPath, shaderText), graph);
    expect(diagsBefore.some((d) => d.message.includes('TestShaderGUI'))).toBe(true);
    expect(diagsBefore.some((d) => d.message.includes('_Surface'))).toBe(true);

    // Create TestShaderGUI.cs in Assets/Editor WITHOUT calling invalidateCustomEditorCache
    const csPath = path.join(ctx.projectRoot, 'Assets', 'Editor', 'TestShaderGUI.cs');
    fs.writeFileSync(
      csPath,
      [
        '#if UNITY_EDITOR',
        'using UnityEditor;',
        'public class TestShaderGUI : ShaderGUI',
        '{',
        '    public override void OnGUI(MaterialEditor ed, MaterialProperty[] props) { FindProperty("_Surface", props, false); }',
        '}',
        '#endif',
      ].join('\n'),
      'utf8',
    );

    const diagsAfter = collectComputeAndShaderLabDiagnostics(makeDoc(shaderPath, shaderText), graph);
    expect(diagsAfter.some((d) => d.message.includes('TestShaderGUI'))).toBe(false);
    expect(diagsAfter.some((d) => d.message.includes('_Surface'))).toBe(false);

    const defLocs = resolveCustomEditorDefinition(graph.getResolver(), 'TestShaderGUI', shaderPath);
    expect(defLocs.length).toBe(1);
    expect(path.resolve(defLocs[0].filePath)).toBe(path.resolve(csPath));
  });

  it('supports Tier-3 namespace-relaxed resolution for CustomEditor F12 and property tracking', () => {
    const ctx = createTempProject();
    const csPath = path.join(ctx.projectRoot, 'Assets', 'Editor', 'RelaxedGui.cs');
    fs.writeFileSync(
      csPath,
      [
        '#if UNITY_EDITOR',
        'using UnityEditor;',
        'public class RelaxedGui : ShaderGUI',
        '{',
        '    void Foo(MaterialProperty[] p) { FindProperty("_Surface", p, false); }',
        '}',
        '#endif',
      ].join('\n'),
      'utf8',
    );

    const graph = new IncludeDependencyGraph(ctx);
    const defLocs = resolveCustomEditorDefinition(graph.getResolver(), 'MyStudio.Shaders.RelaxedGui');
    expect(defLocs.length).toBe(1);
    expect(path.resolve(defLocs[0].filePath)).toBe(path.resolve(csPath));

    const propsRes = resolveCustomEditorProperties(graph.getResolver(), 'MyStudio.Shaders.RelaxedGui');
    expect(propsRes.resolved).toBe(true);
    expect(propsRes.referencedProperties.has('_Surface')).toBe(true);
  });

  it('resolves CustomEditor and Fallback even when resolver falls back to .context without getContext()', () => {
    const ctx = createTempProject();
    const csPath = path.join(ctx.projectRoot, 'Assets', 'Editor', 'FallbackCtxGui.cs');
    fs.writeFileSync(
      csPath,
      [
        'using UnityEditor;',
        'public class FallbackCtxGui : ShaderGUI',
        '{',
        '    void OnGUI() { FindProperty("_Surface", null, false); }',
        '}',
      ].join('\n'),
      'utf8',
    );
    const targetShaderPath = path.join(ctx.projectRoot, 'Assets', 'Shaders', 'TargetBase.shader');
    fs.writeFileSync(
      targetShaderPath,
      ['Shader "Custom/TargetBase"', '{', '}'].join('\n'),
      'utf8',
    );

    const graph = new IncludeDependencyGraph(ctx);
    const resolver = graph.getResolver();
    expect(typeof resolver.getContext).toBe('function');

    // Simulate a legacy resolver instance lacking getContext()
    const legacyResolver = Object.create(Object.getPrototypeOf(resolver));
    Object.assign(legacyResolver, resolver);
    Object.defineProperty(legacyResolver, 'getContext', { value: undefined });

    const propsRes = resolveCustomEditorProperties(legacyResolver, 'FallbackCtxGui');
    expect(propsRes.resolved).toBe(true);
    expect(propsRes.referencedProperties.has('_Surface')).toBe(true);

    const defLocs = resolveCustomEditorDefinition(legacyResolver, 'FallbackCtxGui');
    expect(defLocs.length).toBe(1);
    expect(path.resolve(defLocs[0].filePath)).toBe(path.resolve(csPath));

    const shaderLoc = resolveShaderDefinitionByName(legacyResolver, 'Custom/TargetBase');
    expect(shaderLoc).not.toBeNull();
    expect(path.resolve(shaderLoc!.filePath)).toBe(path.resolve(targetShaderPath));
  });

  it('emits Information diagnostic for legacy CGPROGRAM/CGINCLUDE blocks and ignores comments or HLSLPROGRAM', () => {
    const ctx = createTempProject();
    const graph = new IncludeDependencyGraph(ctx);

    const legacyShaderPath = path.join(ctx.projectRoot, 'Assets', 'Shaders', 'LegacyCg.shader');
    const legacyText = [
      'Shader "Custom/LegacyCg"',
      '{',
      '    SubShader',
      '    {',
      '        CGINCLUDE',
      '        ENDCG',
      '        Pass',
      '        {',
      '            // CGPROGRAM inside comment should be ignored',
      '            CGPROGRAM',
      '            #pragma vertex vert',
      '            #pragma fragment frag',
      '            float4 vert() : SV_POSITION { return 0; }',
      '            float4 frag() : SV_Target { return 1; }',
      '            ENDCG',
      '        }',
      '    }',
      '}',
    ].join('\n');

    const legacyDiags = collectComputeAndShaderLabDiagnostics(makeDoc(legacyShaderPath, legacyText), graph);
    const legacyWarns = legacyDiags.filter(
      (d) =>
        d.severity === vscode.DiagnosticSeverity.Warning &&
        d.message.includes('레거시 셰이더 블록'),
    );
    expect(legacyWarns.length).toBe(2);
    expect(legacyWarns[0].message).toContain('CGINCLUDE');
    expect(legacyWarns[0].message).toContain('HLSLINCLUDE');
    expect(legacyWarns[0].range.start.line).toBe(4);
    expect(legacyWarns[1].message).toContain('CGPROGRAM');
    expect(legacyWarns[1].message).toContain('HLSLPROGRAM');
    expect(legacyWarns[1].range.start.line).toBe(9);

    const modernShaderPath = path.join(ctx.projectRoot, 'Assets', 'Shaders', 'ModernHlsl.shader');
    const modernText = [
      'Shader "Custom/ModernHlsl"',
      '{',
      '    SubShader',
      '    {',
      '        HLSLINCLUDE',
      '        ENDHLSL',
      '        Pass',
      '        {',
      '            HLSLPROGRAM',
      '            #pragma vertex vert',
      '            #pragma fragment frag',
      '            float4 vert() : SV_POSITION { return 0; }',
      '            float4 frag() : SV_Target { return 1; }',
      '            ENDHLSL',
      '        }',
      '    }',
      '}',
    ].join('\n');

    const modernDiags = collectComputeAndShaderLabDiagnostics(makeDoc(modernShaderPath, modernText), graph);
    expect(modernDiags.some((d) => d.message.includes('레거시 셰이더 블록'))).toBe(false);
  });

  it('resolves nested static class Property and split partial class BaseShaderGUI in URP PackageCache', () => {
    const ctx = createTempProject();
    const urpRoot = path.join(
      ctx.projectRoot,
      'Library',
      'PackageCache',
      'com.unity.render-pipelines.universal@14.0.10',
    );
    const shaderGuiDir = path.join(urpRoot, 'Editor', 'ShaderGUI');
    const shadersGuiDir = path.join(shaderGuiDir, 'Shaders');
    fs.mkdirSync(shadersGuiDir, { recursive: true });
    fs.writeFileSync(
      path.join(ctx.projectRoot, 'Packages', 'manifest.json'),
      JSON.stringify({ dependencies: { 'com.unity.render-pipelines.universal': '14.0.10' } }),
      'utf8',
    );

    // Split partial class BaseShaderGUI + nested static class Property in another file (ShaderUtils.cs)
    fs.writeFileSync(
      path.join(shaderGuiDir, 'BaseShaderGUI.cs'),
      [
        'namespace UnityEditor.Rendering.Universal',
        '{',
        '    public abstract partial class BaseShaderGUI : ShaderGUI',
        '    {',
        '        protected MaterialProperty surfaceTypeProp;',
        '        public virtual void FindProperties(MaterialProperty[] properties)',
        '        {',
        '            surfaceTypeProp = FindProperty(Property.SurfaceType, properties, false);',
        '        }',
        '    }',
        '}',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(shaderGuiDir, 'BaseShaderGUI.Advanced.cs'),
      [
        'namespace UnityEditor.Rendering.Universal',
        '{',
        '    public abstract partial class BaseShaderGUI',
        '    {',
        '        protected MaterialProperty queueOffsetProp;',
        '        public void FindAdvanced(MaterialProperty[] properties)',
        '        {',
        '            queueOffsetProp = FindProperty(Property.QueueOffset, properties, false);',
        '        }',
        '    }',
        '}',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(shaderGuiDir, 'ShaderUtils.cs'),
      [
        'namespace UnityEditor.Rendering.Universal',
        '{',
        '    public static class Property',
        '    {',
        '        public static readonly string SurfaceType = "_Surface";',
        '        public static readonly string ReceiveShadows = "_ReceiveShadows";',
        '        public static readonly string QueueOffset = "_QueueOffset";',
        '    }',
        '}',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(shadersGuiDir, 'LitShader.cs'),
      [
        'namespace UnityEditor.Rendering.Universal.ShaderGUI',
        '{',
        '    internal class LitShader : BaseShaderGUI',
        '    {',
        '        public override void FindProperties(MaterialProperty[] properties)',
        '        {',
        '            base.FindProperties(properties);',
        '            var r = FindProperty(Property.ReceiveShadows, properties, false);',
        '        }',
        '    }',
        '}',
      ].join('\n'),
      'utf8',
    );

    const litShaderPath = path.join(urpRoot, 'Shaders', 'Lit.shader');
    fs.mkdirSync(path.dirname(litShaderPath), { recursive: true });
    const litText = [
      'Shader "Universal Render Pipeline/Lit"',
      '{',
      '    Properties',
      '    {',
      '        _Surface("Surface Type", Float) = 0.0',
      '        _ReceiveShadows("Receive Shadows", Float) = 1.0',
      '        [HideInInspector] _QueueOffset("Queue offset", Float) = 0.0',
      '        _DeadProp("Dead", Float) = 0.0',
      '    }',
      '    SubShader { Pass { HLSLPROGRAM ENDHLSL } }',
      '    CustomEditor "UnityEditor.Rendering.Universal.ShaderGUI.LitShader"',
      '}',
    ].join('\n');

    const graph = new IncludeDependencyGraph(ctx);
    const diags = collectComputeAndShaderLabDiagnostics(makeDoc(litShaderPath, litText), graph);
    expect(diags.some((d) => d.message.includes('_Surface'))).toBe(false);
    expect(diags.some((d) => d.message.includes('_ReceiveShadows'))).toBe(false);
    expect(diags.some((d) => d.message.includes('_QueueOffset'))).toBe(false);
    expect(diags.some((d) => d.message.includes('_DeadProp'))).toBe(true);
  });

  it('masks UNITY_DOTS_INSTANCED_PROP metadata blocks so _Surface does not trigger false SRP Batcher warnings', () => {
    const ctx = createTempProject();
    const csPath = path.join(ctx.projectRoot, 'Assets', 'Editor', 'DotsGui.cs');
    fs.writeFileSync(
      csPath,
      [
        'using UnityEditor;',
        'public class DotsGui : ShaderGUI',
        '{',
        '    void OnGUI(MaterialProperty[] p) { FindProperty("_Surface", p, false); }',
        '}',
      ].join('\n'),
      'utf8',
    );

    const shaderPath = path.join(ctx.projectRoot, 'Assets', 'Shaders', 'DotsLit.shader');
    const shaderText = [
      'Shader "Custom/DotsLit"',
      '{',
      '    Properties',
      '    {',
      '        _BaseColor("Color", Color) = (1,1,1,1)',
      '        _Surface("Surface", Float) = 0.0',
      '        _NonCbufferBodyProp("Body", Float) = 1.0',
      '    }',
      '    SubShader',
      '    {',
      '        Pass',
      '        {',
      '            HLSLPROGRAM',
      '            #pragma vertex vert',
      '            #pragma fragment frag',
      '            CBUFFER_START(UnityPerMaterial)',
      '                half4 _BaseColor;',
      '            CBUFFER_END',
      '            #ifdef UNITY_DOTS_INSTANCING_ENABLED',
      '                UNITY_DOTS_INSTANCING_START(MaterialPropertyMetadata)',
      '                    UNITY_DOTS_INSTANCED_PROP(float, _Surface)',
      '                UNITY_DOTS_INSTANCING_END(MaterialPropertyMetadata)',
      '                UNITY_DOTS_INSTANCED_PROP_OVERRIDE_SUPPORTED(float, _Surface)',
      '                void SetupDOTSLitMaterialPropertyCaches() {',
      '                    float s = UNITY_ACCESS_DOTS_INSTANCED_PROP_WITH_DEFAULT(float, _Surface);',
      '                }',
      '            #endif',
      '            float4 vert() : SV_POSITION { return 0; }',
      '            half4 frag() : SV_Target { half s = _Surface; return _BaseColor * _NonCbufferBodyProp * s; }',
      '            ENDHLSL',
      '        }',
      '    }',
      '    CustomEditor "DotsGui"',
      '}',
    ].join('\n');

    const graph = new IncludeDependencyGraph(ctx);
    const diags = collectComputeAndShaderLabDiagnostics(makeDoc(shaderPath, shaderText), graph);
    expect(diags.some((d) => d.message.includes('_Surface'))).toBe(false);
    expect(diags.some((d) => d.message.includes('_NonCbufferBodyProp') && d.message.includes('SRP Batcher'))).toBe(true);
  });

  it('still warns on unused shader properties even if Material.SetFloat or Shader.PropertyToID references them in C#', () => {
    const ctx = createTempProject();
    const scriptsDir = path.join(ctx.projectRoot, 'Assets', 'Scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(scriptsDir, 'MyController.cs'),
      [
        'using UnityEngine;',
        'public class MyController : MonoBehaviour',
        '{',
        '    static readonly int GlobalId = Shader.PropertyToID("_GlobalProp");',
        '    void Update(Material mat) { mat.SetFloat("_RuntimeProp", 1.0f); }',
        '}',
      ].join('\n'),
      'utf8',
    );

    const shaderPath = path.join(ctx.projectRoot, 'Assets', 'Shaders', 'RuntimeDriven.shader');
    const shaderText = [
      'Shader "Custom/RuntimeDriven"',
      '{',
      '    Properties',
      '    {',
      '        _RuntimeProp("Runtime", Float) = 0.0',
      '        _GlobalProp("Global", Float) = 0.0',
      '        _DeadProp("Dead", Float) = 0.0',
      '    }',
      '    SubShader { Pass { HLSLPROGRAM float4 v():SV_POSITION{return 0;} ENDHLSL } }',
      '}',
    ].join('\n');

    const graph = new IncludeDependencyGraph(ctx);
    const diags = collectComputeAndShaderLabDiagnostics(makeDoc(shaderPath, shaderText), graph);
    expect(diags.some((d) => d.message.includes('_RuntimeProp'))).toBe(true);
    expect(diags.some((d) => d.message.includes('_GlobalProp'))).toBe(true);
    expect(diags.some((d) => d.message.includes('_DeadProp'))).toBe(true);
  });

  it('ignores struct member, function parameter, and ShaderLibrary matches for SRP Batcher while catching loose globals', () => {
    const ctx = createTempProject();
    const csPath = path.join(ctx.projectRoot, 'Assets', 'Editor', 'SurfaceGui.cs');
    fs.writeFileSync(
      csPath,
      [
        'using UnityEditor;',
        'public class SurfaceGui : ShaderGUI',
        '{',
        '    void OnGUI(MaterialProperty[] p) { FindProperty("_Surface", p, false); }',
        '}',
      ].join('\n'),
      'utf8',
    );

    const shaderLibDir = path.join(ctx.projectRoot, 'Assets', 'Shaders', 'ShaderLibrary');
    fs.mkdirSync(shaderLibDir, { recursive: true });
    fs.writeFileSync(
      path.join(shaderLibDir, 'Common.hlsl'),
      [
        'struct SurfaceData { half _Surface; };',
        'half EvalSurface(half _Surface) { return _Surface; }',
      ].join('\n'),
      'utf8',
    );

    const shaderPath = path.join(ctx.projectRoot, 'Assets', 'Shaders', 'SurfaceCheck.shader');
    const shaderText = [
      'Shader "Custom/SurfaceCheck"',
      '{',
      '    Properties',
      '    {',
      '        _BaseColor("Color", Color) = (1,1,1,1)',
      '        _Surface("__surface", Float) = 0.0',
      '        _LooseProp("Loose", Float) = 1.0',
      '    }',
      '    SubShader',
      '    {',
      '        Pass',
      '        {',
      '            HLSLPROGRAM',
      '            #pragma vertex vert',
      '            #pragma fragment frag',
      '            #include "ShaderLibrary/Common.hlsl"',
      '            CBUFFER_START(UnityPerMaterial)',
      '                half4 _BaseColor;',
      '            CBUFFER_END',
      '            half _LooseProp;',
      '            half Helper(half _Surface) { SurfaceData d; d._Surface = 0; return d._Surface; }',
      '            float4 vert() : SV_POSITION { return 0; }',
      '            half4 frag() : SV_Target { return _BaseColor * _LooseProp * Helper(1.0); }',
      '            ENDHLSL',
      '        }',
      '    }',
      '    CustomEditor "SurfaceGui"',
      '}',
    ].join('\n');

    const graph = new IncludeDependencyGraph(ctx);
    const diags = collectComputeAndShaderLabDiagnostics(makeDoc(shaderPath, shaderText), graph);
    expect(diags.some((d) => d.message.includes('_Surface'))).toBe(false);
    expect(diags.some((d) => d.message.includes('_LooseProp') && d.message.includes('SRP Batcher'))).toBe(true);
  });
});
