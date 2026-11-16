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

function analyzeCursorLexicalState(snippet: string): {
  inLineComment: boolean;
  inBlockComment: boolean;
  inString: boolean;
  stringStart: number;
  codeWithoutComments: string;
} {
  let i = 0;
  let inLineComment = false;
  let inBlockComment = false;
  let inString = false;
  let stringStart = -1;
  const codeChars: string[] = [];

  while (i < snippet.length) {
    const ch = snippet[i];
    const next = snippet[i + 1];

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        codeChars.push('\n');
      }
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
      } else {
        if (ch === '\n') codeChars.push('\n');
        i++;
      }
      continue;
    }
    if (inString) {
      codeChars.push(ch);
      if (ch === '\\') {
        if (i + 1 < snippet.length) codeChars.push(snippet[i + 1]);
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
      codeChars.push(ch);
      i++;
      continue;
    }
    codeChars.push(ch);
    i++;
  }

  return {
    inLineComment,
    inBlockComment,
    inString,
    stringStart,
    codeWithoutComments: codeChars.join(''),
  };
}

function matchUnityStringApiBeforeArg(beforeArg: string, allowAssignment: boolean): UnityStringContextKind | null {
  const windowLines = beforeArg.split(/\r?\n/).slice(-4).join(' ');

  if (/(?:CompareTag|FindWithTag|FindGameObjects?WithTag)\s*\(\s*$/.test(windowLines)) {
    return 'tag';
  }
  if (allowAssignment && /\.tag\s*(?:==|!=|=)\s*$/.test(windowLines)) {
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

export function detectApiStringContext(textBeforeCursor: string): UnityStringContextKind | null {
  const state = analyzeCursorLexicalState(textBeforeCursor);
  if (!state.inString || state.stringStart === -1) return null;

  const beforeQuote = textBeforeCursor.slice(0, state.stringStart);
  return matchUnityStringApiBeforeArg(beforeQuote, true);
}

export function detectApiParenOrStringContext(textBeforeCursor: string): {
  kind: UnityStringContextKind;
  insideQuotes: boolean;
  quoteStartIdx: number;
} | null {
  const state = analyzeCursorLexicalState(textBeforeCursor);
  if (state.inLineComment || state.inBlockComment) {
    return null;
  }

  if (state.inString && state.stringStart !== -1) {
    const beforeQuote = textBeforeCursor.slice(0, state.stringStart);
    const kind = matchUnityStringApiBeforeArg(beforeQuote, true);
    return kind ? { kind, insideQuotes: true, quoteStartIdx: state.stringStart } : null;
  }

  // Right after an opening parenthesis (or comma inside LayerMask.GetMask) before quotes are typed
  const kind = matchUnityStringApiBeforeArg(state.codeWithoutComments, false);
  return kind ? { kind, insideQuotes: false, quoteStartIdx: -1 } : null;
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

    const detected = detectApiParenOrStringContext(textBeforeCursor);
    if (!detected) {
      return undefined;
    }

    const contextKind = detected.kind;
    const cache = this.getCache();
    const items: vscode.CompletionItem[] = [];

    switch (contextKind) {
      case 'tag': {
        for (const tag of cache.tags) {
          const item = new vscode.CompletionItem(tag, vscode.CompletionItemKind.EnumMember);
          item.detail = '[UnityBrain] 유니티 태그 (Unity Tag)';
          item.documentation = '[UnityBrain] ProjectSettings/TagManager.asset에서 불러온 프로젝트 태그입니다.';
          items.push(item);
        }
        break;
      }
      case 'layer': {
        for (const layer of cache.layers) {
          const item = new vscode.CompletionItem(layer.name, vscode.CompletionItemKind.EnumMember);
          item.detail = `[UnityBrain] 유니티 레이어 ${layer.index} (Layer ${layer.index})`;
          item.documentation = '[UnityBrain] ProjectSettings/TagManager.asset에 등록된 레이어입니다.';
          items.push(item);
        }
        break;
      }
      case 'sortingLayer': {
        for (const sl of cache.sortingLayers) {
          const item = new vscode.CompletionItem(sl.name, vscode.CompletionItemKind.EnumMember);
          item.detail = '[UnityBrain] 정렬 레이어 (Sorting Layer)';
          item.documentation = '[UnityBrain] ProjectSettings/TagManager.asset에 등록된 정렬 레이어입니다.';
          items.push(item);
        }
        break;
      }
      case 'input': {
        for (const axis of cache.inputAxes) {
          const item = new vscode.CompletionItem(axis.name, vscode.CompletionItemKind.Constant);
          item.detail = '[UnityBrain] 입력 축 (Input Axis)';
          item.documentation = axis.descriptiveName
            ? `[UnityBrain] ${axis.descriptiveName}`
            : '[UnityBrain] ProjectSettings/InputManager.asset 입력 축입니다.';
          items.push(item);
        }
        break;
      }
      case 'scene': {
        for (const scene of cache.buildScenes) {
          const item = new vscode.CompletionItem(scene.name, vscode.CompletionItemKind.File);
          item.detail = `[UnityBrain] 빌드 씬 #${scene.buildIndex} (Build Index ${scene.buildIndex} · ${scene.path})`;
          item.documentation = `[UnityBrain] EditorBuildSettings.asset 빌드 인덱스 ${scene.buildIndex}번 씬입니다.`;
          items.push(item);
        }
        break;
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
          item.detail = `[UnityBrain] 셰이더 프로퍼티 (${prop.type} in ${shaderLabel})`;
          item.documentation = `[UnityBrain] 셰이더 '${shaderLabel}'에 선언된 ${prop.type} 프로퍼티입니다.`;
          items.push(item);
        }
        break;
      }
      case 'animator': {
        for (const ctrl of cache.animatorControllers) {
          const ctrlName = path.basename(ctrl.assetPath, path.extname(ctrl.assetPath));
          for (const param of ctrl.parameters) {
            const item = new vscode.CompletionItem(param.name, vscode.CompletionItemKind.Variable);
            item.detail = `[UnityBrain] 애니메이터 파라미터 (${param.type} · ${ctrlName})`;
            item.documentation = `[UnityBrain] '${ctrl.assetPath}' 컨트롤러의 파라미터입니다.`;
            items.push(item);
          }
          for (const state of ctrl.states) {
            const item = new vscode.CompletionItem(state, vscode.CompletionItemKind.Enum);
            item.detail = `[UnityBrain] 애니메이터 상태 (State · ${ctrlName})`;
            item.documentation = `[UnityBrain] '${ctrl.assetPath}' 컨트롤러의 스테이트입니다.`;
            items.push(item);
          }
        }
        break;
      }
      case 'coroutine':
      case 'invoke': {
        const methods = extractCSharpClassMethods(document.getText());
        for (const method of methods) {
          const isCoroutine = method.returnType.includes('IEnumerator');
          const item = new vscode.CompletionItem(method.name, vscode.CompletionItemKind.Method);
          item.detail = `[UnityBrain] ${method.className} 메서드 (${method.returnType})`;
          item.documentation = `[UnityBrain] ${method.className} 클래스에 선언된 메서드입니다.`;
          if (contextKind === 'coroutine') {
            item.sortText = isCoroutine ? `0_${method.name}` : `1_${method.name}`;
          } else {
            item.sortText = isCoroutine ? `1_${method.name}` : `0_${method.name}`;
          }
          items.push(item);
        }
        break;
      }
    }

    let replaceRange: vscode.Range | undefined;
    if (detected.insideQuotes) {
      const curBeforeCursor = document.lineAt(position.line).text.slice(0, position.character);
      const lastQuoteCol = curBeforeCursor.lastIndexOf('"');
      if (lastQuoteCol >= 0) {
        replaceRange = new vscode.Range(new vscode.Position(position.line, lastQuoteCol + 1), position);
      }
    }

    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      if (!detected.insideQuotes) {
        item.insertText = `"${item.label}"`;
        item.filterText = `"${item.label}" ${item.label}`;
      } else if (replaceRange) {
        item.range = replaceRange;
      }
      item.sortText = item.sortText
        ? `\u0000_${item.sortText}`
        : `\u0000_${String(idx).padStart(3, '0')}_${item.label}`;
      (item as vscode.CompletionItem & { preselect?: boolean }).preselect = idx === 0;
    }

    return items;
  }
}
