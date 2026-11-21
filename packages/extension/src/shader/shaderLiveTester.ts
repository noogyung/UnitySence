import * as vscode from 'vscode';
import type { IncludeDependencyGraph } from '../../../shader-lsp/src/indexer/hlslIncludeGraph.ts';
import { extractVirtualHlslDocument } from '../../../shader-lsp/src/parser/shaderLabVirtualDoc.ts';
import { normalizePathKey } from '../../../shader-lsp/src/vfs/virtualPathResolver.ts';
import { collectComputeAndShaderLabDiagnostics, stripCommentsAndStringsByLine } from './shaderEditorProviders.ts';
import { analyzeShaderVariants, isShaderDocument } from './shaderKeywordContextStatusBar.ts';

export type ShaderLoadGrade = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface ShaderPerformanceMetrics {
  readonly textureSampleCount: number;
  readonly expensiveMathCount: number;
  readonly derivativeCount: number;
  readonly dynamicBranchCount: number;
  readonly loopCount: number;
  readonly textureSampleInLoopCount: number;
  readonly floatUsageCount: number;
  readonly halfUsageCount: number;
  readonly estimatedAluScore: number;
  readonly loadGrade: ShaderLoadGrade;
  readonly heavyReasons: string[];
  readonly optimizationHints: string[];
  readonly topVariantMultipliers: Array<{ keywordLine: string; multiplier: number }>;
}

export interface ShaderLiveTestResult {
  readonly filePath: string;
  readonly unresolvedIncludeCount: number;
  readonly diagnosticCount: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly totalVariants: number;
  readonly reachableFileCount: number;
  readonly diagnostics: vscode.Diagnostic[];
  readonly performance: ShaderPerformanceMetrics;
  readonly summaryLines: string[];
}

