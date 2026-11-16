import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MarkupKind, type Hover, type Position } from 'vscode-languageserver';
import type { IncludeDependencyGraph } from '../indexer/hlslIncludeGraph.ts';
import { ShaderDefinitionProvider } from './definitionProvider.ts';
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

    // 2. #ifdef / #if defined(...) keyword hover
    const kwMatch = /^\s*#\s*ifdef\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(lineText);
    if (kwMatch && this.activeKeywords.size > 0) {
      const kw = kwMatch[1];
      const enabled = this.activeKeywords.has(kw);
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**[UnityBrain] 셰이더 키워드** \`${kw}\`: 현재 컨텍스트에서 **${enabled ? '활성(ACTIVE)' : '비활성(INACTIVE)'}** 상태입니다.`,
        },
      };
    }

    const span = this.definitionProvider.getWordSpanAt(lineText, position.character);
    if (!span) return null;
    const word = span.word;

    // 3. Member access hover (`varName.fieldName`)
    if (span.start > 0 && lineText[span.start - 1] === '.') {
      const baseMatch = /([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*$/.exec(lineText.slice(0, span.start));
      if (baseMatch) {
        const varType = this.graph.inferVariableType(filePath, baseMatch[1], position.line);
        if (varType) {
          const cleanType = varType.replace(/<.*>$/, '').trim();
          const fields = this.graph.findStructFields(filePath, cleanType);
          const field = fields.find((f) => f.name === word);
          if (field) {
            const declaredIn = this.formatVirtualLocation(field.uri, projectRoot);
            return {
              contents: {
                kind: MarkupKind.Markdown,
                value: `\`\`\`hlsl\n${field.signature ?? `${field.returnType ?? ''} ${field.name}`}\n\`\`\`\n\n**[UnityBrain]** 구조체 \`${cleanType}\`의 멤버\n\n선언 위치: \`${declaredIn}\``,
              },
            };
          }
        }
      }
    }

    // 3-2. Local variables & function parameters in enclosing scope
    if (!(span.start > 0 && lineText[span.start - 1] === '.')) {
      const scope = parsed.localVarScopes.find(
        (sc) => position.line >= sc.startLine && position.line <= sc.endLine && sc.declarations.has(word),
      );
      const localDecl = scope?.declarations.get(word);
      if (localDecl) {
        const declaredIn = this.formatVirtualLocation(parsed.uri, projectRoot);
        const roleLabel = localDecl.kind === 'parameter' ? '함수 파라미터' : '로컬 변수';
        return {
          contents: {
            kind: MarkupKind.Markdown,
            value: `\`\`\`hlsl\n${localDecl.signature}\n\`\`\`\n\n**[UnityBrain]** ${roleLabel}\n\n선언 위치: \`${declaredIn}:${localDecl.line + 1}\``,
          },
        };
      }
    }

    // 4. Visible symbols from Include graph
    const hits = this.graph.findSymbolsVisibleFrom(filePath, word);
    if (hits.length > 0) {
      const sym = hits[0];
      const declaredIn = this.formatVirtualLocation(sym.uri, projectRoot);
      const parts = [
        `\`\`\`hlsl\n${sym.signature ?? `${sym.returnType ?? ''} ${sym.name}`.trim()}\n\`\`\``,
      ];
      if (sym.documentation) {
        parts.push(sym.documentation);
      }
      parts.push(`**[UnityBrain]** 선언 위치: \`${declaredIn}\``);
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: parts.join('\n\n'),
        },
      };
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
