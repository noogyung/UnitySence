import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vscode from 'vscode';
import { IncludeDependencyGraph } from '../../shader-lsp/src/indexer/hlslIncludeGraph.ts';
import { ShaderCompletionProvider } from '../../shader-lsp/src/providers/completionProvider.ts';
import { ShaderDefinitionProvider } from '../../shader-lsp/src/providers/definitionProvider.ts';
import { ShaderHoverProvider } from '../../shader-lsp/src/providers/hoverProvider.ts';
import { UnityCSharpCodeActionProvider } from './analyzers/csharpCodeActionProvider.ts';
import { MsbuildAnalyzerInjector } from './analyzers/msbuildInjector.ts';
import { UnityAsmdefProvider } from './asmdef/unityAsmdefProvider.ts';
import {
  type DaemonClientTransport,
  registerShowAssetUsagesCommand,
  UnityAssetUsageCodeLensProvider,
  UnityDaemonClient,
} from './codelens/unityAssetUsageCodeLensProvider.ts';
import {
  registerCSharpGoToDefinitionCommand,
  UnityCSharpDefinitionProvider,
} from './completion/unityCSharpDefinitionProvider.ts';
import {
  registerGenerateEventFunctionsCommand,
  UnityEventCompletionProvider,
} from './completion/unityEventGenerator.ts';
import {
  detectApiParenOrStringContext,
  type UiToolkitElementRef,
  UnityStringCompletionProvider,
} from './completion/unityStringCompletionProvider.ts';
import { registerUnityEditorCommands } from './editor/unityEditorIntegration.ts';
import {
  collectUiToolkitElements,
  UnityUssCompletionProvider,
  UnityUxmlDefinitionProvider,
} from './uitoolkit/unityUiToolkitProvider.ts';
import type {
  ProjectSettingsCache,
  ShaderSymbolIndex,
  UnityApiDatabase,
  UnityProjectContext,
} from './contracts/index.ts';
import { UnityProjectContextManager } from './core/unityProjectContext.ts';
import { MetaFileSyncManager } from './meta/metaFileSyncManager.ts';
import {
  collectComputeAndShaderLabDiagnostics,
  SHADER_SEMANTIC_TOKEN_MODIFIERS,
  SHADER_SEMANTIC_TOKEN_TYPES,
  ShaderDocumentColorProvider,
  ShaderDocumentHighlightProvider,
  ShaderDocumentSymbolProvider,
  ShaderFoldingRangeProvider,
  ShaderReferenceProvider,
  ShaderRenameProvider,
  ShaderSemanticTokensProvider,
  ShaderSignatureHelpProvider,
} from './shader/shaderEditorProviders.ts';
import {
  isShaderFilePath,
  normalizePathKey,
  SHADER_FILE_EXTENSIONS,
  SHADER_LANGUAGE_IDS,
} from '../../shader-lsp/src/vfs/virtualPathResolver.ts';
import { ShaderExplorerProvider } from './shader/shaderExplorerView.ts';
import {
  analyzeShaderVariants,
  buildShaderPreprocessorKeywordCompletions,
  type DocResolveIncludeTextFn,
  isShaderDocument,
  ShaderKeywordContextStatusBar,
  ShaderVariantCodeLensProvider,
} from './shader/shaderKeywordContextStatusBar.ts';
import { ShaderFormattingProvider } from './shader/shaderFormatter.ts';
import { executeShaderLiveTestCommand } from './shader/shaderLiveTester.ts';
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
  shaderExplorerProvider: ShaderExplorerProvider;
  dispose: () => void;
}

const SHADER_EXT_GLOB = `**/*.{${SHADER_FILE_EXTENSIONS.map((e) => e.slice(1)).join(',')}}`;

const SHADER_SELECTOR: vscode.DocumentSelector = [
  ...SHADER_LANGUAGE_IDS.map((language) => ({ language })),
  { pattern: SHADER_EXT_GLOB },
];

const CSHARP_SELECTOR: vscode.DocumentSelector = [{ language: 'csharp' }];

let activeApi: UnityBrainExtensionApi | undefined;

function setUnityProjectContextKey(enabled: boolean): void {
  if (typeof vscode.commands.executeCommand === 'function') {
    void vscode.commands.executeCommand('setContext', 'unityBrain.isUnityProject', enabled);
  }
}

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
    types: [],
  };
}

function walkShaderFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkShaderFiles(full, out);
    } else if (entry.isFile() && isShaderFilePath(entry.name)) {
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
    unityEditorPath:
      options.unityEditorPath !== undefined
        ? options.unityEditorPath
        : configuredEditorPath || undefined,
    enableWatchers,
  });

  const unityContext = await contextManager.initialize();
  if (!unityContext) {
    setUnityProjectContextKey(false);
    contextManager.dispose();
    return undefined;
  }

  setUnityProjectContextKey(true);

  if (options.cacheDir) {
    unityContext.cacheDir = path.resolve(options.cacheDir);
  }

  const settingsWatcher = new ProjectSettingsWatcher(unityContext, { enableWatchers });
  const initialCache = await settingsWatcher.start();

  const outputChannel = vscode.window.createOutputChannel?.('UnityBrain');
  const shaderLiveOutputChannel = vscode.window.createOutputChannel?.('UnityBrain Shader Live Profiler');

  const msbuildInjector = new MsbuildAnalyzerInjector({
    extensionPath: context.extensionPath,
    projectRoot: unityContext.projectRoot,
    cacheDir: unityContext.cacheDir,
  });
  try {
    await msbuildInjector.ensureInjected();
  } catch (err) {
    outputChannel?.appendLine(
      `[UnityBrain] Directory.Build.props 자동 주입 중 오류 (무시하고 계속 진행): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const mainStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  mainStatusBar.command = 'unityBrain.rebuildAssetIndex';
  const refreshMainStatusBar = (ctx: UnityProjectContext, cache: ProjectSettingsCache) => {
    mainStatusBar.text = `$(flame) [UnityBrain] 활성 (Unity ${ctx.editorVersion} | 태그 ${cache.tags.length} · 레이어 ${cache.layers.length} · 씬 ${cache.buildScenes.length})`;
    mainStatusBar.tooltip = `[UnityBrain] 프로젝트: ${ctx.projectRoot}\n에디터 경로: ${ctx.editorInstallPath ?? '미감지 (PackageCache 기반 동작)'}\n클릭하여 에셋 인덱스를 다시 구축합니다.`;
  };
  refreshMainStatusBar(unityContext, initialCache);
  mainStatusBar.show();

  outputChannel?.appendLine(
    `[UnityBrain] 활성화 완료 (Unity ${unityContext.editorVersion}) | 루트: ${unityContext.projectRoot}`,
  );
  outputChannel?.appendLine(
    `[UnityBrain] 설정 로드: 태그 ${initialCache.tags.length}개, 레이어 ${initialCache.layers.length}개, 빌드 씬 ${initialCache.buildScenes.length}개`,
  );

  const shaderGraph = new IncludeDependencyGraph(unityContext);
  shaderGraph.registerWorkspaceShaderFiles(walkShaderFiles(path.join(unityContext.projectRoot, 'Assets')));
  const shaderDefinitionProvider = new ShaderDefinitionProvider(shaderGraph);
  const shaderCompletionProvider = new ShaderCompletionProvider(shaderGraph);
  const shaderHoverProvider = new ShaderHoverProvider(shaderGraph);
  const shaderDiagnosticCollection = vscode.languages.createDiagnosticCollection('unitybrain-shader');

  const updateShaderDiagnostics = (doc: vscode.TextDocument) => {
    if (!isShaderDocument(doc)) return;
    const diagsEnabled = vscode.workspace
      .getConfiguration('unityBrain')
      .get<boolean>('shader.diagnostics.enabled', true);
    if (!diagsEnabled) {
      shaderDiagnosticCollection.delete(doc.uri);
      return;
    }
    shaderGraph.setOpenDocumentContent(doc.uri.toString(), doc.getText());
    const walk = shaderGraph.collectReachableFiles(doc.uri.toString());
    const docKey = normalizePathKey(doc.uri.toString());
    const includeDiags = walk.unresolvedIncludes
      .filter((u) => u.fromUri === doc.uri.toString() || normalizePathKey(u.fromFile) === docKey)
      .map(
        (u) =>
          new vscode.Diagnostic(
            new vscode.Range(u.line, u.startCol, u.line, u.endCol),
            `[UnityBrain] 해석할 수 없는 유니티 셰이더 include 경로입니다: "${u.includePath}"`,
            vscode.DiagnosticSeverity.Error,
          ),
      );
    const semanticDiags = collectComputeAndShaderLabDiagnostics(doc, shaderGraph);
    shaderDiagnosticCollection.set(doc.uri, [...includeDiags, ...semanticDiags]);
  };

  let cachedShaderIndex: ShaderSymbolIndex | null = null;
  let cachedShaderKeywords: string[] | null = null;
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

  const eventCompletionProvider = new UnityEventCompletionProvider({
    apiDatabase,
    projectRoot: unityContext.projectRoot,
    getEditorVersion: () => contextManager.context?.editorVersion ?? unityContext.editorVersion,
  });

  const assetUsageCodeLensProvider = new UnityAssetUsageCodeLensProvider(
    unityContext.projectRoot,
    daemonClient,
    eventCompletionProvider,
  );
  const resolveIncludeText: DocResolveIncludeTextFn = (docUri, includePath, fromUri) => {
    const fromFs =
      fromUri && !fromUri.startsWith('Packages/') && !fromUri.startsWith('Assets/')
        ? shaderGraph.normalizeFilePath(fromUri)
        : docUri.fsPath;
    const resolved = shaderGraph.getResolver().resolve(includePath, fromFs);
    if (resolved.physicalPath && fs.existsSync(resolved.physicalPath)) {
      try {
        return {
          text: fs.readFileSync(resolved.physicalPath, 'utf8'),
          resolvedPath: resolved.physicalPath,
        };
      } catch {
        return undefined;
      }
    }
    return undefined;
  };

  const shaderVariantCodeLensProvider = new ShaderVariantCodeLensProvider({
    resolveIncludeText,
  });

  const collectProjectShaderKeywords = (): string[] => {
    if (cachedShaderKeywords !== null) {
      return cachedShaderKeywords;
    }
    const activeCtx = contextManager.context ?? unityContext;
    const files = walkShaderFiles(path.join(activeCtx.projectRoot, 'Assets'));
    const kwSet = new Set<string>();
    for (const file of files) {
      try {
        const analysis = analyzeShaderVariants(fs.readFileSync(file, 'utf8'));
        for (const kw of analysis.allKeywords) kwSet.add(kw);
      } catch {
        // Ignore unreadable shader
      }
    }
    cachedShaderKeywords = Array.from(kwSet);
    return cachedShaderKeywords;
  };

  const stringCompletionProvider = new UnityStringCompletionProvider(
    () => settingsWatcher.getCache(),
    () => cachedShaderIndex ?? buildCurrentShaderIndex(),
    {
      getInputActions: () => settingsWatcher.getInputActions(),
      getResourcePaths: () => settingsWatcher.getResourcePaths(),
      getShaderKeywords: collectProjectShaderKeywords,
    },
  );

  const csharpCodeActionProvider = new UnityCSharpCodeActionProvider();

  const metaSyncManager = new MetaFileSyncManager({ projectRoot: unityContext.projectRoot });

  const shaderKeywordStatusBar = new ShaderKeywordContextStatusBar({
    onKeywordsChanged: (_uri, keywords) => {
      shaderHoverProvider.setActiveKeywords(keywords);
      shaderVariantCodeLensProvider.refresh();
    },
    getDefinedMacros: (uri) => {
      const macros = new Set<string>();
      const walk = shaderGraph.collectReachableFiles(uri.toString());
      for (const file of walk.files.slice(1)) {
        for (const sym of file.symbols) {
          if (sym.kind === 'macro') macros.add(sym.name);
        }
      }
      return macros;
    },
    resolveIncludeText,
  });

  const shaderExplorerProvider = new ShaderExplorerProvider(
    () => contextManager.context?.projectRoot ?? unityContext.projectRoot,
    shaderGraph,
    { resolveIncludeText },
  );

  const shaderDiagTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const asmdefDiagTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const suggestTimers = new Set<ReturnType<typeof setTimeout>>();
  let assetRebuildTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleShaderDiagnostics = (doc: vscode.TextDocument) => {
    if (!isShaderDocument(doc)) return;
    if (!enableWatchers) {
      updateShaderDiagnostics(doc);
      return;
    }
    const key = doc.uri.toString();
    const existing = shaderDiagTimers.get(key);
    if (existing) clearTimeout(existing);
    shaderDiagTimers.set(
      key,
      setTimeout(() => {
        shaderDiagTimers.delete(key);
        updateShaderDiagnostics(doc);
      }, 200),
    );
  };

  const disposables: vscode.Disposable[] = [
    ...(outputChannel ? [outputChannel] : []),
    ...(shaderLiveOutputChannel ? [shaderLiveOutputChannel] : []),
    mainStatusBar,
    contextManager,
    settingsWatcher,
    daemonClient,
    shaderDiagnosticCollection,
    assetUsageCodeLensProvider,
    shaderVariantCodeLensProvider,
    metaSyncManager,
    shaderKeywordStatusBar,
    shaderExplorerProvider,
    new vscode.Disposable(() => {
      for (const t of shaderDiagTimers.values()) clearTimeout(t);
      shaderDiagTimers.clear();
      for (const t of asmdefDiagTimers.values()) clearTimeout(t);
      asmdefDiagTimers.clear();
      for (const t of suggestTimers) clearTimeout(t);
      suggestTimers.clear();
      if (assetRebuildTimer) {
        clearTimeout(assetRebuildTimer);
        assetRebuildTimer = undefined;
      }
    }),

    contextManager.onDidChangeContext((nextCtx) => {
      if (nextCtx) {
        shaderGraph.updateContext(nextCtx);
        shaderGraph.registerWorkspaceShaderFiles(walkShaderFiles(path.join(nextCtx.projectRoot, 'Assets')));
        settingsWatcher.updateContext(nextCtx);
        cachedShaderIndex = null;
        cachedShaderKeywords = null;
        shaderExplorerProvider.refresh();
        refreshMainStatusBar(nextCtx, settingsWatcher.getCache());
        for (const openDoc of vscode.workspace.textDocuments) {
          updateShaderDiagnostics(openDoc);
        }
      }
    }),

    settingsWatcher.onDidUpdateCache((nextCache) => {
      refreshMainStatusBar(contextManager.context ?? unityContext, nextCache);
    }),

    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration('unityBrain.analyzers.enabled')) {
        try {
          await msbuildInjector.ensureInjected();
        } catch (err) {
          outputChannel?.appendLine(
            `[UnityBrain] Directory.Build.props 갱신 중 오류: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (e.affectsConfiguration('unityBrain.codeLens.enabled')) {
        assetUsageCodeLensProvider.refresh();
        shaderVariantCodeLensProvider.refresh();
      }
      if (e.affectsConfiguration('unityBrain.shader.diagnostics.enabled')) {
        for (const openDoc of vscode.workspace.textDocuments) {
          updateShaderDiagnostics(openDoc);
        }
      }
    }),

    vscode.workspace.onDidOpenTextDocument((doc) => updateShaderDiagnostics(doc)),
    ...(typeof vscode.workspace.onDidCloseTextDocument === 'function'
      ? [
          vscode.workspace.onDidCloseTextDocument((doc) => {
            const key = doc.uri.toString();
            const sTimer = shaderDiagTimers.get(key);
            if (sTimer) {
              clearTimeout(sTimer);
              shaderDiagTimers.delete(key);
            }
            const aTimer = asmdefDiagTimers.get(key);
            if (aTimer) {
              clearTimeout(aTimer);
              asmdefDiagTimers.delete(key);
            }
            if (isShaderDocument(doc)) {
              shaderGraph.closeOpenDocument(key);
              shaderDiagnosticCollection.delete(doc.uri);
            }
            if (/\.(?:asmdef|asmref)$/i.test(doc.fileName)) {
              asmdefDiagCollection.delete(doc.uri);
            }
          }),
        ]
      : []),
    vscode.workspace.onDidChangeTextDocument((e) => {
      scheduleShaderDiagnostics(e.document);
      const changeReason = (e as { reason?: number }).reason;
      const reasonEnum = (
        vscode as unknown as { TextDocumentChangeReason?: { Undo: number; Redo: number } }
      ).TextDocumentChangeReason;
      const isUndoOrRedo =
        changeReason !== undefined &&
        reasonEnum !== undefined &&
        (changeReason === reasonEnum.Undo || changeReason === reasonEnum.Redo);
      if (
        enableWatchers &&
        !isUndoOrRedo &&
        e.document.languageId === 'csharp' &&
        e.contentChanges.length > 0 &&
        vscode.window.activeTextEditor?.document.uri.toString() === e.document.uri.toString()
      ) {
        const lastChange = e.contentChanges[e.contentChanges.length - 1];
        if (
          lastChange.text === '"' ||
          lastChange.text === '""' ||
          lastChange.text === '(' ||
          lastChange.text === '()' ||
          lastChange.text === ',' ||
          lastChange.text === ', '
        ) {
          const afterOffset =
            lastChange.text === '""' || lastChange.text === '()'
              ? e.document.offsetAt(lastChange.range.start) + 1
              : e.document.offsetAt(lastChange.range.start) + lastChange.text.length;
          const cursorPos = e.document.positionAt(afterOffset);
          const startLine = Math.max(0, cursorPos.line - 3);
          const snippet = e.document.getText(
            new vscode.Range(new vscode.Position(startLine, 0), cursorPos),
          );
          if (detectApiParenOrStringContext(snippet, e.document.getText())) {
            const suggestTimer = setTimeout(() => {
              suggestTimers.delete(suggestTimer);
              void vscode.commands.executeCommand('editor.action.triggerSuggest');
            }, 20);
            suggestTimers.add(suggestTimer);
          }
        }
      }
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (isShaderDocument(doc)) {
        cachedShaderIndex = null;
        cachedShaderKeywords = null;
        shaderExplorerProvider.refresh();
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
          const keywordToggleItems = buildShaderPreprocessorKeywordCompletions(
            doc,
            pos,
            shaderKeywordStatusBar,
          );
          if (keywordToggleItems && keywordToggleItems.length > 0) {
            return keywordToggleItems;
          }

          const items = shaderCompletionProvider.provideCompletionItems(
            doc.uri.toString(),
            { line: pos.line, character: pos.character },
            doc.getText(),
          );
          return items.map((item) => {
            const mappedKind =
              typeof item.kind === 'number'
                ? (Math.max(0, item.kind - 1) as vscode.CompletionItemKind)
                : undefined;
            const ci = new vscode.CompletionItem(item.label, mappedKind);
            ci.detail = item.detail;
            if (typeof item.documentation === 'string') {
              ci.documentation = item.documentation;
            } else if (item.documentation && typeof item.documentation === 'object' && 'value' in item.documentation) {
              ci.documentation = new vscode.MarkdownString(String(item.documentation.value));
            }
            if (item.insertText) {
              ci.insertText =
                item.insertTextFormat === 2
                  ? new vscode.SnippetString(item.insertText)
                  : item.insertText;
            }
            if (item.filterText) {
              ci.filterText = item.filterText;
            }
            if (item.sortText) {
              ci.sortText = item.sortText;
            }
            return ci;
          });
        },
      },
      '"',
      '/',
      '.',
      '#',
      '_',
      ' ',
      '[',
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
      '(',
      ',',
      ' ',
    ),
    vscode.languages.registerCompletionItemProvider(
      CSHARP_SELECTOR,
      eventCompletionProvider,
      ' ',
    ),
    vscode.languages.registerCodeActionsProvider(
      CSHARP_SELECTOR,
      csharpCodeActionProvider,
      { providedCodeActionKinds: UnityCSharpCodeActionProvider.providedCodeActionKinds },
    ),
    vscode.languages.registerCodeLensProvider(CSHARP_SELECTOR, assetUsageCodeLensProvider),
    vscode.languages.registerCodeLensProvider(SHADER_SELECTOR, shaderVariantCodeLensProvider),

    registerGenerateEventFunctionsCommand(eventCompletionProvider),
    registerShowAssetUsagesCommand(unityContext.projectRoot),
    vscode.commands.registerCommand('unityBrain.rebuildAssetIndex', async () => {
      try {
        const res = await daemonClient.rebuild(true);
        assetUsageCodeLensProvider.refresh();
        void vscode.window.showInformationMessage(
          `[UnityBrain] 에셋 인덱스 재구축 완료 (${res.indexedAssets}개 에셋, ${res.elapsedMs}ms)`,
        );
        return res;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel?.appendLine(`[UnityBrain] 에셋 인덱스 재구축 실패: ${msg}`);
        void vscode.window.showErrorMessage(`[UnityBrain] 에셋 인덱스 재구축 실패: ${msg}`);
        return null;
      }
    }),
    vscode.commands.registerCommand('unityBrain.cleanOrphanMetaFiles', async () => {
      const removed = await metaSyncManager.cleanOrphanMetaFiles();
      void vscode.window.showInformationMessage(
        `[UnityBrain] 고아 .meta 파일 ${removed.length}개를 정리했습니다.`,
      );
      return removed;
    }),
  ];

  const langWithLinks = vscode.languages as unknown as {
    registerDocumentLinkProvider?: (
      selector: vscode.DocumentSelector,
      provider: { provideDocumentLinks: (doc: vscode.TextDocument) => unknown[] },
    ) => vscode.Disposable;
  };
  const DocLinkCtor = (vscode as unknown as {
    DocumentLink?: new (
      range: vscode.Range,
      target?: vscode.Uri,
    ) => { range: vscode.Range; target?: vscode.Uri; tooltip?: string };
  }).DocumentLink;

  if (typeof langWithLinks.registerDocumentLinkProvider === 'function') {
    disposables.push(
      langWithLinks.registerDocumentLinkProvider(SHADER_SELECTOR, {
        provideDocumentLinks(doc: vscode.TextDocument) {
          shaderGraph.setOpenDocumentContent(doc.uri.toString(), doc.getText());
          const filePath = shaderGraph.normalizeFilePath(doc.uri.toString());
          const parsed = shaderGraph.getOrParseFile(filePath);
          if (!parsed) return [];
          const links: unknown[] = [];
          for (const inc of parsed.includes) {
            const resolved = shaderGraph.getResolver().resolve(inc.rawPath, filePath);
            if (!resolved.physicalPath) continue;
            const range = new vscode.Range(
              inc.line,
              inc.pathStartColumn,
              inc.line,
              inc.pathEndColumn,
            );
            const target = vscode.Uri.file(resolved.physicalPath);
            const link = DocLinkCtor
              ? new DocLinkCtor(range, target)
              : { range, target, tooltip: '' };
            link.tooltip = `[UnityBrain] 클릭하여 셰이더 파일 열기: ${resolved.physicalPath}`;
            links.push(link);
          }
          return links;
        },
      }),
    );
  }

  const semanticLegend = new vscode.SemanticTokensLegend(
    [...SHADER_SEMANTIC_TOKEN_TYPES],
    [...SHADER_SEMANTIC_TOKEN_MODIFIERS],
  );
  const shaderSemanticTokensProvider = new ShaderSemanticTokensProvider(shaderGraph, semanticLegend);
  const shaderDocumentSymbolProvider = new ShaderDocumentSymbolProvider(shaderGraph);
  const shaderSignatureHelpProvider = new ShaderSignatureHelpProvider(shaderGraph);
  const shaderHighlightProvider = new ShaderDocumentHighlightProvider(shaderGraph);
  const shaderReferenceProvider = new ShaderReferenceProvider(shaderGraph);
  const shaderRenameProvider = new ShaderRenameProvider(shaderGraph);
  const shaderFoldingRangeProvider = new ShaderFoldingRangeProvider();
  const shaderColorProvider = new ShaderDocumentColorProvider();
  const shaderFormattingProvider = new ShaderFormattingProvider();

  disposables.push(
    vscode.languages.registerDocumentSemanticTokensProvider(
      SHADER_SELECTOR,
      shaderSemanticTokensProvider,
      semanticLegend,
    ),
    vscode.languages.registerDocumentSymbolProvider(SHADER_SELECTOR, shaderDocumentSymbolProvider),
    vscode.languages.registerSignatureHelpProvider(
      SHADER_SELECTOR,
      shaderSignatureHelpProvider,
      { triggerCharacters: ['(', ','], retriggerCharacters: ['(', ',', ' ', '\t', '\n'] },
    ),
    vscode.languages.registerDocumentHighlightProvider(SHADER_SELECTOR, shaderHighlightProvider),
    vscode.languages.registerReferenceProvider(SHADER_SELECTOR, shaderReferenceProvider),
    vscode.languages.registerRenameProvider(SHADER_SELECTOR, shaderRenameProvider),
    vscode.languages.registerFoldingRangeProvider(SHADER_SELECTOR, shaderFoldingRangeProvider),
    vscode.languages.registerColorProvider(SHADER_SELECTOR, shaderColorProvider),
    vscode.commands.registerCommand('unityBrain.testCurrentShader', () =>
      executeShaderLiveTestCommand(shaderGraph, shaderDiagnosticCollection, shaderLiveOutputChannel),
    ),
  );
  if (typeof vscode.window.registerTreeDataProvider === 'function') {
    disposables.push(
      vscode.window.registerTreeDataProvider('unityBrain.shaderExplorer', shaderExplorerProvider),
    );
  }
  disposables.push(
    vscode.commands.registerCommand('unityBrain.refreshShaderExplorer', () => {
      shaderExplorerProvider.refresh();
    }),
  );
  if (typeof vscode.languages.registerDocumentFormattingEditProvider === 'function') {
    disposables.push(
      vscode.languages.registerDocumentFormattingEditProvider(SHADER_SELECTOR, shaderFormattingProvider),
    );
  }
  if (typeof vscode.languages.registerDocumentRangeFormattingEditProvider === 'function') {
    disposables.push(
      vscode.languages.registerDocumentRangeFormattingEditProvider(SHADER_SELECTOR, shaderFormattingProvider),
    );
  }
  if (typeof vscode.languages.registerOnTypeFormattingEditProvider === 'function') {
    disposables.push(
      vscode.languages.registerOnTypeFormattingEditProvider(SHADER_SELECTOR, shaderFormattingProvider, '}', '\n'),
    );
  }

  let cachedUiElements: UiToolkitElementRef[] | null = null;
  const getUiToolkitElements = (): UiToolkitElementRef[] => {
    if (!cachedUiElements) {
      cachedUiElements = collectUiToolkitElements(unityContext.projectRoot);
    }
    return cachedUiElements;
  };
  stringCompletionProvider.setExtraSources({ getUiToolkitElements });

  const asmdefProvider = new UnityAsmdefProvider(unityContext.projectRoot);
  const asmdefDiagCollection = vscode.languages.createDiagnosticCollection('unitybrain-asmdef');
  const updateAsmdefDiagnostics = (doc: vscode.TextDocument) => {
    if (!/\.(?:asmdef|asmref)$/i.test(doc.fileName)) return;
    asmdefDiagCollection.set(doc.uri, asmdefProvider.validateDocument(doc));
  };
  const scheduleAsmdefDiagnostics = (doc: vscode.TextDocument) => {
    if (!/\.(?:asmdef|asmref)$/i.test(doc.fileName)) return;
    if (!enableWatchers) {
      updateAsmdefDiagnostics(doc);
      return;
    }
    const key = doc.uri.toString();
    const existing = asmdefDiagTimers.get(key);
    if (existing) clearTimeout(existing);
    asmdefDiagTimers.set(
      key,
      setTimeout(() => {
        asmdefDiagTimers.delete(key);
        updateAsmdefDiagnostics(doc);
      }, 250),
    );
  };
  const ussCompletionProvider = new UnityUssCompletionProvider(getUiToolkitElements);
  const uxmlDefinitionProvider = new UnityUxmlDefinitionProvider(
    unityContext.projectRoot,
    getUiToolkitElements,
  );
  const ASMDEF_SELECTOR: vscode.DocumentSelector = [{ pattern: '**/*.{asmdef,asmref}' }];
  const USS_SELECTOR: vscode.DocumentSelector = [{ language: 'uss' }, { pattern: '**/*.uss' }];
  const UXML_SELECTOR: vscode.DocumentSelector = [{ language: 'uxml' }, { pattern: '**/*.uxml' }];

  const csharpDefinitionProvider = new UnityCSharpDefinitionProvider({
    projectRoot: unityContext.projectRoot,
    getCache: () => settingsWatcher.getCache(),
    getUiToolkitElements,
  });

  disposables.push(
    csharpDefinitionProvider,
    asmdefProvider,
    asmdefDiagCollection,
    vscode.languages.registerDefinitionProvider(CSHARP_SELECTOR, csharpDefinitionProvider),
    registerCSharpGoToDefinitionCommand(csharpDefinitionProvider),
    vscode.languages.registerDefinitionProvider(ASMDEF_SELECTOR, asmdefProvider),
    vscode.languages.registerCompletionItemProvider(ASMDEF_SELECTOR, asmdefProvider, '"', '[', ',', ' '),
    vscode.languages.registerCompletionItemProvider(USS_SELECTOR, ussCompletionProvider, ':', '.', '#', '-'),
    vscode.languages.registerDefinitionProvider(UXML_SELECTOR, uxmlDefinitionProvider),
    ...registerUnityEditorCommands(unityContext.projectRoot),
    vscode.workspace.onDidOpenTextDocument((doc) => updateAsmdefDiagnostics(doc)),
    vscode.workspace.onDidChangeTextDocument((e) => scheduleAsmdefDiagnostics(e.document)),
  );

  const langWithInlayHints = vscode.languages as unknown as {
    registerInlayHintsProvider?: (
      selector: vscode.DocumentSelector,
      provider: vscode.InlayHintsProvider,
    ) => vscode.Disposable;
  };
  if (typeof langWithInlayHints.registerInlayHintsProvider === 'function') {
    disposables.push(langWithInlayHints.registerInlayHintsProvider(ASMDEF_SELECTOR, asmdefProvider));
  }

  for (const openDoc of vscode.workspace.textDocuments) {
    updateAsmdefDiagnostics(openDoc);
  }

  if (enableWatchers) {
    const invalidateEcosystemCaches = () => {
      asmdefProvider.invalidate();
      cachedUiElements = null;
      for (const openDoc of vscode.workspace.textDocuments) {
        updateAsmdefDiagnostics(openDoc);
      }
    };
    for (const pat of ['Assets/**/*.{asmdef,asmref,uxml,uss}', 'Packages/**/*.{asmdef,asmref,uxml,uss}']) {
      const uiAndAsmWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(unityContext.projectRoot, pat),
      );
      disposables.push(
        uiAndAsmWatcher,
        uiAndAsmWatcher.onDidChange(invalidateEcosystemCaches),
        uiAndAsmWatcher.onDidCreate(invalidateEcosystemCaches),
        uiAndAsmWatcher.onDidDelete(invalidateEcosystemCaches),
      );
    }
    for (const pat of ['Packages/**/*', 'Library/PackageCache/*']) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(unityContext.projectRoot, pat),
      );
      const onPackageChanged = () => {
        shaderGraph.getResolver().invalidateCache();
        cachedShaderIndex = null;
        cachedShaderKeywords = null;
        shaderExplorerProvider.refresh();
        invalidateEcosystemCaches();
        for (const openDoc of vscode.workspace.textDocuments) {
          updateShaderDiagnostics(openDoc);
        }
      };
      disposables.push(
        watcher,
        watcher.onDidChange(onPackageChanged),
        watcher.onDidCreate(onPackageChanged),
        watcher.onDidDelete(onPackageChanged),
      );
    }

    const shaderWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(unityContext.projectRoot, `Assets/${SHADER_EXT_GLOB}`),
    );
    const onShaderFilesChanged = (uri?: vscode.Uri) => {
      const activeCtx = contextManager.context ?? unityContext;
      if (uri?.fsPath) {
        shaderGraph.invalidateFile(uri.fsPath);
      }
      shaderGraph.registerWorkspaceShaderFiles(
        walkShaderFiles(path.join(activeCtx.projectRoot, 'Assets')),
      );
      cachedShaderIndex = null;
      cachedShaderKeywords = null;
      shaderExplorerProvider.refresh();
      for (const openDoc of vscode.workspace.textDocuments) {
        updateShaderDiagnostics(openDoc);
      }
    };
    disposables.push(
      shaderWatcher,
      shaderWatcher.onDidChange(onShaderFilesChanged),
      shaderWatcher.onDidCreate(onShaderFilesChanged),
      shaderWatcher.onDidDelete(onShaderFilesChanged),
    );

    for (const pat of [
      'Assets/**/*.{unity,prefab,asset,controller,meta}',
      'Packages/**/*.{unity,prefab,asset,controller,meta}',
    ]) {
      const assetWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(unityContext.projectRoot, pat),
      );
      const onAssetChanged = () => {
        const codeLensEnabled = vscode.workspace
          .getConfiguration('unityBrain')
          .get<boolean>('codeLens.enabled', true);
        if (!codeLensEnabled) return;
        if (assetRebuildTimer) clearTimeout(assetRebuildTimer);
        assetRebuildTimer = setTimeout(() => {
          assetRebuildTimer = undefined;
          void daemonClient
            .rebuild(false)
            .then(() => assetUsageCodeLensProvider.refresh())
            .catch(() => {});
        }, 400);
      };
      disposables.push(
        assetWatcher,
        assetWatcher.onDidChange(onAssetChanged),
        assetWatcher.onDidCreate(onAssetChanged),
        assetWatcher.onDidDelete(onAssetChanged),
      );
    }

    const csWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(unityContext.projectRoot, 'Assets/**/*.cs'),
    );
    const onCsChanged = () => {
      eventCompletionProvider.invalidateInheritanceCache();
    };
    disposables.push(
      csWatcher,
      csWatcher.onDidChange(onCsChanged),
      csWatcher.onDidCreate(onCsChanged),
      csWatcher.onDidDelete(onCsChanged),
    );
  }

  for (const openDoc of vscode.workspace.textDocuments) {
    updateShaderDiagnostics(openDoc);
  }

  void vscode.window.showInformationMessage(
    `[UnityBrain] 유니티 프로젝트 활성화 완료! (Unity ${unityContext.editorVersion} | 태그 ${initialCache.tags.length}개 · 레이어 ${initialCache.layers.length}개 · 씬 ${initialCache.buildScenes.length}개 로드됨)`,
  );

  let disposed = false;
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
    shaderExplorerProvider,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      setUnityProjectContextKey(false);
      while (disposables.length > 0) {
        try {
          disposables.pop()?.dispose();
        } catch {
          // Ignore individual disposal failures during teardown
        }
      }
      if (activeApi === api) {
        activeApi = undefined;
      }
    },
  };

  context.subscriptions.push({ dispose: () => api.dispose() });
  activeApi = api;
  return api;
}

export function deactivate(): void {
  activeApi?.dispose();
  activeApi = undefined;
}