export function analyzeShaderPerformance(text: string, filePath = ''): ShaderPerformanceMetrics {
  const virtualDoc = extractVirtualHlslDocument(text, filePath);
  const targetText = virtualDoc.isShaderLab ? virtualDoc.virtualHlsl : text;
  const codeLines = stripCommentsAndStringsByLine(targetText.split(/\r?\n/));

  let textureSampleCount = 0;
  let expensiveMathCount = 0;
  let derivativeCount = 0;
  let dynamicBranchCount = 0;
  let loopCount = 0;
  let textureSampleInLoopCount = 0;
  let floatUsageCount = 0;
  let halfUsageCount = 0;

  const texSampleRe =
    /(?:\b(?:SAMPLE_TEXTURE(?:2D|2D_X|2D_ARRAY|3D|CUBE)(?:_LOD|_BIAS|_GRAD|_SHADOW)?|LOAD_TEXTURE(?:2D|2D_X|2D_ARRAY|3D)|UNITY_SAMPLE_TEX2D(?:_SAMPLER)?|tex2D(?:lod|proj|grad|bias)?|tex3D(?:lod)?|texCUBE(?:lod)?)|\.(?:Sample(?:Level|Bias|Grad|Cmp|CmpLevelZero)?|Load))\b/g;
  const mathRe = /\b(?:sin|cos|tan|asin|acos|atan|atan2|pow|exp|exp2|log|log2|sqrt|rsqrt|normalize|length|distance|reflect|refract)\b/g;
  const derivRe = /\b(?:ddx|ddy|fwidth)\b/g;
  const branchRe = /\belse\s+if\b|\b(?:if|else)\b/g;
  const loopRe = /\b(?:for|while|do)\b/g;
  const floatRe = /\bfloat(?:[234]|2x2|3x3|4x4)?\b/g;
  const halfRe = /\b(?:half|real)(?:[234]|2x2|3x3|4x4)?\b/g;

  let loopBraceDepth = 0;
  let pendingDoWhile = false;
  let pendingLoopHeader: 'braceOrStmt' | 'parensThenBody' | null = null;
  let headerParenDepth = 0;
  let inBracelessLoopStmt = false;
  let inPreprocContinuation = false;

  for (const line of codeLines) {
    if (inPreprocContinuation) {
      inPreprocContinuation = line.trimEnd().endsWith('\\');
      continue;
    }
    if (/^\s*#/.test(line)) {
      inPreprocContinuation = line.trimEnd().endsWith('\\');
      continue;
    }

    const texHits = (line.match(texSampleRe) ?? []).length;
    textureSampleCount += texHits;
    expensiveMathCount += (line.match(mathRe) ?? []).length;
    derivativeCount += (line.match(derivRe) ?? []).length;
    dynamicBranchCount += (line.match(branchRe) ?? []).length;

    let loopsHere = 0;
    const loopMatches = line.match(loopRe) ?? [];
    for (const kw of loopMatches) {
      if (kw === 'while' && pendingDoWhile) {
        pendingDoWhile = false;
        continue;
      }
      if (kw === 'do') {
        pendingDoWhile = true;
      }
      loopsHere++;
    }
    loopCount += loopsHere;

    floatUsageCount += (line.match(floatRe) ?? []).length;
    halfUsageCount += (line.match(halfRe) ?? []).length;

    let lineTouchedLoopBody = loopBraceDepth > 0 || inBracelessLoopStmt;
    if (pendingLoopHeader === 'braceOrStmt' && line.trim().length > 0 && !line.trimStart().startsWith('{')) {
      inBracelessLoopStmt = true;
      lineTouchedLoopBody = true;
      pendingLoopHeader = null;
    }
    const tokRe = /\b(for|while|do)\b|([(){};])/g;
    let m: RegExpExecArray | null;
    while ((m = tokRe.exec(line)) !== null) {
      const kw = m[1];
      const sym = m[2];
      if (kw) {
        if (kw === 'do') {
          pendingLoopHeader = 'braceOrStmt';
        } else if (kw === 'for' || kw === 'while') {
          // Wait until balanced (...) closes if this starts a loop
          if (!pendingDoWhile || kw === 'for') {
            pendingLoopHeader = 'parensThenBody';
            headerParenDepth = 0;
          }
        }
        continue;
      }

      if (pendingLoopHeader === 'parensThenBody') {
        if (sym === '(') headerParenDepth++;
        else if (sym === ')') {
          if (headerParenDepth > 0) headerParenDepth--;
          if (headerParenDepth === 0) pendingLoopHeader = 'braceOrStmt';
        }
        continue;
      }

      if (pendingLoopHeader === 'braceOrStmt') {
        if (sym === '{') {
          loopBraceDepth++;
          lineTouchedLoopBody = true;
          pendingLoopHeader = null;
        } else if (sym === ';') {
          lineTouchedLoopBody = true;
          pendingLoopHeader = null;
          inBracelessLoopStmt = false;
        } else {
          inBracelessLoopStmt = true;
          lineTouchedLoopBody = true;
          pendingLoopHeader = null;
        }
        continue;
      }

      if (sym === '{' && loopBraceDepth > 0) {
        loopBraceDepth++;
        lineTouchedLoopBody = true;
      } else if (sym === '}' && loopBraceDepth > 0) {
        loopBraceDepth--;
      } else if (sym === ';' && inBracelessLoopStmt) {
        lineTouchedLoopBody = true;
        inBracelessLoopStmt = false;
      }
    }

    if (lineTouchedLoopBody && texHits > 0) {
      textureSampleInLoopCount += texHits;
    }
  }

  const variantInfo = analyzeShaderVariants(text);
  const topVariantMultipliers: Array<{ keywordLine: string; multiplier: number }> = [];
  const seenPragmas = new Set<string>();
  for (const blk of variantInfo.blocks) {
    for (const p of blk.pragmas) {
      if (p.variantFactor <= 1) continue;
      const lineKey = `${p.line}:${p.kind}:${p.keywords.join(' ')}`;
      if (seenPragmas.has(lineKey)) continue;
      seenPragmas.add(lineKey);
      topVariantMultipliers.push({
        keywordLine: `#pragma ${p.kind} ${p.keywords.join(' ')}`,
        multiplier: p.variantFactor,
      });
    }
  }
  topVariantMultipliers.sort((a, b) => b.multiplier - a.multiplier);

  const estimatedAluScore =
    textureSampleCount * 8 +
    textureSampleInLoopCount * 24 +
    expensiveMathCount * 4 +
    derivativeCount * 3 +
    dynamicBranchCount * 3 +
    loopCount * 10;

  let loadGrade: ShaderLoadGrade = 'LOW';
  if (estimatedAluScore >= 120 || textureSampleInLoopCount > 0 || variantInfo.totalVariants >= 512) {
    loadGrade = 'CRITICAL';
  } else if (estimatedAluScore >= 60 || textureSampleCount >= 6 || variantInfo.totalVariants >= 128) {
    loadGrade = 'HIGH';
  } else if (estimatedAluScore >= 25 || textureSampleCount >= 3) {
    loadGrade = 'MEDIUM';
  }

  const heavyReasons: string[] = [];
  const optimizationHints: string[] = [];

  if (textureSampleInLoopCount > 0) {
    heavyReasons.push(`반복문(for/while) 내부에서 텍스처 샘플링이 ${textureSampleInLoopCount}회 발생하여 TMU 병목 위험이 큽니다.`);
    optimizationHints.push('루프 내부 텍스처 샘플링은 루프 언롤링/LOD 명시(SAMPLE_TEXTURE2D_LOD) 또는 채널 패킹으로 횟수를 줄이세요.');
  }
  if (textureSampleCount >= 4) {
    heavyReasons.push(`텍스처 샘플링 횟수가 ${textureSampleCount}회로 많습니다 (대역폭 및 캐시 미스 증가).`);
    optimizationHints.push('마스크/메탈릭/러프니스 텍스처를 RGBA 채널로 패킹하면 샘플링 횟수를 줄일 수 있습니다.');
  }
  if (expensiveMathCount >= 6) {
    heavyReasons.push(`삼각함수·pow·sqrt·normalize 등 고비용 ALU 연산이 ${expensiveMathCount}회 호출됩니다.`);
    optimizationHints.push('모바일/URP 환경에서는 normalize/pow 빈도를 줄이고 근사식이나 half 정밀도를 활용하세요.');
  }
  if (dynamicBranchCount >= 3) {
    heavyReasons.push(`동적 조건 분기(if/else)가 ${dynamicBranchCount}회 존재하여 GPU 워프(Warp/Wavefront) 발산 가능성이 있습니다.`);
    optimizationHints.push('간단한 분기는 step() / lerp() 기반 분기 없는(branchless) 연산으로 치환하는 것을 권장합니다.');
  }
  if (variantInfo.totalVariants >= 64) {
    const topStr = topVariantMultipliers
      .slice(0, 2)
      .map((t) => `${t.keywordLine} (×${t.multiplier})`)
      .join(', ');
    heavyReasons.push(`셰이더 배리언트가 총 ${variantInfo.totalVariants}개로 많습니다${topStr ? ` — 주요 원인: ${topStr}` : ''}.`);
    optimizationHints.push('글로벌 multi_compile 대신 shader_feature_local 또는 _local 접미사를 사용해 빌드 배리언트 폭발을 줄이세요.');
  }
  if (floatUsageCount > 8 && halfUsageCount === 0) {
    optimizationHints.push('모든 벡터가 float(32-bit)으로 작성되었습니다. 색상·UV·노멀 연산에 half(16-bit)를 쓰면 모바일 GPU 레지스터 점유율을 크게 낮출 수 있습니다.');
  }
  if (heavyReasons.length === 0) {
    heavyReasons.push('고비용 연산, 루프 내 텍스처 샘플링, 과도한 배리언트 폭발이 감지되지 않은 경량 셰이더입니다.');
  }

  return {
    textureSampleCount,
    expensiveMathCount,
    derivativeCount,
    dynamicBranchCount,
    loopCount,
    textureSampleInLoopCount,
    floatUsageCount,
    halfUsageCount,
    estimatedAluScore,
    loadGrade,
    heavyReasons,
    optimizationHints,
    topVariantMultipliers: topVariantMultipliers.slice(0, 3),
  };
}

