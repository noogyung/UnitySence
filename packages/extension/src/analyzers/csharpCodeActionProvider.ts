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

    const gcMatch = /\b(?:(?:this|gameObject|transform)\s*\.\s*)?(GetComponent(?:InChildren|InParent)?)\s*<\s*([A-Za-z_][A-Za-z0-9_.]*)\s*>\s*\(\s*\)/.exec(
      lineText,
    );
    if (!gcMatch) return null;

    // Skip external receivers like `other.GetComponent<T>()`
    const beforeCall = lineText.slice(0, gcMatch.index);
    if (/\.\s*$/.test(beforeCall)) return null;

    const callMethod = gcMatch[1];
    const typeName = gcMatch[2];
    const shortType = typeName.includes('.') ? typeName.slice(typeName.lastIndexOf('.') + 1) : typeName;
    const fieldName = `_cached${shortType}`;

    const classStartLine = document.positionAt(classCtx.classOpenBraceOffset).line;
    const indent = '    ';
    const edit = new vscode.WorkspaceEdit();

    const fieldRegex = new RegExp(`\\b${fieldName}\\b`);
    const classBody = fullText.slice(classCtx.classOpenBraceOffset, classCtx.classCloseBraceOffset);
    if (!fieldRegex.test(classBody)) {
      edit.insert(
        document.uri,
        new vscode.Position(classStartLine + 1, 0),
        `${indent}private ${typeName} ${fieldName};\n`,
      );
    }

    const awakeBody = this.findMethodBodyStart(lines, classStartLine, 'Awake');
    if (awakeBody !== null) {
      if (awakeBody.sameLineCloseCol !== undefined) {
        const lineStr = lines[awakeBody.openLine] ?? '';
        const inner = lineStr.slice(awakeBody.openCol + 1, awakeBody.sameLineCloseCol).trim();
        const methodIndent = /^(\s*)/.exec(lineStr)?.[1] ?? indent;
        const innerLines = inner
          ? `\n${methodIndent}${indent}${fieldName} = ${callMethod}<${typeName}>();\n${methodIndent}${indent}${inner}\n${methodIndent}`
          : `\n${methodIndent}${indent}${fieldName} = ${callMethod}<${typeName}>();\n${methodIndent}`;
        edit.replace(
          document.uri,
          new vscode.Range(awakeBody.openLine, awakeBody.openCol + 1, awakeBody.openLine, awakeBody.sameLineCloseCol),
          innerLines,
        );
      } else {
        edit.insert(
          document.uri,
          new vscode.Position(awakeBody.openLine + 1, 0),
          `${indent}${indent}${fieldName} = ${callMethod}<${typeName}>();\n`,
        );
      }
    } else {
      edit.insert(
        document.uri,
        new vscode.Position(classStartLine + 1, 0),
        `\n${indent}private void Awake()\n${indent}{\n${indent}${indent}${fieldName} = ${callMethod}<${typeName}>();\n${indent}}\n`,
      );
    }

    edit.replace(
      document.uri,
      new vscode.Range(lineIdx, gcMatch.index, lineIdx, gcMatch.index + gcMatch[0].length),
      fieldName,
    );

    const action = new vscode.CodeAction(
      `[UnityBrain] Awake()에 '${shortType}' 컴포넌트 캐싱 (${fieldName})`,
      vscode.CodeActionKind.QuickFix,
    );
    action.edit = edit;
    action.isPreferred = true;
    return action;
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
      lineText,
    );
    const shaderCall = !directHash
      ? /(?:mat|material|Material|mpb|block|PropertyBlock)[A-Za-z0-9_]*\.(?:SetFloat|SetInt|SetInteger|SetColor|SetVector|SetTexture|GetFloat|GetInt|HasProperty)\s*\(\s*("([^"]+)")/.exec(
          lineText,
        )
      : null;
    const animCall =
      !directHash && !shaderCall
        ? /(?:anim|animator|Animator)[A-Za-z0-9_]*\.(?:SetFloat|SetInteger|SetBool|SetTrigger|ResetTrigger|GetFloat|GetBool|GetInteger|Play|CrossFade)\s*\(\s*("([^"]+)")/.exec(
            lineText,
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
      const argIdx = lineText.indexOf(shaderCall[1], shaderCall.index);
      literalOrCallStart = argIdx;
      literalOrCallEnd = argIdx + shaderCall[1].length;
      keyName = shaderCall[2];
      hashFactory = `Shader.PropertyToID("${keyName}")`;
      suffix = 'Id';
    } else if (animCall) {
      const argIdx = lineText.indexOf(animCall[1], animCall.index);
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
    methodName: string,
  ): { openLine: number; openCol: number; sameLineCloseCol?: number } | null {
    const re = new RegExp(`\\bvoid\\s+${methodName}\\s*\\(`);
    for (let i = startLine; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      for (let j = i; j < Math.min(i + 4, lines.length); j++) {
        const lineStr = lines[j];
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
