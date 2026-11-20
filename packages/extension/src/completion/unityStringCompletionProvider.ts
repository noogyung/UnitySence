import path from 'node:path';
import * as vscode from 'vscode';
import type {
  ProjectSettingsCache,
  ShaderSymbolIndex,
} from '../contracts/index.ts';
import type { InputActionEntry } from '../watchers/projectSettingsWatcher.ts';

export type UnityStringContextKind =
  | 'tag'
  | 'layer'
  | 'sortingLayer'
  | 'input'
  | 'inputAction'
  | 'scene'
  | 'shaderProperty'
  | 'shaderName'
  | 'shaderKeyword'
  | 'resource'
  | 'animator'
  | 'coroutine'
  | 'invoke'
  | 'uiElement';

export type AnimatorFilterKind = 'Float' | 'Int' | 'Bool' | 'Trigger' | 'State';

export interface UiToolkitElementRef {
  name?: string;
  className?: string;
  assetPath: string;
  line: number;
}

export interface UnityStringExtraSources {
  getInputActions?: () => readonly InputActionEntry[];
  getResourcePaths?: () => readonly string[];
  getShaderKeywords?: () => readonly string[];
  getUiToolkitElements?: () => readonly UiToolkitElementRef[];
}

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

interface ApiMatchResult {
  kind: UnityStringContextKind;
  animatorSubKind?: AnimatorFilterKind;
}

export function extractDeclaredAnimatorVars(documentText?: string): ReadonlySet<string> {
  const vars = new Set<string>();
  if (!documentText) return vars;

  const declRe = /\b(?:UnityEngine\.)?Animator\s+([A-Za-z_][A-Za-z0-9_]*)(?!\s*\()/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(documentText)) !== null) {
    vars.add(m[1]);
  }

  const getCompRe =
    /\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*[^;\n]*(?:GetComponent(?:InChildren|InParent)?|AddComponent)<\s*(?:UnityEngine\.)?Animator\s*>/g;
  while ((m = getCompRe.exec(documentText)) !== null) {
    vars.add(m[1]);
  }

  return vars;
}

