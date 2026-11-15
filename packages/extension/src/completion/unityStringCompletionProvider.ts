import path from 'node:path';
import * as vscode from 'vscode';
import type {
  ProjectSettingsCache,
  ShaderSymbolIndex,
} from '../contracts/index.ts';

export type UnityStringContextKind =
  | 'tag'
  | 'layer'
  | 'sortingLayer'
  | 'input'
  | 'scene'
  | 'shaderProperty'
  | 'animator'
  | 'coroutine'
  | 'invoke';

export interface ParsedCSharpMethod {
  name: string;
  returnType: string;
  className: string;
}

function findUnclosedStringStart(snippet: string): number {
  let i = 0;
  let inLineComment = false;
  let inBlockComment = false;
  let inString = false;
  let stringStart = -1;

  while (i < snippet.length) {
    const ch = snippet[i];
    const next = snippet[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '"') {
        inString = false;
        stringStart = -1;
      }
      i++;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === '"') {
      inString = true;
      stringStart = i;
      i++;
      continue;
    }
    i++;
  }

  return inString ? stringStart : -1;
}

export function detectApiStringContext(textBeforeCursor: string): UnityStringContextKind | null {
  const quoteIdx = findUnclosedStringStart(textBeforeCursor);
  if (quoteIdx === -1) return null;

  const beforeQuote = textBeforeCursor.slice(0, quoteIdx);
  const windowLines = beforeQuote.split(/\r?\n/).slice(-4).join(' ');

  if (/(?:CompareTag|FindWithTag|FindGameObjects?WithTag)\s*\(\s*$/.test(windowLines)) {
    return 'tag';
  }
  if (/\.tag\s*(?:==|!=|=)\s*$/.test(windowLines)) {
    return 'tag';
  }

  if (/LayerMask\.NameToLayer\s*\(\s*$/.test(windowLines)) {
    return 'layer';
  }
  if (/LayerMask\.GetMask\s*\([^;()]*$/.test(windowLines)) {
    return 'layer';
  }

  if (/SortingLayer\.NameToID\s*\(\s*$/.test(windowLines)) {
    return 'sortingLayer';
  }

  if (/Input\.(?:GetAxis|GetAxisRaw|GetButton|GetButtonDown|GetButtonUp)\s*\(\s*$/.test(windowLines)) {
    return 'input';
  }

  if (/SceneManager\.(?:LoadScene|LoadSceneAsync|GetSceneByName)\s*\(\s*$/.test(windowLines)) {
    return 'scene';
  }

  if (
    /Shader\.PropertyToID\s*\(\s*$/.test(windowLines) ||
    /(?:mat|material|Material|mpb|block|PropertyBlock)[A-Za-z0-9_]*\.(?:SetFloat|SetInt|SetInteger|SetColor|SetVector|SetTexture|SetMatrix|SetBuffer|GetFloat|GetInt|GetInteger|GetColor|GetVector|GetTexture|GetMatrix|HasProperty)\s*\(\s*$/.test(
      windowLines,
    ) ||
    /\.(?:HasProperty|SetColor|SetTexture|GetColor|GetTexture|SetVector|GetVector)\s*\(\s*$/.test(
      windowLines,
    )
  ) {
    return 'shaderProperty';
  }

  if (
    /Animator\.StringToHash\s*\(\s*$/.test(windowLines) ||
    /(?:anim|animator|Animator)[A-Za-z0-9_]*\.(?:SetFloat|SetInteger|SetBool|SetTrigger|ResetTrigger|GetFloat|GetInteger|GetBool|Play|CrossFade|IsName)\s*\(\s*$/.test(
      windowLines,
    ) ||
    /\.(?:SetTrigger|ResetTrigger|SetBool|GetBool|CrossFade)\s*\(\s*$/.test(windowLines)
  ) {
    return 'animator';
  }

  // Fallback for `.SetFloat("` when receiver is unrecognized: still differentiate animator vs material
  if (/\.(?:SetFloat|GetFloat|SetInt|GetInt|SetInteger|GetInteger)\s*\(\s*$/.test(windowLines)) {
    return 'shaderProperty';
  }

  if (/(?:StartCoroutine|StopCoroutine)\s*\(\s*$/.test(windowLines)) {
    return 'coroutine';
  }

  if (/(?:Invoke|InvokeRepeating|CancelInvoke|IsInvoking)\s*\(\s*$/.test(windowLines)) {
    return 'invoke';
  }

  return null;
}

export function extractCSharpClassMethods(sourceText: string): ParsedCSharpMethod[] {
  const classMatch = /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(sourceText);
  const className = classMatch ? classMatch[1] : 'Script';
  const methodRegex =
    /^[ \t]*(?:(?:public|private|protected|internal|static|virtual|override|async|sealed|new)\s+)*([A-Za-z_][A-Za-z0-9_<>.?[\]]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/gm;

  const methods: ParsedCSharpMethod[] = [];
  const skipNames = new Set(['if', 'for', 'while', 'switch', 'catch', 'using', 'lock', 'class']);
  let m: RegExpExecArray | null;
  while ((m = methodRegex.exec(sourceText)) !== null) {
    const returnType = m[1];
    const name = m[2];
    if (skipNames.has(returnType) || skipNames.has(name) || returnType === 'class') continue;
    methods.push({ name, returnType, className });
  }
  return methods;
}

export class UnityStringCompletionProvider implements vscode.CompletionItemProvider {
  private readonly getCache: () => ProjectSettingsCache;
  private readonly getShaderIndex: () => Promise<ShaderSymbolIndex | null> | ShaderSymbolIndex | null;

  constructor(
    getCache: () => ProjectSettingsCache,
    getShaderIndex: () => Promise<ShaderSymbolIndex | null> | ShaderSymbolIndex | null,
  ) {
    this.getCache = getCache;
    this.getShaderIndex = getShaderIndex;
  }

  public async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[] | undefined> {
    const startLine = Math.max(0, position.line - 3);
    const textBeforeCursor = document.getText(
      new vscode.Range(new vscode.Position(startLine, 0), position),
    );

    const contextKind = detectApiStringContext(textBeforeCursor);
    if (!contextKind) {
      return undefined;
    }

    const cache = this.getCache();
    const items: vscode.CompletionItem[] = [];

    switch (contextKind) {
      case 'tag': {
        for (const tag of cache.tags) {
          const item = new vscode.CompletionItem(tag, vscode.CompletionItemKind.EnumMember);
          item.detail = 'Unity Tag';
          items.push(item);
        }
        return items;
      }
      case 'layer': {
        for (const layer of cache.layers) {
          const item = new vscode.CompletionItem(layer.name, vscode.CompletionItemKind.EnumMember);
          item.detail = `Layer ${layer.index}`;
          items.push(item);
        }
        return items;
      }
      case 'sortingLayer': {
        for (const sl of cache.sortingLayers) {
          const item = new vscode.CompletionItem(sl.name, vscode.CompletionItemKind.EnumMember);
          item.detail = 'Sorting Layer';
          items.push(item);
        }
        return items;
      }
      case 'input': {
        for (const axis of cache.inputAxes) {
          const item = new vscode.CompletionItem(axis.name, vscode.CompletionItemKind.Constant);
          item.detail = 'Input Axis';
          if (axis.descriptiveName) item.documentation = axis.descriptiveName;
          items.push(item);
        }
        return items;
      }
      case 'scene': {
        for (const scene of cache.buildScenes) {
          const item = new vscode.CompletionItem(scene.name, vscode.CompletionItemKind.File);
          item.detail = `Build Index ${scene.buildIndex} (${scene.path})`;
          items.push(item);
        }
        return items;
      }
      case 'shaderProperty': {
        const shaderIndex = await this.getShaderIndex();
        if (!shaderIndex) return [];
        const seen = new Set<string>();
        for (const prop of shaderIndex.properties) {
          if (seen.has(prop.name)) continue;
          seen.add(prop.name);
          const item = new vscode.CompletionItem(prop.name, vscode.CompletionItemKind.Property);
          const shaderLabel = prop.shaderName ?? path.basename(prop.shaderFile);
          item.detail = `${prop.type} in ${shaderLabel}`;
          items.push(item);
        }
        return items;
      }
      case 'animator': {
        for (const ctrl of cache.animatorControllers) {
          const ctrlName = path.basename(ctrl.assetPath, path.extname(ctrl.assetPath));
          for (const param of ctrl.parameters) {
            const item = new vscode.CompletionItem(param.name, vscode.CompletionItemKind.Variable);
            item.detail = `${param.type} (${ctrlName})`;
            items.push(item);
          }
          for (const state of ctrl.states) {
            const item = new vscode.CompletionItem(state, vscode.CompletionItemKind.Enum);
            item.detail = `State (${ctrlName})`;
            items.push(item);
          }
        }
        return items;
      }
      case 'coroutine':
      case 'invoke': {
        const methods = extractCSharpClassMethods(document.getText());
        for (const method of methods) {
          const isCoroutine = method.returnType.includes('IEnumerator');
          const item = new vscode.CompletionItem(method.name, vscode.CompletionItemKind.Method);
          item.detail = `Method in ${method.className} (${method.returnType})`;
          if (contextKind === 'coroutine') {
            item.sortText = isCoroutine ? `0_${method.name}` : `1_${method.name}`;
          } else {
            item.sortText = isCoroutine ? `1_${method.name}` : `0_${method.name}`;
          }
          items.push(item);
        }
        return items;
      }
    }
  }
}
