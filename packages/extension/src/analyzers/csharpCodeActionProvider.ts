import * as vscode from 'vscode';
import {
  findEnclosingClassContext,
  maskCSharpCommentsAndStrings,
} from '../completion/unityEventGenerator.ts';

const PERF_CRITICAL_METHOD_NAMES = new Set([
  'Update',
  'FixedUpdate',
  'LateUpdate',
  'OnGUI',
  'OnAnimatorIK',
]);

type MethodBodyStart =
  | { kind: 'block'; openLine: number; openCol: number; sameLineCloseCol?: number }
  | { kind: 'expression'; arrowLine: number; arrowCol: number; semiLine: number; semiCol: number };

function toPascalIdentifier(raw: string, suffix: string): string {
  const cleaned = raw.replace(/^_+/, '').replace(/[^A-Za-z0-9]/g, '');
  if (!cleaned) return `Cached${suffix}`;
  const pascal = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  const safe = /^\d/.test(pascal) ? `_${pascal}` : pascal;
  return `${safe}${suffix}`;
}

function sliceLineRange(
  lines: string[],
  startLine: number,
  startCol: number,
  endLine: number,
  endCol: number,
): string {
  if (startLine === endLine) {
    return (lines[startLine] ?? '').slice(startCol, endCol);
  }
  const parts: string[] = [(lines[startLine] ?? '').slice(startCol)];
  for (let l = startLine + 1; l < endLine; l++) {
    parts.push(lines[l] ?? '');
  }
  parts.push((lines[endLine] ?? '').slice(0, endCol));
  return parts.join('\n');
}

