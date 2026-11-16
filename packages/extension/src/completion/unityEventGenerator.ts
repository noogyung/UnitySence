import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vscode from 'vscode';
import type {
  UnityApiDatabase,
  UnityApiTypeEntry,
  UnityEventFunction,
} from '../contracts/index.ts';

export interface ClassContextInfo {
  className: string;
  baseTypes: string[];
  classOpenBraceOffset: number;
  classCloseBraceOffset: number;
  isAtMemberDeclarationLevel: boolean;
  existingMethods: Set<string>;
}

export function loadUnityApiDatabase(extensionPath?: string): UnityApiDatabase {
  const candidates: string[] = [];
  if (extensionPath) {
    candidates.push(path.join(extensionPath, 'resources', 'unity-api.json'));
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  candidates.push(path.resolve(here, '../../resources/unity-api.json'));
  candidates.push(path.resolve(here, '../../../resources/unity-api.json'));

  for (const cand of candidates) {
    if (fs.existsSync(cand)) {
      return JSON.parse(fs.readFileSync(cand, 'utf8')) as UnityApiDatabase;
    }
  }
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), types: [] };
}

function parseUnityVersionTuple(ver: string | undefined): [number, number] | null {
  if (!ver) return null;
  const m = /(\d+)\.(\d+)/.exec(ver);
  if (!m) return null;
  return [Number.parseInt(m[1], 10), Number.parseInt(m[2], 10)];
}

export function isVersionCompatible(
  editorVersion: string | undefined,
  minVer?: string,
  maxVer?: string,
): boolean {
  const current = parseUnityVersionTuple(editorVersion);
  if (!current) return true;
  const min = parseUnityVersionTuple(minVer);
  if (min && (current[0] < min[0] || (current[0] === min[0] && current[1] < min[1]))) {
    return false;
  }
  const max = parseUnityVersionTuple(maxVer);
  if (max && (current[0] > max[0] || (current[0] === max[0] && current[1] > max[1]))) {
    return false;
  }
  return true;
}

export function shortenCSharpType(fullType: string): string {
  const map: Record<string, string> = {
    'System.Void': 'void',
    'System.Boolean': 'bool',
    'System.Int32': 'int',
    'System.Single': 'float',
    'System.String': 'string',
    'System.Collections.IEnumerator': 'IEnumerator',
  };
  if (map[fullType]) return map[fullType];
  const lastDot = fullType.lastIndexOf('.');
  return lastDot >= 0 ? fullType.slice(lastDot + 1) : fullType;
}

export function findEnclosingClassContext(sourceText: string, cursorOffset: number): ClassContextInfo | null {
  const classRegex = /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*:\s*([^{]+))?\s*\{/g;
  let match: RegExpExecArray | null;
  let best: ClassContextInfo | null = null;

  while ((match = classRegex.exec(sourceText)) !== null) {
    const className = match[1];
    const baseListRaw = match[2] ?? '';
    const openBraceOffset = match.index + match[0].length - 1;
    let depth = 0;
    let closeBraceOffset = sourceText.length - 1;
    for (let i = openBraceOffset; i < sourceText.length; i++) {
      if (sourceText[i] === '{') depth++;
      else if (sourceText[i] === '}') {
        depth--;
        if (depth === 0) {
          closeBraceOffset = i;
          break;
        }
      }
    }

    if (cursorOffset >= openBraceOffset && cursorOffset <= closeBraceOffset) {
      let localDepth = 0;
      for (let i = openBraceOffset; i < cursorOffset; i++) {
        if (sourceText[i] === '{') localDepth++;
        else if (sourceText[i] === '}') localDepth--;
      }

      const classBody = sourceText.slice(openBraceOffset + 1, closeBraceOffset);
      const existingMethods = extractMethodNamesAtTopLevel(classBody);
      const baseTypes = baseListRaw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.startsWith('where '));

      best = {
        className,
        baseTypes,
        classOpenBraceOffset: openBraceOffset,
        classCloseBraceOffset: closeBraceOffset,
        isAtMemberDeclarationLevel: localDepth === 1,
        existingMethods,
      };
    }
  }

  return best;
}

