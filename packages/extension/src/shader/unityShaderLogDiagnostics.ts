import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { normalizePathKey } from '../../../shader-lsp/src/vfs/virtualPathResolver.ts';
import { resolveUnityEditorLogPath } from '../editor/unityEditorIntegration.ts';

export interface UnityShaderLogDiagnostic {
  severity: 'error' | 'warning';
  shaderName: string;
  filePath: string | null;
  line: number;
  message: string;
  apis: string[];
}

export interface UnityShaderLogIndex {
  byFilePath: Map<string, UnityShaderLogDiagnostic[]>;
  byShaderName: Map<string, UnityShaderLogDiagnostic[]>;
  byFileName: Map<string, UnityShaderLogDiagnostic[]>;
}

const MAX_LOG_TAIL_BYTES = 4 * 1024 * 1024; // 4 MB
const SHADER_IMPORT_RE =
  /(?:Start importing|Done importing asset:\s*'?)\s*([^'\r\n]+?\.(?:shader|urtshader|compute|hlsl|hlsli|cginc))/i;
const COMPILING_SHADER_RE = /Compiling shader\s+"([^"]+)"/;
const SHADER_LOG_LINE_RE = /(?:^|[\s|\]])Shader\s+(error|warning)\s+in\s+'([^']+)':\s*(.+)$/i;
const AT_FILE_LINE_RE = /\bat\s+([^(\r\n]+?)\((\d+)\)/;
const AT_LINE_ONLY_RE = /\bat\s+line\s+(\d+)\b/i;
const ON_API_SUFFIX_RE = /\s*\(on\s+([^)]+)\)\s*$/i;
const SHADER_FILE_EXT_RE = /\.(?:shader|urtshader|compute|hlsl|hlsli|cginc)$/i;

function resolveLoggedFilePath(rawPath: string, projectRoot: string): string {
  const cleaned = rawPath.trim().replace(/^["']|["']$/g, '');
  if (path.isAbsolute(cleaned)) {
    return path.resolve(cleaned);
  }
  return path.resolve(projectRoot, cleaned);
}

/**
 * Parse Unity Editor.log content into an indexed map of active shader compiler errors/warnings.
 * Automatically clears earlier diagnostics for a file or shader when a newer import/compile begins.
 */
export function parseUnityShaderLog(logContent: string, projectRoot: string): UnityShaderLogIndex {
  const entries = new Map<string, UnityShaderLogDiagnostic>();

  const deleteByFile = (normFileKey: string, baseLower: string) => {
    for (const [key, item] of entries.entries()) {
      if (item.filePath && normalizePathKey(item.filePath) === normFileKey) {
        entries.delete(key);
        continue;
      }
      if (!item.filePath && item.shaderName.toLowerCase() === baseLower) {
        entries.delete(key);
      }
    }
  };

  const deleteByShaderName = (shaderName: string) => {
    for (const [key, item] of entries.entries()) {
      if (item.shaderName === shaderName) {
        entries.delete(key);
      }
    }
  };

  const lines = logContent.split(/\r?\n/);
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    const importMatch = SHADER_IMPORT_RE.exec(trimmed);
    if (importMatch) {
      const resolved = resolveLoggedFilePath(importMatch[1], projectRoot);
      deleteByFile(normalizePathKey(resolved), path.basename(resolved).toLowerCase());
      if (/\.(?:shader|urtshader)$/i.test(resolved) && fs.existsSync(resolved)) {
        try {
          const shaderSrc = fs.readFileSync(resolved, 'utf8');
          const declMatch = /^\s*Shader\s+"([^"]+)"/m.exec(shaderSrc);
          if (declMatch) {
            deleteByShaderName(declMatch[1].trim());
          }
        } catch {
          // Ignore unreadable shader file
        }
      }
      continue;
    }

    const compileMatch = COMPILING_SHADER_RE.exec(trimmed);
    if (compileMatch) {
      deleteByShaderName(compileMatch[1]);
      continue;
    }

    const diagMatch = SHADER_LOG_LINE_RE.exec(trimmed);
    if (!diagMatch) continue;

    const severity = diagMatch[1].toLowerCase() === 'error' ? 'error' : 'warning';
    const shaderName = diagMatch[2].trim();
    let rest = diagMatch[3].trim();

    const apis: string[] = [];
    const apiMatch = ON_API_SUFFIX_RE.exec(rest);
    if (apiMatch) {
      for (const api of apiMatch[1].split(',')) {
        const cleanApi = api.trim();
        if (cleanApi && !apis.includes(cleanApi)) {
          apis.push(cleanApi);
        }
      }
      rest = rest.slice(0, apiMatch.index).trim();
    }

    let filePath: string | null = null;
    let line = 0;
    const atFileMatch = AT_FILE_LINE_RE.exec(rest);
    if (atFileMatch) {
      filePath = resolveLoggedFilePath(atFileMatch[1], projectRoot);
      const parsedLine = Number.parseInt(atFileMatch[2], 10);
      line = Number.isFinite(parsedLine) && parsedLine > 0 ? parsedLine - 1 : 0;
    } else {
      const atLineMatch = AT_LINE_ONLY_RE.exec(rest);
      if (atLineMatch) {
        const parsedLine = Number.parseInt(atLineMatch[1], 10);
        line = Number.isFinite(parsedLine) && parsedLine > 0 ? parsedLine - 1 : 0;
      }
    }

    const fileKey = filePath ? normalizePathKey(filePath) : '';
    const dedupeKey = `${severity}|${shaderName}|${fileKey}|${line}|${rest}`;
    const existing = entries.get(dedupeKey);
    if (existing) {
      for (const api of apis) {
        if (!existing.apis.includes(api)) {
          existing.apis.push(api);
        }
      }
    } else {
      entries.set(dedupeKey, {
        severity,
        shaderName,
        filePath,
        line,
        message: rest,
        apis,
      });
    }
  }

  const byFilePath = new Map<string, UnityShaderLogDiagnostic[]>();
  const byShaderName = new Map<string, UnityShaderLogDiagnostic[]>();
  const byFileName = new Map<string, UnityShaderLogDiagnostic[]>();

  const pushTo = (map: Map<string, UnityShaderLogDiagnostic[]>, key: string, item: UnityShaderLogDiagnostic) => {
    const arr = map.get(key);
    if (arr) {
      arr.push(item);
    } else {
      map.set(key, [item]);
    }
  };

  for (const item of entries.values()) {
    if (item.filePath) {
      pushTo(byFilePath, normalizePathKey(item.filePath), item);
    }
    pushTo(byShaderName, item.shaderName, item);
    if (SHADER_FILE_EXT_RE.test(item.shaderName)) {
      pushTo(byFileName, path.basename(item.shaderName).toLowerCase(), item);
    }
  }

  return { byFilePath, byShaderName, byFileName };
}

