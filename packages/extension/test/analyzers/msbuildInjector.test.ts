import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vscode from 'vscode';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BEGIN_MARKER,
  END_MARKER,
  MsbuildAnalyzerInjector,
} from '../../src/analyzers/msbuildInjector.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');
const TEMP_PROJ = path.join(REPO_ROOT, 'test-output', 'msbuild-injector-test');
const TEMP_MOCK_EXT = path.join(REPO_ROOT, 'test-output', 'msbuild-injector-mock-ext');
const TEMP_SHADOW_DIR = path.join(os.tmpdir(), 'unitybrain-runtime', 'analyzers');
const EXT_PATH = path.join(REPO_ROOT, 'packages', 'extension');

describe('MsbuildAnalyzerInjector', () => {
  afterEach(() => {
    vscode.__mock.reset();
    if (fs.existsSync(TEMP_PROJ)) {
      fs.rmSync(TEMP_PROJ, { recursive: true, force: true });
    }
    if (fs.existsSync(TEMP_MOCK_EXT)) {
      fs.rmSync(TEMP_MOCK_EXT, { recursive: true, force: true });
    }
    if (fs.existsSync(TEMP_SHADOW_DIR)) {
      fs.rmSync(TEMP_SHADOW_DIR, { recursive: true, force: true });
    }
  });

  it('creates Directory.Build.props with Analyzer and AdditionalFiles inside managed markers', async () => {
    fs.mkdirSync(TEMP_PROJ, { recursive: true });
    const injector = new MsbuildAnalyzerInjector({
      extensionPath: EXT_PATH,
      projectRoot: TEMP_PROJ,
    });

    const status = await injector.ensureInjected();
    expect(status).toBe('injected');

    const content = fs.readFileSync(injector.getPropsFilePath(), 'utf8');
    expect(content).toContain(BEGIN_MARKER);
    expect(content).toContain(END_MARKER);
    expect(content).toContain('UnityBrain.Analyzers.dll');
    expect(content).toContain('TagManager.asset');
    expect(content).toContain('EditorBuildSettings.asset');
    expect(content).toContain('unity-api.json');
    expect(content).not.toContain('project-settings.json');

    // Second run is idempotent
    expect(await injector.ensureInjected()).toBe('unchanged');
  });

  it('preserves user-defined MSBuild properties and removes only managed block when disabled', async () => {
    fs.mkdirSync(TEMP_PROJ, { recursive: true });
    const propsPath = path.join(TEMP_PROJ, 'Directory.Build.props');
    const customXml = `<Project>
  <PropertyGroup>
    <CustomUnityFlag>KeepMeSafe</CustomUnityFlag>
  </PropertyGroup>
</Project>
`;
    fs.writeFileSync(propsPath, customXml, 'utf8');

    const injector = new MsbuildAnalyzerInjector({
      extensionPath: EXT_PATH,
      projectRoot: TEMP_PROJ,
    });
    await injector.ensureInjected();
    const afterInject = fs.readFileSync(propsPath, 'utf8');
    expect(afterInject).toContain('<CustomUnityFlag>KeepMeSafe</CustomUnityFlag>');
    expect(afterInject).toContain(BEGIN_MARKER);

    // Disable analyzers via config -> cleanly remove managed block
    await vscode.workspace.getConfiguration('unityBrain').update('analyzers.enabled', false);
    const removeRes = await injector.ensureInjected();
    expect(removeRes).toBe('removed');

    const afterRemove = fs.readFileSync(propsPath, 'utf8');
    expect(afterRemove).toContain('<CustomUnityFlag>KeepMeSafe</CustomUnityFlag>');
    expect(afterRemove).not.toContain(BEGIN_MARKER);
    expect(afterRemove).not.toContain('UnityBrain.Analyzers.dll');
  });

  it('shadow-copies UnityBrain.Analyzers.dll into temp runtime dir without creating Library/UnityBrainCache and remains idempotent', async () => {
    fs.mkdirSync(TEMP_PROJ, { recursive: true });
    fs.mkdirSync(path.join(TEMP_MOCK_EXT, 'analyzers'), { recursive: true });
    fs.mkdirSync(path.join(TEMP_MOCK_EXT, 'resources'), { recursive: true });

    const sourceDll = path.join(TEMP_MOCK_EXT, 'analyzers', 'UnityBrain.Analyzers.dll');
    const sourcePdb = path.join(TEMP_MOCK_EXT, 'analyzers', 'UnityBrain.Analyzers.pdb');
    fs.writeFileSync(sourceDll, 'dummy-analyzer-dll-v1', 'utf8');
    fs.writeFileSync(sourcePdb, 'dummy-analyzer-pdb-v1', 'utf8');
    fs.writeFileSync(path.join(TEMP_MOCK_EXT, 'resources', 'unity-api.json'), '{}', 'utf8');

    const injector = new MsbuildAnalyzerInjector({
      extensionPath: TEMP_MOCK_EXT,
      projectRoot: TEMP_PROJ,
    });

    const firstStatus = await injector.ensureInjected();
    expect(firstStatus).toBe('injected');

    const expectedShadowDll = path.join(TEMP_SHADOW_DIR, 'UnityBrain.Analyzers.dll');
    const expectedShadowPdb = path.join(TEMP_SHADOW_DIR, 'UnityBrain.Analyzers.pdb');

    expect(fs.existsSync(path.join(TEMP_PROJ, 'Library', 'UnityBrainCache'))).toBe(false);
    expect(fs.existsSync(expectedShadowDll)).toBe(true);
    expect(fs.existsSync(expectedShadowPdb)).toBe(true);
    expect(fs.readFileSync(expectedShadowDll, 'utf8')).toBe('dummy-analyzer-dll-v1');
    expect(fs.readFileSync(expectedShadowPdb, 'utf8')).toBe('dummy-analyzer-pdb-v1');

    const propsContent = fs.readFileSync(injector.getPropsFilePath(), 'utf8');
    expect(propsContent).toContain(`<Analyzer Include="${expectedShadowDll}"`);
    expect(propsContent).not.toContain(sourceDll);

    // Second call with unchanged DLL is completely idempotent
    expect(await injector.ensureInjected()).toBe('unchanged');

    // Updating source DLL refreshes shadow copy without altering Directory.Build.props path
    fs.writeFileSync(sourceDll, 'dummy-analyzer-dll-v2-updated', 'utf8');
    expect(await injector.ensureInjected()).toBe('unchanged');
    expect(fs.readFileSync(expectedShadowDll, 'utf8')).toBe('dummy-analyzer-dll-v2-updated');
  });

  it('falls back to source DLL path cleanly when extension analyzers DLL does not exist on disk', async () => {
    fs.mkdirSync(TEMP_PROJ, { recursive: true });
    fs.mkdirSync(TEMP_MOCK_EXT, { recursive: true });

    const injector = new MsbuildAnalyzerInjector({
      extensionPath: TEMP_MOCK_EXT,
      projectRoot: TEMP_PROJ,
    });

    const status = await injector.ensureInjected();
    expect(status).toBe('injected');

    const expectedSourceDll = path.join(TEMP_MOCK_EXT, 'analyzers', 'UnityBrain.Analyzers.dll');
    expect(fs.existsSync(TEMP_SHADOW_DIR)).toBe(false);
    expect(fs.readFileSync(injector.getPropsFilePath(), 'utf8')).toContain(
      `<Analyzer Include="${expectedSourceDll}"`,
    );
    expect(await injector.ensureInjected()).toBe('unchanged');
  });
});
