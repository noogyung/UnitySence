import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { UnityProjectContext } from '../../src/contracts/index.ts';
import {
  parseAnimatorControllerYaml,
  ProjectSettingsWatcher,
} from '../../src/watchers/projectSettingsWatcher.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');
const SAMPLE_PROJECT = path.join(REPO_ROOT, 'test-fixtures', 'SampleUnityProject');
const TEMP_CACHE_DIR = path.join(REPO_ROOT, 'test-output', 'project-settings-cache');

describe('ProjectSettingsWatcher', () => {
  afterEach(() => {
    if (fs.existsSync(TEMP_CACHE_DIR)) {
      fs.rmSync(TEMP_CACHE_DIR, { recursive: true, force: true });
    }
  });

  it('parses TagManager, InputManager, EditorBuildSettings, and AnimatorController YAML and writes project-settings.json', async () => {
    const ctx: UnityProjectContext = {
      projectRoot: SAMPLE_PROJECT,
      editorVersion: '6000.0.23f1',
      editorInstallPath: null,
      cgIncludesPath: null,
      builtInPackagesPath: null,
      manifestPath: path.join(SAMPLE_PROJECT, 'Packages', 'manifest.json'),
      packagesLockPath: null,
      cacheDir: TEMP_CACHE_DIR,
    };

    const watcher = new ProjectSettingsWatcher(ctx, { enableWatchers: false });
    const cache = await watcher.start();

    expect(cache.schemaVersion).toBe(1);
    expect(cache.tags).toContain('Untagged');
    expect(cache.tags).toContain('Player');
    expect(cache.tags).toContain('Enemy');
    expect(cache.tags).toContain('Interactable');

    expect(cache.layers).toContainEqual({ index: 0, name: 'Default' });
    expect(cache.layers).toContainEqual({ index: 8, name: 'Ground' });
    expect(cache.layers).toContainEqual({ index: 9, name: 'Hitbox' });
    expect(cache.layers.some((l) => l.name === '')).toBe(false);

    expect(cache.sortingLayers).toContainEqual({ id: 1001, name: 'Background' });
    expect(cache.sortingLayers).toContainEqual({ id: 1002, name: 'Foreground' });

    expect(cache.inputAxes.map((a) => a.name)).toEqual(['Horizontal', 'Vertical', 'Fire1', 'Jump']);

    expect(cache.buildScenes.length).toBe(2);
    expect(cache.buildScenes[0]).toEqual({
      name: 'MainMenu',
      path: 'Assets/Scenes/MainMenu.unity',
      guid: '11111111111111111111111111111111',
      buildIndex: 0,
      enabled: true,
    });
    expect(cache.buildScenes[1]).toEqual({
      name: 'Stage01',
      path: 'Assets/Scenes/Stage01.unity',
      guid: '33333333333333333333333333333333',
      buildIndex: 1,
      enabled: true,
    });

    expect(cache.animatorControllers.length).toBe(1);
    const ctrl = cache.animatorControllers[0];
    expect(ctrl.guid).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(ctrl.parameters).toContainEqual({ name: 'Speed', type: 'Float' });
    expect(ctrl.parameters).toContainEqual({ name: 'JumpCount', type: 'Int' });
    expect(ctrl.parameters).toContainEqual({ name: 'IsGrounded', type: 'Bool' });
    expect(ctrl.parameters).toContainEqual({ name: 'Attack', type: 'Trigger' });
    expect(ctrl.states).toEqual(['Idle', 'Run', 'Jump']);

    // ProjectSettings 원본을 메모리로만 읽으며 디스크에 중복 캐시를 쓰지 않아야 함
    expect(fs.existsSync(TEMP_CACHE_DIR)).toBe(false);
    watcher.dispose();
  });

  it('stops parsing AnimatorController parameters at m_AnimatorLayers even when layer entries contain m_Name and m_Type', () => {
    const yaml = [
      '%YAML 1.1',
      '--- !u!91 &9100000',
      'AnimatorController:',
      '  m_Name: PlayerCtrl',
      '  m_AnimatorParameters:',
      '  - m_Name: MoveSpeed',
      '    m_Type: 1',
      '  - m_Name: IsJumping',
      '    m_Type: 4',
      '  m_AnimatorLayers:',
      '  - serializedVersion: 5',
      '    m_Name: Base Layer',
      '    m_Type: 3',
      '  - m_Name: UpperBody',
      '    m_Type: 9',
    ].join('\n');

    const parsed = parseAnimatorControllerYaml(yaml, 'Assets/Anim/PlayerCtrl.controller', 'deadbeef');
    expect(parsed.parameters).toEqual([
      { name: 'MoveSpeed', type: 'Float' },
      { name: 'IsJumping', type: 'Bool' },
    ]);
  });
});