let sharedOutputChannel: vscode.OutputChannel | undefined;

export function runShaderLiveTest(
  doc: vscode.TextDocument,
  shaderGraph: IncludeDependencyGraph,
): ShaderLiveTestResult {
  const uriStr = doc.uri.toString();
  const text = doc.getText();
  shaderGraph.setOpenDocumentContent(uriStr, text);

  const normPath = shaderGraph.normalizeFilePath(uriStr);
  const normKey = normalizePathKey(normPath);
  const walk = shaderGraph.collectReachableFiles(uriStr);
  const unresolvedForDoc = walk.unresolvedIncludes.filter(
    (u) => u.fromUri === uriStr || normalizePathKey(u.fromFile) === normKey,
  );
  const includeDiags = unresolvedForDoc.map(
    (u) =>
      new vscode.Diagnostic(
        new vscode.Range(u.line, u.startCol, u.line, u.endCol),
        `[UnityBrain] 해석할 수 없는 유니티 셰이더 include 경로입니다: "${u.includePath}"`,
        vscode.DiagnosticSeverity.Error,
      ),
  );
  const semanticDiags = collectComputeAndShaderLabDiagnostics(doc, shaderGraph);
  const diagnostics = [...includeDiags, ...semanticDiags];
  const variantInfo = analyzeShaderVariants(text);
  const performance = analyzeShaderPerformance(text, normPath);

  const errorCount =
    unresolvedForDoc.length +
    semanticDiags.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length;
  const warningCount = semanticDiags.filter(
    (d) => d.severity === vscode.DiagnosticSeverity.Warning,
  ).length;

  const summaryLines: string[] = [
    `============================================================`,
    `[UnityBrain Shader Live Profiler] ${doc.fileName}`,
    `============================================================`,
    `▶ 종합 GPU 부하 등급: ${performance.loadGrade} (추정 비용 점수: ${performance.estimatedAluScore})`,
    `▶ 정적 검증: 오류 ${errorCount}건 · 경고 ${warningCount}건 · Include ${walk.files.length}개`,
    `▶ 연산/메모리 상세:`,
    `   - 텍스처 샘플링(TMU): ${performance.textureSampleCount}회 (루프 내: ${performance.textureSampleInLoopCount}회)`,
    `   - 고비용 ALU(sin/cos/pow/sqrt 등): ${performance.expensiveMathCount}회 · 편미분(ddx/ddy): ${performance.derivativeCount}회`,
    `   - 동적 분기(if/else): ${performance.dynamicBranchCount}회 · 루프(for/while): ${performance.loopCount}회`,
    `   - 정밀도 분포: float ${performance.floatUsageCount}회 vs half/real ${performance.halfUsageCount}회`,
    `   - 배리언트 수: ${variantInfo.totalVariants}개 (블록 ${variantInfo.blocks.length}개)`,
    ``,
    `▶ 부하 원인 분석 (왜 무거운가?):`,
    ...performance.heavyReasons.map((r) => `   • ${r}`),
  ];

  if (performance.topVariantMultipliers.length > 0) {
    summaryLines.push(`▶ 주요 배리언트 증가 요인 Top ${performance.topVariantMultipliers.length}:`);
    for (const item of performance.topVariantMultipliers) {
      summaryLines.push(`   • ×${item.multiplier} : ${item.keywordLine}`);
    }
  }
  if (performance.optimizationHints.length > 0) {
    summaryLines.push(`▶ 최적화 제안:`);
    for (const hint of performance.optimizationHints) {
      summaryLines.push(`   ✓ ${hint}`);
    }
  }
  for (const u of unresolvedForDoc) {
    summaryLines.push(`  [ERROR Line ${u.line + 1}] 미해결 #include "${u.includePath}"`);
  }
  for (const d of semanticDiags) {
    const tag = d.severity === vscode.DiagnosticSeverity.Error ? 'ERROR' : 'WARN';
    summaryLines.push(`  [${tag} Line ${d.range.start.line + 1}] ${d.message}`);
  }

  return {
    filePath: normPath,
    unresolvedIncludeCount: unresolvedForDoc.length,
    diagnosticCount: diagnostics.length,
    errorCount,
    warningCount,
    totalVariants: variantInfo.totalVariants,
    reachableFileCount: walk.files.length,
    diagnostics,
    performance,
    summaryLines,
  };
}

