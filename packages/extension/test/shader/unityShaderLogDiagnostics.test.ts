import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  parseUnityShaderLog,
  UnityShaderLogDiagnosticsProvider,
} from '../../src/shader/unityShaderLogDiagnostics.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');
const tempDirs: string[] = [];
const providers: UnityShaderLogDiagnosticsProvider[] = [];

function createTempProject(): string {
  const baseOut = path.join(REPO_ROOT, 'test-output');
  fs.mkdirSync(baseOut, { recursive: true });
  const root = fs.mkdtempSync(path.join(baseOut, 'ub-unity-shader-log-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'Assets', 'Shaders'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Logs'), { recursive: true });
  return root;
}

function makeDoc(filePath: string, content: string): vscode.TextDocument {
  const lines = content.split(/\r?\n/);
  return {
    uri: vscode.Uri.file(filePath),
    fileName: filePath,
    languageId: 'unity-shaderlab',
    version: 1,
    lineCount: lines.length,
    getText: () => content,
    lineAt: (line: number) => ({
      lineNumber: line,
      text: lines[line] ?? '',
      range: new vscode.Range(line, 0, line, (lines[line] ?? '').length),
    }),
  } as unknown as vscode.TextDocument;
}

afterEach(() => {
  while (providers.length > 0) {
    providers.pop()!.dispose();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('UnityShaderLogDiagnosticsProvider', () => {
  it('parses Unity shader errors and warnings across formats and merges duplicate graphics APIs', () => {
    const root = createTempProject();
    const logContent = [
      "Shader error in 'Custom/TestGui': undeclared identifier 'foo' at Assets/Shaders/TestGui.shader(18) (on d3d11)",
      "Shader error in 'Custom/TestGui': undeclared identifier 'foo' at Assets/Shaders/TestGui.shader(18) (on vulkan)",
      "Shader warning in 'Custom/TestGui': implicit truncation of vector type at line 25 (on d3d11)",
      "Shader error in 'MyCompute.compute': Kernel 'CSMain' not found",
    ].join('\n');

    const index = parseUnityShaderLog(logContent, root);
    const shaderPath = path.join(root, 'Assets', 'Shaders', 'TestGui.shader');
    const byFile = index.byFilePath.get(path.resolve(shaderPath).toLowerCase()) ?? [];
    expect(byFile.length).toBe(1);
    expect(byFile[0].severity).toBe('error');
    expect(byFile[0].line).toBe(17);
    expect(byFile[0].apis).toEqual(['d3d11', 'vulkan']);

    const byName = index.byShaderName.get('Custom/TestGui') ?? [];
    expect(byName.length).toBe(2);
    expect(byName[1].severity).toBe('warning');
    expect(byName[1].line).toBe(24);

    const byComputeName = index.byFileName.get('mycompute.compute') ?? [];
    expect(byComputeName.length).toBe(1);
    expect(byComputeName[0].line).toBe(0);
  });

  it('clears stale diagnostics when a newer Start importing or Compiling shader occurs', () => {
    const root = createTempProject();
    const logContent = [
      "Shader error in 'Custom/TestGui': syntax error at Assets/Shaders/TestGui.shader(10) (on d3d11)",
      'Start importing Assets/Shaders/TestGui.shader using Guid(1234567890abcdef)',
      'Compiling shader "Custom/TestGui" pass "ForwardLit"',
      "Shader warning in 'Custom/TestGui': floating point division by zero at Assets/Shaders/TestGui.shader(12)",
    ].join('\n');

    const index = parseUnityShaderLog(logContent, root);
    const shaderPath = path.join(root, 'Assets', 'Shaders', 'TestGui.shader');
    const active = index.byFilePath.get(path.resolve(shaderPath).toLowerCase()) ?? [];
    expect(active.length).toBe(1);
    expect(active[0].severity).toBe('warning');
    expect(active[0].line).toBe(11);
  });

  it('provides live diagnostics for open shader documents and refreshes when Editor.log changes', () => {
    const root = createTempProject();
    const logPath = path.join(root, 'Logs', 'Editor.log');
    fs.writeFileSync(
      logPath,
      "Shader error in 'Custom/TestGui': undeclared identifier 'badVar' at Assets/Shaders/TestGui.shader(3) (on d3d11)\n",
      'utf8',
    );

    const provider = new UnityShaderLogDiagnosticsProvider({
      projectRoot: root,
      logPathOverride: logPath,
      enableWatch: false,
    });
    providers.push(provider);

    const shaderPath = path.join(root, 'Assets', 'Shaders', 'TestGui.shader');
    const doc = makeDoc(
      shaderPath,
      [
        'Shader "Custom/TestGui"',
        '{',
        '    half4 x = badVar;',
        '}',
      ].join('\n'),
    );

    const diags1 = provider.getDiagnosticsForDocument(doc);
    expect(diags1.length).toBe(1);
    expect(diags1[0].severity).toBe(vscode.DiagnosticSeverity.Error);
    expect(diags1[0].range.start.line).toBe(2);
    expect(diags1[0].source).toBe('Unity Shader Compiler');
    expect(diags1[0].message).toContain('[Unity]');

    // Update Editor.log with clean reimport
    fs.writeFileSync(
      logPath,
      'Start importing Assets/Shaders/TestGui.shader using Guid(1234)\n',
      'utf8',
    );
    const bump = new Date(Date.now() + 2000);
    fs.utimesSync(logPath, bump, bump);

    const diags2 = provider.getDiagnosticsForDocument(doc);
    expect(diags2.length).toBe(0);
  });

  it('parses [Worker0] prefixed shader errors and clears at-line errors when the .shader file on disk is re-imported', () => {
    const root = createTempProject();
    const shaderPath = path.join(root, 'Assets', 'Shaders', 'TestGui.shader');
    fs.writeFileSync(shaderPath, 'Shader "Custom/TestGui"\n{\n}\n', 'utf8');

    const logContent = [
      "[Worker0] Shader error in 'Custom/TestGui': undeclared identifier 'x' at line 14 (on d3d11)",
      'Done importing asset: \'Assets/Shaders/TestGui.shader\'',
    ].join('\n');

    const index = parseUnityShaderLog(logContent, root);
    expect(index.byShaderName.get('Custom/TestGui') ?? []).toEqual([]);

    const logWithError = [
      "[Worker0] Shader error in 'Custom/TestGui': undeclared identifier 'x' at line 14 (on d3d11)",
    ].join('\n');
    const indexWithError = parseUnityShaderLog(logWithError, root);
    const errs = indexWithError.byShaderName.get('Custom/TestGui') ?? [];
    expect(errs.length).toBe(1);
    expect(errs[0].line).toBe(13);
  });
});