function extractMethodNamesAtTopLevel(classBody: string): Set<string> {
  const names = new Set<string>();
  const lines = classBody.split(/\r?\n/);
  let depth = 0;
  for (const line of lines) {
    if (depth === 0) {
      const m =
        /^\s*(?:(?:public|private|protected|internal|static|virtual|override|async|new)\s+)*(?:[A-Za-z_][A-Za-z0-9_<>.?[\]]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(
          line,
        );
      if (m) {
        names.add(m[1]);
      }
    }
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
  }
  return names;
}

export function resolveUnityApiType(
  baseTypes: string[],
  db: UnityApiDatabase,
  inheritanceMap: ReadonlyMap<string, string[]> = new Map(),
): UnityApiTypeEntry | null {
  const typeByShortOrFull = new Map<string, UnityApiTypeEntry>();
  for (const t of db.types) {
    typeByShortOrFull.set(t.fullName, t);
    const shortName = shortenCSharpType(t.fullName);
    typeByShortOrFull.set(shortName, t);
  }

  const queue = [...baseTypes];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const candidate = queue.shift()!;
    const clean = candidate.replace(/<.*>$/, '').trim();
    if (!clean || visited.has(clean)) continue;
    visited.add(clean);

    const direct = typeByShortOrFull.get(clean);
    if (direct) return direct;

    const parents = inheritanceMap.get(clean) ?? inheritanceMap.get(shortenCSharpType(clean));
    if (parents) {
      for (const p of parents) queue.push(p);
    }
  }
  return null;
}

export function formatUnityEventMethod(
  ev: UnityEventFunction,
  options: { asCoroutine?: boolean; snippet?: boolean; indent?: string } = {},
): string {
  const indent = options.indent ?? '    ';
  const bodyIndent = `${indent}    `;
  const modifier = ev.isStatic ? 'private static' : 'private';
  const returnType = options.asCoroutine ? 'IEnumerator' : shortenCSharpType(ev.returnType);
  const paramsStr = ev.parameters
    .map((p) => `${shortenCSharpType(p.type)} ${p.name}`)
    .join(', ');

  if (options.snippet) {
    const inner = options.asCoroutine ? `${bodyIndent}$0\n${bodyIndent}yield break;` : `${bodyIndent}$0`;
    return `${modifier} ${returnType} ${ev.name}(${paramsStr})\n{\n${inner}\n}`;
  }

  const inner = options.asCoroutine
    ? `${bodyIndent}// TODO: yield\n${bodyIndent}yield break;`
    : `${bodyIndent}`;
  return `${indent}${modifier} ${returnType} ${ev.name}(${paramsStr})\n${indent}{\n${inner}\n${indent}}`;
}

export interface EventGeneratorOptions {
  apiDatabase?: UnityApiDatabase;
  getEditorVersion?: () => string | undefined;
  getInheritanceMap?: () => ReadonlyMap<string, string[]>;
}

export class UnityEventCompletionProvider implements vscode.CompletionItemProvider {
  private readonly db: UnityApiDatabase;
  private readonly options: EventGeneratorOptions;

  constructor(options: EventGeneratorOptions = {}) {
    this.options = options;
    this.db = options.apiDatabase ?? loadUnityApiDatabase();
  }

  public getMissingEventsForDocument(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): { classCtx: ClassContextInfo; apiType: UnityApiTypeEntry; events: UnityEventFunction[] } | null {
    const offset = document.offsetAt(position);
    const classCtx = findEnclosingClassContext(document.getText(), offset);
    if (!classCtx) return null;

    const inheritanceMap = this.options.getInheritanceMap?.() ?? new Map<string, string[]>();
    const apiType = resolveUnityApiType(classCtx.baseTypes, this.db, inheritanceMap);
    if (!apiType) return null;

    const editorVersion = this.options.getEditorVersion?.();
    const events = apiType.events.filter(
      (ev) =>
        !classCtx.existingMethods.has(ev.name) &&
        isVersionCompatible(editorVersion, ev.minimumUnityVersion, ev.maximumUnityVersion),
    );
    return { classCtx, apiType, events };
  }

