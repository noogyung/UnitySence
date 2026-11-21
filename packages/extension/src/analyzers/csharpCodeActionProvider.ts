import * as vscode from 'vscode';
import { findEnclosingClassContext } from '../completion/unityEventGenerator.ts';

const PERF_CRITICAL_METHOD_NAMES = new Set([
  'Update',
  'FixedUpdate',
  'LateUpdate',
  'OnGUI',
  'OnAnimatorIK',
]);

function toPascalIdentifier(raw: string, suffix: string): string {
  const cleaned = raw.replace(/^_+/, '').replace(/[^A-Za-z0-9]/g, '');
  if (!cleaned) return `Cached${suffix}`;
  const pascal = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  return `${pascal}${suffix}`;
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
    const targetLineIdx = range.start.line;
    const lineText = lines[targetLineIdx] ?? '';
    const offset = document.offsetAt(range.start);
    const classCtx = findEnclosingClassContext(text, offset);

    if (classCtx) {
      const cacheAction = this.tryBuildCacheComponentAction(document, lines, text, targetLineIdx, lineText, classCtx);
      if (cacheAction) actions.push(cacheAction);

      const cameraMainAction = this.tryBuildCacheCameraMainAction(
        document,
        lines,
        text,
        targetLineIdx,
        lineText,
        classCtx,
        context,
      );
      if (cameraMainAction) actions.push(cameraMainAction);

      const hashAction = this.tryBuildExtractHashAction(document, lines, text, targetLineIdx, lineText, classCtx);
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
    fullText: string,
    lineIdx: number,
    lineText: string,
    classCtx: NonNullable<ReturnType<typeof findEnclosingClassContext>>,
  ): vscode.CodeAction | null {
    // Only offer inside performance-critical lifecycle methods and on this/gameObject/implicit receiver
    const enclosingMethod = this.findEnclosingMethodName(lines, lineIdx);
    if (!enclosingMethod || !PERF_CRITICAL_METHOD_NAMES.has(enclosingMethod)) {
      return null;
    }

    const codeBeforeComment = lineText.replace(/\/\/.*$/, '');
    const gcMatch = /\b(?:(?:this|gameObject|transform)\s*\.\s*)?(GetComponent(?:InChildren|InParent)?)\s*<\s*([A-Za-z_][A-Za-z0-9_.]*)\s*>\s*\(\s*\)/.exec(
      codeBeforeComment,
    );
    if (!gcMatch) return null;

    // Skip external receivers like `other.GetComponent<T>()`
    const beforeCall = codeBeforeComment.slice(0, gcMatch.index);
    if (/\.\s*$/.test(beforeCall)) return null;

    const callMethod = gcMatch[1];
    const typeName = gcMatch[2];
    const shortType = typeName.includes('.') ? typeName.slice(typeName.lastIndexOf('.') + 1) : typeName;
    const fieldName = `_cached${shortType}`;

    const edit = this.buildCacheInAwakeEdit(document, lines, fullText, lineIdx, classCtx, {
      matchStart: gcMatch.index,
      matchEnd: gcMatch.index + gcMatch[0].length,
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
    fullText: string,
    lineIdx: number,
    lineText: string,
    classCtx: NonNullable<ReturnType<typeof findEnclosingClassContext>>,
    context?: vscode.CodeActionContext,
  ): vscode.CodeAction | null {
    const enclosingMethod = this.findEnclosingMethodName(lines, lineIdx);
    const isPerfCriticalMethod = Boolean(enclosingMethod && PERF_CRITICAL_METHOD_NAMES.has(enclosingMethod));
    const hasUb1001Diag = this.hasDiagnosticCodeOnLine(context, lineIdx, 'UB1001');
    if (!isPerfCriticalMethod && !hasUb1001Diag) {
      return null;
    }

    const codeBeforeComment = lineText.replace(/\/\/.*$/, '');
    const camMatch = /(?<![A-Za-z0-9_.])(?:UnityEngine\s*\.\s*)?Camera\s*\.\s*main\b/.exec(codeBeforeComment);
    if (!camMatch) return null;

    const fieldType =
      camMatch[0].startsWith('UnityEngine') && !/\busing\s+UnityEngine\s*;/.test(fullText)
        ? 'UnityEngine.Camera'
        : 'Camera';
    const fieldName = '_cachedMainCamera';
    const initExpression = camMatch[0].replace(/\s+/g, '');

    const edit = this.buildCacheInAwakeEdit(document, lines, fullText, lineIdx, classCtx, {
      matchStart: camMatch.index,
      matchEnd: camMatch.index + camMatch[0].length,
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

  private buildCacheInAwakeEdit(
    document: vscode.TextDocument,
    lines: string[],
    fullText: string,
    lineIdx: number,
    classCtx: NonNullable<ReturnType<typeof findEnclosingClassContext>>,
    opts: {
      matchStart: number;
      matchEnd: number;
      fieldType: string;
      fieldName: string;
      initExpression: string;
    },
  ): vscode.WorkspaceEdit {
    const { matchStart, matchEnd, fieldType, fieldName, initExpression } = opts;
    const classStartPos = document.positionAt(classCtx.classOpenBraceOffset);
    const classEndPos = document.positionAt(classCtx.classCloseBraceOffset);
    const classStartLine = classStartPos.line;
    const indent = '    ';
    const edit = new vscode.WorkspaceEdit();

    const fieldRegex = new RegExp(`\\b${fieldName}\\b`);
    const classBody = fullText.slice(classCtx.classOpenBraceOffset, classCtx.classCloseBraceOffset);
    if (!fieldRegex.test(classBody)) {
      edit.insert(
        document.uri,
        new vscode.Position(classStartLine + 1, 0),
        `${indent}private ${fieldType} ${fieldName};\n`,
      );
    }

    const awakeBody = this.findMethodBodyStart(lines, classStartLine, classEndPos, 'Awake');
    if (awakeBody !== null) {
      const awakeBodyText = this.extractMethodBodyText(lines, awakeBody, classEndPos).replace(/\/\/.*$/gm, '');
      const alreadyAssigned = new RegExp(`\\b${fieldName}\\s*=`).test(awakeBodyText);
      if (!alreadyAssigned) {
        if (awakeBody.sameLineCloseCol !== undefined) {
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

    edit.replace(
      document.uri,
      new vscode.Range(lineIdx, matchStart, lineIdx, matchEnd),
      fieldName,
    );

    return edit;
  }

  private extractMethodBodyText(
    lines: string[],
    bodyStart: { openLine: number; openCol: number; sameLineCloseCol?: number },
    endPos: vscode.Position,
  ): string {
    if (bodyStart.sameLineCloseCol !== undefined) {
      const lineStr = lines[bodyStart.openLine] ?? '';
      return lineStr.slice(bodyStart.openCol + 1, bodyStart.sameLineCloseCol);
    }

    const chunks: string[] = [];
    let depth = 1;
    const maxLine = Math.min(endPos.line, lines.length - 1);
    for (let i = bodyStart.openLine; i <= maxLine; i++) {
      const rawLine = i === endPos.line ? (lines[i] ?? '').slice(0, endPos.character) : (lines[i] ?? '');
      const startCol = i === bodyStart.openLine ? bodyStart.openCol + 1 : 0;
      let endCol = rawLine.length;
      let inStr = false;

      for (let c = startCol; c < rawLine.length; c++) {
        const ch = rawLine[c];
        if (inStr) {
          if (ch === '\\') {
            c++;
          } else if (ch === '"') {
            inStr = false;
          }
          continue;
        }
        if (ch === '/' && rawLine[c + 1] === '/') {
          break;
        }
        if (ch === '"') {
          inStr = true;
        } else if (ch === '{') {
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

  private tryBuildExtractHashAction(
    document: vscode.TextDocument,
    lines: string[],
    fullText: string,
    lineIdx: number,
    lineText: string,
    classCtx: NonNullable<ReturnType<typeof findEnclosingClassContext>>,
  ): vscode.CodeAction | null {
    const codeBeforeComment = lineText.replace(/\/\/.*$/, '');
    if (
      /\bstatic\s+readonly\b/.test(codeBeforeComment) ||
      /\breadonly\s+static\b/.test(codeBeforeComment) ||
      /\bconst\b/.test(codeBeforeComment)
    ) {
      return null;
    }

    const directHash = /\b(Shader\.PropertyToID|Animator\.StringToHash)\s*\(\s*"([^"]+)"\s*\)/.exec(
      codeBeforeComment,
    );
    const shaderCall = !directHash
      ? /(?:mat|material|Material|mpb|block|PropertyBlock)[A-Za-z0-9_]*\.(?:SetFloat|SetInt|SetInteger|SetColor|SetVector|SetTexture|GetFloat|GetInt|HasProperty)\s*\(\s*("([^"]+)")/.exec(
          codeBeforeComment,
        )
      : null;
    const animCall =
      !directHash && !shaderCall
        ? /(?:anim|animator|Animator)[A-Za-z0-9_]*\.(?:SetFloat|SetInteger|SetBool|SetTrigger|ResetTrigger|GetFloat|GetBool|GetInteger|Play|CrossFade)\s*\(\s*("([^"]+)")/.exec(
            codeBeforeComment,
          )
        : null;

    let literalOrCallStart = -1;
    let literalOrCallEnd = -1;
    let keyName = '';
    let hashFactory = '';
    let suffix = 'Id';

    if (directHash) {
      literalOrCallStart = directHash.index;
      literalOrCallEnd = directHash.index + directHash[0].length;
      keyName = directHash[2];
      hashFactory = `${directHash[1]}("${keyName}")`;
      suffix = directHash[1].includes('Animator') ? 'Hash' : 'Id';
    } else if (shaderCall) {
      const argIdx = codeBeforeComment.indexOf(shaderCall[1], shaderCall.index);
      literalOrCallStart = argIdx;
      literalOrCallEnd = argIdx + shaderCall[1].length;
      keyName = shaderCall[2];
      hashFactory = `Shader.PropertyToID("${keyName}")`;
      suffix = 'Id';
    } else if (animCall) {
      const argIdx = codeBeforeComment.indexOf(animCall[1], animCall.index);
      literalOrCallStart = argIdx;
      literalOrCallEnd = argIdx + animCall[1].length;
      keyName = animCall[2];
      hashFactory = `Animator.StringToHash("${keyName}")`;
      suffix = 'Hash';
    } else {
      return null;
    }

    const fieldName = toPascalIdentifier(keyName, suffix);
    const classStartLine = document.positionAt(classCtx.classOpenBraceOffset).line;
    const classBody = fullText.slice(classCtx.classOpenBraceOffset, classCtx.classCloseBraceOffset);
    const edit = new vscode.WorkspaceEdit();

    if (!new RegExp(`\\b${fieldName}\\b`).test(classBody)) {
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
    void lines;
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

  private findEnclosingMethodName(lines: string[], lineIdx: number): string | null {
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
      const clean = lines[i].replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/\/\/.*$/, '');
      for (let k = clean.length - 1; k >= 0; k--) {
        if (clean[k] === '}') braceBalance++;
        else if (clean[k] === '{') {
          braceBalance--;
          if (braceBalance < 0) {
            const beforeBrace = clean.slice(0, k).trim();
            const headerCandidate = beforeBrace.length > 0 ? beforeBrace : (lines[i - 1] ?? '').trim();
            if (/\b(?:class|struct|interface|enum|namespace)\b/.test(headerCandidate)) {
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
    startLine: number,
    endPos: vscode.Position,
    methodName: string,
  ): { openLine: number; openCol: number; sameLineCloseCol?: number } | null {
    const re = new RegExp(`\\bvoid\\s+${methodName}\\s*\\(`);
    const maxLine = Math.min(endPos.line, lines.length - 1);
    for (let i = startLine; i <= maxLine; i++) {
      const candidateLine = i === endPos.line ? lines[i].slice(0, endPos.character) : lines[i];
      if (!re.test(candidateLine)) continue;
      for (let j = i; j < Math.min(i + 4, maxLine + 1); j++) {
        const lineStr = j === endPos.line ? lines[j].slice(0, endPos.character) : lines[j];
        const openCol = lineStr.indexOf('{');
        if (openCol >= 0) {
          let depth = 1;
          let sameLineCloseCol: number | undefined;
          for (let c = openCol + 1; c < lineStr.length; c++) {
            if (lineStr[c] === '{') depth++;
            else if (lineStr[c] === '}') {
              depth--;
              if (depth === 0) {
                sameLineCloseCol = c;
                break;
              }
            }
          }
          return { openLine: j, openCol, sameLineCloseCol };
        }
      }
    }
    return null;
  }
}
