import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MarkupKind, type Hover, type Position } from 'vscode-languageserver';
import {
  extractMemberChainExpression,
  type IncludeDependencyGraph,
} from '../indexer/hlslIncludeGraph.ts';
import { ShaderDefinitionProvider } from './definitionProvider.ts';
import { detectShaderLabContext, SHADERLAB_HOVER_DOCS } from '../parser/shaderLabContext.ts';
import { UNITY_BUILTIN_MACROS } from '../parser/unityHlslMacroPrepass.ts';

export class ShaderHoverProvider {
  private readonly graph: IncludeDependencyGraph;
  private readonly definitionProvider: ShaderDefinitionProvider;
  private activeKeywords: Set<string> = new Set();

  constructor(graph: IncludeDependencyGraph) {
    this.graph = graph;
    this.definitionProvider = new ShaderDefinitionProvider(graph);
  }

  public setActiveKeywords(keywords: Iterable<string>): void {
    this.activeKeywords = new Set(keywords);
  }

  public getActiveKeywords(): ReadonlySet<string> {
    return this.activeKeywords;
  }

  public provideHover(
    documentUri: string,
    position: Position,
    documentText: string,
    projectRoot?: string,
  ): Hover | null {
    this.graph.setOpenDocumentContent(documentUri, documentText);
    const filePath = this.graph.normalizeFilePath(documentUri);
    const parsed = this.graph.getOrParseFile(filePath);
    if (!parsed) return null;

    const lines = documentText.split(/\r?\n/);
    const lineText = lines[position.line] ?? '';

    // 1. Include line hover
    const inc = parsed.includes.find((item) => item.line === position.line);
    if (inc) {
      const mapped = this.graph.getResolver().resolve(inc.rawPath, filePath);
      if (mapped.physicalPath) {
        return {
          contents: {
            kind: MarkupKind.Markdown,
            value: `**[UnityBrain] 셰이더 인클루드 경로**: \`${inc.rawPath}\`\n\n해석 방식(\`${mapped.resolvedVia}\`):\n\`${mapped.physicalPath}\``,
          },
        };
      }
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**[UnityBrain] 미해석 셰이더 인클루드**: \`${inc.rawPath}\``,
        },
      };
    }

    const span = this.definitionProvider.getWordSpanAt(lineText, position.character);
    if (!span) return null;
    const word = span.word;

    // 2. #if / #elif / #ifdef / #ifndef / #pragma keyword hover (works even when activeKeywords is empty)
    const lineCommentIdx = lineText.indexOf('//');
    const inLineComment = lineCommentIdx >= 0 && position.character >= lineCommentIdx;
    if (!inLineComment) {
      const preprocInfo = this.extractPreprocessorDirectiveKeywords(lines, position.line);
      if (preprocInfo) {
        if (preprocInfo.ignoredWords.has(word)) {
          return null;
        }
        if (preprocInfo.keywords.has(word)) {
          const enabled = this.activeKeywords.has(word);
          return {
            contents: {
              kind: MarkupKind.Markdown,
              value: `**[UnityBrain] 셰이더 키워드** \`${word}\`: 현재 컨텍스트에서 **${enabled ? 'ON (활성)' : 'OFF (비활성)'}** 상태입니다.`,
            },
          };
        }
      }
    }

    // 3. Chained member access hover (`a.b.c`, `_Buf[i].field`, `GetMainLight().direction`, `col.rgb`)
    const isMemberAccess = span.start > 0 && lineText[span.start - 1] === '.';
    if (isMemberAccess) {
      const chainExpr = extractMemberChainExpression(lineText.slice(0, span.end));
      if (chainExpr) {
        const resolved = this.graph.resolveExpressionChain(filePath, chainExpr, position.line);
        if (resolved.field && resolved.ownerType) {
          const declaredIn = this.formatVirtualLocation(resolved.field.uri, projectRoot);
          return {
            contents: {
              kind: MarkupKind.Markdown,
              value: `\`\`\`hlsl\n${resolved.field.signature ?? `${resolved.field.returnType ?? ''} ${resolved.field.name}`}\n\`\`\`\n\n**[UnityBrain]** 구조체 \`${resolved.ownerType}\`의 멤버\n\n선언 위치: \`${declaredIn}:${resolved.field.line + 1}\``,
            },
          };
        }
        if (!resolved.field && resolved.type && /^[xyzwrgba]{1,4}$/i.test(word)) {
          return {
            contents: {
              kind: MarkupKind.Markdown,
              value: `\`\`\`hlsl\n${resolved.type} .${word}\n\`\`\`\n\n[UnityBrain] 벡터 스위즐 (${resolved.type})`,
            },
          };
        }
      }
    }

    // 3-2. ShaderLab Properties & DSL keywords when outside HLSL/CG blocks
    const shaderLabCtx = detectShaderLabContext(documentText, position.line, position.character, filePath);
    if (!isMemberAccess && shaderLabCtx !== 'hlsl') {
      const slProp = parsed.symbols.find((s) => s.name === word && s.kind === 'property');
      if (slProp) {
        return this.buildSymbolHover(slProp, undefined, projectRoot);
      }
      const slDoc = SHADERLAB_HOVER_DOCS.get(word);
      if (slDoc) {
        return {
          contents: {
            kind: MarkupKind.Markdown,
            value: `**${slDoc.label}** — *${slDoc.detail}*\n\n${slDoc.documentation}`,
          },
        };
      }
    }

    // 3-3. Local variables & function parameters in enclosing scope
    if (!isMemberAccess) {
      const scope = parsed.localVarScopes.find(
        (sc) => position.line >= sc.startLine && position.line <= sc.endLine && sc.declarations.has(word),
      );
      const localDecl = scope?.declarations.get(word);
      if (localDecl && position.line >= localDecl.line) {
        const declaredIn = this.formatVirtualLocation(parsed.uri, projectRoot);
        const roleLabel = localDecl.kind === 'parameter' ? '함수 파라미터' : '로컬 변수';
        return {
          contents: {
            kind: MarkupKind.Markdown,
            value: `\`\`\`hlsl\n${localDecl.signature}\n\`\`\`\n\n**[UnityBrain]** ${roleLabel}\n\n선언 위치: \`${declaredIn}:${localDecl.line + 1}\``,
          },
        };
      }

      // 3-4. Direct struct field declaration on the cursor line
      const directFieldSym =
        parsed.symbols.find(
          (s) =>
            s.kind === 'field' &&
            s.name === word &&
            s.line === position.line &&
            position.character >= s.column &&
            position.character <= s.column + s.name.length,
        ) ??
        parsed.symbols.find(
          (s) => s.kind === 'field' && s.name === word && s.line === position.line,
        );
      if (directFieldSym) {
        return this.buildSymbolHover(directFieldSym, undefined, projectRoot);
      }
    }

    // 4. Visible symbols from Include graph (Pass-scoped + HLSL variable preferred over Property)
    const hits = this.graph.findSymbolsVisibleFrom(filePath, word, position.line);
    if (hits.length > 0) {
      const sym = hits[0];
      const propNote =
        sym.kind !== 'property'
          ? hits.find((h) => h.kind === 'property')
          : undefined;
      return this.buildSymbolHover(sym, propNote, projectRoot);
    }

    // 5. Built-in Unity macro table fallback
    const builtin = UNITY_BUILTIN_MACROS.find((m) => m.name === word);
    if (builtin) {
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `\`\`\`hlsl\n${builtin.signature}\n\`\`\`\n\n**[UnityBrain]** ${builtin.description} (*${builtin.pipeline}*)`,
        },
      };
    }

    return null;
  }

  private buildSymbolHover(
    sym: {
      name: string;
      kind: string;
      returnType?: string;
      signature?: string;
      documentation?: string;
      uri: string;
      line?: number;
      containerName?: string;
    },
    propNote: { name: string; signature?: string; documentation?: string } | undefined,
    projectRoot?: string,
  ): Hover {
    const declaredIn = this.formatVirtualLocation(sym.uri, projectRoot);
    const parts = [
      `\`\`\`hlsl\n${sym.signature ?? `${sym.returnType ?? ''} ${sym.name}`.trim()}\n\`\`\``,
    ];
    if (sym.documentation) {
      parts.push(sym.documentation);
    }
    if (sym.kind === 'field' && sym.containerName) {
      parts.push(`**[UnityBrain]** 구조체 \`${sym.containerName}\`의 멤버`);
    }
    if (propNote) {
      parts.push(`ShaderLab 프로퍼티: \`${propNote.signature ?? propNote.name}\``);
    }
    const colorPropText = propNote?.signature ?? (sym.kind === 'property' ? sym.signature : undefined);
    const colorDocText = propNote?.documentation ?? (sym.kind === 'property' ? sym.documentation : undefined);
    const isColorProp =
      (colorPropText && /,\s*Color\s*\)/.test(colorPropText)) || sym.returnType === 'Color';
    if (isColorProp && colorDocText) {
      const cm = /\(\s*([0-9]*\.?[0-9]+)\s*,\s*([0-9]*\.?[0-9]+)\s*,\s*([0-9]*\.?[0-9]+)\s*,\s*([0-9]*\.?[0-9]+)\s*\)/.exec(colorDocText);
      if (cm) {
        const toHex = (v: string) =>
          Math.max(0, Math.min(255, Math.round(Number.parseFloat(v) * 255)))
            .toString(16)
            .padStart(2, '0')
            .toUpperCase();
        const hex = `#${toHex(cm[1])}${toHex(cm[2])}${toHex(cm[3])}${toHex(cm[4])}`;
        parts.push(`색상 미리보기: \`rgba(${cm[1]}, ${cm[2]}, ${cm[3]}, ${cm[4]})\` · **\`${hex}\`**`);
      }
    }
    const locWithLine = sym.line !== undefined ? `${declaredIn}:${sym.line + 1}` : declaredIn;
    parts.push(`**[UnityBrain]** 선언 위치: \`${locWithLine}\``);
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: parts.join('\n\n'),
      },
    };
  }

  private extractPreprocessorDirectiveKeywords(
    lines: readonly string[],
    lineIdx: number,
  ): { keywords: Set<string>; ignoredWords: Set<string> } | null {
    let startLine = lineIdx;
    while (startLine > 0) {
      const prev = (lines[startLine - 1] ?? '').replace(/\/\/.*$/, '').trimEnd();
      if (!prev.endsWith('\\')) break;
      startLine--;
    }
    let endLine = lineIdx;
    while (endLine + 1 < lines.length) {
      const curr = (lines[endLine] ?? '').replace(/\/\/.*$/, '').trimEnd();
      if (!curr.endsWith('\\')) break;
      endLine++;
    }

    const parts: string[] = [];
    for (let i = startLine; i <= endLine; i++) {
      let part = (lines[i] ?? '').replace(/\/\/.*$/, '').trimEnd();
      if (part.endsWith('\\')) {
        part = part.slice(0, -1).trimEnd();
      }
      parts.push(part.trim());
    }
    const joined = parts.join(' ').trim();
    if (!joined.startsWith('#')) return null;

    const ignoredWords = new Set([
      'if',
      'elif',
      'ifdef',
      'ifndef',
      'else',
      'endif',
      'pragma',
      'defined',
      'true',
      'false',
    ]);
    const keywords = new Set<string>();

    const ifdefMatch = /^#\s*(?:ifdef|ifndef)\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(joined);
    if (ifdefMatch) {
      keywords.add(ifdefMatch[1]);
      return { keywords, ignoredWords };
    }

    const ifMatch = /^#\s*(?:if|elif)\b(.*)$/.exec(joined);
    if (ifMatch) {
      const expr = ifMatch[1].replace(/\/\*.*?\*\//g, ' ');
      const idents = expr.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
      for (const ident of idents) {
        if (!ignoredWords.has(ident)) {
          keywords.add(ident);
        }
      }
      return { keywords, ignoredWords };
    }

    const pragmaMatch =
      /^#\s*pragma\s+((?:multi_compile|shader_feature|dynamic_branch)(?:_[a-zA-Z0-9]+)*)\s+(.+)$/.exec(
        joined,
      );
    if (pragmaMatch) {
      ignoredWords.add(pragmaMatch[1]);
      const tokens = pragmaMatch[2].split(/\s+/).filter(Boolean);
      for (const tok of tokens) {
        if (!/^_+$/.test(tok) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(tok)) {
          keywords.add(tok);
        }
      }
      return { keywords, ignoredWords };
    }

    if (/^#\s*pragma\b/.test(joined)) {
      return { keywords, ignoredWords };
    }

    return null;
  }

  private formatVirtualLocation(targetUri: string, projectRoot?: string): string {
    let targetPath: string;
    try {
      targetPath = fileURLToPath(targetUri).replace(/\\/g, '/');
    } catch {
      return targetUri;
    }

    const pkgCacheMarker = '/Library/PackageCache/';
    const cacheIdx = targetPath.indexOf(pkgCacheMarker);
    if (cacheIdx !== -1) {
      const after = targetPath.slice(cacheIdx + pkgCacheMarker.length);
      const slash = after.indexOf('/');
      if (slash !== -1) {
        const pkgWithVer = after.slice(0, slash);
        const atIdx = pkgWithVer.indexOf('@');
        const pkgName = atIdx !== -1 ? pkgWithVer.slice(0, atIdx) : pkgWithVer;
        return `Packages/${pkgName}${after.slice(slash)}`;
      }
    }

    if (projectRoot) {
      const rel = path.relative(projectRoot, targetPath).replace(/\\/g, '/');
      if (!rel.startsWith('..')) {
        return rel;
      }
    }

    return targetPath;
  }
}
