import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import * as vscode from 'vscode';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc';
import type {
  AssetUsageLocation,
  DaemonIndexStatus,
  SerializedFieldValueEntry,
} from '../contracts/index.ts';
import {
  shortenCSharpType,
  UnityEventCompletionProvider,
} from '../completion/unityEventGenerator.ts';
import { openAssetInUnityEditor } from '../editor/unityEditorIntegration.ts';

export interface DaemonClientTransport {
  sendRequest<T = unknown>(method: string, params?: unknown): Promise<T>;
  dispose(): void;
}

export interface UnityDaemonClientOptions {
  projectRoot: string;
  extensionPath: string;
  cacheDir?: string;
  transportFactory?: () => DaemonClientTransport;
}

export interface CSharpCodeDeclarations {
  classes: Array<{ className: string; line: number }>;
  serializedFields: Array<{ fieldName: string; line: number }>;
  methods: Array<{ methodName: string; line: number }>;
}

export interface ShowAssetUsagesCommandArgs {
  title: string;
  projectRoot: string;
  locations: AssetUsageLocation[];
}

export class UnityDaemonClient implements vscode.Disposable {
  private readonly projectRoot: string;
  private readonly extensionPath: string;
  private readonly cacheDir: string;
  private readonly transportFactory?: () => DaemonClientTransport;

  private transport: DaemonClientTransport | null = null;
  private childProcess: ChildProcess | null = null;
  private connection: MessageConnection | null = null;
  private startPromise: Promise<void> | null = null;
  private shadowDaemonDir: string | null = null;

  constructor(options: UnityDaemonClientOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.extensionPath = path.resolve(options.extensionPath);
    this.cacheDir = path.resolve(
      options.cacheDir ?? path.join(this.projectRoot, 'Library', 'UnityBrainCache'),
    );
    this.transportFactory = options.transportFactory;
  }

