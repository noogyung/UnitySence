import fs from 'node:fs';
import type { Location, Position } from 'vscode-languageserver';
import {
  extractMemberChainExpression,
  IncludeDependencyGraph,
} from '../indexer/hlslIncludeGraph.ts';

export class ShaderDefinitionProvider {
  private readonly graph: IncludeDependencyGraph;

  constructor(graph: IncludeDependencyGraph) {
    this.graph = graph;
  }

  public provideDefinition(
    documentUri: string,
    position: Position,
    documentText?: string,
  ): Location[] {
    if (documentText !== undefined) {
      this.graph.setOpenDocumentContent(documentUri, documentText);
    }

    const filePath = this.graph.normalizeFilePath(documentUri);
    const parsed = this.graph.getOrParseFile(filePath);
    if (!parsed) return [];

    const text =
      documentText ??
      (fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : parsed.virtualHlsl);
    const lines = text.split(/\r?\n/);
    const lineText = lines[position.line] ?? '';

    // Case A: #include "..." or #include <...>
    const inc = parsed.includes.find((item) => item.line === position.line);
    if (inc) {
      const resolved = this.graph.getResolver().resolve(inc.rawPath, filePath);
      if (resolved.physicalPath) {
        return [
          {
            uri: this.graph.toUri(resolved.physicalPath),
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 0 },
            },
          },
        ];
      }
      return [];
    }

    // Case B: #pragma vertex/fragment/kernel/hull/domain <fnName>
    const pragmaEntry = parsed.pragmas.entryPoints.find(
      (ep) =>
        ep.line === position.line &&
        position.character >= ep.column &&
        position.character <= ep.column + ep.name.length,
    );
    if (pragmaEntry) {
      const hits = this.graph.findSymbolsVisibleFrom(filePath, pragmaEntry.name, position.line);
      return hits.map((s) => ({
        uri: s.uri,
        range: {
          start: { line: s.line, character: s.column },
          end: { line: s.line, character: s.column + s.name.length },
        },
      }));
    }

    const wordSpan = this.getWordSpanAt(lineText, position.character);
    if (!wordSpan) return [];
    const word = wordSpan.word;

    // Case C: Chained member access (e.g. data.normalWS, a.b.c, _Lights[i].color, GetMainLight().direction)
    const isMemberAccess = wordSpan.start > 0 && lineText[wordSpan.start - 1] === '.';
    if (isMemberAccess) {
      const chainExpr = extractMemberChainExpression(lineText.slice(0, wordSpan.end));
      if (chainExpr) {
        const resolved = this.graph.resolveExpressionChain(filePath, chainExpr, position.line);
        if (resolved.field) {
          return [
            {
              uri: resolved.field.uri,
              range: {
                start: { line: resolved.field.line, character: resolved.field.column },
                end: {
                  line: resolved.field.line,
                  character: resolved.field.column + resolved.field.name.length,
                },
              },
            },
          ];
        }
        if (resolved.type && resolved.rootSymbol) {
          return [
            {
              uri: resolved.rootSymbol.uri,
              range: {
                start: { line: resolved.rootSymbol.line, character: resolved.rootSymbol.column },
                end: {
                  line: resolved.rootSymbol.line,
                  character: resolved.rootSymbol.column + resolved.rootSymbol.name.length,
                },
              },
            },
          ];
        }
      }
    }

    // Case C-2: Function parameters & local variables in enclosing scope
    if (!isMemberAccess) {
      const scope = parsed.localVarScopes.find(
        (sc) => position.line >= sc.startLine && position.line <= sc.endLine && sc.declarations.has(word),
      );
      const localDecl = scope?.declarations.get(word);
      if (localDecl && position.line >= localDecl.line) {
        return [
          {
            uri: parsed.uri,
            range: {
              start: { line: localDecl.line, character: localDecl.column },
              end: { line: localDecl.line, character: localDecl.column + word.length },
            },
          },
        ];
      }
    }

    // Case D: General symbol lookup (Pass-scoped + HLSL CBUFFER/variable prioritized over ShaderLab Properties)
    const symbols = this.graph.findSymbolsVisibleFrom(filePath, word, position.line);
    if (symbols.length === 0) return [];

    // Sort definitions nicely: functions/structs/macros/properties first
    return symbols.map((sym) => ({
      uri: sym.uri,
      range: {
        start: { line: sym.line, character: sym.column },
        end: { line: sym.line, character: sym.column + sym.name.length },
      },
    }));
  }

  public getWordSpanAt(
    lineText: string,
    character: number,
  ): { word: string; start: number; end: number } | null {
    const isWordChar = (ch: string | undefined): boolean =>
      Boolean(ch && /[A-Za-z0-9_]/.test(ch));

    let idx = character;
    if (!isWordChar(lineText[idx]) && idx > 0 && isWordChar(lineText[idx - 1])) {
      idx--;
    }
    if (!isWordChar(lineText[idx])) {
      return null;
    }

    let start = idx;
    while (start > 0 && isWordChar(lineText[start - 1])) {
      start--;
    }
    let end = idx + 1;
    while (end < lineText.length && isWordChar(lineText[end])) {
      end++;
    }
    return {
      word: lineText.slice(start, end),
      start,
      end,
    };
  }
}
