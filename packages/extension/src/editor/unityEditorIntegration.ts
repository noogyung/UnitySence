import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';

export interface EditorInstanceInfo {
  process_id: number;
  version: string;
  app_path?: string;
  app_contents_path?: string;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === 'EPERM';
  }
}

export function isUnityEditorRunning(projectRoot: string): EditorInstanceInfo | null {
  const info = readEditorInstance(projectRoot);
  if (!info) return null;
  return isProcessAlive(info.process_id) ? info : null;
}

export function serializeUnityEditorPacket(messageType: number, value: string): Buffer {
  const payload = Buffer.from(value, 'utf8');
  const buf = Buffer.alloc(8 + payload.length);
  buf.writeInt32LE(messageType, 0);
  buf.writeInt32LE(payload.length, 4);
  if (payload.length > 0) {
    payload.copy(buf, 8);
  }
  return buf;
}

export type UnityUdpTransport = (
  port: number,
  pingPacket: Buffer,
  showUsagePacket: Buffer,
) => Promise<boolean>;

const defaultUdpTransport: UnityUdpTransport = (port, pingPacket, showUsagePacket) =>
  new Promise<boolean>((resolve) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Ignore close error
      }
      resolve(ok);
    };

    const timer = setTimeout(() => {
      finish(false);
    }, 300);

    socket.on('error', () => finish(false));
    socket.on('message', (msg) => {
      if (msg.length >= 4 && msg.readInt32LE(0) === 2) {
        socket.send(showUsagePacket, port, '127.0.0.1', (err) => {
          finish(!err);
        });
      }
    });

    socket.bind(0, '127.0.0.1', () => {
      socket.send(pingPacket, port, '127.0.0.1', (err) => {
        if (err) finish(false);
      });
    });
  });

export function openAssetInUnityEditor(
  projectRoot: string,
  assetPath: string,
  gameObjectPath?: string,
  transport: UnityUdpTransport = defaultUdpTransport,
): Promise<boolean> {
  const info = isUnityEditorRunning(projectRoot);
  if (!info) {
    return Promise.resolve(false);
  }

  const messagingPort = 56002 + (info.process_id % 1000);
  const absAsset = path.isAbsolute(assetPath) ? assetPath : path.resolve(projectRoot, assetPath);
  const relAsset = path.relative(projectRoot, absAsset).replace(/\\/g, '/');
  const goSegments = (gameObjectPath ?? '')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const payloadJson = JSON.stringify({
    Path: relAsset,
    GameObjectPath: goSegments,
  });

  // MessageType.Ping = 1, Pong = 2, ShowUsage = 25 (com.unity.ide.visualstudio)
  const pingPacket = serializeUnityEditorPacket(1, '');
  const showUsagePacket = serializeUnityEditorPacket(25, payloadJson);
  return transport(messagingPort, pingPacket, showUsagePacket);
}

export function readEditorInstance(projectRoot: string): EditorInstanceInfo | null {
  const filePath = path.join(projectRoot, 'Library', 'EditorInstance.json');
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<EditorInstanceInfo>;
    if (typeof raw.process_id === 'number' && typeof raw.version === 'string') {
      return {
        process_id: raw.process_id,
        version: raw.version,
        app_path: typeof raw.app_path === 'string' ? raw.app_path : undefined,
        app_contents_path: typeof raw.app_contents_path === 'string' ? raw.app_contents_path : undefined,
      };
    }
  } catch {
    // Ignore invalid JSON
  }
  return null;
}

export function resolveUnityEditorLogPath(
  projectRoot: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const localProjectLog = path.join(projectRoot, 'Logs', 'Editor.log');
  if (fs.existsSync(localProjectLog)) {
    return localProjectLog;
  }

  if (platform === 'win32') {
    const base = env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'Unity', 'Editor', 'Editor.log');
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Logs', 'Unity', 'Editor.log');
  }
  return path.join(os.homedir(), '.config', 'unity3d', 'Editor.log');
}