export class UnityCSharpCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
    vscode.CodeActionKind.Refactor,
    vscode.CodeActionKind.Source,
  ];

  public provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context?: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    if (document.languageId !== 'csharp') return [];
    const actions: vscode.CodeAction[] = [];
    const text = document.getText();
    const lines = text.split(/\r?\n/);
    const maskedText = maskCSharpCommentsAndStrings(text);
    const maskedLines = maskedText.split(/\r?\n/);
    const targetLineIdx = range.start.line;
    const lineText = lines[targetLineIdx] ?? '';
    const maskedLine = maskedLines[targetLineIdx] ?? '';
    const offset = document.offsetAt(range.start);
    const classCtx = findEnclosingClassContext(text, offset);

    if (classCtx) {
      const cacheAction = this.tryBuildCacheComponentAction(
        document,
        lines,
        maskedLines,
        maskedText,
        targetLineIdx,
        maskedLine,
        classCtx,
      );
      if (cacheAction) actions.push(cacheAction);

      const cameraMainAction = this.tryBuildCacheCameraMainAction(
        document,
        lines,
        maskedLines,
        maskedText,
        targetLineIdx,
        maskedLine,
        classCtx,
        context,
      );
      if (cameraMainAction) actions.push(cameraMainAction);

      const hashAction = this.tryBuildExtractHashAction(
        document,
        maskedLines,
        maskedText,
        targetLineIdx,
        lineText,
        maskedLine,
        classCtx,
      );
      if (hashAction) actions.push(hashAction);

      const fsaAction = this.tryBuildFormerlySerializedAsAction(document, lines, targetLineIdx, lineText);
      if (fsaAction) actions.push(fsaAction);

      const genEventAction = new vscode.CodeAction(
        '[UnityBrain] 유니티 이벤트 함수 생성...',
        vscode.CodeActionKind.Source,
      );
      genEventAction.command = {
        title: '[UnityBrain] 유니티 이벤트 함수 생성',
        command: 'unityBrain.generateEventFunctions',
      };
      actions.push(genEventAction);
    }

    return actions;
  }

  private tryBuildCacheComponentAction(
    document: vscode.TextDocument,
    lines: string[],
    maskedLines: string[],
    maskedText: string,
    lineIdx: number,
    maskedLine: string,
    classCtx: NonNullable<ReturnType<typeof findEnclosingClassContext>>,
  ): vscode.CodeAction | null {
    // Only offer inside performance-critical lifecycle methods and on this/gameObject/transform/implicit receiver
    const enclosingMethod = this.findEnclosingMethodName(maskedLines, lineIdx);
    if (!enclosingMethod || !PERF_CRITICAL_METHOD_NAMES.has(enclosingMethod)) {
      return null;
    }

    const gcMatch =
      /\b(?:(?:this\s*\.\s*)?(?:gameObject|transform)\s*\.\s*|this\s*\.\s*)?(GetComponent(?:InChildren|InParent)?)\s*<\s*([A-Za-z_][A-Za-z0-9_.]*)\s*>\s*\(\s*\)/.exec(
        maskedLine,
      );
    if (!gcMatch) return null;

    // Skip external receivers like `other.GetComponent<T>()` or `other.gameObject.GetComponent<T>()`
    const beforeCall = maskedLine.slice(0, gcMatch.index);
    if (/\.\s*$/.test(beforeCall)) return null;

    const callMethod = gcMatch[1];
    const typeName = gcMatch[2];
    const shortType = typeName.includes('.') ? typeName.slice(typeName.lastIndexOf('.') + 1) : typeName;
    const fieldName = `_cached${shortType}`;

    const edit = this.buildCacheInAwakeEdit(document, lines, maskedLines, maskedText, lineIdx, classCtx, {
      replacements: [{ start: gcMatch.index, end: gcMatch.index + gcMatch[0].length }],
      fieldType: typeName,
      fieldName,
      initExpression: `${callMethod}<${typeName}>()`,
    });

    const action = new vscode.CodeAction(
      `[UnityBrain] Awake()에 '${shortType}' 컴포넌트 캐싱 (${fieldName})`,
      vscode.CodeActionKind.QuickFix,
    );
    action.edit = edit;
    action.isPreferred = true;
    return action;
  }

  private tryBuildCacheCameraMainAction(
    document: vscode.TextDocument,
    lines: string[],
    maskedLines: string[],
    maskedText: string,
    lineIdx: number,
    maskedLine: string,
    classCtx: NonNullable<ReturnType<typeof findEnclosingClassContext>>,
    context?: vscode.CodeActionContext,
  ): vscode.CodeAction | null {
    const enclosingMethod = this.findEnclosingMethodName(maskedLines, lineIdx);
    if (enclosingMethod === 'Awake') {
      return null;
    }
    const isPerfCriticalMethod = Boolean(enclosingMethod && PERF_CRITICAL_METHOD_NAMES.has(enclosingMethod));
    const hasUb1001Diag = this.hasDiagnosticCodeOnLine(context, lineIdx, 'UB1001');
    if (!isPerfCriticalMethod && !hasUb1001Diag) {
      return null;
    }

    const camRegex = /(?<![A-Za-z0-9_.])(?:UnityEngine\s*\.\s*)?Camera\s*\.\s*main\b/g;
    const matches: Array<{ start: number; end: number; text: string }> = [];
    let camMatch: RegExpExecArray | null;
    while ((camMatch = camRegex.exec(maskedLine)) !== null) {
      matches.push({
        start: camMatch.index,
        end: camMatch.index + camMatch[0].length,
        text: camMatch[0],
      });
    }
    if (matches.length === 0) return null;

    const firstMatch = matches[0];
    const fieldType =
      firstMatch.text.startsWith('UnityEngine') && !/\busing\s+UnityEngine\s*;/.test(maskedText)
        ? 'UnityEngine.Camera'
        : 'Camera';
    const fieldName = '_cachedMainCamera';
    const initExpression = firstMatch.text.replace(/\s+/g, '');

    const edit = this.buildCacheInAwakeEdit(document, lines, maskedLines, maskedText, lineIdx, classCtx, {
      replacements: matches.map(({ start, end }) => ({ start, end })),
      fieldType,
      fieldName,
      initExpression,
    });

    const action = new vscode.CodeAction(
      `[UnityBrain] Awake()에 'Camera.main' 캐싱 (${fieldName})`,
      vscode.CodeActionKind.QuickFix,
    );
    action.edit = edit;
    action.isPreferred = true;
    return action;
  }

  private hasDiagnosticCodeOnLine(
    context: vscode.CodeActionContext | undefined,
    lineIdx: number,
    targetCode: string,
  ): boolean {
    if (!context?.diagnostics) return false;
    return context.diagnostics.some((diag) => {
      if (diag.range.start.line > lineIdx || diag.range.end.line < lineIdx) {
        return false;
      }
      const rawCode =
        typeof diag.code === 'object' && diag.code !== null
          ? String(diag.code.value)
          : diag.code !== undefined
            ? String(diag.code)
            : '';
      return rawCode.includes(targetCode);
    });
  }

  private hasClassMemberFieldDeclaration(maskedClassBody: string, fieldName: string): boolean {
    const topLevelChunks: string[] = [];
    let depth = 0;
    for (let i = 0; i < maskedClassBody.length; i++) {
      const ch = maskedClassBody[i];
      if (ch === '{') {
        if (depth === 0) {
          topLevelChunks.push(';');
        }
        depth++;
      } else if (ch === '}') {
        depth = Math.max(0, depth - 1);
      } else if (depth === 0) {
        topLevelChunks.push(ch);
      }
    }
    const topLevelOnly = topLevelChunks.join('');
    const escapedField = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const memberFieldRegex = new RegExp(
      `(?:^|[;\\n{}])\\s*(?:\\[[^\\]]*\\]\\s*)*(?:(?:private|public|protected|internal|static|readonly|volatile|new)\\s+)*[A-Za-z_][A-Za-z0-9_.<>?\\[\\],\\s]*\\b${escapedField}\\s*[;=]`,
    );
    return memberFieldRegex.test(topLevelOnly);
  }

  private buildCacheInAwakeEdit(
    document: vscode.TextDocument,
    lines: string[],
    maskedLines: string[],
    maskedText: string,
    lineIdx: number,
    classCtx: NonNullable<ReturnType<typeof findEnclosingClassContext>>,
    opts: {
      replacements: Array<{ start: number; end: number }>;
      fieldType: string;
      fieldName: string;
      initExpression: string;
    },
  ): vscode.WorkspaceEdit {
    const { replacements, fieldType, fieldName, initExpression } = opts;
    const classStartPos = document.positionAt(classCtx.classOpenBraceOffset);
    const classEndPos = document.positionAt(classCtx.classCloseBraceOffset);
    const classStartLine = classStartPos.line;
    const indent = '    ';
    const edit = new vscode.WorkspaceEdit();

    const maskedClassBody = maskedText.slice(classCtx.classOpenBraceOffset + 1, classCtx.classCloseBraceOffset);
    if (!this.hasClassMemberFieldDeclaration(maskedClassBody, fieldName)) {
      edit.insert(
        document.uri,
        new vscode.Position(classStartLine + 1, 0),
        `${indent}private ${fieldType} ${fieldName};\n`,
      );
    }

    const awakeBody = this.findMethodBodyStart(lines, maskedLines, classStartLine, classEndPos, 'Awake');
    if (awakeBody !== null) {
      const awakeBodyText = this.extractMethodBodyText(lines, maskedLines, awakeBody, classEndPos);
      const alreadyAssigned = new RegExp(`\\b${fieldName}\\s*=`).test(awakeBodyText);
      if (!alreadyAssigned) {
        if (awakeBody.kind === 'expression') {
          const rawExpr = sliceLineRange(
            lines,
            awakeBody.arrowLine,
            awakeBody.arrowCol + 2,
            awakeBody.semiLine,
            awakeBody.semiCol,
          ).trim();
          const methodIndent = /^(\s*)/.exec(lines[awakeBody.arrowLine] ?? '')?.[1] ?? indent;
          const exprBlock = rawExpr
            ? `{\n${methodIndent}${indent}${fieldName} = ${initExpression};\n${methodIndent}${indent}${rawExpr};\n${methodIndent}}`
            : `{\n${methodIndent}${indent}${fieldName} = ${initExpression};\n${methodIndent}}`;
          edit.replace(
            document.uri,
            new vscode.Range(awakeBody.arrowLine, awakeBody.arrowCol, awakeBody.semiLine, awakeBody.semiCol + 1),
            exprBlock,
          );
        } else if (awakeBody.sameLineCloseCol !== undefined) {
          const lineStr = lines[awakeBody.openLine] ?? '';
          const inner = lineStr.slice(awakeBody.openCol + 1, awakeBody.sameLineCloseCol).trim();
          const methodIndent = /^(\s*)/.exec(lineStr)?.[1] ?? indent;
          const innerLines = inner
            ? `\n${methodIndent}${indent}${fieldName} = ${initExpression};\n${methodIndent}${indent}${inner}\n${methodIndent}`
            : `\n${methodIndent}${indent}${fieldName} = ${initExpression};\n${methodIndent}`;
          edit.replace(
            document.uri,
            new vscode.Range(awakeBody.openLine, awakeBody.openCol + 1, awakeBody.openLine, awakeBody.sameLineCloseCol),
            innerLines,
          );
        } else {
          edit.insert(
            document.uri,
            new vscode.Position(awakeBody.openLine + 1, 0),
            `${indent}${indent}${fieldName} = ${initExpression};\n`,
          );
        }
      }
    } else {
      edit.insert(
        document.uri,
        new vscode.Position(classStartLine + 1, 0),
        `\n${indent}private void Awake()\n${indent}{\n${indent}${indent}${fieldName} = ${initExpression};\n${indent}}\n`,
      );
    }

    for (const rep of replacements) {
      edit.replace(
        document.uri,
        new vscode.Range(lineIdx, rep.start, lineIdx, rep.end),
        fieldName,
      );
    }

    return edit;
  }

  private extractMethodBodyText(
    lines: string[],
    maskedLines: string[],
    bodyStart: MethodBodyStart,
    endPos: vscode.Position,
  ): string {
    void lines;
    if (bodyStart.kind === 'expression') {
      return sliceLineRange(
        maskedLines,
        bodyStart.arrowLine,
        bodyStart.arrowCol + 2,
        bodyStart.semiLine,
        bodyStart.semiCol,
      );
    }

    if (bodyStart.sameLineCloseCol !== undefined) {
      const lineStr = maskedLines[bodyStart.openLine] ?? '';
      return lineStr.slice(bodyStart.openCol + 1, bodyStart.sameLineCloseCol);
    }

    const chunks: string[] = [];
    let depth = 1;
    const maxLine = Math.min(endPos.line, maskedLines.length - 1);
    for (let i = bodyStart.openLine; i <= maxLine; i++) {
      const rawLine = i === endPos.line ? (maskedLines[i] ?? '').slice(0, endPos.character) : (maskedLines[i] ?? '');
      const startCol = i === bodyStart.openLine ? bodyStart.openCol + 1 : 0;
      let endCol = rawLine.length;

      for (let c = startCol; c < rawLine.length; c++) {
        const ch = rawLine[c];
        if (ch === '{') {
          depth++;
        } else if (ch === '}') {
          depth--;
          if (depth === 0) {
            endCol = c;
            break;
          }
        }
      }

      chunks.push(rawLine.slice(startCol, endCol));
      if (depth === 0) break;
    }
    return chunks.join('\n');
  }

  private findCallWithStringArg(
    maskedLine: string,
    lineText: string,
    prefixRegex: RegExp,
    requireClosingParen: boolean,
  ): {
    callee: string;
    replaceStart: number;
    replaceEnd: number;
    keyName: string;
    rawLiteral: string;
  } | null {
    let m: RegExpExecArray | null;
    while ((m = prefixRegex.exec(maskedLine)) !== null) {
      const parenEnd = m.index + m[0].length;
      const wsMatch = /^\s*/.exec(lineText.slice(parenEnd));
      const argStart = parenEnd + (wsMatch ? wsMatch[0].length : 0);
      const strMatch = /^"((?:[^"\\]|\\.)+)"/.exec(lineText.slice(argStart));
      if (!strMatch) continue;

      const rawLiteral = strMatch[0];
      const keyName = rawLiteral.slice(1, -1);
      const afterLiteral = maskedLine.slice(argStart + rawLiteral.length);
      if (requireClosingParen) {
        const closeMatch = /^\s*\)/.exec(afterLiteral);
        if (!closeMatch) continue;
        return {
          callee: m[1] ?? '',
          replaceStart: m.index,
          replaceEnd: argStart + rawLiteral.length + closeMatch[0].length,
          keyName,
          rawLiteral,
        };
      }

      return {
        callee: m[1] ?? '',
        replaceStart: argStart,
        replaceEnd: argStart + rawLiteral.length,
        keyName,
        rawLiteral,
      };
    }
    return null;
  }

  private isStaticReadonlyOrConstInitializerLine(maskedLines: string[], lineIdx: number): boolean {
    const currentMasked = maskedLines[lineIdx] ?? '';
    if (
      /\bstatic\s+readonly\b/.test(currentMasked) ||
      /\breadonly\s+static\b/.test(currentMasked) ||
      /\bconst\b/.test(currentMasked)
    ) {
      return true;
    }

    let prevDeclText = '';
    let checked = 0;
    for (let p = lineIdx - 1; p >= 0 && checked < 2; p--) {
      const prevMasked = (maskedLines[p] ?? '').trim();
      if (!prevMasked) continue;
      checked++;
      prevDeclText = `${prevMasked} ${prevDeclText}`;
      if (
        /=\s*$/.test(prevDeclText.trimEnd()) &&
        (/\bstatic\s+readonly\b/.test(prevDeclText) ||
          /\breadonly\s+static\b/.test(prevDeclText) ||
          /\bconst\b/.test(prevDeclText))
      ) {
        return true;
      }
      if (/[;{}]/.test(prevMasked)) {
        break;
      }
    }
    return false;
  }

  private tryBuildExtractHashAction(
    document: vscode.TextDocument,
    maskedLines: string[],
    maskedText: string,
    lineIdx: number,
    lineText: string,
    maskedLine: string,
    classCtx: NonNullable<ReturnType<typeof findEnclosingClassContext>>,
  ): vscode.CodeAction | null {
    if (this.isStaticReadonlyOrConstInitializerLine(maskedLines, lineIdx)) {
      return null;
    }

    const directCall = this.findCallWithStringArg(
      maskedLine,
      lineText,
      /\b(Shader\.PropertyToID|Animator\.StringToHash)\s*\(/g,
      true,
    );
    const shaderCall = !directCall
      ? this.findCallWithStringArg(
          maskedLine,
          lineText,
          /(?:mat|material|Material|mpb|block|PropertyBlock)[A-Za-z0-9_]*\.(?:SetFloat|SetInt|SetInteger|SetColor|SetVector|SetTexture|GetFloat|GetInt|HasProperty)\s*\(/g,
          false,
        )
      : null;
    const animCall =
      !directCall && !shaderCall
        ? this.findCallWithStringArg(
            maskedLine,
            lineText,
            /(?:anim|animator|Animator)[A-Za-z0-9_]*\.(?:SetFloat|SetInteger|SetBool|SetTrigger|ResetTrigger|GetFloat|GetBool|GetInteger|Play|CrossFade)\s*\(/g,
            false,
          )
        : null;

    let literalOrCallStart = -1;
    let literalOrCallEnd = -1;
    let keyName = '';
    let hashFactory = '';
    let suffix = 'Id';

    if (directCall) {
      literalOrCallStart = directCall.replaceStart;
      literalOrCallEnd = directCall.replaceEnd;
      keyName = directCall.keyName;
      hashFactory = `${directCall.callee}(${directCall.rawLiteral})`;
      suffix = directCall.callee.includes('Animator') ? 'Hash' : 'Id';
    } else if (shaderCall) {
      literalOrCallStart = shaderCall.replaceStart;
      literalOrCallEnd = shaderCall.replaceEnd;
      keyName = shaderCall.keyName;
      hashFactory = `Shader.PropertyToID(${shaderCall.rawLiteral})`;
      suffix = 'Id';
    } else if (animCall) {
      literalOrCallStart = animCall.replaceStart;
      literalOrCallEnd = animCall.replaceEnd;
      keyName = animCall.keyName;
      hashFactory = `Animator.StringToHash(${animCall.rawLiteral})`;
      suffix = 'Hash';
    } else {
      return null;
    }

    const fieldName = toPascalIdentifier(keyName, suffix);
    const classStartLine = document.positionAt(classCtx.classOpenBraceOffset).line;
    const maskedClassBody = maskedText.slice(classCtx.classOpenBraceOffset + 1, classCtx.classCloseBraceOffset);
    const edit = new vscode.WorkspaceEdit();

    if (!this.hasClassMemberFieldDeclaration(maskedClassBody, fieldName)) {
      edit.insert(
        document.uri,
        new vscode.Position(classStartLine + 1, 0),
        `    private static readonly int ${fieldName} = ${hashFactory};\n`,
      );
    }

    edit.replace(
      document.uri,
      new vscode.Range(lineIdx, literalOrCallStart, lineIdx, literalOrCallEnd),
      fieldName,
    );

    const action = new vscode.CodeAction(
      `[UnityBrain] '${keyName}' 해시를 static readonly int ${fieldName} 필드로 추출`,
      vscode.CodeActionKind.QuickFix,
    );
    action.edit = edit;
    return action;
  }

  private stripLeadingAttributes(trimmedLine: string): string {
    let i = 0;
    while (i < trimmedLine.length && trimmedLine[i] === '[') {
      let depth = 0;
      let inStr: string | null = null;
      const start = i;
      while (i < trimmedLine.length) {
        const ch = trimmedLine[i];
        if (inStr) {
          if (ch === '\\') {
            i += 2;
            continue;
          }
          if (ch === inStr) inStr = null;
        } else {
          if (ch === '"' || ch === "'") inStr = ch;
          else if (ch === '[') depth++;
          else if (ch === ']') {
            depth--;
            if (depth === 0) {
              i++;
              break;
            }
          }
        }
        i++;
      }
      if (depth !== 0) {
        i = start;
        break;
      }
      while (i < trimmedLine.length && /\s/.test(trimmedLine[i])) i++;
    }
    return trimmedLine.slice(i).trim();
  }

  private tryBuildFormerlySerializedAsAction(
    document: vscode.TextDocument,
    lines: string[],
    lineIdx: number,
    lineText: string,
  ): vscode.CodeAction | null {
    const trimmed = lineText.trim();
    if (!trimmed || trimmed.includes('FormerlySerializedAs')) {
      return null;
    }

    const withoutLeadingAttrs = this.stripLeadingAttributes(trimmed);
    const declHead = withoutLeadingAttrs.split('=')[0];
    if (!declHead || declHead.includes('(') || /\b(?:static|const|readonly)\b/.test(declHead)) {
      return null;
    }

    const fieldMatch =
      /^(?:(?:public|private|protected|internal|new)\s+)*([A-Za-z_][A-Za-z0-9_<>\[\].,?]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|;)/.exec(
        withoutLeadingAttrs,
      );
    if (!fieldMatch) return null;

    const prevLine = lines[lineIdx - 1] ?? '';
    const isSerialized =
      /\bpublic\b/.test(withoutLeadingAttrs) ||
      /SerializeField/.test(trimmed) ||
      /SerializeField/.test(prevLine);
    if (!isSerialized) return null;
    if (/FormerlySerializedAs/.test(prevLine)) return null;

    const indent = /^(\s*)/.exec(lineText)?.[1] ?? '    ';
    const fieldName = fieldMatch[2];
    const hasUsing = lines.some((l) => /^\s*using\s+UnityEngine\.Serialization\s*;/.test(l));
    const attrName = hasUsing ? 'FormerlySerializedAs' : 'UnityEngine.Serialization.FormerlySerializedAs';

    const edit = new vscode.WorkspaceEdit();
    edit.insert(
      document.uri,
      new vscode.Position(lineIdx, 0),
      `${indent}[${attrName}("${fieldName}")]\n`,
    );

    const act = new vscode.CodeAction(
      `[UnityBrain] '${fieldName}'에 [FormerlySerializedAs("${fieldName}")] 추가`,
      vscode.CodeActionKind.Refactor,
    );
    act.edit = edit;
    return act;
  }

  private findEnclosingMethodName(maskedLines: string[], lineIdx: number): string | null {
    const controlFlowKeywords = new Set([
      'if',
      'else',
      'for',
      'foreach',
      'while',
      'do',
      'switch',
      'catch',
      'finally',
      'try',
      'using',
      'lock',
      'fixed',
      'checked',
      'unchecked',
      'unsafe',
      'return',
      'new',
      'get',
      'set',
      'init',
      'add',
      'remove',
    ]);
    let braceBalance = 0;
    for (let i = lineIdx; i >= 0; i--) {
      const clean = maskedLines[i] ?? '';
      for (let k = clean.length - 1; k >= 0; k--) {
        if (clean[k] === '}') braceBalance++;
        else if (clean[k] === '{') {
          braceBalance--;
          if (braceBalance < 0) {
            const beforeBrace = clean.slice(0, k).trim();
            const headerCandidate = beforeBrace.length > 0 ? beforeBrace : (maskedLines[i - 1] ?? '').trim();
            if (/\b(?:class|struct|interface|enum|namespace)\b/.test(headerCandidate)) {
              // Check if lineIdx is inside a class-level expression-bodied method (`void Awake() => ...;`)
              const memberParts: string[] = [];
              for (let m = lineIdx; m >= i; m--) {
                const seg = m === i ? (maskedLines[m] ?? '').slice(k + 1) : (maskedLines[m] ?? '');
                if (m < lineIdx && /[;}]/.test(seg)) {
                  const lastSep = Math.max(seg.lastIndexOf(';'), seg.lastIndexOf('}'));
                  memberParts.unshift(seg.slice(lastSep + 1));
                  break;
                }
                memberParts.unshift(seg);
              }
              const exprSig = /(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*=>/.exec(
                memberParts.join(' ').trim(),
              );
              if (exprSig && !controlFlowKeywords.has(exprSig[1])) {
                return exprSig[1];
              }
              return null;
            }
            const methodSig =
              /(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*(?:=>|$)/.exec(headerCandidate);
            if (methodSig && !controlFlowKeywords.has(methodSig[1])) {
              return methodSig[1];
            }
            // Control-flow block (if/for/foreach/while/switch/catch/using/lock/etc.): keep climbing to method
            braceBalance++;
          }
        }
      }
    }
    return null;
  }

  private findMethodBodyStart(
    lines: string[],
    maskedLines: string[],
    startLine: number,
    endPos: vscode.Position,
    methodName: string,
  ): MethodBodyStart | null {
    void lines;
    const re = new RegExp(`\\b(?:void|Awaitable)\\s+${methodName}\\s*\\(`);
    const maxLine = Math.min(endPos.line, maskedLines.length - 1);
    for (let i = startLine; i <= maxLine; i++) {
      const candidateLine =
        i === endPos.line ? (maskedLines[i] ?? '').slice(0, endPos.character) : (maskedLines[i] ?? '');
      const m = re.exec(candidateLine);
      if (!m) continue;

      let parenDepth = 0;
      let angleDepth = 0;
      let foundParen = false;
      let aborted = false;

      for (let j = i; j <= maxLine && !aborted; j++) {
        const lineStr =
          j === endPos.line ? (maskedLines[j] ?? '').slice(0, endPos.character) : (maskedLines[j] ?? '');
        const startCol = j === i ? m.index + m[0].length - 1 : 0;

        for (let c = startCol; c < lineStr.length; c++) {
          const ch = lineStr[c];
          if (!foundParen || parenDepth > 0 || angleDepth > 0) {
            if (ch === '(') {
              foundParen = true;
              parenDepth++;
            } else if (ch === ')') {
              parenDepth = Math.max(0, parenDepth - 1);
            } else if (ch === '<') {
              angleDepth++;
            } else if (ch === '>' && angleDepth > 0) {
              angleDepth--;
            } else if (ch === ';' || ch === '{' || ch === '}') {
              aborted = true;
              break;
            }
            continue;
          }

          if (ch === ';' || ch === '}') {
            aborted = true;
            break;
          }

          if (ch === '{') {
            let depth = 1;
            let sameLineCloseCol: number | undefined;
            for (let k = c + 1; k < lineStr.length; k++) {
              if (lineStr[k] === '{') depth++;
              else if (lineStr[k] === '}') {
                depth--;
                if (depth === 0) {
                  sameLineCloseCol = k;
                  break;
                }
              }
            }
            return { kind: 'block', openLine: j, openCol: c, sameLineCloseCol };
          }

          if (ch === '=' && lineStr[c + 1] === '>') {
            let exprParenDepth = 0;
            let exprBraceDepth = 0;
            let exprBracketDepth = 0;
            for (let sLine = j; sLine <= maxLine; sLine++) {
              const exprLineStr =
                sLine === endPos.line
                  ? (maskedLines[sLine] ?? '').slice(0, endPos.character)
                  : (maskedLines[sLine] ?? '');
              const exprStartCol = sLine === j ? c + 2 : 0;
              for (let sCol = exprStartCol; sCol < exprLineStr.length; sCol++) {
                const ec = exprLineStr[sCol];
                if (ec === '(') exprParenDepth++;
                else if (ec === ')') exprParenDepth = Math.max(0, exprParenDepth - 1);
                else if (ec === '{') exprBraceDepth++;
                else if (ec === '}') {
                  exprBraceDepth--;
                  if (exprBraceDepth < 0) {
                    return null;
                  }
                } else if (ec === '[') exprBracketDepth++;
                else if (ec === ']') exprBracketDepth = Math.max(0, exprBracketDepth - 1);
                else if (
                  ec === ';' &&
                  exprParenDepth === 0 &&
                  exprBraceDepth === 0 &&
                  exprBracketDepth === 0
                ) {
                  return {
                    kind: 'expression',
                    arrowLine: j,
                    arrowCol: c,
                    semiLine: sLine,
                    semiCol: sCol,
                  };
                }
              }
            }
            return null;
          }
        }
      }
    }
    return null;
  }
}
