import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';

export interface AsmdefRecord {
  name: string;
  guid: string | null;
  filePath: string;
  isAsmref: boolean;
  references: string[];
  rawReference?: string;
}

const UNITY_ASMDEF_PLATFORMS = [
  'Editor',
  'WindowsStandalone32',
  'WindowsStandalone64',
  'OSXUniversal',
  'LinuxStandalone64',
  'Android',
  'iOS',
  'WebGL',
  'PS4',
  'PS5',
  'XboxOne',
  'GameCoreXboxOne',
  'GameCoreScarlett',
  'Switch',
  'tvOS',
  'VisionOS',
];

function walkAsmdefFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  const stack = [path.resolve(dir)];
  const visitedRealDirs = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isSymbolicLink()) {
        try {
          const st = fs.statSync(full);
          if (st.isDirectory()) {
            const real = fs.realpathSync(full);
            if (!visitedRealDirs.has(real)) {
              visitedRealDirs.add(real);
              stack.push(full);
            }
          } else if (st.isFile() && /\.(?:asmdef|asmref)$/i.test(entry.name)) {
            out.push(full);
          }
        } catch {
          // Ignore broken symlinks
        }
      } else if (entry.isFile() && /\.(?:asmdef|asmref)$/i.test(entry.name)) {
        out.push(full);
      }
    }
  }
  return out;
}

