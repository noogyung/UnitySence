import fs from 'node:fs';
import type { Location, Position } from 'vscode-languageserver';
import { IncludeDependencyGraph } from '../indexer/hlslIncludeGraph.ts';

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
    if (inc && position.character >= inc.column) {
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
      const hits = this.graph.findSymbolsVisibleFrom(filePath, pragmaEntry.name);
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

    // Case C: Member access (e.g. data.normalWS, input.positionOS.xyz)
    if (wordSpan.start > 0 && lineText[wordSpan.start - 1] === '.') {
      const baseIdentMatch = /([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*$/.exec(
        lineText.slice(0, wordSpan.start),
      );
      if (baseIdentMatch) {
        const baseName = baseIdentMatch[1];
        const varType = this.graph.inferVariableType(filePath, baseName, position.line);
        if (varType) {
          const cleanType = varType.replace(/<.*>$/, '').trim();
          const fields = this.graph.findStructFields(filePath, cleanType);
          const matchedField = fields.find((f) => f.name === word);
          if (matchedField) {
            return [
              {
                uri: matchedField.uri,
                range: {
                  start: { line: matchedField.line, character: matchedField.column },
                  end: { line: matchedField.line, character: matchedField.column + matchedField.name.length },
                },
              },
            ];
          }
        }
      }
    }

    // Case D: General symbol lookup (functions, structs, macros, variables, ShaderLab Properties)
    const symbols = this.graph.findSymbolsVisibleFrom(filePath, word);
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
