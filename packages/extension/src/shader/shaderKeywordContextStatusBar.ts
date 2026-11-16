import * as vscode from 'vscode';

export interface PragmaDirectiveInfo {
  line: number;
  kind: 'multi_compile' | 'shader_feature';
  keywords: string[];
  variantFactor: number;
}

export interface ShaderBlockVariantSummary {
  anchorLine: number;
  pragmas: PragmaDirectiveInfo[];
  variantCount: number;
}

export interface ShaderVariantAnalysis {
  blocks: ShaderBlockVariantSummary[];
  totalVariants: number;
  allKeywords: string[];
}

const SPECIAL_PRAGMA_SHORTCUTS: Record<string, string[]> = {
  multi_compile_fog: ['_', 'FOG_EXP2'],
  multi_compile_instancing: ['_', 'INSTANCING_ON'],
  multi_compile_fwdbase: ['_', 'DIRECTIONAL', 'LIGHTMAP_ON'],
  multi_compile_fwdadd: ['_', 'POINT', 'SPOT'],
  multi_compile_shadowcaster: ['_', 'SHADOWS_DEPTH'],
};

const SHADER_LANG_IDS = new Set(['unity-shaderlab', 'shaderlab', 'hlsl']);

export function isShaderDocument(doc: vscode.TextDocument | undefined): boolean {
  if (!doc) return false;
  if (SHADER_LANG_IDS.has(doc.languageId)) return true;
  return /\.(shader|hlsl|hlsli|cginc|cg|compute)$/i.test(doc.fileName);
}

export function parsePragmaDirectiveLine(rawLine: string, lineNumber: number): PragmaDirectiveInfo | null {
  const withoutComment = rawLine.replace(/\/\/.*$/, '').trim();
  if (!withoutComment.startsWith('#pragma')) {
    return null;
  }

  const tokens = withoutComment.split(/\s+/);
  if (tokens.length < 2) {
    return null;
  }

  const directive = tokens[1];
  if (directive in SPECIAL_PRAGMA_SHORTCUTS) {
    const kws = SPECIAL_PRAGMA_SHORTCUTS[directive];
    return {
      line: lineNumber,
      kind: 'multi_compile',
      keywords: kws,
      variantFactor: kws.length,
    };
  }

  let kind: 'multi_compile' | 'shader_feature' | null = null;
  if (/^multi_compile(?:_local)?(?:_vertex|_fragment)?$/.test(directive)) {
    kind = 'multi_compile';
  } else if (/^shader_feature(?:_local)?(?:_vertex|_fragment)?$/.test(directive)) {
    kind = 'shader_feature';
  }

  if (!kind) {
    return null;
  }

  const rawKeywords = tokens.slice(2).filter(Boolean);
  if (rawKeywords.length === 0) {
    return null;
  }

  const keywords =
    kind === 'shader_feature' && rawKeywords.length === 1 && !/^_+$/.test(rawKeywords[0])
      ? ['_', rawKeywords[0]]
      : rawKeywords;

  return {
    line: lineNumber,
    kind,
    keywords,
    variantFactor: Math.max(1, keywords.length),
  };
}

export function analyzeShaderVariants(text: string): ShaderVariantAnalysis {
  const lines = text.split(/\r?\n/);
  const sharedIncludePragmas: PragmaDirectiveInfo[] = [];
  const programBlocks: Array<{ anchorLine: number; pragmas: PragmaDirectiveInfo[] }> = [];
  const standalonePragmas: PragmaDirectiveInfo[] = [];

  let inInclude = false;
  let inProgram = false;
  let currentProgram: { anchorLine: number; pragmas: PragmaDirectiveInfo[] } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].replace(/\/\/.*$/, '').trim();
    if (!trimmed) continue;

    if (/^(HLSLINCLUDE|CGINCLUDE)\b/.test(trimmed)) {
      inInclude = true;
      continue;
    }
    if (/^(ENDHLSL|ENDCG)\b/.test(trimmed)) {
      inInclude = false;
      if (inProgram && currentProgram) {
        programBlocks.push(currentProgram);
      }
      inProgram = false;
      currentProgram = null;
      continue;
    }
    if (/^(HLSLPROGRAM|CGPROGRAM)\b/.test(trimmed)) {
      inProgram = true;
      currentProgram = { anchorLine: i, pragmas: [] };
      continue;
    }

    const pragma = parsePragmaDirectiveLine(lines[i], i);
    if (!pragma) continue;

    if (inInclude) {
      sharedIncludePragmas.push(pragma);
    } else if (inProgram && currentProgram) {
      currentProgram.pragmas.push(pragma);
    } else {
      standalonePragmas.push(pragma);
    }
  }

  if (inProgram && currentProgram) {
    programBlocks.push(currentProgram);
  }

  const blocks: ShaderBlockVariantSummary[] = [];
  if (programBlocks.length > 0) {
    for (const blk of programBlocks) {
      const combined = [...sharedIncludePragmas, ...blk.pragmas];
      const variantCount = combined.reduce((acc, p) => acc * p.variantFactor, 1);
      blocks.push({
        anchorLine: blk.anchorLine,
        pragmas: combined,
        variantCount,
      });
    }
  } else if (standalonePragmas.length > 0 || sharedIncludePragmas.length > 0) {
    const combined = [...sharedIncludePragmas, ...standalonePragmas];
    const variantCount = combined.reduce((acc, p) => acc * p.variantFactor, 1);
    blocks.push({
      anchorLine: combined[0].line,
      pragmas: combined,
      variantCount,
    });
  }

  const keywordSet = new Set<string>();
  for (const blk of blocks) {
    for (const p of blk.pragmas) {
      for (const kw of p.keywords) {
        if (!/^_+$/.test(kw)) {
          keywordSet.add(kw);
        }
      }
    }
  }

  const totalVariants =
    blocks.length > 0 ? blocks.reduce((acc, blk) => acc + blk.variantCount, 0) : 0;

  return {
    blocks,
    totalVariants,
    allKeywords: Array.from(keywordSet),
  };
}

