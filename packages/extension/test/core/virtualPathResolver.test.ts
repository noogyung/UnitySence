import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vscode from 'vscode';
import { afterEach, describe, expect, it } from 'vitest';
import { UnityProjectContextManager } from '../../src/core/unityProjectContext.ts';
import { UnityVirtualPathResolver } from '../../src/core/virtualPathResolver.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');
const SAMPLE_EDITOR = path.join(REPO_ROOT, 'test-fixtures', 'SampleEditor');
const TEMP_ROOT = path.join(REPO_ROOT, 'test-output', 'vfs-test-temp');

function createIsolatedVfsProject(): string {
  const root = path.join(TEMP_ROOT, `proj-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(path.join(root, 'Assets', 'Shaders', 'Include'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ProjectSettings'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Packages', 'com.unity.custom.embedded', 'Shaders'), { recursive: true });
  fs.mkdirSync(path.join(root, 'LocalPackages', 'com.unity.custom.localpkg', 'Shaders'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Library', 'PackageCache', 'com.unity.render-pipelines.universal@17.0.3', 'ShaderLibrary'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Library', 'PackageCache', 'com.unity.render-pipelines.core@a1b2c3d4e5f6', 'ShaderLibrary'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Library', 'PackageCache', 'com.unity.custom.gitpkg@1.2.0', 'ShaderLibrary'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Library', 'PackageCache', 'com.unity.render-pipelines.universal@d7774c218bdf', 'ShaderLibrary'), { recursive: true });

  fs.writeFileSync(path.join(root, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0.23f1\n');
  fs.writeFileSync(
    path.join(root, 'Packages', 'manifest.json'),
    JSON.stringify(
      {
        dependencies: {
          'com.unity.render-pipelines.universal': '17.0.3',
          'com.unity.render-pipelines.core': '17.0.3',
          'com.unity.custom.embedded': '1.0.0',
          'com.unity.custom.localpkg': 'file:../LocalPackages/com.unity.custom.localpkg',
          'com.unity.custom.gitpkg': 'https://example.invalid/custom-gitpkg.git',
          'com.unity.modules.physics': '1.0.0',
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(root, 'Packages', 'packages-lock.json'),
    JSON.stringify(
      {
        dependencies: {
          'com.unity.render-pipelines.universal': { version: '17.0.3', source: 'registry' },
          'com.unity.render-pipelines.core': { version: '17.0.3', source: 'registry' },
          'com.unity.custom.embedded': { version: 'file:com.unity.custom.embedded', source: 'embedded' },
          'com.unity.custom.localpkg': { version: 'file:../LocalPackages/com.unity.custom.localpkg', source: 'local' },
          'com.unity.custom.gitpkg': { version: '1.2.0', source: 'git' },
          'com.unity.modules.physics': { version: '1.0.0', source: 'builtin' },
        },
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(path.join(root, 'Assets', 'Shaders', 'TestLit.shader'), 'Shader "Test/Lit" {}\n');
  fs.writeFileSync(path.join(root, 'Assets', 'Shaders', 'Include', 'LocalShaderHelper.hlsl'), '// helper\n');
  fs.writeFileSync(path.join(root, 'Packages', 'com.unity.custom.embedded', 'package.json'), '{"name":"com.unity.custom.embedded"}\n');
  fs.writeFileSync(path.join(root, 'Packages', 'com.unity.custom.embedded', 'Shaders', 'EmbeddedLib.hlsl'), '// embedded\n');
  fs.writeFileSync(path.join(root, 'LocalPackages', 'com.unity.custom.localpkg', 'Shaders', 'LocalUtil.hlsl'), '// local\n');
  fs.writeFileSync(path.join(root, 'Library', 'PackageCache', 'com.unity.render-pipelines.universal@17.0.3', 'ShaderLibrary', 'Core.hlsl'), '// core\n');
  fs.writeFileSync(path.join(root, 'Library', 'PackageCache', 'com.unity.render-pipelines.universal@17.0.3', 'ShaderLibrary', 'Lighting.hlsl'), '// lighting\n');
  fs.writeFileSync(path.join(root, 'Library', 'PackageCache', 'com.unity.render-pipelines.core@a1b2c3d4e5f6', 'ShaderLibrary', 'Common.hlsl'), '// common\n');
  fs.writeFileSync(path.join(root, 'Library', 'PackageCache', 'com.unity.custom.gitpkg@1.2.0', 'ShaderLibrary', 'GitHelper.hlsl'), '// git\n');
  fs.writeFileSync(path.join(root, 'Library', 'PackageCache', 'com.unity.render-pipelines.universal@d7774c218bdf', 'ShaderLibrary', 'Core.hlsl'), '// unity6 core\n');

  return root;
}

describe('UnityProjectContextManager & UnityVirtualPathResolver', () => {
  afterEach(() => {
    vscode.__mock.reset();
    if (fs.existsSync(TEMP_ROOT)) {
      fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
    }
  });

  it('detects editorVersion, cgIncludesPath, and builtInPackagesPath from Unity project', async () => {
    const projectRoot = createIsolatedVfsProject();
    const mgr = new UnityProjectContextManager({
      workspaceRoot: projectRoot,
      unityEditorPath: SAMPLE_EDITOR,
      enableWatchers: false,
    });

    const ctx = await mgr.initialize();
    expect(ctx).not.toBeNull();
    expect(ctx?.projectRoot).toBe(path.resolve(projectRoot));
    expect(ctx?.editorVersion).toBe('6000.0.23f1');
    expect(ctx?.cgIncludesPath).toBe(path.join(SAMPLE_EDITOR, 'Data', 'CGIncludes'));
    expect(ctx?.builtInPackagesPath).toBe(
      path.join(SAMPLE_EDITOR, 'Data', 'Resources', 'PackageManager', 'BuiltInPackages'),
    );
    mgr.dispose();
  });

  it('resolves all 5 package sources, Unity 6 hash & builtin-in-PackageCache fallback, Assets, relative includes, and CGIncludes', async () => {
    const projectRoot = createIsolatedVfsProject();
    const mgr = new UnityProjectContextManager({
      workspaceRoot: projectRoot,
      unityEditorPath: SAMPLE_EDITOR,
      enableWatchers: false,
    });
    const ctx = await mgr.initialize();
    expect(ctx).not.toBeNull();

    const resolver = new UnityVirtualPathResolver(ctx!);
    const currentShader = path.join(projectRoot, 'Assets', 'Shaders', 'TestLit.shader');

    // 1. registry (exact version folder)
    const reg = resolver.resolve('Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl', currentShader);
    expect(reg.physicalPath).toBe(
      path.resolve(projectRoot, 'Library/PackageCache/com.unity.render-pipelines.universal@17.0.3/ShaderLibrary/Core.hlsl'),
    );
    expect(reg.resolvedVia).toBe('registry');

    // 2. Unity 6 hashed folder fallback (packageCacheFallback)
    const hashed = resolver.resolve('Packages/com.unity.render-pipelines.core/ShaderLibrary/Common.hlsl', currentShader);
    expect(hashed.physicalPath).toBe(
      path.resolve(projectRoot, 'Library/PackageCache/com.unity.render-pipelines.core@a1b2c3d4e5f6/ShaderLibrary/Common.hlsl'),
    );
    expect(hashed.resolvedVia).toBe('packageCacheFallback');

    // 3. embedded
    const embedded = resolver.resolve('Packages/com.unity.custom.embedded/Shaders/EmbeddedLib.hlsl', currentShader);
    expect(embedded.physicalPath).toBe(
      path.resolve(projectRoot, 'Packages/com.unity.custom.embedded/Shaders/EmbeddedLib.hlsl'),
    );
    expect(embedded.resolvedVia).toBe('embedded');

    // 4. local (file:...)
    const localPkg = resolver.resolve('Packages/com.unity.custom.localpkg/Shaders/LocalUtil.hlsl', currentShader);
    expect(localPkg.physicalPath).toBe(
      path.resolve(projectRoot, 'LocalPackages/com.unity.custom.localpkg/Shaders/LocalUtil.hlsl'),
    );
    expect(localPkg.resolvedVia).toBe('local');

    // 5. git
    const gitPkg = resolver.resolve('Packages/com.unity.custom.gitpkg/ShaderLibrary/GitHelper.hlsl', currentShader);
    expect(gitPkg.physicalPath).toBe(
      path.resolve(projectRoot, 'Library/PackageCache/com.unity.custom.gitpkg@1.2.0/ShaderLibrary/GitHelper.hlsl'),
    );
    expect(gitPkg.resolvedVia).toBe('git');

    // 6. builtin
    const builtin = resolver.resolve('Packages/com.unity.modules.physics/Shaders/PhysicsBuiltin.hlsl', currentShader);
    expect(builtin.physicalPath).toBe(
      path.resolve(SAMPLE_EDITOR, 'Data/Resources/PackageManager/BuiltInPackages/com.unity.modules.physics/Shaders/PhysicsBuiltin.hlsl'),
    );
    expect(builtin.resolvedVia).toBe('builtin');

    // 7. relative include
    const rel = resolver.resolve('./Include/LocalShaderHelper.hlsl', currentShader);
    expect(rel.physicalPath).toBe(
      path.resolve(projectRoot, 'Assets/Shaders/Include/LocalShaderHelper.hlsl'),
    );
    expect(rel.resolvedVia).toBe('relative');

    // 8. CGIncludes fallback
    const cg = resolver.resolve('UnityCG.cginc', currentShader);
    expect(cg.physicalPath).toBe(path.resolve(SAMPLE_EDITOR, 'Data/CGIncludes/UnityCG.cginc'));
    expect(cg.resolvedVia).toBe('cgIncludes');

    // 9. Virtual directory listing
    const pkgDirs = resolver.listVirtualDirectory('Packages/');
    expect(pkgDirs.some((d) => d.name === 'com.unity.render-pipelines.universal')).toBe(true);
    const urpFiles = resolver.listVirtualDirectory('Packages/com.unity.render-pipelines.universal/ShaderLibrary/');
    expect(urpFiles.some((f) => f.name === 'Core.hlsl')).toBe(true);
    expect(urpFiles.some((f) => f.name === 'Lighting.hlsl')).toBe(true);

    // 10. Unity 6 builtin-source package unpacked inside Library/PackageCache/<pkg>@<hash>
    fs.rmSync(
      path.join(projectRoot, 'Library', 'PackageCache', 'com.unity.render-pipelines.universal@17.0.3'),
      { recursive: true, force: true },
    );
    fs.writeFileSync(
      path.join(projectRoot, 'Packages', 'packages-lock.json'),
      JSON.stringify(
        {
          dependencies: {
            'com.unity.render-pipelines.universal': { version: '17.5.0', source: 'builtin' },
          },
        },
        null,
        2,
      ),
    );
    resolver.invalidateCache();
    const unity6Urp = resolver.resolve(
      'Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl',
      currentShader,
    );
    expect(unity6Urp.physicalPath).toBe(
      path.resolve(projectRoot, 'Library/PackageCache/com.unity.render-pipelines.universal@d7774c218bdf/ShaderLibrary/Core.hlsl'),
    );
    expect(unity6Urp.resolvedVia).toBe('packageCacheFallback');

    mgr.dispose();
  });

  it('invalidates cached package resolutions immediately when packages-lock.json is modified', async () => {
    fs.mkdirSync(path.join(TEMP_ROOT, 'Assets'), { recursive: true });
    fs.mkdirSync(path.join(TEMP_ROOT, 'ProjectSettings'), { recursive: true });
    fs.mkdirSync(path.join(TEMP_ROOT, 'Packages'), { recursive: true });
    fs.mkdirSync(path.join(TEMP_ROOT, 'Library/PackageCache/com.acme.test@1.0.0/Shaders'), { recursive: true });
    fs.mkdirSync(path.join(TEMP_ROOT, 'Library/PackageCache/com.acme.test@2.0.0/Shaders'), { recursive: true });

    fs.writeFileSync(path.join(TEMP_ROOT, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 6000.0.23f1\n');
    fs.writeFileSync(
      path.join(TEMP_ROOT, 'Packages/manifest.json'),
      JSON.stringify({ dependencies: { 'com.acme.test': '1.0.0' } }, null, 2),
    );
    const lockPath = path.join(TEMP_ROOT, 'Packages/packages-lock.json');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ dependencies: { 'com.acme.test': { version: '1.0.0', source: 'registry' } } }, null, 2),
    );
    const v1File = path.join(TEMP_ROOT, 'Library/PackageCache/com.acme.test@1.0.0/Shaders/Acme.hlsl');
    const v2File = path.join(TEMP_ROOT, 'Library/PackageCache/com.acme.test@2.0.0/Shaders/Acme.hlsl');
    fs.writeFileSync(v1File, '// v1');
    fs.writeFileSync(v2File, '// v2');

    const mgr = new UnityProjectContextManager({
      workspaceRoot: TEMP_ROOT,
      enableWatchers: false,
    });
    const ctx = await mgr.initialize();
    const resolver = new UnityVirtualPathResolver(ctx!);

    expect(resolver.resolve('Packages/com.acme.test/Shaders/Acme.hlsl').physicalPath).toBe(path.resolve(v1File));

    // Modify packages-lock.json to version 2.0.0 (bump mtime deliberately in case clock is coarse)
    const futureMs = Date.now() + 2000;
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ dependencies: { 'com.acme.test': { version: '2.0.0', source: 'registry' } } }, null, 2),
    );
    fs.utimesSync(lockPath, futureMs / 1000, futureMs / 1000);

    expect(resolver.resolve('Packages/com.acme.test/Shaders/Acme.hlsl').physicalPath).toBe(path.resolve(v2File));
    mgr.dispose();
  });
});