function readMetaGuid(assetPath: string): string | null {
  const metaPath = `${assetPath}.meta`;
  if (!fs.existsSync(metaPath)) return null;
  try {
    const content = fs.readFileSync(metaPath, 'utf8');
    const match = /^\s*guid:\s*([0-9a-fA-F]{32})\b/m.exec(content);
    return match ? match[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

export class UnityAsmdefProvider {
  private readonly projectRoot: string;
  private byName = new Map<string, AsmdefRecord>();
  private byGuid = new Map<string, AsmdefRecord>();
  private byPath = new Map<string, AsmdefRecord>();
  private dirty = true;

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot);
  }

  public invalidate(): void {
    this.dirty = true;
  }

  private ensureIndex(): void {
    if (!this.dirty) return;
    this.byName.clear();
    this.byGuid.clear();
    this.byPath.clear();

    // Scan workspace Assets/ and embedded Packages/ before Library/PackageCache
    // so workspace/embedded definitions always override cached package versions.
    const files = [
      ...walkAsmdefFiles(path.join(this.projectRoot, 'Assets')),
      ...walkAsmdefFiles(path.join(this.projectRoot, 'Packages')),
      ...walkAsmdefFiles(path.join(this.projectRoot, 'Library', 'PackageCache')),
    ];

    for (const filePath of files) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw) as {
          name?: string;
          references?: string[];
          reference?: string;
        };
        const isAsmref = filePath.toLowerCase().endsWith('.asmref');
        const guid = readMetaGuid(filePath);
        const name = parsed.name ?? path.basename(filePath, path.extname(filePath));
        const references = Array.isArray(parsed.references)
          ? parsed.references.filter((r): r is string => typeof r === 'string')
          : typeof parsed.reference === 'string'
            ? [parsed.reference]
            : [];
        const rec: AsmdefRecord = {
          name,
          guid,
          filePath,
          isAsmref,
          references,
          rawReference: parsed.reference,
        };
        const normPath = path.resolve(filePath).toLowerCase();
        if (!this.byPath.has(normPath)) {
          this.byPath.set(normPath, rec);
        }
        if (!isAsmref && parsed.name) {
          if (this.byName.has(parsed.name)) {
            continue;
          }
          this.byName.set(parsed.name, rec);
        }
        if (guid && !this.byGuid.has(guid)) {
          this.byGuid.set(guid, rec);
        }
      } catch {
        // Ignore malformed asmdef JSON
      }
    }
    this.dirty = false;
  }

  public resolveReference(refValue: string): AsmdefRecord | undefined {
    this.ensureIndex();
    const guidMatch = /^GUID:([0-9a-fA-F]{32})$/i.exec(refValue.trim());
    if (guidMatch) {
      return this.byGuid.get(guidMatch[1].toLowerCase());
    }
    return this.byName.get(refValue.trim());
  }

  public provideInlayHints(doc: vscode.TextDocument): vscode.InlayHint[] {
    if (!/\.(?:asmdef|asmref)$/i.test(doc.fileName)) return [];
    this.ensureIndex();
    const hints: vscode.InlayHint[] = [];
    const text = doc.getText();
    const guidRe = /"GUID:([0-9a-fA-F]{32})"/gi;
    let m: RegExpExecArray | null;
    while ((m = guidRe.exec(text)) !== null) {
      const target = this.byGuid.get(m[1].toLowerCase());
      if (!target) continue;
      const posAfterQuote = doc.positionAt(m.index + m[0].length);
      hints.push(
        new vscode.InlayHint(
          posAfterQuote,
          ` → ${target.name}`,
          vscode.InlayHintKind.Type,
        ),
      );
    }
    return hints;
  }

  public provideDefinition(
    doc: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Location | undefined {
    if (!/\.(?:asmdef|asmref)$/i.test(doc.fileName)) return undefined;
    const lineText = doc.lineAt(position.line).text;
    const quoteRe = /"([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = quoteRe.exec(lineText)) !== null) {
      const start = m.index;
      const end = m.index + m[0].length;
      if (position.character >= start && position.character <= end) {
        const resolved = this.resolveReference(m[1]);
        if (resolved && fs.existsSync(resolved.filePath)) {
          return new vscode.Location(vscode.Uri.file(resolved.filePath), new vscode.Position(0, 0));
        }
      }
    }
    return undefined;
  }

  public provideCompletionItems(
    doc: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] | undefined {
    if (!/\.(?:asmdef|asmref)$/i.test(doc.fileName)) return undefined;
    this.ensureIndex();

    const textBefore = doc.getText(new vscode.Range(new vscode.Position(0, 0), position));
    const lastKeyMatch = /"([A-Za-z_]+)"\s*:\s*(?:\[[^\]]*)?(?:"[^"]*)?$/.exec(textBefore);
    if (!lastKeyMatch) return undefined;
    const key = lastKeyMatch[1];

    // Inspect quote state on current line to emit valid JSON string literals
    const lineText = doc.lineAt(position.line).text;
    const lineBefore = lineText.slice(0, position.character);
    const lineAfter = lineText.slice(position.character);
    let inString = false;
    let openQuoteCol = -1;
    for (let i = 0; i < lineBefore.length; i++) {
      if (lineBefore[i] === '\\') {
        i++;
        continue;
      }
      if (lineBefore[i] === '"') {
        inString = !inString;
        openQuoteCol = inString ? i : -1;
      }
    }

    let replaceRange: vscode.Range | undefined;
    let hasClosingQuote = true;
    let unquotedPrefix = '';
    if (inString && openQuoteCol >= 0) {
      let closingOffset = -1;
      for (let k = 0; k < lineAfter.length; k++) {
        if (lineAfter[k] === '\\') {
          k++;
          continue;
        }
        if (lineAfter[k] === '"') {
          closingOffset = k;
          break;
        }
      }
      hasClosingQuote = closingOffset >= 0;
      const endCol = hasClosingQuote ? position.character + closingOffset : position.character;
      replaceRange = new vscode.Range(
        new vscode.Position(position.line, openQuoteCol + 1),
        new vscode.Position(position.line, endCol),
      );
    } else {
      const mPrefix = /([A-Za-z0-9_.:-]+)$/.exec(lineBefore);
      if (mPrefix) {
        unquotedPrefix = mPrefix[1];
        replaceRange = new vscode.Range(
          new vscode.Position(position.line, position.character - unquotedPrefix.length),
          position,
        );
      }
    }

    const formatJsonItem = (item: vscode.CompletionItem) => {
      const label = String(item.label);
      if (!inString) {
        item.insertText = `"${label}"`;
        item.filterText = unquotedPrefix ? `${unquotedPrefix} "${label}" ${label}` : `"${label}" ${label}`;
      } else if (!hasClosingQuote) {
        item.insertText = `${label}"`;
        item.filterText = label;
      }
      if (replaceRange) {
        item.range = replaceRange;
      }
      return item;
    };

    if (key === 'references' || key === 'reference') {
      const items: vscode.CompletionItem[] = [];
      for (const rec of this.byName.values()) {
        if (path.resolve(rec.filePath) === path.resolve(doc.fileName)) continue;
        const rel = path.relative(this.projectRoot, rec.filePath).replace(/\\/g, '/');
        const nameItem = new vscode.CompletionItem(rec.name, vscode.CompletionItemKind.Module);
        nameItem.detail = `[UnityBrain] 어셈블리 참조 (${rel})`;
        nameItem.documentation = `[UnityBrain] ${rel} 어셈블리를 이름으로 참조합니다.`;
        items.push(formatJsonItem(nameItem));

        if (rec.guid) {
          const guidLabel = `GUID:${rec.guid}`;
          const guidItem = new vscode.CompletionItem(guidLabel, vscode.CompletionItemKind.Reference);
          guidItem.detail = `[UnityBrain] ${rec.name} (GUID 참조 · ${rel})`;
          guidItem.documentation = `[UnityBrain] ${rec.name} 어셈블리의 .meta GUID 참조입니다.`;
          items.push(formatJsonItem(guidItem));
        }
      }
      return items;
    }

    if (key === 'includePlatforms' || key === 'excludePlatforms') {
      return UNITY_ASMDEF_PLATFORMS.map((p) => {
        const item = new vscode.CompletionItem(p, vscode.CompletionItemKind.EnumMember);
        item.detail = '[UnityBrain] Unity 빌드 타겟 플랫폼';
        return formatJsonItem(item);
      });
    }

    return undefined;
  }

  public validateDocument(doc: vscode.TextDocument): vscode.Diagnostic[] {
    if (!/\.(?:asmdef|asmref)$/i.test(doc.fileName)) return [];
    this.invalidate();
    this.ensureIndex();

    const diags: vscode.Diagnostic[] = [];
    const text = doc.getText();
    let parsed: { name?: string; references?: string[]; reference?: string };
    try {
      parsed = JSON.parse(text) as { name?: string; references?: string[]; reference?: string };
    } catch {
      return [];
    }

    const refs = Array.isArray(parsed.references)
      ? parsed.references
      : typeof parsed.reference === 'string'
        ? [parsed.reference]
        : [];

    const findRefRange = (refStr: string): vscode.Range => {
      const idx = text.indexOf(`"${refStr}"`);
      if (idx < 0) return new vscode.Range(0, 0, 0, 1);
      return new vscode.Range(doc.positionAt(idx + 1), doc.positionAt(idx + 1 + refStr.length));
    };

    for (const refStr of refs) {
      if (typeof refStr !== 'string') continue;
      if (/^GUID:/i.test(refStr) && !this.resolveReference(refStr)) {
        diags.push(
          new vscode.Diagnostic(
            findRefRange(refStr),
            `[UnityBrain] 어셈블리 GUID 참조 '${refStr}'에 해당하는 .asmdef를 찾을 수 없습니다.`,
            vscode.DiagnosticSeverity.Warning,
          ),
        );
      }
    }

    // Check cycle starting from this assembly (override its in-memory references with current doc)
    const selfName = parsed.name ?? path.basename(doc.fileName, path.extname(doc.fileName));
    if (!doc.fileName.toLowerCase().endsWith('.asmref') && parsed.name) {
      const currentCycle = this.detectCycle(selfName, refs);
      if (currentCycle) {
        const offendingRef = refs[0] ?? '';
        diags.push(
          new vscode.Diagnostic(
            findRefRange(offendingRef),
            `[UnityBrain] 순환 어셈블리 참조가 감지되었습니다: ${currentCycle.join(' -> ')}`,
            vscode.DiagnosticSeverity.Error,
          ),
        );
      }
    }

    return diags;
  }

  private detectCycle(startName: string, overrideStartRefs: string[]): string[] | null {
    const stack: string[] = [startName];
    const visiting = new Set<string>([startName]);

    const getRefsFor = (name: string): string[] => {
      if (name === startName) return overrideStartRefs;
      return this.byName.get(name)?.references ?? [];
    };

    const dfs = (current: string): string[] | null => {
      for (const ref of getRefsFor(current)) {
        const target = this.resolveReference(ref);
        if (!target) continue;
        if (target.name === startName) {
          return [...stack, target.name];
        }
        if (visiting.has(target.name)) continue;
        visiting.add(target.name);
        stack.push(target.name);
        const found = dfs(target.name);
        if (found) return found;
        stack.pop();
        visiting.delete(target.name);
      }
      return null;
    };

    return dfs(startName);
  }
}