export class ShaderVariantCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses: vscode.Event<void> = this.onDidChangeEmitter.event;

  public refresh(): void {
    this.onDidChangeEmitter.fire();
  }

  public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!isShaderDocument(document)) {
      return [];
    }

    const analysis = analyzeShaderVariants(document.getText());
    if (analysis.blocks.length === 0) {
      return [];
    }

    return analysis.blocks.map((blk) => {
      const warning = blk.variantCount > 128 ? ' (배리언트 과다 주의!)' : '';
      return new vscode.CodeLens(new vscode.Range(blk.anchorLine, 0, blk.anchorLine, 0), {
        title: `$(layers) [UnityBrain] 셰이더 배리언트 ${blk.variantCount}개${warning}`,
        command: 'unityBrain.switchShaderKeywords',
        tooltip: '[UnityBrain] 클릭하여 활성 셰이더 전처리기 키워드 컨텍스트를 전환합니다',
      });
    });
  }

  public dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}

export interface InactivePreprocessorRange {
  startLine: number;
  endLine: number;
}

function evaluatePreprocessorCondition(
  expr: string,
  definedSet: ReadonlySet<string>,
  numericMacros: ReadonlyMap<string, number>,
): boolean | null {
  const cleaned = expr.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '').trim();
  if (!cleaned) return null;

  // Arithmetic comparisons with unknown identifiers remain indeterminate to avoid false dimming
  if (/(<=|>=|==|!=|<|>)/.test(cleaned)) {
    const tokens = cleaned.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? [];
    for (const tok of tokens) {
      if (tok !== 'defined' && !numericMacros.has(tok)) {
        return null;
      }
    }
  }

  let jsExpr = cleaned
    .replace(/\bdefined\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g, (_, name: string) =>
      definedSet.has(name) ? '1' : '0',
    )
    .replace(/\bdefined\s+([A-Za-z_][A-Za-z0-9_]*)\b/g, (_, name: string) =>
      definedSet.has(name) ? '1' : '0',
    )
    .replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, (ident: string) => {
      if (ident === 'true') return '1';
      if (ident === 'false') return '0';
      if (numericMacros.has(ident)) return String(numericMacros.get(ident));
      return definedSet.has(ident) ? '1' : '0';
    });

  if (!/^[0-9\s()!&|=<>+\-*/%]+$/.test(jsExpr)) {
    return null;
  }

  try {
    const value = Function(`"use strict"; return Boolean(${jsExpr});`)() as boolean;
    return Boolean(value);
  } catch {
    return null;
  }
}

