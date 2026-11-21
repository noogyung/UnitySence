import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type { IncludeDependencyGraph } from '../../../shader-lsp/src/indexer/hlslIncludeGraph.ts';
import { isShaderFilePath } from '../../../shader-lsp/src/vfs/virtualPathResolver.ts';
import {
  analyzeShaderVariants,
  type DocResolveIncludeTextFn,
} from './shaderKeywordContextStatusBar.ts';

export interface ShaderExplorerNode {
  readonly kind: 'file' | 'section' | 'item' | 'warning';
  readonly label: string;
  readonly description?: string;
  readonly filePath: string;
  readonly line?: number;
  readonly children?: ShaderExplorerNode[];
}

export interface ShaderExplorerOptions {
  resolveIncludeText?: DocResolveIncludeTextFn;
}

export class ShaderExplorerProvider
  implements vscode.TreeDataProvider<ShaderExplorerNode>, vscode.Disposable
{
  private readonly onDidChangeEmitter = new vscode.EventEmitter<ShaderExplorerNode | undefined | void>();
  public readonly onDidChangeTreeData = this.onDidChangeEmitter.event;
  private readonly resolveIncludeText?: DocResolveIncludeTextFn;

  constructor(
    private readonly getProjectRoot: () => string,
    private readonly shaderGraph: IncludeDependencyGraph,
    options?: ShaderExplorerOptions,
  ) {
    this.resolveIncludeText = options?.resolveIncludeText;
  }

  public refresh(): void {
    this.onDidChangeEmitter.fire();
  }

  public dispose(): void {
    this.onDidChangeEmitter.dispose();
  }

  public getTreeItem(element: ShaderExplorerNode): vscode.TreeItem {
    const collapsible =
      element.children && element.children.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(element.label, collapsible);
    item.description = element.description;
    if (element.kind === 'file') {
      item.iconPath = new vscode.ThemeIcon('file-code');
      item.command = {
        command: 'vscode.open',
        title: '셰이더 열기',
        arguments: [vscode.Uri.file(element.filePath)],
      };
    } else if (element.kind === 'section') {
      item.iconPath = new vscode.ThemeIcon('symbol-namespace');
    } else if (element.kind === 'warning') {
      item.iconPath = new vscode.ThemeIcon('warning');
      if (element.line !== undefined) {
        const pos = new vscode.Position(element.line, 0);
        item.command = {
          command: 'vscode.open',
          title: '위치로 이동',
          arguments: [vscode.Uri.file(element.filePath), { selection: new vscode.Range(pos, pos) }],
        };
      }
    } else {
      item.iconPath = new vscode.ThemeIcon('symbol-property');
      if (element.line !== undefined) {
        const pos = new vscode.Position(element.line, 0);
        item.command = {
          command: 'vscode.open',
          title: '위치로 이동',
          arguments: [vscode.Uri.file(element.filePath), { selection: new vscode.Range(pos, pos) }],
        };
      }
    }
    return item;
  }

  public getChildren(element?: ShaderExplorerNode): ShaderExplorerNode[] {
    if (element) {
      return element.children ?? [];
    }
    return this.buildRootNodes();
  }

  public buildRootNodes(): ShaderExplorerNode[] {
    const root = this.getProjectRoot();
    const scanRoots = [path.join(root, 'Assets'), path.join(root, 'Packages')];
    const files: string[] = [];
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && isShaderFilePath(entry.name)) {
          files.push(full);
        }
      }
    };
    for (const scanRoot of scanRoots) {
      walk(scanRoot);
    }
    files.sort((a, b) => a.localeCompare(b));

    return files.map((filePath) => {
      const rel = path.relative(root, filePath).replace(/\\/g, '/');
      let parsed: ReturnType<IncludeDependencyGraph['getOrParseFile']> = null;
      try {
        parsed = this.shaderGraph.getOrParseFile(filePath);
      } catch {
        parsed = null;
      }
      const children: ShaderExplorerNode[] = [];
      let variantDesc = '';

      if (/\.(shader|compute|urtshader)$/i.test(filePath) && fs.existsSync(filePath)) {
        try {
          const text = fs.readFileSync(filePath, 'utf8');
          const fileUri = vscode.Uri.file(filePath);
          const analysis = analyzeShaderVariants(
            text,
            this.resolveIncludeText
              ? { resolveIncludeText: (inc, fromUri) => this.resolveIncludeText!(fileUri, inc, fromUri) }
              : undefined,
          );
          if (analysis.totalVariants > 1) {
            variantDesc = `${analysis.totalVariants} variants`;
          }
          if (analysis.totalVariants > 128) {
            children.push({
              kind: 'warning',
              label: `배리언트 과다 주의 (${analysis.totalVariants}개 > 128)`,
              description: 'shader_feature_local 검토 권장',
              filePath,
              line: analysis.blocks[0]?.anchorLine ?? 0,
            });
          }
        } catch {
          // Ignore unreadable shader file
        }
      }

      if (parsed) {
        if (parsed.properties.length > 0) {
          children.push({
            kind: 'section',
            label: `Properties (${parsed.properties.length})`,
            filePath,
            children: parsed.properties.map((p) => ({
              kind: 'item',
              label: p.name,
              description: `${p.type} · ${p.displayName}`,
              filePath,
              line: p.line ?? 0,
            })),
          });
        }
        const programBlocks = (parsed.blocks ?? []).filter(
          (b) => b.kind === 'HLSLPROGRAM' || b.kind === 'CGPROGRAM',
        );
        if (programBlocks.length > 0) {
          children.push({
            kind: 'section',
            label: `Passes (${programBlocks.length})`,
            filePath,
            children: programBlocks.map((b, idx) => ({
              kind: 'item',
              label: `Pass #${idx + 1} (${b.kind})`,
              description: `Line ${b.startLine + 1}`,
              filePath,
              line: b.startLine,
            })),
          });
        }
        if (parsed.pragmas.keywordGroups.length > 0) {
          children.push({
            kind: 'section',
            label: `Keywords (${parsed.pragmas.keywordGroups.length})`,
            filePath,
            children: parsed.pragmas.keywordGroups.map((g) => ({
              kind: 'item',
              label: `#pragma ${g.directive}`,
              description: g.keywords.join(' '),
              filePath,
              line: g.line,
            })),
          });
        }
        const fns = parsed.symbols.filter((s) => s.kind === 'function');
        if (fns.length > 0) {
          children.push({
            kind: 'section',
            label: `Functions (${fns.length})`,
            filePath,
            children: fns.map((f) => ({
              kind: 'item',
              label: f.name,
              description: f.returnType ?? 'function',
              filePath,
              line: f.line,
            })),
          });
        }
      }

      return {
        kind: 'file',
        label: parsed?.shaderName ? `${path.basename(filePath)} (${parsed.shaderName})` : path.basename(filePath),
        description: variantDesc ? `${rel} · ${variantDesc}` : rel,
        filePath,
        children,
      };
    });
  }
}
