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
      const warning = blk.variantCount > 128 ? ' (High Variant Count!)' : '';
      const noun = blk.variantCount === 1 ? 'Shader Variant' : 'Shader Variants';
      return new vscode.CodeLens(new vscode.Range(blk.anchorLine, 0, blk.anchorLine, 0), {
        title: `$(layers) ${blk.variantCount} ${noun}${warning}`,
        command: 'unityBrain.switchShaderKeywords',
        tooltip: 'Click to switch active shader preprocessor keywords',
      });
    });
  }

  public dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}

export interface ShaderKeywordStatusBarOptions {
  onKeywordsChanged?: (uri: vscode.Uri | undefined, keywords: string[]) => void | Promise<void>;
}

export class ShaderKeywordContextStatusBar implements vscode.Disposable {
  private readonly statusBarItem: vscode.StatusBarItem;
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

    this.disposables.push(
      this.statusBarItem,
      vscode.commands.registerCommand('unityBrain.switchShaderKeywords', (explicitKeywords?: unknown) =>
        this.switchKeywordsCommand(Array.isArray(explicitKeywords) ? (explicitKeywords as string[]) : undefined),
      ),
      vscode.window.onDidChangeActiveTextEditor((editor) => this.updateForDocument(editor?.document)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (vscode.window.activeTextEditor?.document.uri.toString() === e.document.uri.toString()) {
          this.updateForDocument(e.document);
        }
      }),
    );

    this.updateForDocument(vscode.window.activeTextEditor?.document);
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
    const label = active.length > 0 ? active.join(', ') : '(default)';
    this.statusBarItem.text = `$(symbol-keyword) Shader Keywords: ${label}`;
    this.statusBarItem.tooltip = `${analysis.totalVariants} total variants | Available: ${
      analysis.allKeywords.length > 0 ? analysis.allKeywords.join(', ') : 'none'
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
      await vscode.window.showInformationMessage('No multi_compile or shader_feature keywords found in active shader.');
      return [];
    }

    const current = new Set(this.getActiveKeywords(uri));
    const items: vscode.QuickPickItem[] = analysis.allKeywords.map((kw) => ({
      label: kw,
      picked: current.has(kw),
      description: current.has(kw) ? 'Active' : undefined,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: 'Select active Shader keywords for HLSL preprocessor context',
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