export function evaluateInactivePreprocessorRanges(
  text: string,
  activeKeywords: ReadonlySet<string>,
  definedMacros?: ReadonlySet<string>,
): InactivePreprocessorRange[] {
  const lines = text.split(/\r?\n/);
  const definedSet = new Set<string>(activeKeywords);
  if (definedMacros) {
    for (const m of definedMacros) definedSet.add(m);
  }
  const numericMacros = new Map<string, number>();

  interface Frame {
    parentActive: boolean;
    branchTaken: boolean;
    currentActive: boolean;
    inactiveBodyStartLine: number | null;
  }

  const stack: Frame[] = [];
  const ranges: InactivePreprocessorRange[] = [];

  const isParentActive = (): boolean => (stack.length === 0 ? true : stack[stack.length - 1].currentActive);

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].replace(/\/\/.*$/, '').trim();
    if (!trimmed.startsWith('#')) continue;

    const ifdefMatch = /^#\s*(ifdef|ifndef)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(trimmed);
    if (ifdefMatch) {
      const parentActive = isParentActive();
      const sym = ifdefMatch[2];
      const cond = ifdefMatch[1] === 'ifdef' ? definedSet.has(sym) : !definedSet.has(sym);
      const active = parentActive && cond;
      stack.push({
        parentActive,
        branchTaken: active,
        currentActive: active,
        inactiveBodyStartLine: !active && parentActive ? i + 1 : null,
      });
      continue;
    }

    const ifMatch = /^#\s*if\s+(.+)$/.exec(trimmed);
    if (ifMatch) {
      const parentActive = isParentActive();
      const evalRes = evaluatePreprocessorCondition(ifMatch[1], definedSet, numericMacros);
      const cond = evalRes === null ? true : evalRes;
      const active = parentActive && cond;
      stack.push({
        parentActive,
        branchTaken: active,
        currentActive: active,
        inactiveBodyStartLine: !active && parentActive ? i + 1 : null,
      });
      continue;
    }

    const elifMatch = /^#\s*elif\s+(.+)$/.exec(trimmed);
    if (elifMatch && stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top.inactiveBodyStartLine !== null && i - 1 >= top.inactiveBodyStartLine) {
        ranges.push({ startLine: top.inactiveBodyStartLine, endLine: i - 1 });
      }
      top.inactiveBodyStartLine = null;

      if (!top.parentActive || top.branchTaken) {
        top.currentActive = false;
        if (top.parentActive) {
          top.inactiveBodyStartLine = i + 1;
        }
      } else {
        const evalRes = evaluatePreprocessorCondition(elifMatch[1], definedSet, numericMacros);
        const cond = evalRes === null ? true : evalRes;
        top.currentActive = cond;
        if (cond) {
          top.branchTaken = true;
        } else {
          top.inactiveBodyStartLine = i + 1;
        }
      }
      continue;
    }

    if (/^#\s*else\b/.test(trimmed) && stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top.inactiveBodyStartLine !== null && i - 1 >= top.inactiveBodyStartLine) {
        ranges.push({ startLine: top.inactiveBodyStartLine, endLine: i - 1 });
      }
      top.inactiveBodyStartLine = null;

      if (!top.parentActive || top.branchTaken) {
        top.currentActive = false;
        if (top.parentActive) {
          top.inactiveBodyStartLine = i + 1;
        }
      } else {
        top.currentActive = true;
        top.branchTaken = true;
      }
      continue;
    }

    if (/^#\s*endif\b/.test(trimmed) && stack.length > 0) {
      const top = stack.pop()!;
      if (top.inactiveBodyStartLine !== null && i - 1 >= top.inactiveBodyStartLine) {
        ranges.push({ startLine: top.inactiveBodyStartLine, endLine: i - 1 });
      }
      continue;
    }

    if (isParentActive()) {
      const defineMatch = /^#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+(\d+))?/.exec(trimmed);
      if (defineMatch) {
        definedSet.add(defineMatch[1]);
        if (defineMatch[2] !== undefined) {
          numericMacros.set(defineMatch[1], Number(defineMatch[2]));
        }
      } else {
        const undefMatch = /^#\s*undef\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(trimmed);
        if (undefMatch) {
          definedSet.delete(undefMatch[1]);
          numericMacros.delete(undefMatch[1]);
        }
      }
    }
  }

  return ranges;
}

export interface ShaderKeywordStatusBarOptions {
  onKeywordsChanged?: (uri: vscode.Uri | undefined, keywords: string[]) => void | Promise<void>;
}

export class ShaderKeywordContextStatusBar implements vscode.Disposable {
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly inactiveDecorationType: vscode.TextEditorDecorationType | null;
  private readonly onKeywordsChanged?: (
    uri: vscode.Uri | undefined,
    keywords: string[],
  ) => void | Promise<void>;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly keywordsByUri = new Map<string, string[]>();