function readLogTailUtf8(logPath: string, size: number): string {
  if (size <= MAX_LOG_TAIL_BYTES) {
    return fs.readFileSync(logPath, 'utf8');
  }

  const fd = fs.openSync(logPath, 'r');
  try {
    const startOffset = size - MAX_LOG_TAIL_BYTES;
    const buffer = Buffer.allocUnsafe(MAX_LOG_TAIL_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, MAX_LOG_TAIL_BYTES, startOffset);
    const chunk = buffer.subarray(0, bytesRead).toString('utf8');
    const firstNewline = chunk.indexOf('\n');
    return firstNewline >= 0 ? chunk.slice(firstNewline + 1) : chunk;
  } finally {
    fs.closeSync(fd);
  }
}

export interface UnityShaderLogProviderOptions {
  projectRoot: string;
  logPathOverride?: string;
  onDidUpdate?: () => void;
  enableWatch?: boolean;
}

/**
 * Watches Unity Editor.log (with mtime/size caching) and exposes live Unity shader compiler
 * errors and warnings as VS Code diagnostics for open shader documents.
 */
export class UnityShaderLogDiagnosticsProvider implements vscode.Disposable {
  private readonly projectRoot: string;
  private readonly logPathOverride?: string;
  private readonly onDidUpdate?: () => void;
  private watchedPath: string | null = null;
  private watchListener: ((curr: fs.Stats, prev: fs.Stats) => void) | null = null;
  private cachedLogPath = '';
  private cachedMtimeMs = -1;
  private cachedSize = -1;
  private cachedIndex: UnityShaderLogIndex = {
    byFilePath: new Map(),
    byShaderName: new Map(),
    byFileName: new Map(),
  };

  constructor(options: UnityShaderLogProviderOptions) {
    this.projectRoot = options.projectRoot;
    this.logPathOverride = options.logPathOverride;
    this.onDidUpdate = options.onDidUpdate;
    if (options.enableWatch) {
      this.startWatch();
    }
  }

