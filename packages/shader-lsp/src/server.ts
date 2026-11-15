import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createConnection,
  DiagnosticSeverity,
  ProposedFeatures,
  SymbolKind,
  TextDocument,
  TextDocuments,
  TextDocumentSyncKind,
  type Connection,
  type Diagnostic,
  type InitializeParams,
} from 'vscode-languageserver';
import type { ShaderSymbolIndex, UnityProjectContext } from '../../extension/src/contracts/index.ts';
import { IncludeDependencyGraph } from './indexer/hlslIncludeGraph.ts';
import { ShaderDefinitionProvider } from './providers/definitionProvider.ts';
import { ShaderCompletionProvider } from './providers/completionProvider.ts';
import { ShaderHoverProvider } from './providers/hoverProvider.ts';

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

export interface ShaderLanguageServerHandle {
  getGraph: () => IncludeDependencyGraph | null;
  getHoverProvider: () => ShaderHoverProvider | null;
  dispose: () => void;
}

export function createShaderLanguageServer(
  connection: Connection,
  initialContext: UnityProjectContext | null = null,
): ShaderLanguageServerHandle {
  const documents = new TextDocuments(TextDocument);
  let context: UnityProjectContext | null = initialContext;
  let graph: IncludeDependencyGraph | null = context ? new IncludeDependencyGraph(context) : null;
  let definitionProvider = graph ? new ShaderDefinitionProvider(graph) : null;
  let completionProvider = graph ? new ShaderCompletionProvider(graph) : null;
  let hoverProvider = graph ? new ShaderHoverProvider(graph) : null;

  const ensureContext = (newCtx: UnityProjectContext) => {
    context = newCtx;
    if (!graph) {
      graph = new IncludeDependencyGraph(newCtx);
      definitionProvider = new ShaderDefinitionProvider(graph);
      completionProvider = new ShaderCompletionProvider(graph);
      hoverProvider = new ShaderHoverProvider(graph);
    } else {
      graph.updateContext(newCtx);
    }
  };

  const buildDefaultContextFromRoot = (rootPath: string): UnityProjectContext => ({
    projectRoot: rootPath,
    editorVersion: 'unknown',
    editorInstallPath: null,
    cgIncludesPath: null,
    builtInPackagesPath: null,
    manifestPath: path.join(rootPath, 'Packages', 'manifest.json'),
    packagesLockPath: fs.existsSync(path.join(rootPath, 'Packages', 'packages-lock.json'))
      ? path.join(rootPath, 'Packages', 'packages-lock.json')
      : null,
    cacheDir: path.join(rootPath, 'Library', 'UnityBrainCache'),
  });

  const validateDocument = (doc: TextDocument) => {
    if (!graph) return;
    graph.setOpenDocumentContent(doc.uri, doc.getText());
    const walk = graph.collectReachableFiles(doc.uri);
    const diagnostics: Diagnostic[] = walk.unresolvedIncludes
      .filter((u) => u.fromUri === doc.uri || graph?.normalizeFilePath(doc.uri) === u.fromFile)
      .map((u) => ({
        severity: DiagnosticSeverity.Error,
        range: {
          start: { line: u.line, character: u.startCol },
          end: { line: u.line, character: u.endCol },
        },
        source: 'unitybrain-shader-lsp',
        code: 'UB-SHADER-001',
        message: `Unresolved Unity #include path: "${u.includePath}"`,
      }));
    void connection.sendDiagnostics({ uri: doc.uri, diagnostics });
  };

  connection.onInitialize((params: InitializeParams) => {
    const initOpts = params.initializationOptions as { unityContext?: UnityProjectContext } | undefined;
    if (initOpts?.unityContext) {
      ensureContext(initOpts.unityContext);
    } else if (!context && params.rootUri) {
      try {
        ensureContext(buildDefaultContextFromRoot(fileURLToPath(params.rootUri)));
      } catch {
        // Ignore non-file rootUri
      }
    }

    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        definitionProvider: true,
        completionProvider: {
          resolveProvider: false,
          triggerCharacters: ['"', '/', '.'],
        },
        hoverProvider: true,
        documentSymbolProvider: true,
      },
    };
  });

  documents.onDidChangeContent(({ document }) => {
    validateDocument(document);
  });

  documents.onDidClose(({ document }) => {
    graph?.closeOpenDocument(document.uri);
    void connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
  });

  connection.onDefinition((params) => {
    if (!definitionProvider) return null;
    const doc = documents.get(params.textDocument.uri);
    const locs = definitionProvider.provideDefinition(
      params.textDocument.uri,
      params.position,
      doc?.getText(),
    );
    return locs.length > 0 ? locs : null;
  });

  connection.onCompletion((params) => {
    if (!completionProvider) return [];
    const doc = documents.get(params.textDocument.uri);
    const text =
      doc?.getText() ??
      (() => {
        try {
          const p = fileURLToPath(params.textDocument.uri);
          return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
        } catch {
          return '';
        }
      })();
    return completionProvider.provideCompletionItems(params.textDocument.uri, params.position, text);
  });

  connection.onHover((params) => {
    if (!hoverProvider) return null;
    const doc = documents.get(params.textDocument.uri);
    const text =
      doc?.getText() ??
      (() => {
        try {
          const p = fileURLToPath(params.textDocument.uri);
          return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
        } catch {
          return '';
        }
      })();
    return hoverProvider.provideHover(
      params.textDocument.uri,
      params.position,
      text,
      context?.projectRoot,
    );
  });

  connection.onDocumentSymbol((params) => {
    if (!graph) return [];
    const doc = documents.get(params.textDocument.uri);
    if (doc) {
      graph.setOpenDocumentContent(doc.uri, doc.getText());
    }
    const parsed = graph.getOrParseFile(params.textDocument.uri);
    if (!parsed) return [];
    const kindMap: Record<string, number> = {
      function: SymbolKind.Function,
      struct: SymbolKind.Struct,
      field: SymbolKind.Field,
      macro: SymbolKind.Constant,
      cbuffer: SymbolKind.Namespace,
      variable: SymbolKind.Variable,
      property: SymbolKind.Property,
    };
    return parsed.symbols.map((sym) => ({
      name: sym.name,
      kind: kindMap[sym.kind] ?? SymbolKind.Variable,
      location: {
        uri: sym.uri,
        range: {
          start: { line: sym.line, character: sym.column },
          end: { line: sym.line, character: sym.column + sym.name.length },
        },
      },
    }));
  });

  connection.onRequest('unityBrain/getShaderPropertyIndex', async (): Promise<ShaderSymbolIndex> => {
    if (!graph || !context) {
      return { schemaVersion: 1, shaderNames: [], properties: [], symbolsByFile: {} };
    }
    const assetsShaders = walkShaderFiles(path.join(context.projectRoot, 'Assets'));
    const openPaths = documents.all().map((d) => graph!.normalizeFilePath(d.uri));
    const allPaths = Array.from(new Set([...assetsShaders, ...openPaths]));
    return graph.buildShaderSymbolIndex(allPaths);
  });

  connection.onNotification('unityBrain/setShaderKeywords', (params: { keywords?: string[] }) => {
    hoverProvider?.setActiveKeywords(params?.keywords ?? []);
  });

  connection.onNotification('unityBrain/updateContext', (params: { unityContext?: UnityProjectContext }) => {
    if (params?.unityContext) {
      ensureContext(params.unityContext);
      for (const doc of documents.all()) {
        validateDocument(doc);
      }
    }
  });

  documents.listen(connection);
  connection.listen();

  return {
    getGraph: () => graph,
    getHoverProvider: () => hoverProvider,
    dispose: () => connection.dispose(),
  };
}

const isMainEntry =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainEntry) {
  const conn = createConnection(ProposedFeatures.all);
  createShaderLanguageServer(conn);
}