  constructor(options: ShaderKeywordStatusBarOptions = {}) {
    this.onKeywordsChanged = options.onKeywordsChanged;
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.command = 'unityBrain.switchShaderKeywords';
    this.inactiveDecorationType =
      typeof vscode.window.createTextEditorDecorationType === 'function'
        ? vscode.window.createTextEditorDecorationType({ opacity: '0.45', isWholeLine: true })
        : null;

    if (this.inactiveDecorationType) {
      this.disposables.push(this.inactiveDecorationType);
    }

    this.disposables.push(
      this.statusBarItem,
      vscode.commands.registerCommand('unityBrain.switchShaderKeywords', (explicitKeywords?: unknown) =>
        this.switchKeywordsCommand(Array.isArray(explicitKeywords) ? (explicitKeywords as string[]) : undefined),
      ),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.updateForDocument(editor?.document);
        this.applyInactiveDecorations(editor);
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (vscode.window.activeTextEditor?.document.uri.toString() === e.document.uri.toString()) {
          this.updateForDocument(e.document);
          this.applyInactiveDecorations(vscode.window.activeTextEditor);
        }
      }),
    );

    this.updateForDocument(vscode.window.activeTextEditor?.document);
    this.applyInactiveDecorations(vscode.window.activeTextEditor);
  }

  public applyInactiveDecorations(editor: vscode.TextEditor | undefined): void {
    if (!editor || !this.inactiveDecorationType || typeof editor.setDecorations !== 'function') {
      return;
    }
    if (!isShaderDocument(editor.document)) {
      editor.setDecorations(this.inactiveDecorationType, []);
      return;
    }
    const active = new Set(this.getActiveKeywords(editor.document.uri));
    const inactiveRanges = evaluateInactivePreprocessorRanges(editor.document.getText(), active);
    const decorations = inactiveRanges.map((r) => {
      const endLineLen = editor.document.lineAt(Math.min(r.endLine, editor.document.lineCount - 1)).text.length;
      return new vscode.Range(r.startLine, 0, r.endLine, endLineLen);
    });
    editor.setDecorations(this.inactiveDecorationType, decorations);
  }

  public getStatusBarItem(): vscode.StatusBarItem {
    return this.statusBarItem;
  }

  public getActiveKeywords(uri?: vscode.Uri): string[] {
    if (!uri) return [];
    return [...(this.keywordsByUri.get(uri.toString()) ?? [])];
  }

  public async setActiveKeywords(uri: vscode.Uri | undefined, keywords: string[]): Promise<string[]> {
    const cleaned = Array.from(new Set(keywords.map((k) => k.trim()).filter(Boolean)));
    if (uri) {
      this.keywordsByUri.set(uri.toString(), cleaned);
    }
    this.updateForDocument(vscode.window.activeTextEditor?.document, cleaned);
    this.applyInactiveDecorations(vscode.window.activeTextEditor);
    if (this.onKeywordsChanged) {
      await this.onKeywordsChanged(uri, cleaned);
    }
    return cleaned;
  }

  public updateForDocument(doc: vscode.TextDocument | undefined, overrideKeywords?: string[]): void {
    if (!isShaderDocument(doc)) {
      this.statusBarItem.hide();
      return;
    }

    const active = overrideKeywords ?? this.getActiveKeywords(doc!.uri);
    const analysis = analyzeShaderVariants(doc!.getText());
    const label = active.length > 0 ? active.join(', ') : '(기본값)';
    this.statusBarItem.text = `$(symbol-keyword) [UnityBrain] 셰이더 키워드: ${label}`;
    this.statusBarItem.tooltip = `[UnityBrain] 전체 배리언트 ${analysis.totalVariants}개 | 사용 가능 키워드: ${
      analysis.allKeywords.length > 0 ? analysis.allKeywords.join(', ') : '없음'
    }`;
    this.statusBarItem.show();
  }

  private async switchKeywordsCommand(explicitKeywords?: string[]): Promise<string[]> {
    const doc = vscode.window.activeTextEditor?.document;
    const uri = doc?.uri;
    if (explicitKeywords) {
      return this.setActiveKeywords(uri, explicitKeywords);
    }

    const analysis = doc ? analyzeShaderVariants(doc.getText()) : { allKeywords: [], blocks: [], totalVariants: 0 };
    if (analysis.allKeywords.length === 0) {
      await vscode.window.showInformationMessage(
        '[UnityBrain] 현재 셰이더에서 multi_compile 또는 shader_feature 키워드를 찾지 못했습니다.',
      );
      return [];
    }

    const current = new Set(this.getActiveKeywords(uri));
    const items: vscode.QuickPickItem[] = analysis.allKeywords.map((kw) => ({
      label: kw,
      picked: current.has(kw),
      description: current.has(kw) ? '활성화됨' : undefined,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: '[UnityBrain] HLSL 전처리기 컨텍스트에 활성화할 셰이더 키워드를 선택하세요',
    });

    if (!picked) {
      return this.getActiveKeywords(uri);
    }

    const pickedArray = Array.isArray(picked) ? picked : [picked];
    const nextKeywords = pickedArray.map((item) => item.label);
    return this.setActiveKeywords(uri, nextKeywords);
  }

  public dispose(): void {
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }
}