export async function executeShaderLiveTestCommand(
  shaderGraph: IncludeDependencyGraph,
  diagnosticCollection: vscode.DiagnosticCollection,
  outputChannel?: vscode.OutputChannel,
): Promise<ShaderLiveTestResult | null> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isShaderDocument(editor.document)) {
    void vscode.window.showWarningMessage('[UnityBrain] 활성화된 셰이더 파일(.shader, .hlsl, .compute)이 없습니다.');
    return null;
  }

  const doc = editor.document;
  const result = runShaderLiveTest(doc, shaderGraph);
  diagnosticCollection.set(doc.uri, result.diagnostics);

  let channel = outputChannel;
  if (!channel) {
    if (!sharedOutputChannel && typeof vscode.window.createOutputChannel === 'function') {
      sharedOutputChannel = vscode.window.createOutputChannel('UnityBrain Shader Live Profiler');
    }
    channel = sharedOutputChannel;
  }
  if (channel) {
    channel.clear();
    for (const line of result.summaryLines) {
      channel.appendLine(line);
    }
    channel.show(true);
  }

  const p = result.performance;
  const statusText = `[UnityBrain Live Profiler] 부하 등급: ${p.loadGrade} (점수 ${p.estimatedAluScore}) · TMU ${p.textureSampleCount}회 · 고비용연산 ${p.expensiveMathCount}회 · 오류 ${result.errorCount}건 — ${p.heavyReasons[0]}`;
  if (result.errorCount > 0 || p.loadGrade === 'CRITICAL') {
    void vscode.window.showWarningMessage(statusText);
  } else {
    void vscode.window.showInformationMessage(statusText);
  }
  return result;
}
