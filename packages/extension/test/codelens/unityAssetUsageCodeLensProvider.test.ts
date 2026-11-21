import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc';
import {
  parseCSharpDeclarations,
  registerShowAssetUsagesCommand,
  UnityAssetUsageCodeLensProvider,
  UnityDaemonClient,
} from '../../src/codelens/unityAssetUsageCodeLensProvider.ts';

const tempDirs: string[] = [];

function createTempProject(): string {
  const dir = path.join(
    process.cwd(),
    'test-output',
    `ext-codelens-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  fs.mkdirSync(path.join(dir, 'Assets', 'Scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'Assets', 'Scenes'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'Assets', 'Prefabs'), { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vscode.__mock.reset();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('UnityAssetUsageCodeLensProvider', () => {
  it('renders class usage, inspector serialized field values, and UnityEvent callback lenses over JSON-RPC', async () => {
    const root = createTempProject();
    const csPath = path.join(root, 'Assets', 'Scripts', 'PlayerController.cs');
    const scenePath = path.join(root, 'Assets', 'Scenes', 'MainMenu.unity');

    const csSource = [
      'using UnityEngine;',
      '',
      'public class PlayerController : MonoBehaviour',
      '{',
      '    [SerializeField]',
      '    private float moveSpeed = 5f;',
      '',
      '    public void OnStartClicked()',
      '    {',
      '    }',
      '}',
      '',
    ].join('\n');

    fs.writeFileSync(csPath, csSource, 'utf8');
    fs.writeFileSync(
      `${csPath}.meta`,
      'fileFormatVersion: 2\nguid: 1234567890abcdef1234567890abcdef\n',
      'utf8',
    );
    fs.writeFileSync(
      scenePath,
      Array.from({ length: 30 }, (_, idx) => `# line ${idx + 1}`).join('\n'),
      'utf8',
    );

    const { clientReadable, clientWritable, serverReadable, serverWritable } =
      UnityDaemonClient.createPassThroughPair();

    const serverConn = createMessageConnection(
      new StreamMessageReader(serverReadable),
      new StreamMessageWriter(serverWritable),
    );

    serverConn.onRequest('usage/findByScriptGuid', (params: { scriptGuid: string }) => {
      if (params.scriptGuid !== '1234567890abcdef1234567890abcdef') {
        return { locations: [] };
      }
      return {
        locations: [
          {
            assetPath: 'Assets/Scenes/MainMenu.unity',
            assetType: 'scene',
            assetGuid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            gameObjectPath: 'Canvas/Player',
            fileId: '100',
            line: 12,
            usageKind: 'component',
          },
          {
            assetPath: 'Assets/Scenes/Battle.unity',
            assetType: 'scene',
            assetGuid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            gameObjectPath: 'Arena/PlayerSpawn',
            fileId: '200',
            line: 18,
            usageKind: 'component',
          },
          {
            assetPath: 'Assets/Prefabs/Hero.prefab',
            assetType: 'prefab',
            assetGuid: 'cccccccccccccccccccccccccccccccc',
            gameObjectPath: 'Hero',
            fileId: '300',
            line: 9,
            usageKind: 'component',
          },
        ],
      };
    });

    serverConn.onRequest('inspector/getSerializedValues', () => ({
      fields: [
        {
          fieldName: 'moveSpeed',
          value: '8.5',
          assetPath: 'Assets/Scenes/MainMenu.unity',
          assetType: 'scene',
          gameObjectPath: 'Canvas/Player',
          fileId: '100',
          line: 14,
        },
        {
          fieldName: 'moveSpeed',
          value: '12',
          assetPath: 'Assets/Prefabs/Hero.prefab',
          assetType: 'prefab',
          gameObjectPath: 'Hero',
          fileId: '300',
          line: 11,
        },
      ],
    }));

    serverConn.onRequest('usage/findByMethod', (params: { methodName: string }) => {
      if (params.methodName === 'OnStartClicked') {
        return {
          locations: [
            {
              assetPath: 'Assets/Scenes/MainMenu.unity',
              assetType: 'scene',
              assetGuid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              gameObjectPath: 'Canvas/StartButton',
              fileId: '150',
              line: 22,
              usageKind: 'unityEventCallback',
              methodName: 'OnStartClicked',
            },
          ],
        };
      }
      return { locations: [] };
    });

    serverConn.listen();

    const daemonClient = new UnityDaemonClient({
      projectRoot: root,
      extensionPath: root,
      transportFactory: () =>
        UnityDaemonClient.createConnectionTransport(clientReadable, clientWritable),
    });

    const provider = new UnityAssetUsageCodeLensProvider(root, daemonClient);
    const cmdDisp = registerShowAssetUsagesCommand(root);

    try {
      const doc = vscode.__mock.createTextDocument(vscode.Uri.file(csPath), csSource, 'csharp');
      const cts = new vscode.CancellationTokenSource();
      const lenses = await provider.provideCodeLenses(doc, cts.token);

      expect(lenses.length).toBe(3);

      const classLens = lenses.find((l) => l.range.start.line === 2);
      expect(classLens?.command?.title).toBe(
        '$(symbol-reference) [UnitySense] 에셋 참조 3곳 (씬 2개, 프리팹 1개)',
      );

      const fieldLens = lenses.find((l) => l.range.start.line === 5);
      expect(fieldLens?.command?.title).toContain('[UnitySense] 인스펙터 값: 8.5 (MainMenu), 12 (Hero)');

      const methodLens = lenses.find((l) => l.range.start.line === 7);
      expect(methodLens?.command?.title).toBe('$(zap) [UnitySense] 이벤트 콜백 1곳');

      await vscode.commands.executeCommand(
        classLens!.command!.command,
        ...(classLens!.command!.arguments ?? []),
      );

      expect(vscode.window.activeTextEditor?.document.fileName).toBe(path.resolve(scenePath));
      expect(vscode.window.activeTextEditor?.selection.start.line).toBe(11);
    } finally {
      cmdDisp.dispose();
      provider.dispose();
      daemonClient.dispose();
      serverConn.dispose();
    }
  });

  it('respects unitySense.codeLens.enabled setting', async () => {
    const root = createTempProject();
    const csPath = path.join(root, 'Assets', 'Scripts', 'Simple.cs');
    const source = 'public class Simple : MonoBehaviour {}\n';
    fs.writeFileSync(csPath, source, 'utf8');
    fs.writeFileSync(`${csPath}.meta`, 'guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', 'utf8');

    await vscode.workspace.getConfiguration('unitySense').update('codeLens.enabled', false);

    let queried = false;
    const daemonClient = new UnityDaemonClient({
      projectRoot: root,
      extensionPath: root,
      transportFactory: () => ({
        sendRequest: async <T>() => {
          queried = true;
          return { locations: [] } as T;
        },
        dispose: () => {},
      }),
    });

    const provider = new UnityAssetUsageCodeLensProvider(root, daemonClient);
    const doc = vscode.__mock.createTextDocument(vscode.Uri.file(csPath), source, 'csharp');
    const lenses = await provider.provideCodeLenses(doc, new vscode.CancellationTokenSource().token);

    expect(lenses.length).toBe(0);
    expect(queried).toBe(false);
    provider.dispose();
    daemonClient.dispose();
  });

  it('emits Rider-style Unity event function CodeLenses even for modifierless methods and without .meta', async () => {
    const root = createTempProject();
    const csPath = path.join(root, 'Assets', 'Scripts', 'LifecycleProbe.cs');
    const source = [
      'using UnityEngine;',
      '',
      'public class LifecycleProbe : MonoBehaviour',
      '{',
      '    void Awake() {}',
      '    private void Update() {}',
      '    void HelperOnly() {}',
      '}',
    ].join('\n');
    fs.writeFileSync(csPath, source, 'utf8');

    const daemonClient = new UnityDaemonClient({
      projectRoot: root,
      extensionPath: root,
      transportFactory: () => ({
        sendRequest: async <T>() => ({ locations: [] } as T),
        dispose: () => {},
      }),
    });

    const provider = new UnityAssetUsageCodeLensProvider(root, daemonClient);
    const doc = vscode.__mock.createTextDocument(vscode.Uri.file(csPath), source, 'csharp');
    const lenses = await provider.provideCodeLenses(doc, new vscode.CancellationTokenSource().token);

    const awakeLens = lenses.find((l) => l.range.start.line === 4);
    const updateLens = lenses.find((l) => l.range.start.line === 5);
    const helperLens = lenses.find((l) => l.range.start.line === 6);

    expect(awakeLens?.command?.title).toBe('$(symbol-event) [UnitySense] 유니티 이벤트 함수 (MonoBehaviour)');
    expect(updateLens?.command?.title).toBe(
      '$(symbol-event) [UnitySense] 유니티 이벤트 함수 (MonoBehaviour) · 매 프레임 호출',
    );
    expect(helperLens).toBeUndefined();
    provider.dispose();
    daemonClient.dispose();
  });

  it('matches nested struct propertyPath entries to parent serialized field CodeLens', async () => {
    const root = createTempProject();
    const csPath = path.join(root, 'Assets', 'Scripts', 'StatsHolder.cs');
    const source = [
      'using UnityEngine;',
      '',
      'public class StatsHolder : MonoBehaviour',
      '{',
      '    [SerializeField]',
      '    private CharacterStats stats;',
      '}',
    ].join('\n');
    fs.writeFileSync(csPath, source, 'utf8');
    fs.writeFileSync(`${csPath}.meta`, 'guid: 99999999999999999999999999999999\n', 'utf8');

    const daemonClient = new UnityDaemonClient({
      projectRoot: root,
      extensionPath: root,
      transportFactory: () => ({
        sendRequest: async <T>(method: string) => {
          if (method === 'inspector/getSerializedValues') {
            return {
              fields: [
                {
                  fieldName: 'stats.maxHealth',
                  value: '250',
                  assetPath: 'Assets/Prefabs/Boss.prefab',
                  assetType: 'prefab',
                  gameObjectPath: 'Boss',
                  fileId: '10',
                  line: 15,
                },
              ],
            } as T;
          }
          return { locations: [] } as T;
        },
        dispose: () => {},
      }),
    });

    const provider = new UnityAssetUsageCodeLensProvider(root, daemonClient);
    const doc = vscode.__mock.createTextDocument(vscode.Uri.file(csPath), source, 'csharp');
    const lenses = await provider.provideCodeLenses(doc, new vscode.CancellationTokenSource().token);

    const statsLens = lenses.find((l) => l.range.start.line === 5);
    expect(statsLens?.command?.title).toContain('maxHealth=250 (Boss)');
    provider.dispose();
    daemonClient.dispose();
  });

  it('matches [field: SerializeField] auto-properties and <Prop>k__BackingField YAML entries', async () => {
    const root = createTempProject();
    const csPath = path.join(root, 'Assets', 'Scripts', 'HeroStats.cs');
    const source = [
      'using UnityEngine;',
      '',
      'public class HeroStats : MonoBehaviour',
      '{',
      '    [field: SerializeField] public float MoveSpeed { get; private set; }',
      '    [field: SerializeField]',
      '    public CharacterStats Stats { get; set; }',
      '    public float IgnoredProp { get; set; }',
      '    private void Update() {}',
      '}',
    ].join('\n');
    fs.writeFileSync(csPath, source, 'utf8');
    fs.writeFileSync(`${csPath}.meta`, 'guid: 88888888888888888888888888888888\n', 'utf8');

    const daemonClient = new UnityDaemonClient({
      projectRoot: root,
      extensionPath: root,
      transportFactory: () => ({
        sendRequest: async <T>(method: string) => {
          if (method === 'inspector/getSerializedValues') {
            return {
              fields: [
                {
                  fieldName: '<MoveSpeed>k__BackingField',
                  value: '11.5',
                  assetPath: 'Assets/Scenes/Stage01.unity',
                  assetType: 'scene',
                  gameObjectPath: 'Player',
                  fileId: '10',
                  line: 18,
                },
                {
                  fieldName: '<Stats>k__BackingField.maxHealth',
                  value: '400',
                  assetPath: 'Assets/Prefabs/Boss.prefab',
                  assetType: 'prefab',
                  gameObjectPath: 'Boss',
                  fileId: '20',
                  line: 25,
                },
                {
                  fieldName: '<IgnoredProp>k__BackingField',
                  value: '99',
                  assetPath: 'Assets/Scenes/Stage01.unity',
                  assetType: 'scene',
                  gameObjectPath: 'Player',
                  fileId: '10',
                  line: 30,
                },
              ],
            } as T;
          }
          return { locations: [] } as T;
        },
        dispose: () => {},
      }),
    });

    const provider = new UnityAssetUsageCodeLensProvider(root, daemonClient);
    const doc = vscode.__mock.createTextDocument(vscode.Uri.file(csPath), source, 'csharp');
    const lenses = await provider.provideCodeLenses(doc, new vscode.CancellationTokenSource().token);

    const speedLens = lenses.find((l) => l.range.start.line === 4);
    expect(speedLens?.command?.title).toContain('[UnitySense] 인스펙터 값: 11.5 (Stage01)');

    const statsLens = lenses.find((l) => l.range.start.line === 6);
    expect(statsLens?.command?.title).toContain('[UnitySense] 인스펙터 값: maxHealth=400 (Boss)');

    const ignoredLens = lenses.find((l) => l.range.start.line === 7);
    expect(ignoredLens).toBeUndefined();

    const updateLens = lenses.find((l) => l.range.start.line === 8);
    expect(updateLens?.command?.title).toContain('유니티 이벤트 함수 (MonoBehaviour)');

    provider.dispose();
    daemonClient.dispose();
  });

  it('masks char literals and multiline block comments before tracking brace depth in parseCSharpDeclarations', () => {
    const src = [
      'public class BraceTrap : MonoBehaviour',
      '{',
      "    void A() { char c = '}'; /* } */ }",
      '    /*',
      '    public void CommentedOutMethod() {}',
      '    }',
      '    */',
      '    private string verbatim = @"fake } brace";',
      '    [SerializeField] private int realField;',
      '    public void RealMethod() {}',
      '}',
    ].join('\n');

    const decls = parseCSharpDeclarations(src);
    expect(decls.classes.map((c) => c.className)).toEqual(['BraceTrap']);
    expect(decls.serializedFields).toEqual([
      { fieldName: 'realField', line: 8, className: 'BraceTrap' },
    ]);
    expect(decls.methods).toEqual([
      { methodName: 'A', line: 2, className: 'BraceTrap' },
      { methodName: 'RealMethod', line: 9, className: 'BraceTrap' },
    ]);
  });

  it('masks C# 11 raw strings, @$"..."/$@"..." verbatim interpolated strings, and $"{...}" holes without hiding subsequent members', () => {
    const src = [
      'public class ModernStringTrap : MonoBehaviour',
      '{',
      '    private string raw = """',
      '        "unclosed quote and { fake } brace',
      '        """;',
      '    private string rawInterp = $$"""{{new { x = "}" }}}""";',
      '    private string verb1 = @$"a ""b"" {new { c = "}" }}";',
      '    private string verb2 = $@"c ""d"" {"}"}";',
      '    private string interpChar = $"{' + "'\"'" + '}";',
      '    private string interpStr = $"{\\"}\\"}";',
      '    [SerializeField] private float visibleAfterStrings;',
      '    public void VisibleMethod() {}',
      '}',
    ].join('\n');

    const decls = parseCSharpDeclarations(src);
    expect(decls.classes.map((c) => c.className)).toEqual(['ModernStringTrap']);
    expect(decls.serializedFields).toEqual([
      { fieldName: 'visibleAfterStrings', line: 10, className: 'ModernStringTrap' },
    ]);
    expect(decls.methods).toEqual([
      { methodName: 'VisibleMethod', line: 11, className: 'ModernStringTrap' },
    ]);
  });

  it('uses 60000ms timeout for index/rebuild and 15000ms timeout for standard query RPCs', async () => {
    const root = createTempProject();
    const origSetTimeout = globalThis.setTimeout;
    const origClearTimeout = globalThis.clearTimeout;
    const capturedDelays: number[] = [];
    const scheduledTimers: Array<{ delay: number; fn: () => void }> = [];

    globalThis.setTimeout = ((fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay === 15_000 || delay === 60_000) {
        capturedDelays.push(delay);
        scheduledTimers.push({ delay, fn: () => fn(...args) });
        return { __mockTimer: true } as unknown as ReturnType<typeof setTimeout>;
      }
      return origSetTimeout(fn, delay, ...args);
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout> | undefined) => {
      if (id && typeof id === 'object' && '__mockTimer' in id) return;
      return origClearTimeout(id);
    }) as typeof clearTimeout;

    const client = new UnityDaemonClient({
      projectRoot: root,
      extensionPath: root,
      transportFactory: () => ({
        sendRequest: () => new Promise<never>(() => {}),
        dispose: () => {},
      }),
    });

    try {
      const statusPromise = client.getStatus();
      for (let i = 0; i < 5 && scheduledTimers.length < 1; i++) {
        await Promise.resolve();
      }
      expect(capturedDelays).toEqual([15_000]);
      scheduledTimers[0].fn();
      await expect(statusPromise).rejects.toThrow(/timed out after 15000ms/);

      const rebuildPromise = client.rebuild(true);
      for (let i = 0; i < 5 && scheduledTimers.length < 2; i++) {
        await Promise.resolve();
      }
      expect(capturedDelays).toEqual([15_000, 60_000]);
      scheduledTimers[1].fn();
      await expect(rebuildPromise).rejects.toThrow(/timed out after 60000ms/);
    } finally {
      client.dispose();
      globalThis.setTimeout = origSetTimeout;
      globalThis.clearTimeout = origClearTimeout;
    }
  });
});
