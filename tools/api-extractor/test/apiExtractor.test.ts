import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractUnityApiXmlToJson } from '../src/index.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../..');

describe('extractUnityApiXmlToJson', () => {
  it('converts sample-api.xml into schema-valid UnityApiDatabase with performance and coroutine metadata', () => {
    const xmlPath = path.join(TEST_DIR, 'fixtures', 'sample-api.xml');
    const xml = fs.readFileSync(xmlPath, 'utf8');
    const db = extractUnityApiXmlToJson(xml, 'test-commit');

    expect(db.schemaVersion).toBe(1);
    expect(db.sourceCommit).toBe('test-commit');
    expect(db.types.length).toBeGreaterThanOrEqual(7);

    const mono = db.types.find((t) => t.fullName === 'UnityEngine.MonoBehaviour');
    expect(mono).toBeDefined();
    expect(mono?.kind).toBe('class');

    const update = mono?.events.find((e) => e.name === 'Update');
    expect(update?.isPerformanceCritical).toBe(true);
    expect(update?.supportsCoroutine).toBe(false);

    const onTriggerEnter = mono?.events.find((e) => e.name === 'OnTriggerEnter');
    expect(onTriggerEnter?.supportsCoroutine).toBe(true);
    expect(onTriggerEnter?.parameters).toEqual([
      {
        name: 'other',
        type: 'UnityEngine.Collider',
        description: 'The other Collider involved in this collision.',
      },
    ]);

    const postprocessor = db.types.find((t) => t.fullName === 'UnityEditor.AssetPostprocessor');
    const onAll = postprocessor?.events.find((e) => e.name === 'OnPostprocessAllAssets');
    expect(onAll?.isStatic).toBe(true);
    expect(onAll?.parameters.length).toBe(4);
  });

  it('produces valid packages/extension/resources/unity-api.json matching schema', () => {
    const outPath = path.join(REPO_ROOT, 'packages', 'extension', 'resources', 'unity-api.json');
    expect(fs.existsSync(outPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8')) as {
      schemaVersion: number;
      types: Array<{ fullName: string; events: Array<{ name: string }> }>;
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.types.some((t) => t.fullName === 'UnityEngine.MonoBehaviour')).toBe(true);
  });
});
