import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vscode from 'vscode';
import { IncludeDependencyGraph } from '../../shader-lsp/src/indexer/hlslIncludeGraph.ts';
import { ShaderCompletionProvider } from '../../shader-lsp/src/providers/completionProvider.ts';
import { ShaderDefinitionProvider } from '../../shader-lsp/src/providers/definitionProvider.ts';
import { ShaderHoverProvider } from '../../shader-lsp/src/providers/hoverProvider.ts';
import { MsbuildAnalyzerInjector } from './analyzers/msbuildInjector.ts';
import {
  type DaemonClientTransport,
  registerShowAssetUsagesCommand,
  UnityAssetUsageCodeLensProvider,
  UnityDaemonClient,
} from './codelens/unityAssetUsageCodeLensProvider.ts';
import {
  registerGenerateEventFunctionsCommand,
  UnityEventCompletionProvider,
} from './completion/unityEventGenerator.ts';
import { UnityStringCompletionProvider } from './completion/unityStringCompletionProvider.ts';
import type {
  ShaderSymbolIndex,
  UnityApiDatabase,
  UnityProjectContext,
} from './contracts/index.ts';
import { UnityProjectContextManager } from './core/unityProjectContext.ts';
import { MetaFileSyncManager } from './meta/metaFileSyncManager.ts';
import {
  isShaderDocument,
  ShaderKeywordContextStatusBar,
  ShaderVariantCodeLensProvider,
} from './shader/shaderKeywordContextStatusBar.ts';
import { ProjectSettingsWatcher } from './watchers/projectSettingsWatcher.ts';

export interface UnityBrainActivationOptions {
  workspaceRoot?: string;
  unityEditorPath?: string | null;
  cacheDir?: string;
  enableWatchers?: boolean;
  daemonTransportFactory?: () => DaemonClientTransport;
}

export interface UnityBrainExtensionApi {
  context: UnityProjectContext;
  contextManager: UnityProjectContextManager;
  settingsWatcher: ProjectSettingsWatcher;
  msbuildInjector: MsbuildAnalyzerInjector;
  daemonClient: UnityDaemonClient;
  shaderGraph: IncludeDependencyGraph;
  shaderDefinitionProvider: ShaderDefinitionProvider;
  shaderCompletionProvider: ShaderCompletionProvider;
  shaderHoverProvider: ShaderHoverProvider;
  assetUsageCodeLensProvider: UnityAssetUsageCodeLensProvider;
  shaderVariantCodeLensProvider: ShaderVariantCodeLensProvider;
  stringCompletionProvider: UnityStringCompletionProvider;
  eventCompletionProvider: UnityEventCompletionProvider;
  metaSyncManager: MetaFileSyncManager;
  shaderKeywordStatusBar: ShaderKeywordContextStatusBar;
  dispose: () => void;
}

const SHADER_SELECTOR: vscode.DocumentSelector = [
  { language: 'unity-shaderlab' },
  { language: 'shaderlab' },
  { language: 'hlsl' },
];

const CSHARP_SELECTOR: vscode.DocumentSelector = [{ language: 'csharp' }];

let activeApi: UnityBrainExtensionApi | undefined;

function loadUnityApiDatabase(extensionPath: string): UnityApiDatabase {
  const candidates = [
    path.join(extensionPath, 'resources', 'unity-api.json'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'unity-api.json'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'resources', 'unity-api.json'),
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      return JSON.parse(fs.readFileSync(candidate, 'utf8')) as UnityApiDatabase;
    } catch {
      // Try next candidate
    }
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    unityVersionRange: '*',
    types: [],
  };
}

function walkShaderFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkShaderFiles(full, out);
    } else if (entry.isFile() && /\.(shader|hlsl|hlsli|cginc|compute|urtshader|hlslinc)$/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

export async function activate(
  context: vscode.ExtensionContext,
  options: UnityBrainActivationOptions = {},
): Promise<UnityBrainExtensionApi | undefined> {
  const enableWatchers = options.enableWatchers ?? true;
  const configuredEditorPath = vscode.workspace
    .getConfiguration('unityBrain')
    .get<string>('unityEditorPath', '');

  const contextManager = new UnityProjectContextManager({
    workspaceRoot: options.workspaceRoot,
    unityEditorPath: options.unityEditorPath ?? (configuredEditorPath || undefined),
    enableWatchers,
  });

  const unityContext = await contextManager.initialize();
  if (!unityContext) {
    contextManager.dispose();
    return undefined;
  }

  if (options.cacheDir) {
    unityContext.cacheDir = path.resolve(options.cacheDir);
  }

  const settingsWatcher = new ProjectSettingsWatcher(unityContext, { enableWatchers });
  await settingsWatcher.start();

  const msbuildInjector = new MsbuildAnalyzerInjector({
    extensionPath: context.extensionPath,
    projectRoot: unityContext.projectRoot,
    cacheDir: unityContext.cacheDir,
  });
  await msbuildInjector.ensureInjected();

  const shaderGraph = new IncludeDependencyGraph(unityContext);
  const shaderDefinitionProvider = new ShaderDefinitionProvider(shaderGraph);
  const shaderCompletionProvider = new ShaderCompletionProvider(shaderGraph);
  const shaderHoverProvider = new ShaderHoverProvider(shaderGraph);
  const shaderDiagnosticCollection = vscode.languages.createDiagnosticCollection('unitybrain-shader');

  const updateShaderDiagnostics = (doc: vscode.TextDocument) => {
    if (!isShaderDocument(doc)) return;
    shaderGraph.setOpenDocumentContent(doc.uri.toString(), doc.getText());
    const walk = shaderGraph.collectReachableFiles(doc.uri.toString());
    const normDocPath = shaderGraph.normalizeFilePath(doc.uri.toString());
    const diags = walk.unresolvedIncludes
      .filter((u) => u.fromUri === doc.uri.toString() || u.fromFile === normDocPath)
      .map(
        (u) =>
          new vscode.Diagnostic(
            new vscode.Range(u.line, u.startCol, u.line, u.endCol),
            `Unresolved Unity shader include: "${u.rawPath}"`,
            vscode.DiagnosticSeverity.Error,
          ),
      );
    shaderDiagnosticCollection.set(doc.uri, diags);
  };

  let cachedShaderIndex: ShaderSymbolIndex | null = null;
  const buildCurrentShaderIndex = (): ShaderSymbolIndex => {
    const activeCtx = contextManager.context ?? unityContext;
    const files = walkShaderFiles(path.join(activeCtx.projectRoot, 'Assets'));
    cachedShaderIndex = shaderGraph.buildShaderSymbolIndex(files);
    return cachedShaderIndex;
  };

  const apiDatabase = loadUnityApiDatabase(context.extensionPath);

  const daemonClient = new UnityDaemonClient({
    projectRoot: unityContext.projectRoot,
    extensionPath: context.extensionPath,
    cacheDir: unityContext.cacheDir,
    transportFactory: options.daemonTransportFactory,
  });

  const assetUsageCodeLensProvider = new UnityAssetUsageCodeLensProvider(
    unityContext.projectRoot,
    daemonClient,
  );
  const shaderVariantCodeLensProvider = new ShaderVariantCodeLensProvider();

  const stringCompletionProvider = new UnityStringCompletionProvider(
    () => settingsWatcher.getCache(),
    () => cachedShaderIndex ?? buildCurrentShaderIndex(),
  );

  const eventCompletionProvider = new UnityEventCompletionProvider({
    apiDatabase,
    getEditorVersion: () => contextManager.context?.editorVersion ?? unityContext.editorVersion,
  });

  const metaSyncManager = new MetaFileSyncManager({ projectRoot: unityContext.projectRoot });

  const shaderKeywordStatusBar = new ShaderKeywordContextStatusBar({
    onKeywordsChanged: (_uri, keywords) => {
      shaderHoverProvider.setActiveKeywords(keywords);
      shaderVariantCodeLensProvider.refresh();
    },
  });

  const disposables: vscode.Disposable[] = [
    contextManager,
    settingsWatcher,
    daemonClient,
    shaderDiagnosticCollection,
    assetUsageCodeLensProvider,
    shaderVariantCodeLensProvider,
    metaSyncManager,
    shaderKeywordStatusBar,

    contextManager.onDidChangeContext((nextCtx) => {
      if (nextCtx) {
        shaderGraph.updateContext(nextCtx);
        settingsWatcher.updateContext(nextCtx);
        cachedShaderIndex = null;
      }
    }),

    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration('unityBrain.analyzers.enabled')) {
        await msbuildInjector.ensureInjected();
      }
    }),

    vscode.workspace.onDidOpenTextDocument((doc) => updateShaderDiagnostics(doc)),
    vscode.workspace.onDidChangeTextDocument((e) => updateShaderDiagnostics(e.document)),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (isShaderDocument(doc)) {
        cachedShaderIndex = null;
        updateShaderDiagnostics(doc);
      }
    }),

    vscode.languages.registerDefinitionProvider(SHADER_SELECTOR, {
      provideDefinition(doc: vscode.TextDocument, pos: vscode.Position) {
        const locs = shaderDefinitionProvider.provideDefinition(
          doc.uri.toString(),
          { line: pos.line, character: pos.character },
          doc.getText(),
        );
        return locs.map(
          (l) =>
            new vscode.Location(
              vscode.Uri.parse(l.uri),
              new vscode.Range(
                l.range.start.line,
                l.range.start.character,
                l.range.end.line,
                l.range.end.character,
              ),
            ),
        );
      },
    }),

    vscode.languages.registerCompletionItemProvider(
      SHADER_SELECTOR,
      {
        provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position) {
          const items = shaderCompletionProvider.provideCompletionItems(
            doc.uri.toString(),
            { line: pos.line, character: pos.character },
            doc.getText(),
          );
          return items.map((item) => {
            const ci = new vscode.CompletionItem(
              item.label,
              item.kind as vscode.CompletionItemKind | undefined,
            );
            ci.detail = item.detail;
            if (typeof item.documentation === 'string') {
              ci.documentation = item.documentation;
            } else if (item.documentation && typeof item.documentation === 'object' && 'value' in item.documentation) {
              ci.documentation = new vscode.MarkdownString(String(item.documentation.value));
            }
            if (item.insertText) {
              ci.insertText = item.insertText;
            }
            return ci;
          });
        },
      },
      '"',
      '/',
      '.',
    ),

    vscode.languages.registerHoverProvider(SHADER_SELECTOR, {
      provideHover(doc: vscode.TextDocument, pos: vscode.Position) {
        const hover = shaderHoverProvider.provideHover(
          doc.uri.toString(),
          { line: pos.line, character: pos.character },
          doc.getText(),
          unityContext.projectRoot,
        );
        if (!hover) return undefined;
        const val =
          typeof hover.contents === 'string'
            ? hover.contents
            : 'value' in hover.contents
              ? String(hover.contents.value)
              : '';
        return new vscode.Hover(new vscode.MarkdownString(val));
      },
    }),

    vscode.languages.registerCompletionItemProvider(
      CSHARP_SELECTOR,
      stringCompletionProvider,
      '"',
    ),
    vscode.languages.registerCompletionItemProvider(
      CSHARP_SELECTOR,
      eventCompletionProvider,
    ),
    vscode.languages.registerCodeLensProvider(CSHARP_SELECTOR, assetUsageCodeLensProvider),
    vscode.languages.registerCodeLensProvider(SHADER_SELECTOR, shaderVariantCodeLensProvider),

    registerGenerateEventFunctionsCommand(eventCompletionProvider),
    registerShowAssetUsagesCommand(unityContext.projectRoot),
    vscode.commands.registerCommand('unityBrain.rebuildAssetIndex', async () => {
      const res = await daemonClient.rebuild(true);
      assetUsageCodeLensProvider.refresh();
      return res;
    }),
  ];

  for (const d of disposables) {
    context.subscriptions.push(d);
  }

  for (const openDoc of vscode.workspace.textDocuments) {
    updateShaderDiagnostics(openDoc);
  }

  const api: UnityBrainExtensionApi = {
    context: unityContext,
    contextManager,
    settingsWatcher,
    msbuildInjector,
    daemonClient,
    shaderGraph,
    shaderDefinitionProvider,
    shaderCompletionProvider,
    shaderHoverProvider,
    assetUsageCodeLensProvider,
    shaderVariantCodeLensProvider,
    stringCompletionProvider,
    eventCompletionProvider,
    metaSyncManager,
    shaderKeywordStatusBar,
    dispose: () => {
      while (disposables.length > 0) {
        disposables.pop()?.dispose();
      }
      if (activeApi === api) {
        activeApi = undefined;
      }
    },
  };

  activeApi = api;
  return api;
}

export function deactivate(): void {
  activeApi?.dispose();
  activeApi = undefined;
}
