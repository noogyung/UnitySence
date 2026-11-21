import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { normalizePathKey } from '../../../shader-lsp/src/vfs/virtualPathResolver.ts';
import type { ProjectSettingsCache } from '../contracts/index.ts';
import { isUnityEditorRunning, openAssetInUnityEditor } from '../editor/unityEditorIntegration.ts';
import {
  extractDeclaredAnimatorVars,
  type UiToolkitElementRef,
} from './unityStringCompletionProvider.ts';

export interface UnityCSharpDefinitionOptions {
  projectRoot: string;
  getCache: () => ProjectSettingsCache;
  getUiToolkitElements?: () => readonly UiToolkitElementRef[];
  openInUnityEditor?: (projectRoot: string, assetPath: string) => Promise<boolean>;
}

export type UnityStringNavigationResult =
  | { kind: 'unity'; targetPath: string; label: string }
  | { kind: 'location'; location: vscode.Location };

function unescapeCSharpRegularString(raw: string): string {
  return raw.replace(/\\(.)/g, (_, ch: string) => {
    switch (ch) {
      case '\\':
        return '\\';
      case '"':
        return '"';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case '0':
        return '\0';
      default:
        return ch;
    }
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function walkFilesFiltered(
  dir: string,
  predicate: (fullPath: string, fileName: string) => boolean,
  out: string[] = [],
): string[] {
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
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
      } else if (entry.isFile() && predicate(full, entry.name)) {
        out.push(full);
      }
    }
  }
  return out;
}