  public provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] | undefined {
    const enabled = vscode.workspace
      .getConfiguration('unityBrain')
      .get<boolean>('completion.showEventSnippets', true);
    if (!enabled) return undefined;

    const lineText = document.lineAt(position.line).text.slice(0, position.character).trimStart();
    if (lineText.startsWith('//') || lineText.startsWith('/*')) return undefined;

    const missing = this.getMissingEventsForDocument(document, position);
    if (!missing || !missing.classCtx.isAtMemberDeclarationLevel) {
      return undefined;
    }

    const items: vscode.CompletionItem[] = [];
    for (const ev of missing.events) {
      const baseItem = new vscode.CompletionItem(ev.name, vscode.CompletionItemKind.Method);
      baseItem.detail = `[UnityBrain] 유니티 이벤트 함수 (${missing.apiType.fullName})`;
      baseItem.documentation = new vscode.MarkdownString(`[UnityBrain] ${ev.description}`);
      baseItem.insertText = new vscode.SnippetString(
        formatUnityEventMethod(ev, { asCoroutine: false, snippet: true }),
      );
      baseItem.sortText = `1_unity_${ev.name}`;
      items.push(baseItem);

      if (ev.supportsCoroutine) {
        const coroItem = new vscode.CompletionItem(
          `${ev.name} (Coroutine)`,
          vscode.CompletionItemKind.Snippet,
        );
        coroItem.filterText = ev.name;
        coroItem.detail = `[UnityBrain] 유니티 코루틴 이벤트 (${missing.apiType.fullName})`;
        coroItem.documentation = new vscode.MarkdownString(
          `[UnityBrain] ${ev.description}\n\n코루틴 실행을 위해 \`IEnumerator\`를 반환합니다.`,
        );
        coroItem.insertText = new vscode.SnippetString(
          formatUnityEventMethod(ev, { asCoroutine: true, snippet: true }),
        );
        coroItem.sortText = `2_unity_${ev.name}_coro`;
        items.push(coroItem);
      }
    }

    return items;
  }
}

export function registerGenerateEventFunctionsCommand(
  provider: UnityEventCompletionProvider,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    'unityBrain.generateEventFunctions',
    async (preselectedLabels?: string[]) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'csharp') {
        await vscode.window.showInformationMessage(
          '[UnityBrain] C# 스크립트 파일 안에서만 유니티 이벤트 함수를 생성할 수 있습니다.',
        );
        return 0;
      }
      const doc = editor.document;
      const pos = editor.selection.active;
      const missing = provider.getMissingEventsForDocument(doc, pos);
      if (!missing || missing.events.length === 0) {
        await vscode.window.showInformationMessage(
          '[UnityBrain] 현재 위치에서 생성 가능한 유니티 이벤트 함수가 없습니다. MonoBehaviour 등 유니티 클래스 내부에 커서를 두세요.',
        );
        return 0;
      }

      const choices: Array<vscode.QuickPickItem & { event: UnityEventFunction; asCoroutine: boolean }> = [];
      for (const ev of missing.events) {
        const params = ev.parameters.map((p) => `${shortenCSharpType(p.type)} ${p.name}`).join(', ');
        choices.push({
          label: ev.name,
          description: `void ${ev.name}(${params})`,
          detail: `[UnityBrain] ${ev.description}`,
          event: ev,
          asCoroutine: false,
        });
        if (ev.supportsCoroutine) {
          choices.push({
            label: `${ev.name} (Coroutine)`,
            description: `IEnumerator ${ev.name}(${params})`,
            detail: `[UnityBrain] ${ev.description} (코루틴)`,
            event: ev,
            asCoroutine: true,
          });
        }
      }

      let selected = preselectedLabels
        ? choices.filter((c) => preselectedLabels.includes(c.label))
        : ((await vscode.window.showQuickPick(choices, {
            canPickMany: true,
            placeHolder: `[UnityBrain] ${missing.classCtx.className} 클래스에 생성할 유니티 이벤트 함수를 선택하세요 (복수 선택 가능)`,
          })) as typeof choices | undefined);

      if (!selected) return 0;
      if (!Array.isArray(selected)) selected = [selected];
      if (selected.length === 0) return 0;

      const generatedText =
        '\n' +
        selected
          .map((s) => formatUnityEventMethod(s.event, { asCoroutine: s.asCoroutine, snippet: false }))
          .join('\n\n') +
        '\n';

      const insertPos = doc.positionAt(missing.classCtx.classCloseBraceOffset);
      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, insertPos, generatedText);
      await vscode.workspace.applyEdit(edit);
      return selected.length;
    },
  );
}