  private getLogPath(): string {
    return this.logPathOverride ?? resolveUnityEditorLogPath(this.projectRoot);
  }

  private startWatch(): void {
    const targetPath = this.getLogPath();
    this.watchedPath = targetPath;
    this.watchListener = (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) {
        this.refreshIfNeeded();
        this.onDidUpdate?.();
      }
    };
    try {
      fs.watchFile(targetPath, { interval: 1500, persistent: false }, this.watchListener);
    } catch {
      this.watchListener = null;
    }
  }

  public dispose(): void {
    if (this.watchedPath && this.watchListener) {
      try {
        fs.unwatchFile(this.watchedPath, this.watchListener);
      } catch {
        // Ignore unwatch errors
      }
      this.watchedPath = null;
      this.watchListener = null;
    }
  }

  private refreshIfNeeded(): void {
    const logPath = this.getLogPath();
    if (!logPath || !fs.existsSync(logPath)) {
      this.cachedLogPath = logPath;
      this.cachedMtimeMs = -1;
      this.cachedSize = -1;
      this.cachedIndex = {
        byFilePath: new Map(),
        byShaderName: new Map(),
        byFileName: new Map(),
      };
      return;
    }

    let st: fs.Stats;
    try {
      st = fs.statSync(logPath);
    } catch {
      return;
    }

    if (
      logPath === this.cachedLogPath &&
      st.mtimeMs === this.cachedMtimeMs &&
      st.size === this.cachedSize
    ) {
      return;
    }

    try {
      const content = readLogTailUtf8(logPath, st.size);
      this.cachedIndex = parseUnityShaderLog(content, this.projectRoot);
      this.cachedLogPath = logPath;
      this.cachedMtimeMs = st.mtimeMs;
      this.cachedSize = st.size;
    } catch {
      // Ignore transient read errors while Unity writes to Editor.log
    }
  }

  public getDiagnosticsForDocument(doc: vscode.TextDocument): vscode.Diagnostic[] {
    this.refreshIfNeeded();

    const docPath = doc.uri.fsPath;
    const docKey = normalizePathKey(docPath);
    const docBase = path.basename(docPath).toLowerCase();
    const docText = doc.getText();
    const shaderDeclMatch = /^\s*Shader\s+"([^"]+)"/m.exec(docText);
    const declaredShaderName = shaderDeclMatch ? shaderDeclMatch[1].trim() : null;

    const matched: UnityShaderLogDiagnostic[] = [];
    const seen = new Set<string>();
    const addUnique = (items: UnityShaderLogDiagnostic[] | undefined) => {
      if (!items) return;
      for (const item of items) {
        const key = `${item.severity}|${item.shaderName}|${item.filePath ?? ''}|${item.line}|${item.message}`;
        if (!seen.has(key)) {
          seen.add(key);
          matched.push(item);
        }
      }
    };

    addUnique(this.cachedIndex.byFilePath.get(docKey));

    if (declaredShaderName) {
      const byName = this.cachedIndex.byShaderName.get(declaredShaderName);
      if (byName) {
        addUnique(
          byName.filter(
            (item) => !item.filePath || normalizePathKey(item.filePath) === docKey,
          ),
        );
      }
    }

    const byFileName = this.cachedIndex.byFileName.get(docBase);
    if (byFileName) {
      addUnique(
        byFileName.filter(
          (item) => !item.filePath || normalizePathKey(item.filePath) === docKey,
        ),
      );
    }

    const maxLine = Math.max(0, doc.lineCount - 1);
    return matched.map((item) => {
      const clampedLine = Math.min(Math.max(0, item.line), maxLine);
      const lineText = doc.lineAt(clampedLine).text;
      const startCol = Math.max(0, lineText.search(/\S/));
      const endCol = Math.max(startCol, lineText.trimEnd().length);
      const apiSuffix = item.apis.length > 0 ? ` (${item.apis.join(', ')})` : '';
      const diag = new vscode.Diagnostic(
        new vscode.Range(clampedLine, startCol, clampedLine, endCol),
        `[Unity] ${item.message}${apiSuffix}`,
        item.severity === 'error'
          ? vscode.DiagnosticSeverity.Error
          : vscode.DiagnosticSeverity.Warning,
      );
      diag.source = 'Unity Shader Compiler';
      return diag;
    });
  }
}