export function stripJsoncCommentsAndTrailingCommas(raw: string): string {
  const withoutComments: string[] = [];
  let inString = false;
  let i = 0;
  const n = raw.length;

  while (i < n) {
    const ch = raw[i];
    const next = raw[i + 1];

    if (inString) {
      withoutComments.push(ch);
      if (ch === '\\' && i + 1 < n) {
        withoutComments.push(raw[i + 1]);
        i += 2;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      withoutComments.push(ch);
      i++;
      continue;
    }

    if (ch === '/' && next === '/') {
      i += 2;
      while (i < n && raw[i] !== '\n') {
        i++;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n) {
        if (raw[i] === '*' && raw[i + 1] === '/') {
          i += 2;
          break;
        }
        if (raw[i] === '\n') {
          withoutComments.push('\n');
        }
        i++;
      }
      continue;
    }

    withoutComments.push(ch);
    i++;
  }

  const noCommentsStr = withoutComments.join('');
  const out: string[] = [];
  inString = false;
  for (let j = 0; j < noCommentsStr.length; j++) {
    const ch = noCommentsStr[j];
    if (inString) {
      out.push(ch);
      if (ch === '\\' && j + 1 < noCommentsStr.length) {
        out.push(noCommentsStr[j + 1]);
        j++;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out.push(ch);
      continue;
    }

    if (ch === ',') {
      let look = j + 1;
      while (look < noCommentsStr.length && /\s/.test(noCommentsStr[look])) {
        look++;
      }
      if (noCommentsStr[look] === '}' || noCommentsStr[look] === ']') {
        continue;
      }
    }

    out.push(ch);
  }

  return out.join('');
}

export function generateUnityLaunchConfig(projectRoot: string): {
  filePath: string;
  created: boolean;
  editorInfo: EditorInstanceInfo | null;
  aborted?: boolean;
} {
  const vscodeDir = path.join(projectRoot, '.vscode');
  const launchPath = path.join(vscodeDir, 'launch.json');
  const editorInfo = readEditorInstance(projectRoot);
  fs.mkdirSync(vscodeDir, { recursive: true });

  const configName = '[UnityBrain] Unity Editor 디버거 연결';
  const unityConfig: Record<string, unknown> = {
    name: configName,
    type: 'vstuc',
    request: 'attach',
  };

  let parsed: Record<string, unknown> & {
    version?: string;
    configurations?: Array<Record<string, unknown>>;
  } = {
    version: '0.2.0',
    configurations: [],
  };
  const existed = fs.existsSync(launchPath);
  if (existed) {
    try {
      const rawText = fs.readFileSync(launchPath, 'utf8').replace(/^\uFEFF/, '');
      const cleaned = stripJsoncCommentsAndTrailingCommas(rawText);
      const raw = JSON.parse(cleaned) as Record<string, unknown> & {
        version?: string;
        configurations?: Array<Record<string, unknown>>;
      };
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Invalid launch.json root value');
      }
      parsed = {
        ...raw,
        version: raw.version ?? '0.2.0',
        configurations: Array.isArray(raw.configurations) ? [...raw.configurations] : [],
      };
    } catch {
      void vscode.window.showErrorMessage(
        `[UnityBrain] 기존 '.vscode/launch.json' 파싱에 실패하여 사용자 설정 보호를 위해 덮어쓰지 않고 중단했습니다.`,
      );
      return { filePath: launchPath, created: false, editorInfo, aborted: true };
    }
  }

  const existingIdx = (parsed.configurations ?? []).findIndex(
    (c) => c.name === configName || (c.type === 'vstuc' && c.request === 'attach'),
  );
  if (existingIdx >= 0) {
    parsed.configurations![existingIdx] = unityConfig;
  } else {
    parsed.configurations!.push(unityConfig);
  }

  fs.writeFileSync(launchPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  return { filePath: launchPath, created: !existed, editorInfo };
}

export function registerUnityEditorCommands(projectRoot: string): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('unityBrain.generateDebugConfig', async () => {
      const res = generateUnityLaunchConfig(projectRoot);
      if (res.aborted) {
        return res;
      }
      const status = res.editorInfo
        ? `실행 중인 Unity ${res.editorInfo.version} (PID ${res.editorInfo.process_id})`
        : '현재 실행 중인 EditorInstance.json 미감지 (실행 시 자동 연결)';
      void vscode.window.showInformationMessage(
        `[UnityBrain] 디버거 연결 설정을 '.vscode/launch.json'에 저장했습니다 (${status}).`,
      );
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(res.filePath));
        await vscode.window.showTextDocument(doc);
      } catch {
        // Ignore open failure in headless environment
      }
      return res;
    }),

    vscode.commands.registerCommand('unityBrain.openUnityEditorLog', async () => {
      const logPath = resolveUnityEditorLogPath(projectRoot);
      if (!fs.existsSync(logPath)) {
        void vscode.window.showInformationMessage(
          `[UnityBrain] Unity Editor.log 파일을 찾을 수 없습니다: ${logPath}`,
        );
        return null;
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(logPath));
      await vscode.window.showTextDocument(doc);
      return logPath;
    }),
  ];
}