function findStringLiteralAtPosition(
  lineText: string,
  character: number,
): { value: string; openQuoteCol: number; closeQuoteCol: number } | null {
  let i = 0;
  while (i < lineText.length) {
    const ch = lineText[i];
    if (ch === '/' && lineText[i + 1] === '/') {
      break;
    }
    // Skip C# char literals such as '"' or '\'' cleanly
    if (ch === "'") {
      let j = i + 1;
      if (j < lineText.length && lineText[j] === '\\') {
        j += 2;
      } else if (j < lineText.length) {
        j += 1;
      }
      if (j < lineText.length && lineText[j] === "'") {
        i = j + 1;
        continue;
      }
      i++;
      continue;
    }
    // Verbatim C# string literal: @"..." (doubled quotes "" escape a quote)
    if (ch === '@' && lineText[i + 1] === '"') {
      const tokenStartCol = i;
      const openQuoteCol = i + 1;
      i += 2;
      while (i < lineText.length) {
        if (lineText[i] === '"') {
          if (lineText[i + 1] === '"') {
            i += 2;
            continue;
          }
          const closeCol = i;
          if (character >= openQuoteCol && character <= closeCol + 1) {
            return {
              value: lineText.slice(openQuoteCol + 1, closeCol).replace(/""/g, '"'),
              openQuoteCol: tokenStartCol,
              closeQuoteCol: closeCol,
            };
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '"') {
      const openCol = i;
      i++;
      while (i < lineText.length) {
        if (lineText[i] === '\\') {
          i += 2;
          continue;
        }
        if (lineText[i] === '"') {
          const closeCol = i;
          if (character >= openCol && character <= closeCol + 1) {
            return {
              value: unescapeCSharpRegularString(lineText.slice(openCol + 1, closeCol)),
              openQuoteCol: openCol,
              closeQuoteCol: closeCol,
            };
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    i++;
  }
  return null;
}

function findMethodLocationInSource(
  sourceText: string,
  uri: vscode.Uri,
  methodName: string,
): vscode.Location | null {
  const escaped = escapeRegex(methodName);
  const declRe = new RegExp(
    `^[ \\t]*(?:(?:public|private|protected|internal|static|virtual|override|async|sealed|new)\\s+)*(?:[A-Za-z_][A-Za-z0-9_<>.?[\\]]*)\\s+(${escaped})\\s*\\(`,
    'gm',
  );
  const skipPrefixes = /^(?:if|for|while|switch|catch|using|lock|return|new)\b/;
  const lines = sourceText.split(/\r?\n/);

  let m: RegExpExecArray | null;
  while ((m = declRe.exec(sourceText)) !== null) {
    const snippet = m[0].trimStart();
    if (skipPrefixes.test(snippet)) continue;
    const beforeMatch = sourceText.slice(0, m.index + m[0].length - 1);
    const lineIdx = beforeMatch.split(/\r?\n/).length - 1;
    const lineStr = lines[lineIdx] ?? '';
    const col = Math.max(0, lineStr.indexOf(methodName));
    return new vscode.Location(uri, new vscode.Range(lineIdx, col, lineIdx, col + methodName.length));
  }
  return null;
}

export class UnityCSharpDefinitionProvider
  implements vscode.DefinitionProvider, vscode.Disposable
{
  private readonly options: UnityCSharpDefinitionOptions;
  private disposed = false;

  constructor(options: UnityCSharpDefinitionOptions) {
    this.options = options;
  }

  public dispose(): void {
    this.disposed = true;
  }

  public async openUnityNavigationTarget(targetPath: string, label: string): Promise<boolean> {
    if (this.disposed) return false;
    const opener = this.options.openInUnityEditor ?? openAssetInUnityEditor;
    const ok = await opener(this.options.projectRoot, targetPath);
    if (ok) {
      const lowerPath = targetPath.toLowerCase();
      const message = lowerPath.endsWith('.unity')
        ? `[UnitySense] Unity Editor에서 씬 '${label}'을(를) 열도록 요청했습니다.`
        : lowerPath.endsWith('.controller')
          ? `[UnitySense] Unity Editor에서 애니메이터 컨트롤러 '${label}'을(를) 열도록 요청했습니다.`
          : `[UnitySense] Unity Editor에서 에셋 '${label}'을(를) 열도록 요청했습니다.`;
      void vscode.window.showInformationMessage(message);
    }
    return ok;
  }

  public provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Location | undefined {
    const nav = this.resolveUnityStringNavigationInternal(document, position, false);
    return nav?.kind === 'location' ? nav.location : undefined;
  }

  private collectAssetAndPackageFiles(extLower: string): string[] {
    return [
      ...walkFilesFiltered(path.join(this.options.projectRoot, 'Assets'), (_, n) =>
        n.toLowerCase().endsWith(extLower),
      ),
      ...walkFilesFiltered(path.join(this.options.projectRoot, 'Packages'), (_, n) =>
        n.toLowerCase().endsWith(extLower),
      ),
    ];
  }

  private collectShaderFilesWithPackageCache(): string[] {
    const baseFiles = this.collectAssetAndPackageFiles('.shader');
    const pkgCacheDir = path.join(this.options.projectRoot, 'Library', 'PackageCache');
    const cacheFiles = walkFilesFiltered(pkgCacheDir, (_, n) => n.toLowerCase().endsWith('.shader'));
    cacheFiles.sort((a, b) => {
      const aUrp = a.includes('render-pipelines') ? 0 : 1;
      const bUrp = b.includes('render-pipelines') ? 0 : 1;
      return aUrp - bUrp;
    });
    return [...baseFiles, ...cacheFiles];
  }

  private findShaderPropertyLocation(target: string): UnityStringNavigationResult | undefined {
    const propRe = new RegExp(`\\b${escapeRegex(target)}\\s*\\(`, 'm');
    for (const sf of this.collectShaderFilesWithPackageCache()) {
      try {
        const text = fs.readFileSync(sf, 'utf8');
        const m = propRe.exec(text);
        if (m) {
          const lineIdx = text.slice(0, m.index).split(/\r?\n/).length - 1;
          const lineStr = text.split(/\r?\n/)[lineIdx] ?? '';
          const col = Math.max(0, lineStr.indexOf(target));
          return {
            kind: 'location',
            location: new vscode.Location(
              vscode.Uri.file(sf),
              new vscode.Range(lineIdx, col, lineIdx, col + target.length),
            ),
          };
        }
      } catch {
        // Ignore unreadable shader
      }
    }
    return undefined;
  }

  private findInputActionLocation(target: string): UnityStringNavigationResult | undefined {
    const nameRe = new RegExp(`"name"\\s*:\\s*"(${escapeRegex(target)})"`, 'm');
    for (const iaFile of this.collectAssetAndPackageFiles('.inputactions')) {
      try {
        const text = fs.readFileSync(iaFile, 'utf8');
        const m = nameRe.exec(text);
        if (m) {
          const lineIdx = text.slice(0, m.index).split(/\r?\n/).length - 1;
          const lineStr = text.split(/\r?\n/)[lineIdx] ?? '';
          const token = `"${target}"`;
          const nameKeyIdx = lineStr.indexOf('"name"');
          const col = Math.max(0, lineStr.indexOf(token, nameKeyIdx >= 0 ? nameKeyIdx : 0));
          return {
            kind: 'location',
            location: new vscode.Location(
              vscode.Uri.file(iaFile),
              new vscode.Range(lineIdx, col, lineIdx, col + token.length),
            ),
          };
        }
      } catch {
        // Ignore unreadable inputactions file
      }
    }
    return undefined;
  }

  private findAnimatorControllerLocation(
    target: string,
    includeStates = false,
    preferUnityEditor = true,
  ): UnityStringNavigationResult | undefined {
    const cache = this.options.getCache();
    const paramRe = new RegExp(`m_Name:\\s*["']?${escapeRegex(target)}["']?\\s*$`, 'm');
    for (const ctrl of cache.animatorControllers) {
      const hasParam = ctrl.parameters.some((p) => p.name === target);
      const hasState = includeStates && ctrl.states.includes(target);
      if (!hasParam && !hasState) continue;

      const absController = path.resolve(this.options.projectRoot, ctrl.assetPath);
      if (!fs.existsSync(absController)) continue;

      if (preferUnityEditor && isUnityEditorRunning(this.options.projectRoot)) {
        return {
          kind: 'unity',
          targetPath: absController,
          label: `${path.basename(absController)} (${target})`,
        };
      }

      try {
        const text = fs.readFileSync(absController, 'utf8');
        let searchStart = 0;
        if (hasParam) {
          const paramSectionIdx = text.indexOf('m_AnimatorParameters:');
          if (paramSectionIdx >= 0) {
            searchStart = paramSectionIdx;
          }
        }
        const m = paramRe.exec(text.slice(searchStart));
        if (m) {
          const absIdx = searchStart + m.index;
          const lineIdx = text.slice(0, absIdx).split(/\r?\n/).length - 1;
          const lineStr = text.split(/\r?\n/)[lineIdx] ?? '';
          const col = Math.max(0, lineStr.indexOf(target));
          return {
            kind: 'location',
            location: new vscode.Location(
              vscode.Uri.file(absController),
              new vscode.Range(lineIdx, col, lineIdx, col + target.length),
            ),
          };
        }
      } catch {
        // Fallback to line 0 if controller file exists
      }
      return {
        kind: 'location',
        location: new vscode.Location(vscode.Uri.file(absController), new vscode.Position(0, 0)),
      };
    }
    return undefined;
  }

  public resolveUnityStringNavigation(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): UnityStringNavigationResult | undefined {
    return this.resolveUnityStringNavigationInternal(document, position, true);
  }

  private resolveUnityStringNavigationInternal(
    document: vscode.TextDocument,
    position: vscode.Position,
    preferUnityEditor: boolean,
  ): UnityStringNavigationResult | undefined {
    const lineText = document.lineAt(position.line).text;
    const lit = findStringLiteralAtPosition(lineText, position.character);
    if (!lit || !lit.value) {
      return undefined;
    }

    const startLine = Math.max(0, position.line - 3);
    const beforeQuote = document.getText(
      new vscode.Range(new vscode.Position(startLine, 0), new vscode.Position(position.line, lit.openQuoteCol)),
    );
    const windowLines = beforeQuote.split(/\r?\n/).slice(-4).join(' ');
    const target = lit.value;

    // 1. StartCoroutine / StopCoroutine / Invoke / InvokeRepeating / CancelInvoke / IsInvoking
    if (
      /(?:StartCoroutine|StopCoroutine|Invoke|InvokeRepeating|CancelInvoke|IsInvoking)\s*\(\s*$/.test(
        windowLines,
      )
    ) {
      const localHit = findMethodLocationInSource(document.getText(), document.uri, target);
      if (localHit) return { kind: 'location', location: localHit };

      const currentDocKey = normalizePathKey(document.uri.fsPath);
      const csFiles = [
        ...walkFilesFiltered(path.join(this.options.projectRoot, 'Assets'), (_, n) => n.endsWith('.cs')),
        ...walkFilesFiltered(path.join(this.options.projectRoot, 'Packages'), (_, n) => n.endsWith('.cs')),
      ];
      for (const csFile of csFiles) {
        if (normalizePathKey(csFile) === currentDocKey) continue;
        try {
          const text = fs.readFileSync(csFile, 'utf8');
          if (!text.includes(target)) continue;
          const hit = findMethodLocationInSource(text, vscode.Uri.file(csFile), target);
          if (hit) return { kind: 'location', location: hit };
        } catch {
          // Ignore unreadable script
        }
      }
      return undefined;
    }

    // 2. SceneManager.LoadScene / LoadSceneAsync / GetSceneByName
    if (/SceneManager\.(?:LoadScene|LoadSceneAsync|GetSceneByName)\s*\(\s*$/.test(windowLines)) {
      const normalizedTarget = target.replace(/\\/g, '/');
      const cache = this.options.getCache();
      let resolvedScenePath: string | null = null;

      for (const scene of cache.buildScenes) {
        const scenePathNorm = scene.path.replace(/\\/g, '/');
        if (
          scene.name === target ||
          scenePathNorm === normalizedTarget ||
          scenePathNorm === `${normalizedTarget}.unity` ||
          scenePathNorm === `Assets/${normalizedTarget}.unity`
        ) {
          const absScene = path.resolve(this.options.projectRoot, scene.path);
          if (fs.existsSync(absScene)) {
            resolvedScenePath = absScene;
            break;
          }
        }
      }

      if (!resolvedScenePath) {
        const unityFiles = walkFilesFiltered(
          path.join(this.options.projectRoot, 'Assets'),
          (_, n) => n.endsWith('.unity'),
        );
        for (const uFile of unityFiles) {
          const rel = path.relative(this.options.projectRoot, uFile).replace(/\\/g, '/');
          const base = path.basename(uFile, '.unity');
          if (
            base === target ||
            rel === normalizedTarget ||
            rel === `${normalizedTarget}.unity` ||
            rel === `Assets/${normalizedTarget}.unity`
          ) {
            resolvedScenePath = uFile;
            break;
          }
        }
      }

      if (resolvedScenePath) {
        if (preferUnityEditor && isUnityEditorRunning(this.options.projectRoot)) {
          return {
            kind: 'unity',
            targetPath: resolvedScenePath,
            label: target,
          };
        }
        return {
          kind: 'location',
          location: new vscode.Location(vscode.Uri.file(resolvedScenePath), new vscode.Position(0, 0)),
        };
      }
      return undefined;
    }

    // 3. Shader.Find
    if (/Shader\.Find\s*\(\s*$/.test(windowLines)) {
      const shaderFiles = this.collectShaderFilesWithPackageCache();
      const escapedShader = escapeRegex(target);
      const shaderDeclRe = new RegExp(`^\\s*Shader\\s+"(${escapedShader})"`, 'm');
      for (const sf of shaderFiles) {
        try {
          const text = fs.readFileSync(sf, 'utf8');
          const m = shaderDeclRe.exec(text);
          if (m) {
            const lineIdx = text.slice(0, m.index).split(/\r?\n/).length - 1;
            const lineStr = text.split(/\r?\n/)[lineIdx] ?? '';
            const col = Math.max(0, lineStr.indexOf(`"${target}"`));
            return {
              kind: 'location',
              location: new vscode.Location(vscode.Uri.file(sf), new vscode.Position(lineIdx, col)),
            };
          }
        } catch {
          // Ignore unreadable shader
        }
      }
      return undefined;
    }

    // 4. Resources.Load / LoadAsync / LoadAll
    if (/Resources\.(?:Load|LoadAsync|LoadAll)(?:<[^>]+>)?\s*\(\s*$/.test(windowLines)) {
      const normalizedRes = target.replace(/\\/g, '/').replace(/^\/+/, '');
      const roots = [
        path.join(this.options.projectRoot, 'Assets'),
        path.join(this.options.projectRoot, 'Packages'),
      ];
      for (const rootDir of roots) {
        const allFiles = walkFilesFiltered(rootDir, (_, n) => !n.endsWith('.meta'));
        for (const f of allFiles) {
          const norm = f.replace(/\\/g, '/');
          const marker = '/Resources/';
          const markerIdx = norm.lastIndexOf(marker);
          if (markerIdx < 0) continue;
          const afterRes = norm.slice(markerIdx + marker.length);
          const ext = path.extname(afterRes);
          const withoutExt = ext ? afterRes.slice(0, -ext.length) : afterRes;
          if (withoutExt === normalizedRes || afterRes === normalizedRes) {
            if (
              preferUnityEditor &&
              /\.(?:prefab|unity|controller|asset|mat|anim|overridecontroller)$/i.test(f) &&
              isUnityEditorRunning(this.options.projectRoot)
            ) {
              return {
                kind: 'unity',
                targetPath: f,
                label: path.basename(f),
              };
            }
            return {
              kind: 'location',
              location: new vscode.Location(vscode.Uri.file(f), new vscode.Position(0, 0)),
            };
          }
        }
      }
      return undefined;
    }

    // 5. UI Toolkit .Q<T>("...") / .Query("...")
    if (/\.(?:Q|Query)(?:<[^>]+>)?\s*\(\s*(?:(?:name|className)\s*:\s*)?$/.test(windowLines)) {
      const elems = this.options.getUiToolkitElements?.() ?? [];
      const matchEl = elems.find((el) => el.name === target || el.className === target);
      if (matchEl && fs.existsSync(matchEl.assetPath)) {
        return {
          kind: 'location',
          location: new vscode.Location(vscode.Uri.file(matchEl.assetPath), new vscode.Position(matchEl.line, 0)),
        };
      }
      return undefined;
    }

    // 6. URP / Material Shader Property (unambiguous shader/material methods)
    if (
      /Shader\.(?:PropertyToID|SetGlobalFloat|SetGlobalInt|SetGlobalInteger|SetGlobalColor|SetGlobalVector|SetGlobalTexture|SetGlobalMatrix|SetGlobalBuffer)\s*\(\s*$/.test(
        windowLines,
      ) ||
      /\.(?:SetColor|GetColor|SetVector|GetVector|SetTexture|GetTexture|SetInt|GetInt|SetBuffer|HasProperty|SetMatrix|GetMatrix)\s*\(\s*$/.test(
        windowLines,
      )
    ) {
      return this.findShaderPropertyLocation(target);
    }

    // 7. New Input System FindAction / FindActionMap / .actions["..."]
    if (
      /(?:FindAction|FindActionMap|SwitchCurrentActionMap)\s*\(\s*$/.test(windowLines) ||
      /\.actions\[\s*$/.test(windowLines)
    ) {
      return this.findInputActionLocation(target);
    }

    // 8. Animator Parameter / State & shared numeric Material/Animator methods
    if (
      /Animator\.StringToHash\s*\(\s*$/.test(windowLines) ||
      /\.(?:SetBool|GetBool|SetTrigger|ResetTrigger)\s*\(\s*$/.test(windowLines)
    ) {
      return this.findAnimatorControllerLocation(
        target,
        /Animator\.StringToHash\s*\(\s*$/.test(windowLines),
        preferUnityEditor,
      );
    }

    if (/\.(?:Play|CrossFade|CrossFadeInFixedTime|IsName)\s*\(\s*$/.test(windowLines)) {
      return this.findAnimatorControllerLocation(target, true, preferUnityEditor);
    }

    const sharedNumericMethod =
      /(?:this\.)?([A-Za-z_][A-Za-z0-9_]*|GetComponent(?:InChildren|InParent)?<\s*(?:UnityEngine\.)?Animator\s*>\s*\(\s*\))\.(?:SetFloat|GetFloat|SetInteger|GetInteger)\s*\(\s*$/.exec(
        windowLines,
      );
    if (
      sharedNumericMethod ||
      /\.(?:SetFloat|GetFloat|SetInteger|GetInteger)\s*\(\s*$/.test(windowLines)
    ) {
      const receiver = sharedNumericMethod?.[1] ?? '';
      const animatorVars = extractDeclaredAnimatorVars(document.getText());
      const looksLikeAnimator =
        animatorVars.has(receiver) ||
        /(?:^_?(?:anim|animator|Animator)[A-Za-z0-9_]*$|Animator\s*>\s*\(\s*\)$)/.test(receiver);
      if (looksLikeAnimator) {
        return (
          this.findAnimatorControllerLocation(target, false, preferUnityEditor) ??
          this.findShaderPropertyLocation(target)
        );
      }
      return (
        this.findShaderPropertyLocation(target) ??
        this.findAnimatorControllerLocation(target, false, preferUnityEditor)
      );
    }

    return undefined;
  }
}

export function registerCSharpGoToDefinitionCommand(
  provider: UnityCSharpDefinitionProvider,
): vscode.Disposable {
  return vscode.commands.registerCommand('unitySense.csharpGoToDefinition', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'csharp') {
      await vscode.commands.executeCommand('editor.action.revealDefinition');
      return;
    }

    const position = editor.selection.active;
    const nav = provider.resolveUnityStringNavigation(editor.document, position);
    if (!nav) {
      await vscode.commands.executeCommand('editor.action.revealDefinition');
      return;
    }

    if (nav.kind === 'unity') {
      const openedInUnity = await provider.openUnityNavigationTarget(nav.targetPath, nav.label);
      if (openedInUnity) {
        return;
      }
      const fallbackLoc =
        provider.provideDefinition(editor.document, position) ??
        new vscode.Location(vscode.Uri.file(nav.targetPath), new vscode.Position(0, 0));
      const fallbackDoc = await vscode.workspace.openTextDocument(fallbackLoc.uri);
      await vscode.window.showTextDocument(fallbackDoc, {
        selection: fallbackLoc.range,
      });
      return;
    }

    const targetDoc = await vscode.workspace.openTextDocument(nav.location.uri);
    await vscode.window.showTextDocument(targetDoc, {
      selection: nav.location.range,
    });
  });
}