  public async start(): Promise<void> {
    if (this.transport) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.doStart();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async doStart(): Promise<void> {
    if (this.transportFactory) {
      this.transport = this.transportFactory();
      return;
    }

    const daemonDll = this.resolveDaemonDllPath();
    if (!daemonDll) {
      throw new Error('UnityBrain.Daemon.dll was not found in extension binaries.');
    }

    const child = spawn(
      'dotnet',
      [daemonDll, '--project-root', this.projectRoot, '--cache-dir', this.cacheDir],
      {
        cwd: this.projectRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    if (!child.stdout || !child.stdin) {
      child.kill();
      throw new Error('Failed to attach stdio streams to UnityBrain.Daemon child process.');
    }

    const conn = createMessageConnection(
      new StreamMessageReader(child.stdout),
      new StreamMessageWriter(child.stdin),
    );
    conn.listen();

    this.childProcess = child;
    this.connection = conn;
    this.transport = {
      sendRequest: <T>(method: string, params?: unknown) => conn.sendRequest<T>(method, params),
      dispose: () => {
        try {
          void Promise.resolve(conn.sendRequest('shutdown')).catch(() => {});
        } catch {
          // Ignore closing request error
        }
        try {
          void Promise.resolve(conn.sendNotification('exit')).catch(() => {});
        } catch {
          // Ignore closing notification error
        }
        conn.dispose();
        try {
          child.stdin?.end();
        } catch {
          // Ignore stdin close error
        }
        if (!child.killed) {
          child.kill();
        }
        if (this.shadowDaemonDir) {
          try {
            fs.rmSync(this.shadowDaemonDir, { recursive: true, force: true });
          } catch {
            // Ignore cleanup error if process is still exiting
          }
          this.shadowDaemonDir = null;
        }
      },
    };
  }

  private resolveDaemonDllPath(): string | null {
    const extDaemonDll = path.join(this.extensionPath, 'bin', 'daemon', 'UnityBrain.Daemon.dll');
    if (fs.existsSync(extDaemonDll)) {
      try {
        const runtimeRoot = path.join(os.tmpdir(), 'unitybrain-runtime');
        const shadowDir = path.join(runtimeRoot, `daemon-${process.pid}-${Date.now()}`);
        fs.mkdirSync(shadowDir, { recursive: true });
        const sourceDir = path.dirname(extDaemonDll);
        for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
          if (entry.isFile()) {
            fs.copyFileSync(path.join(sourceDir, entry.name), path.join(shadowDir, entry.name));
          }
        }
        this.shadowDaemonDir = shadowDir;
        return path.join(shadowDir, 'UnityBrain.Daemon.dll');
      } catch {
        return extDaemonDll;
      }
    }

    const candidates = [
      path.join(this.extensionPath, '..', 'unity-daemon', 'bin', 'Release', 'net10.0', 'UnityBrain.Daemon.dll'),
      path.join(this.extensionPath, '..', 'unity-daemon', 'bin', 'Debug', 'net10.0', 'UnityBrain.Daemon.dll'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  public async getStatus(): Promise<DaemonIndexStatus> {
    await this.start();
    return this.transport!.sendRequest<DaemonIndexStatus>('index/status', {});
  }

  public async rebuild(force = false): Promise<{ indexedAssets: number; elapsedMs: number }> {
    await this.start();
    return this.transport!.sendRequest<{ indexedAssets: number; elapsedMs: number }>(
      'index/rebuild',
      { force },
    );
  }

  public async findByScriptGuid(scriptGuid: string): Promise<AssetUsageLocation[]> {
    await this.start();
    const res = await this.transport!.sendRequest<{ locations?: AssetUsageLocation[] }>(
      'usage/findByScriptGuid',
      { scriptGuid },
    );
    return res?.locations ?? [];
  }

  public async findByMethod(
    scriptGuid: string | undefined,
    className: string | undefined,
    methodName: string,
  ): Promise<AssetUsageLocation[]> {
    await this.start();
    const res = await this.transport!.sendRequest<{ locations?: AssetUsageLocation[] }>(
      'usage/findByMethod',
      { scriptGuid, className, methodName },
    );
    return res?.locations ?? [];
  }

  public async getSerializedValues(
    scriptGuid: string,
    fieldName?: string,
  ): Promise<SerializedFieldValueEntry[]> {
    await this.start();
    const res = await this.transport!.sendRequest<{ fields?: SerializedFieldValueEntry[] }>(
      'inspector/getSerializedValues',
      { scriptGuid, fieldName },
    );
    return res?.fields ?? [];
  }

  public static createConnectionTransport(
    readable: NodeJS.ReadableStream,
    writable: NodeJS.WritableStream,
  ): DaemonClientTransport {
    const conn = createMessageConnection(
      new StreamMessageReader(readable),
      new StreamMessageWriter(writable),
    );
    conn.listen();
    return {
      sendRequest: <T>(method: string, params?: unknown) => conn.sendRequest<T>(method, params),
      dispose: () => conn.dispose(),
    };
  }

  public static createPassThroughPair(): {
    clientReadable: PassThrough;
    clientWritable: PassThrough;
    serverReadable: PassThrough;
    serverWritable: PassThrough;
  } {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    return {
      clientReadable: serverToClient,
      clientWritable: clientToServer,
      serverReadable: clientToServer,
      serverWritable: serverToClient,
    };
  }

  public dispose(): void {
    if (this.transport) {
      this.transport.dispose();
      this.transport = null;
    }
    if (this.connection) {
      this.connection.dispose();
      this.connection = null;
    }
    if (this.childProcess && !this.childProcess.killed) {
      this.childProcess.kill();
    }
    this.childProcess = null;
  }
}

export async function readMetaGuid(assetFilePath: string): Promise<string | null> {
  const metaPath = `${assetFilePath}.meta`;
  try {
    const content = await fs.promises.readFile(metaPath, 'utf8');
    const match = /^\s*guid:\s*([0-9a-fA-F]{32})\b/m.exec(content);
    return match ? match[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

export function parseCSharpDeclarations(sourceText: string): CSharpCodeDeclarations {
  const classes: Array<{ className: string; line: number }> = [];
  const serializedFields: Array<{ fieldName: string; line: number }> = [];
  const methods: Array<{ methodName: string; line: number }> = [];

  const lines = sourceText.split(/\r?\n/);
  let pendingSerializeField = false;
  let braceDepth = 0;
  let pendingClassBrace = false;
  let memberBraceDepth = 1;
  const nonMethodKeywords = new Set([
    'if', 'for', 'foreach', 'while', 'switch', 'catch', 'using', 'lock', 'return', 'throw',
    'else', 'new', 'class', 'struct', 'interface', 'enum', 'namespace', 'get', 'set', 'add', 'remove',
  ]);

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('//')) {
      continue;
    }

    if (/\[[^\]]*\b(?:UnityEngine\.)?SerializeField\b[^\]]*\]/.test(trimmed)) {
      pendingSerializeField = true;
    }

    const classMatch = /^(?:public|internal|private|protected|abstract|sealed|static|partial|\s)*\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(
      trimmed,
    );
    if (classMatch) {
      classes.push({ className: classMatch[1], line: i });
      pendingSerializeField = false;
      pendingClassBrace = true;
    } else if (braceDepth === memberBraceDepth || (!pendingClassBrace && braceDepth === 1)) {
      const methodMatch =
        /^(?:(?:public|private|protected|internal|virtual|override|async|static|sealed|new|unsafe|extern)\s+)*([A-Za-z_][A-Za-z0-9_<>.?[\]]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(
          trimmed,
        );
      if (
        methodMatch &&
        !nonMethodKeywords.has(methodMatch[1]) &&
        !nonMethodKeywords.has(methodMatch[2]) &&
        !trimmed.startsWith('[')
      ) {
        methods.push({ methodName: methodMatch[2], line: i });
        pendingSerializeField = false;
      } else {
        const isPublicField = /\bpublic\b/.test(trimmed) && !/\b(?:static|const|readonly)\b/.test(trimmed);
        const fieldMatch = /^(?:\[[^\]]+\]\s*)*(?:public|private|protected|internal|\s)+[A-Za-z0-9_<>\[\].,\s]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|;)/.exec(
          trimmed,
        );
        const autoPropMatch = pendingSerializeField
          ? /^(?:\[[^\]]+\]\s*)*(?:(?:public|private|protected|internal|virtual|override|new)\s+)*[A-Za-z0-9_<>\[\].,?\s]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{\s*get\b/.exec(
              trimmed,
            )
          : null;
        if (fieldMatch && (pendingSerializeField || isPublicField) && !trimmed.includes('(')) {
          serializedFields.push({ fieldName: fieldMatch[1], line: i });
          pendingSerializeField = false;
        } else if (autoPropMatch && !trimmed.includes('(')) {
          serializedFields.push({ fieldName: autoPropMatch[1], line: i });
          pendingSerializeField = false;
        } else if (!trimmed.startsWith('[')) {
          pendingSerializeField = false;
        }
      }
    }

    const codeOnly = trimmed.replace(/"(?:\\.|[^"\\])*"/g, '').replace(/\/\/.*$/, '');
    for (const ch of codeOnly) {
      if (ch === '{') {
        braceDepth++;
        if (pendingClassBrace) {
          memberBraceDepth = braceDepth;
          pendingClassBrace = false;
        }
      } else if (ch === '}') {
        braceDepth = Math.max(0, braceDepth - 1);
      }
    }
  }

  return { classes, serializedFields, methods };
}

export class UnityAssetUsageCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly projectRoot: string;
  private readonly daemonClient: UnityDaemonClient;
  private readonly eventProvider: UnityEventCompletionProvider;
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();

  public readonly onDidChangeCodeLenses: vscode.Event<void> = this.onDidChangeEmitter.event;

  constructor(
    projectRoot: string,
    daemonClient: UnityDaemonClient,
    eventProvider?: UnityEventCompletionProvider,
  ) {
    this.projectRoot = path.resolve(projectRoot);
    this.daemonClient = daemonClient;
    this.eventProvider =
      eventProvider ?? new UnityEventCompletionProvider({ projectRoot: this.projectRoot });
  }

  public refresh(): void {
    this.onDidChangeEmitter.fire();
  }

  public async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<vscode.CodeLens[]> {
    const enabled = vscode.workspace
      .getConfiguration('unityBrain')
      .get<boolean>('codeLens.enabled', true);
    if (!enabled || document.languageId !== 'csharp' || token.isCancellationRequested) {
      return [];
    }

    const sourceText = document.getText();
    const decls = parseCSharpDeclarations(sourceText);
    if (decls.classes.length === 0) {
      return [];
    }

    const lenses: vscode.CodeLens[] = [];
    const primaryClass = decls.classes[0].className;

    const appendUnityEventMethodLenses = () => {
      for (const method of decls.methods) {
        const methodOffset = document.offsetAt(new vscode.Position(method.line, 0));
        const evInfo = this.eventProvider.findUnityEventInfo(sourceText, methodOffset, method.methodName);
        if (!evInfo) continue;

        const shortOwner = shortenCSharpType(evInfo.apiType.fullName);
        const perfBadge = evInfo.event.isPerformanceCritical ? ' · 매 프레임 호출' : '';
        const range = new vscode.Range(method.line, 0, method.line, 0);
        lenses.push(
          new vscode.CodeLens(range, {
            title: `$(symbol-event) [UnityBrain] 유니티 이벤트 함수 (${shortOwner})${perfBadge}`,
            command: 'unityBrain.generateEventFunctions',
            tooltip: `[UnityBrain] ${evInfo.apiType.fullName}.${evInfo.event.name}: ${evInfo.event.description}`,
          }),
        );
      }
    };

    const scriptGuid = await readMetaGuid(document.fileName);
    if (!scriptGuid || token.isCancellationRequested) {
      appendUnityEventMethodLenses();
      return lenses;
    }

    let scriptUsages: AssetUsageLocation[] = [];
    let serializedValues: SerializedFieldValueEntry[] = [];
    try {
      [scriptUsages, serializedValues] = await Promise.all([
        this.daemonClient.findByScriptGuid(scriptGuid),
        this.daemonClient.getSerializedValues(scriptGuid),
      ]);
    } catch {
      appendUnityEventMethodLenses();
      return lenses;
    }

    if (token.isCancellationRequested) {
      return lenses;
    }

    // 1. Class-level Asset Usage CodeLenses
    const classTitle = this.formatClassUsageSummary(scriptUsages);
    for (const cls of decls.classes) {
      const range = new vscode.Range(cls.line, 0, cls.line, 0);
      lenses.push(
        new vscode.CodeLens(range, {
          title: classTitle,
          command: 'unityBrain.showAssetUsages',
          tooltip: '[UnityBrain] 클릭하여 이 스크립트를 참조하는 유니티 씬/프리팹/에셋 목록으로 이동합니다',
          arguments: [
            {
              title: `[UnityBrain] ${cls.className} 에셋 참조 위치`,
              projectRoot: this.projectRoot,
              locations: scriptUsages,
            } satisfies ShowAssetUsagesCommandArgs,
          ],
        }),
      );
    }

    // 2. Field-level Inspector Serialized Values CodeLenses
    if (serializedValues.length > 0) {
      const valuesByField = new Map<string, SerializedFieldValueEntry[]>();
      for (const entry of serializedValues) {
        const normalizedFieldName = entry.fieldName.replace(
          /<([A-Za-z_][A-Za-z0-9_]*)>k__BackingField/g,
          '$1',
        );
        const directList = valuesByField.get(normalizedFieldName) ?? [];
        directList.push(entry);
        valuesByField.set(normalizedFieldName, directList);

        const dotIdx = normalizedFieldName.indexOf('.');
        if (dotIdx > 0) {
          const rootField = normalizedFieldName.slice(0, dotIdx);
          const subPath = normalizedFieldName.slice(dotIdx + 1);
          const rootList = valuesByField.get(rootField) ?? [];
          rootList.push({
            ...entry,
            value: `${subPath}=${entry.value}`,
          });
          valuesByField.set(rootField, rootList);
        }
      }

      for (const field of decls.serializedFields) {
        const entries = valuesByField.get(field.fieldName);
        if (!entries || entries.length === 0) {
          continue;
        }

        const preview = entries
          .slice(0, 3)
          .map((e) => `${e.value} (${path.basename(e.assetPath, path.extname(e.assetPath))})`)
          .join(', ');
        const suffix = entries.length > 3 ? ` 외 ${entries.length - 3}곳` : '';
        const fieldLocations: AssetUsageLocation[] = entries.map((e) => ({
          assetPath: e.assetPath,
          assetType: e.assetType,
          assetGuid: '',
          gameObjectPath: e.gameObjectPath,
          fileId: e.fileId,
          line: e.line,
          usageKind: 'component',
          serializedValues: { [e.fieldName]: e.value },
        }));

        const range = new vscode.Range(field.line, 0, field.line, 0);
        lenses.push(
          new vscode.CodeLens(range, {
            title: `$(settings-gear) [UnityBrain] 인스펙터 값: ${preview}${suffix}`,
            command: 'unityBrain.showAssetUsages',
            tooltip: `[UnityBrain] 유니티 에셋에 직렬화된 '${field.fieldName}' 필드 값 보기`,
            arguments: [
              {
                title: `[UnityBrain] ${primaryClass}.${field.fieldName} 인스펙터 직렬화 값`,
                projectRoot: this.projectRoot,
                locations: fieldLocations,
              } satisfies ShowAssetUsagesCommandArgs,
            ],
          }),
        );
      }
    }

    // 3. Method-level UnityEvent callback CodeLenses
    const candidateMethods = decls.methods.slice(0, 40);
    const methodResults = await Promise.all(
      candidateMethods.map(async (m) => ({
        method: m,
        locations: await this.daemonClient.findByMethod(scriptGuid, primaryClass, m.methodName).catch(() => []),
      })),
    );

    if (token.isCancellationRequested) {
      return [];
    }

    for (const item of methodResults) {
      if (item.locations.length === 0) {
        continue;
      }
      const range = new vscode.Range(item.method.line, 0, item.method.line, 0);
      const count = item.locations.length;
      lenses.push(
        new vscode.CodeLens(range, {
          title: `$(zap) [UnityBrain] 이벤트 콜백 ${count}곳`,
          command: 'unityBrain.showAssetUsages',
          tooltip: `[UnityBrain] ${item.method.methodName}()를 호출하는 UnityEvent 바인딩 보기`,
          arguments: [
            {
              title: `[UnityBrain] ${primaryClass}.${item.method.methodName}() 이벤트 콜백 목록`,
              projectRoot: this.projectRoot,
              locations: item.locations,
            } satisfies ShowAssetUsagesCommandArgs,
          ],
        }),
      );
    }

    appendUnityEventMethodLenses();
    return lenses;
  }

  private formatClassUsageSummary(locations: AssetUsageLocation[]): string {
    if (locations.length === 0) {
      return '$(symbol-reference) [UnityBrain] 에셋 참조 0곳';
    }

    let scenes = 0;
    let prefabs = 0;
    let assets = 0;
    for (const loc of locations) {
      if (loc.assetType === 'scene') scenes++;
      else if (loc.assetType === 'prefab') prefabs++;
      else assets++;
    }

    const parts: string[] = [];
    if (scenes > 0) parts.push(`씬 ${scenes}개`);
    if (prefabs > 0) parts.push(`프리팹 ${prefabs}개`);
    if (assets > 0) parts.push(`에셋 ${assets}개`);

    const total = locations.length;
    return `$(symbol-reference) [UnityBrain] 에셋 참조 ${total}곳 (${parts.join(', ')})`;
  }

  public dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}

export function registerShowAssetUsagesCommand(defaultProjectRoot: string): vscode.Disposable {
  return vscode.commands.registerCommand('unityBrain.showAssetUsages', async (rawArgs?: unknown) => {
    const args = rawArgs as ShowAssetUsagesCommandArgs | undefined;
    const locations = args?.locations ?? [];
    const root = args?.projectRoot ?? defaultProjectRoot;

    if (locations.length === 0) {
      await vscode.window.showInformationMessage('[UnityBrain] 이 심볼을 참조하는 유니티 씬/프리팹/에셋이 없습니다.');
      return undefined;
    }

    interface UsageQuickPickItem extends vscode.QuickPickItem {
      location: AssetUsageLocation;
    }

    const items: UsageQuickPickItem[] = locations.map((loc) => ({
      label: `${loc.assetPath}:${loc.line}`,
      description: loc.gameObjectPath,
      detail: loc.methodName
        ? `[UnityBrain] UnityEvent 콜백 -> ${loc.methodName}()`
        : loc.usageKind === 'prefabOverride'
          ? '[UnityBrain] 프리팹 오버라이드'
          : `[UnityBrain] 컴포넌트 참조 (${loc.assetType})`,
      location: loc,
    }));

    const picked = await vscode.window.showQuickPick<UsageQuickPickItem>(items, {
      placeHolder: args?.title ?? '[UnityBrain] 이동할 유니티 에셋 참조 위치를 선택하세요',
    });

    const selected = Array.isArray(picked) ? picked[0] : picked;
    if (!selected) {
      return undefined;
    }

    const targetPath = path.resolve(root, selected.location.assetPath);
    const openedInUnity = await openAssetInUnityEditor(
      root,
      selected.location.assetPath,
      selected.location.gameObjectPath,
    );
    if (openedInUnity) {
      void vscode.window.showInformationMessage(
        `[UnityBrain] Unity Editor에서 '${selected.location.assetPath}' (${selected.location.gameObjectPath}) 위치를 열었습니다.`,
      );
      return selected.location;
    }

    const targetUri = vscode.Uri.file(targetPath);
    const targetLine = Math.max(0, selected.location.line - 1);
    const pos = new vscode.Position(targetLine, 0);

    const doc = await vscode.workspace.openTextDocument(targetUri);
    await vscode.window.showTextDocument(doc, {
      selection: new vscode.Range(pos, pos),
      preserveFocus: false,
    });
    return selected.location;
  });
}