function matchUnityStringApiBeforeArg(
  beforeArg: string,
  allowAssignment: boolean,
  animatorVars?: ReadonlySet<string>,
): ApiMatchResult | null {
  const windowLines = beforeArg.split(/\r?\n/).slice(-4).join(' ');

  if (/(?:CompareTag|FindWithTag|FindGameObjects?WithTag)\s*\(\s*$/.test(windowLines)) {
    return { kind: 'tag' };
  }
  if (allowAssignment && /\.tag\s*(?:==|!=|=)\s*$/.test(windowLines)) {
    return { kind: 'tag' };
  }

  if (/LayerMask\.NameToLayer\s*\(\s*$/.test(windowLines)) {
    return { kind: 'layer' };
  }
  if (/LayerMask\.GetMask\s*\([^;()]*$/.test(windowLines)) {
    return { kind: 'layer' };
  }

  if (/SortingLayer\.NameToID\s*\(\s*$/.test(windowLines)) {
    return { kind: 'sortingLayer' };
  }

  if (/Input\.(?:GetAxis|GetAxisRaw|GetButton|GetButtonDown|GetButtonUp)\s*\(\s*$/.test(windowLines)) {
    return { kind: 'input' };
  }

  if (/(?:FindAction|FindActionMap|SwitchCurrentActionMap)\s*\(\s*$/.test(windowLines) || /\.actions\[\s*$/.test(windowLines)) {
    return { kind: 'inputAction' };
  }

  if (/SceneManager\.(?:LoadScene|LoadSceneAsync|GetSceneByName)\s*\(\s*$/.test(windowLines)) {
    return { kind: 'scene' };
  }

  if (/Resources\.(?:Load|LoadAsync|LoadAll)(?:<[^>]+>)?\s*\(\s*$/.test(windowLines)) {
    return { kind: 'resource' };
  }

  if (/Shader\.Find\s*\(\s*$/.test(windowLines)) {
    return { kind: 'shaderName' };
  }

  if (
    /(?:Shader|mat|material|Material)[A-Za-z0-9_]*\.(?:EnableKeyword|DisableKeyword|IsKeywordEnabled)\s*\(\s*$/.test(
      windowLines,
    )
  ) {
    return { kind: 'shaderKeyword' };
  }

  if (/\.(?:Q|Query)(?:<[^>]+>)?\s*\(\s*(?:(?:name|className)\s*:\s*)?$/.test(windowLines)) {
    return { kind: 'uiElement' };
  }

  if (/Animator\.StringToHash\s*\(\s*$/.test(windowLines)) {
    return { kind: 'animator' };
  }

  const receiverMethodMatch =
    /\b(?:this\.)?([A-Za-z_][A-Za-z0-9_]*)\.(SetFloat|GetFloat|SetInteger|GetInteger|SetBool|GetBool|SetTrigger|ResetTrigger|Play|CrossFade|CrossFadeInFixedTime|IsName)\s*\(\s*$/.exec(
      windowLines,
    );
  const animMethodMatch =
    (receiverMethodMatch && animatorVars?.has(receiverMethodMatch[1]) ? receiverMethodMatch : null) ??
    /(?:GetComponent(?:InChildren|InParent)?<\s*(?:UnityEngine\.)?Animator\s*>\s*\(\s*\)|(?<![A-Za-z])_?(?:anim|animator|Animator)[A-Za-z0-9_]*)\.(SetFloat|GetFloat|SetInteger|GetInteger|SetBool|GetBool|SetTrigger|ResetTrigger|Play|CrossFade|CrossFadeInFixedTime|IsName)\s*\(\s*$/.exec(
      windowLines,
    ) ??
    /\.(SetTrigger|ResetTrigger|SetBool|GetBool|CrossFade|CrossFadeInFixedTime)\s*\(\s*$/.exec(windowLines);
  if (animMethodMatch) {
    const mName = animMethodMatch === receiverMethodMatch ? receiverMethodMatch[2] : animMethodMatch[1];
    let sub: AnimatorFilterKind | undefined;
    if (mName.includes('Float')) sub = 'Float';
    else if (mName.includes('Integer')) sub = 'Int';
    else if (mName.includes('Bool')) sub = 'Bool';
    else if (mName.includes('Trigger')) sub = 'Trigger';
    else if (mName === 'Play' || mName.startsWith('CrossFade') || mName === 'IsName') sub = 'State';
    return { kind: 'animator', animatorSubKind: sub };
  }

  if (
    /Shader\.(?:PropertyToID|SetGlobalFloat|SetGlobalInt|SetGlobalInteger|SetGlobalColor|SetGlobalVector|SetGlobalTexture|SetGlobalMatrix|SetGlobalBuffer)\s*\(\s*$/.test(
      windowLines,
    ) ||
    /(?<![A-Za-z])_?(?:mat|material|Material|mpb|block|PropertyBlock)[A-Za-z0-9_]*\.(?:SetFloat|SetInt|SetInteger|SetColor|SetVector|SetTexture|SetMatrix|SetBuffer|GetFloat|GetInt|GetInteger|GetColor|GetVector|GetTexture|GetMatrix|HasProperty)\s*\(\s*$/.test(
      windowLines,
    ) ||
    /\.(?:HasProperty|SetColor|SetTexture|GetColor|GetTexture|SetVector|GetVector)\s*\(\s*$/.test(
      windowLines,
    )
  ) {
    return { kind: 'shaderProperty' };
  }

  // Fallback for `.SetFloat("` when receiver is unrecognized: still differentiate animator vs material
  if (/\.(?:SetFloat|GetFloat|SetInt|GetInt|SetInteger|GetInteger)\s*\(\s*$/.test(windowLines)) {
    return { kind: 'shaderProperty' };
  }

  if (/(?:StartCoroutine|StopCoroutine)\s*\(\s*$/.test(windowLines)) {
    return { kind: 'coroutine' };
  }

  if (/(?:Invoke|InvokeRepeating|CancelInvoke|IsInvoking)\s*\(\s*$/.test(windowLines)) {
    return { kind: 'invoke' };
  }

  return null;
}

export function detectApiStringContext(textBeforeCursor: string, documentText?: string): UnityStringContextKind | null {
  const state = analyzeCursorLexicalState(textBeforeCursor);
  if (!state.inString || state.stringStart === -1) return null;

  const beforeQuote = textBeforeCursor.slice(0, state.stringStart);
  const animatorVars = extractDeclaredAnimatorVars(documentText);
  return matchUnityStringApiBeforeArg(beforeQuote, true, animatorVars)?.kind ?? null;
}

export function detectApiParenOrStringContext(
  textBeforeCursor: string,
  documentText?: string,
): {
  kind: UnityStringContextKind;
  animatorSubKind?: AnimatorFilterKind;
  insideQuotes: boolean;
  quoteStartIdx: number;
  partialIdent: string;
} | null {
  const state = analyzeCursorLexicalState(textBeforeCursor);
  if (state.inLineComment || state.inBlockComment) {
    return null;
  }

  const animatorVars = extractDeclaredAnimatorVars(documentText);

  if (state.inString && state.stringStart !== -1) {
    const beforeQuote = textBeforeCursor.slice(0, state.stringStart);
    const hit = matchUnityStringApiBeforeArg(beforeQuote, true, animatorVars);
    return hit
      ? {
          kind: hit.kind,
          animatorSubKind: hit.animatorSubKind,
          insideQuotes: true,
          quoteStartIdx: state.stringStart,
          partialIdent: '',
        }
      : null;
  }

  // Allow right after opening `(` / comma OR when unquoted identifier prefix was started (`CompareTag(Pl`)
  const partialMatch = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(state.codeWithoutComments);
  const partialIdent = partialMatch ? partialMatch[1] : '';
  const beforeIdent = partialIdent
    ? state.codeWithoutComments.slice(0, state.codeWithoutComments.length - partialIdent.length)
    : state.codeWithoutComments;

  const hit = matchUnityStringApiBeforeArg(beforeIdent, false, animatorVars);
  return hit
    ? {
        kind: hit.kind,
        animatorSubKind: hit.animatorSubKind,
        insideQuotes: false,
        quoteStartIdx: -1,
        partialIdent,
      }
    : null;
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
  private extraSources?: UnityStringExtraSources;

  constructor(
    getCache: () => ProjectSettingsCache,
    getShaderIndex: () => Promise<ShaderSymbolIndex | null> | ShaderSymbolIndex | null,
    extraSources?: UnityStringExtraSources,
  ) {
    this.getCache = getCache;
    this.getShaderIndex = getShaderIndex;
    this.extraSources = extraSources;
  }

  public setExtraSources(extra: Partial<UnityStringExtraSources>): void {
    this.extraSources = { ...this.extraSources, ...extra };
  }

  public async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[] | undefined> {
    const startLine = Math.max(0, position.line - 3);
    const textBeforeCursor = document.getText(
      new vscode.Range(new vscode.Position(startLine, 0), position),
    );

    const fullDocumentText = document.getText();
    const detected = detectApiParenOrStringContext(textBeforeCursor, fullDocumentText);
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
      case 'inputAction': {
        const actions = this.extraSources?.getInputActions?.() ?? [];
        const seen = new Set<string>();
        for (const act of actions) {
          if (!seen.has(act.name)) {
            seen.add(act.name);
            const item = new vscode.CompletionItem(act.name, vscode.CompletionItemKind.Event);
            item.detail = `[UnityBrain] InputAction (${act.actionMap} · ${act.assetName})`;
            item.documentation = `[UnityBrain] '.inputactions' 에셋의 액션 '${act.actionMap}/${act.name}'입니다.`;
            items.push(item);
          }
          if (!seen.has(act.actionMap)) {
            seen.add(act.actionMap);
            const mapItem = new vscode.CompletionItem(act.actionMap, vscode.CompletionItemKind.Module);
            mapItem.detail = `[UnityBrain] InputActionMap (${act.assetName})`;
            mapItem.documentation = `[UnityBrain] '.inputactions' 에셋의 액션 맵입니다.`;
            items.push(mapItem);
          }
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
      case 'resource': {
        const resPaths = this.extraSources?.getResourcePaths?.() ?? [];
        for (const rPath of resPaths) {
          const item = new vscode.CompletionItem(rPath, vscode.CompletionItemKind.File);
          item.detail = '[UnityBrain] Resources 리소스 경로';
          item.documentation = `[UnityBrain] Assets/.../Resources/${rPath} 에셋입니다.`;
          items.push(item);
        }
        break;
      }
      case 'shaderName': {
        const shaderIndex = await this.getShaderIndex();
        if (!shaderIndex) return [];
        for (const sName of shaderIndex.shaderNames) {
          const item = new vscode.CompletionItem(sName, vscode.CompletionItemKind.Class);
          item.detail = '[UnityBrain] 유니티 셰이더 이름 (Shader.Find)';
          item.documentation = `[UnityBrain] 프로젝트에 정의된 셰이더 '${sName}'입니다.`;
          items.push(item);
        }
        break;
      }
      case 'shaderKeyword': {
        const keywords = this.extraSources?.getShaderKeywords?.() ?? [];
        for (const kw of keywords) {
          const item = new vscode.CompletionItem(kw, vscode.CompletionItemKind.Constant);
          item.detail = '[UnityBrain] 셰이더 키워드 (#pragma keyword)';
          item.documentation = `[UnityBrain] 프로젝트 셰이더에 선언된 배리언트 키워드 '${kw}'입니다.`;
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
        const subFilter = detected.animatorSubKind;
        const primaryItems: vscode.CompletionItem[] = [];
        const secondaryItems: vscode.CompletionItem[] = [];
        for (const ctrl of cache.animatorControllers) {
          const ctrlName = path.basename(ctrl.assetPath, path.extname(ctrl.assetPath));
          if (subFilter !== 'State') {
            for (const param of ctrl.parameters) {
              if (subFilter && param.type !== subFilter) continue;
              const item = new vscode.CompletionItem(param.name, vscode.CompletionItemKind.Variable);
              item.detail = `[UnityBrain] 애니메이터 파라미터 (${param.type} · ${ctrlName})`;
              item.documentation = `[UnityBrain] '${ctrl.assetPath}' 컨트롤러의 파라미터입니다.`;
              item.sortText = `0_${param.name}`;
              primaryItems.push(item);
            }
          }
          if (!subFilter || subFilter === 'State') {
            for (const state of ctrl.states) {
              const item = new vscode.CompletionItem(state, vscode.CompletionItemKind.Enum);
              item.detail = `[UnityBrain] 애니메이터 상태 (State · ${ctrlName})`;
              item.documentation = `[UnityBrain] '${ctrl.assetPath}' 컨트롤러의 스테이트입니다.`;
              item.sortText = `0_${state}`;
              primaryItems.push(item);
            }
          } else {
            for (const state of ctrl.states) {
              const item = new vscode.CompletionItem(state, vscode.CompletionItemKind.Enum);
              item.detail = `[UnityBrain] 애니메이터 상태 (State · ${ctrlName})`;
              item.documentation = `[UnityBrain] '${ctrl.assetPath}' 컨트롤러의 스테이트입니다.`;
              item.sortText = `2_${state}`;
              secondaryItems.push(item);
            }
          }
        }
        items.push(...primaryItems, ...secondaryItems);
        break;
      }
      case 'coroutine':
      case 'invoke': {
        const methods = extractCSharpClassMethods(fullDocumentText);
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
      case 'uiElement': {
        const uiElems = this.extraSources?.getUiToolkitElements?.() ?? [];
        const seenNames = new Set<string>();
        const seenClasses = new Set<string>();
        for (const el of uiElems) {
          const assetName = path.basename(el.assetPath);
          if (el.name && !seenNames.has(el.name)) {
            seenNames.add(el.name);
            const item = new vscode.CompletionItem(el.name, vscode.CompletionItemKind.Field);
            item.detail = `[UnityBrain] UI Toolkit 요소 이름 (${assetName})`;
            item.documentation = `[UnityBrain] ${el.assetPath}:${el.line + 1}에 선언된 name="${el.name}" 요소입니다.`;
            items.push(item);
          }
          if (el.className && !seenClasses.has(el.className)) {
            seenClasses.add(el.className);
            const item = new vscode.CompletionItem(el.className, vscode.CompletionItemKind.Class);
            item.detail = `[UnityBrain] UI Toolkit USS 클래스 (${assetName})`;
            item.documentation = `[UnityBrain] ${el.assetPath}:${el.line + 1}에 정의된 USS 클래스 '.${el.className}'입니다.`;
            items.push(item);
          }
        }
        break;
      }
    }

    let replaceRange: vscode.Range | undefined;
    let hasClosingQuote = true;
    const fullLineText = document.lineAt(position.line).text;
    if (detected.insideQuotes) {
      const curBeforeCursor = fullLineText.slice(0, position.character);
      const lastQuoteCol = curBeforeCursor.lastIndexOf('"');
      if (lastQuoteCol >= 0) {
        let closingOffset = -1;
        const afterCursor = fullLineText.slice(position.character);
        for (let k = 0; k < afterCursor.length; k++) {
          if (afterCursor[k] === '\\') {
            k++;
            continue;
          }
          if (afterCursor[k] === '"') {
            closingOffset = k;
            break;
          }
        }
        hasClosingQuote = closingOffset >= 0;
        const endCol = hasClosingQuote ? position.character + closingOffset : position.character;
        replaceRange = new vscode.Range(
          new vscode.Position(position.line, lastQuoteCol + 1),
          new vscode.Position(position.line, endCol),
        );
      }
    } else if (detected.partialIdent) {
      replaceRange = new vscode.Range(
        new vscode.Position(position.line, position.character - detected.partialIdent.length),
        position,
      );
    }

    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      if (!detected.insideQuotes) {
        item.insertText = `"${item.label}"`;
        item.filterText = detected.partialIdent
          ? `${detected.partialIdent} "${item.label}" ${item.label}`
          : `"${item.label}" ${item.label}`;
      } else if (!hasClosingQuote) {
        item.insertText = `${item.label}"`;
        item.filterText = String(item.label);
      }
      if (replaceRange) {
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
