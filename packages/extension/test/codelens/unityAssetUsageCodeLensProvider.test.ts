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
        '$(symbol-reference) [UnityBrain] 에셋 참조 3곳 (씬 2개, 프리팹 1개)',
      );

      const fieldLens = lenses.find((l) => l.range.start.line === 5);
      expect(fieldLens?.command?.title).toContain('[UnityBrain] 인스펙터 값: 8.5 (MainMenu), 12 (Hero)');

      const methodLens = lenses.find((l) => l.range.start.line === 7);
      expect(methodLens?.command?.title).toBe('$(zap) [UnityBrain] 이벤트 콜백 1곳');

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

  it('respects unityBrain.codeLens.enabled setting', async () => {
    const root = createTempProject();
    const csPath = path.join(root, 'Assets', 'Scripts', 'Simple.cs');
    const source = 'public class Simple : MonoBehaviour {}\n';
    fs.writeFileSync(csPath, source, 'utf8');
    fs.writeFileSync(`${csPath}.meta`, 'guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', 'utf8');

    await vscode.workspace.getConfiguration('unityBrain').update('codeLens.enabled', false);

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
});
