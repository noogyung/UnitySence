import fs from 'node:fs';
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
const EXT_PATH = path.join(REPO_ROOT, 'packages', 'extension');

describe('MsbuildAnalyzerInjector', () => {
  afterEach(() => {
    vscode.__mock.reset();
    if (fs.existsSync(TEMP_PROJ)) {
      fs.rmSync(TEMP_PROJ, { recursive: true, force: true });
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
    expect(content).toContain('project-settings.json');
    expect(content).toContain('unity-api.json');

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
});
