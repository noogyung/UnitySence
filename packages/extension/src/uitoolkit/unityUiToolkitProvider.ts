import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type { UiToolkitElementRef } from '../completion/unityStringCompletionProvider.ts';

interface UssPropertyMeta {
  name: string;
  description: string;
}

const UNITY_USS_PROPERTIES: readonly UssPropertyMeta[] = [
  // Unity-specific -unity-* USS properties
  { name: '-unity-font', description: 'UI 요소 텍스트에 사용할 Font 에셋입니다.' },
  { name: '-unity-font-definition', description: 'TextMeshPro / PanelTextSettings FontAsset을 지정합니다.' },
  { name: '-unity-font-style', description: '글꼴 스타일 (normal | bold | italic | bold-and-italic)입니다.' },
  { name: '-unity-text-align', description: '텍스트 정렬 (upper-left | middle-center | lower-right 등)입니다.' },
  { name: '-unity-slice-left', description: '9-슬라이스 왼쪽 여백(px)입니다.' },
  { name: '-unity-slice-top', description: '9-슬라이스 위쪽 여백(px)입니다.' },
  { name: '-unity-slice-right', description: '9-슬라이스 오른쪽 여백(px)입니다.' },
  { name: '-unity-slice-bottom', description: '9-슬라이스 아래쪽 여백(px)입니다.' },
  { name: '-unity-slice-scale', description: '9-슬라이스 스케일 배율입니다.' },
  { name: '-unity-background-scale-mode', description: '배경 이미지 크기 조절 모드 (stretch-to-fill | scale-and-crop | scale-to-fit)입니다.' },
  { name: '-unity-background-image-tint-color', description: '배경 이미지 틴트 색상입니다.' },
  { name: '-unity-overflow-clip-box', description: '클리핑 영역 기준 (padding-box | content-box)입니다.' },
  { name: '-unity-paragraph-spacing', description: '단락 간 간격(px)입니다.' },
  { name: '-unity-text-outline-width', description: '텍스트 외곽선 두께(px)입니다.' },
  { name: '-unity-text-outline-color', description: '텍스트 외곽선 색상입니다.' },

  // Unity 6 UI Toolkit core Flexbox, layout, spacing, border, typography, and transition properties
  { name: 'flex-direction', description: '주축 배치 방향 (row | row-reverse | column | column-reverse)입니다.' },
  { name: 'flex-grow', description: '남은 여유 공간을 차지하는 확장 비율입니다.' },
  { name: 'flex-shrink', description: '공간 부족 시 축소되는 비율입니다.' },
  { name: 'flex-wrap', description: '자식 요소의 줄 바꿈 여부 (nowrap | wrap | wrap-reverse)입니다.' },
  { name: 'flex-basis', description: '주축 방향의 기본 크기 (auto | px | %)입니다.' },
  { name: 'align-items', description: '교차축 기준 자식 요소 정렬 (auto | flex-start | center | flex-end | stretch)입니다.' },
  { name: 'align-self', description: '개별 요소의 교차축 정렬을 재정의합니다 (auto | flex-start | center | flex-end | stretch).' },
  { name: 'align-content', description: '여러 줄 교차축 정렬 방식 (flex-start | center | flex-end | stretch | auto)입니다.' },
  { name: 'justify-content', description: '주축 기준 자식 요소 정렬 (flex-start | center | flex-end | space-between | space-around | space-evenly)입니다.' },
  { name: 'width', description: '요소의 너비 (auto | px | %)입니다.' },
  { name: 'height', description: '요소의 높이 (auto | px | %)입니다.' },
  { name: 'min-width', description: '요소의 최소 너비입니다.' },
  { name: 'min-height', description: '요소의 최소 높이입니다.' },
  { name: 'max-width', description: '요소의 최대 너비입니다.' },
  { name: 'max-height', description: '요소의 최대 높이입니다.' },
  { name: 'margin', description: '요소 바깥쪽 여백 단축 속성 (상 우 하 좌)입니다.' },
  { name: 'padding', description: '요소 안쪽 여백 단축 속성 (상 우 하 좌)입니다.' },
  { name: 'position', description: '위치 배치 방식 (relative | absolute)입니다.' },
  { name: 'left', description: '왼쪽 기준 오프셋 위치입니다.' },
  { name: 'top', description: '위쪽 기준 오프셋 위치입니다.' },
  { name: 'right', description: '오른쪽 기준 오프셋 위치입니다.' },
  { name: 'bottom', description: '아래쪽 기준 오프셋 위치입니다.' },
  { name: 'background-color', description: '요소 배경 색상입니다.' },
  { name: 'background-image', description: '요소 배경 이미지 (url(...) 또는 resource(...))입니다.' },
  { name: 'border-radius', description: '테두리 모서리 둥글기 단축 속성입니다.' },
  { name: 'border-width', description: '테두리 두께 단축 속성입니다.' },
  { name: 'border-color', description: '테두리 색상 단축 속성입니다.' },
  { name: 'color', description: '텍스트 및 전경 색상입니다.' },
  { name: 'font-size', description: '텍스트 글꼴 크기(px)입니다.' },
  { name: 'opacity', description: '요소 불투명도 (0 ~ 1)입니다.' },
  { name: 'display', description: '레이아웃 표시 여부 (flex | none)입니다.' },
  { name: 'visibility', description: '요소 가시성 (visible | hidden)입니다.' },
  { name: 'overflow', description: '영역을 넘치는 콘텐츠 처리 (visible | hidden)입니다.' },
  { name: 'translate', description: '2D 이동 변환 (<length> <length>)입니다.' },
  { name: 'scale', description: '2D 스케일 변환 (<number> [<number>])입니다.' },
  { name: 'rotate', description: '2D 회전 변환 (<angle>)입니다.' },
  { name: 'transition-property', description: '애니메이션 트랜지션을 적용할 USS 속성 목록입니다.' },
  { name: 'transition-duration', description: '트랜지션 지속 시간 (예: 0.2s, 200ms)입니다.' },
];

const UNITY_USS_PSEUDO_STATES: readonly string[] = [
  'hover',
  'active',
  'inactive',
  'focus',
  'selected',
  'disabled',
  'enabled',
  'checked',
  'root',
];

function isExistingFile(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isExistingDirectory(dirPath: string): boolean {
  try {
    return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function walkUiToolkitFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  const stack = [path.resolve(dir)];
  const visitedRealDirs = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isSymbolicLink()) {
        try {
          const st = fs.statSync(full);
          if (st.isDirectory()) {
            const real = fs.realpathSync(full);
            if (!visitedRealDirs.has(real)) {
              visitedRealDirs.add(real);
              stack.push(full);
            }
          } else if (st.isFile() && /\.(?:uxml|uss)$/i.test(entry.name)) {
            out.push(full);
          }
        } catch {
          // Ignore broken symlinks
        }
      } else if (entry.isFile() && /\.(?:uxml|uss)$/i.test(entry.name)) {
        out.push(full);
      }
    }
  }
  return out;
}

function maskBlockCommentsPreservingNewlines(source: string): string {
  return source.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, (block) =>
    block.replace(/[^\n]/g, ' '),
  );
}

function isInsideUnclosedBlockComment(source: string): boolean {
  const lastOpen = source.lastIndexOf('/*');
  if (lastOpen < 0) return false;
  const lastClose = source.lastIndexOf('*/', source.length);
  return lastClose < lastOpen;
}

export function collectUiToolkitElements(projectRoot: string): UiToolkitElementRef[] {
  const files = [
    ...walkUiToolkitFiles(path.join(projectRoot, 'Assets')),
    ...walkUiToolkitFiles(path.join(projectRoot, 'Packages')),
    ...walkUiToolkitFiles(path.join(projectRoot, 'Library', 'PackageCache')),
  ];
  const results: UiToolkitElementRef[] = [];

  for (const filePath of files) {
    let text: string;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    const lower = filePath.toLowerCase();

    if (lower.endsWith('.uxml')) {
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const nameRe = /\bname\s*=\s*"([^"]+)"/g;
        let m: RegExpExecArray | null;
        while ((m = nameRe.exec(line)) !== null) {
          if (m[1]) results.push({ name: m[1], assetPath: filePath, line: i });
        }
        const classRe = /\bclass\s*=\s*"([^"]+)"/g;
        while ((m = classRe.exec(line)) !== null) {
          for (const cls of m[1].split(/\s+/)) {
            if (cls) results.push({ className: cls, assetPath: filePath, line: i });
          }
        }
      }
    } else if (lower.endsWith('.uss')) {
      const lines = maskBlockCommentsPreservingNewlines(text).split(/\r?\n/);
      let depth = 0;
      for (let i = 0; i < lines.length; i++) {
        const cleaned = lines[i];
        const strippedAtImport = cleaned.replace(/@(?:import|charset|namespace)\b[^;\n]*(?:;|$)/gi, '');
        if (depth === 0) {
          const selPart = strippedAtImport.split('{')[0];
          const classSelRe = /\.([A-Za-z_][A-Za-z0-9_-]*)/g;
          let m: RegExpExecArray | null;
          while ((m = classSelRe.exec(selPart)) !== null) {
            results.push({ className: m[1], assetPath: filePath, line: i });
          }
          const idSelRe = /#([A-Za-z_][A-Za-z0-9_-]*)/g;
          while ((m = idSelRe.exec(selPart)) !== null) {
            results.push({ name: m[1], assetPath: filePath, line: i });
          }
        }
        for (const ch of strippedAtImport) {
          if (ch === '{') depth++;
          else if (ch === '}') depth = Math.max(0, depth - 1);
        }
      }
    }
  }

  return results;
}

export class UnityUssCompletionProvider implements vscode.CompletionItemProvider {
  private readonly getElements: () => readonly UiToolkitElementRef[];

  constructor(getElements: () => readonly UiToolkitElementRef[]) {
    this.getElements = getElements;
  }

  public provideCompletionItems(
    doc: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] | undefined {
    const fileName = doc.fileName || doc.uri.fsPath || '';
    if (doc.languageId !== 'uss' && !fileName.toLowerCase().endsWith('.uss')) return undefined;
    const lineBefore = doc.lineAt(position.line).text.slice(0, position.character);

    const textBefore = doc.getText(new vscode.Range(new vscode.Position(0, 0), position));
    if (isInsideUnclosedBlockComment(textBefore)) return undefined;
    const cleanedBefore = maskBlockCommentsPreservingNewlines(textBefore).replace(
      /@(?:import|charset|namespace)\b[^;\n]*(?:;|$)/gi,
      '',
    );
    let braceDepth = 0;
    for (const ch of cleanedBefore) {
      if (ch === '{') braceDepth++;
      else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
    }

    if (/^\s*@(?:import|charset|namespace)\b/i.test(lineBefore)) {
      return undefined;
    }

    // 1. Pseudo-states after `:` at selector level (outside declaration `{}`)
    if (braceDepth === 0 && /:([A-Za-z-]*)$/.test(lineBefore) && !lineBefore.includes(';')) {
      return UNITY_USS_PSEUDO_STATES.map((state) => {
        const item = new vscode.CompletionItem(state, vscode.CompletionItemKind.EnumMember);
        item.detail = '[UnityBrain] UI Toolkit USS 의사 상태 (Pseudo-state)';
        item.documentation = `[UnityBrain] ':${state}' 상태 선택자입니다.`;
        return item;
      });
    }

    // 2. Class `.` or `#` ID selectors from UXML at selector level
    if (braceDepth === 0 && /(?:^|[\s>,])([.#])([A-Za-z0-9_-]*)$/.test(lineBefore)) {
      const isId = /(?:^|[\s>,])#([A-Za-z0-9_-]*)$/.test(lineBefore);
      const items: vscode.CompletionItem[] = [];
      const seen = new Set<string>();
      for (const el of this.getElements()) {
        const val = isId ? el.name : el.className;
        if (!val || seen.has(val)) continue;
        seen.add(val);
        const item = new vscode.CompletionItem(
          val,
          isId ? vscode.CompletionItemKind.Field : vscode.CompletionItemKind.Class,
        );
        item.detail = `[UnityBrain] ${path.basename(el.assetPath)}에서 추출됨`;
        items.push(item);
      }
      return items;
    }

    // 3. USS property names only inside `{ ... }` rule blocks (skip value side after `:`)
    if (braceDepth <= 0) {
      return undefined;
    }
    const declChunk = lineBefore.slice(
      Math.max(lineBefore.lastIndexOf('{'), lineBefore.lastIndexOf(';')) + 1,
    );
    if (declChunk.includes(':')) {
      return undefined;
    }

    const prefixMatch = /([A-Za-z-][A-Za-z0-9-]*)$/.exec(lineBefore);
    const replaceRange = prefixMatch
      ? new vscode.Range(
          new vscode.Position(position.line, position.character - prefixMatch[1].length),
          position,
        )
      : undefined;

    return UNITY_USS_PROPERTIES.map((prop) => {
      const item = new vscode.CompletionItem(prop.name, vscode.CompletionItemKind.Property);
      item.detail = prop.name.startsWith('-unity-')
        ? '[UnityBrain] Unity USS 전용 스타일 속성'
        : '[UnityBrain] Unity UI Toolkit USS 스타일 속성';
      item.documentation = `[UnityBrain] ${prop.description}`;
      item.insertText = new vscode.SnippetString(`${prop.name}: $1;`);
      if (replaceRange) {
        item.range = replaceRange;
      }
      return item;
    });
  }
}

export class UnityUxmlDefinitionProvider implements vscode.DefinitionProvider {
  private readonly projectRoot: string;
  private readonly getElements: () => readonly UiToolkitElementRef[];

  constructor(
    projectRoot: string,
    getElements: () => readonly UiToolkitElementRef[],
  ) {
    this.projectRoot = path.resolve(projectRoot);
    this.getElements = getElements;
  }

  public provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Location | undefined {
    const fileName = document.fileName || document.uri.fsPath || '';
    if (!fileName.toLowerCase().endsWith('.uxml')) return undefined;

    const lineText = document.lineAt(position.line).text;
    const attrRe = /\b([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(["'])([^"']*)\2/g;
    let match: RegExpExecArray | null;

    while ((match = attrRe.exec(lineText)) !== null) {
      const attrName = match[1];
      const quoteChar = match[2];
      const attrValue = match[3];
      const openQuoteIdx = match.index + match[0].indexOf(quoteChar);
      const valueStart = openQuoteIdx + 1;
      const valueEnd = valueStart + attrValue.length;

      if (position.character < openQuoteIdx || position.character > valueEnd) {
        continue;
      }

      if (attrName === 'src') {
        const resolved = this.resolveUxmlSrcPath(attrValue, document.uri.fsPath || fileName);
        if (resolved) {
          return new vscode.Location(vscode.Uri.file(resolved), new vscode.Position(0, 0));
        }
        return undefined;
      }

      if (attrName === 'class') {
        const token = this.extractTokenAtPosition(attrValue, position.character - valueStart);
        if (!token) return undefined;
        const hit = this.findUssSelectorHit(
          (el) => el.className === token,
          document.uri.fsPath || fileName,
        );
        if (hit) {
          return new vscode.Location(vscode.Uri.file(hit.assetPath), new vscode.Position(hit.line, 0));
        }
        return undefined;
      }

      if (attrName === 'name') {
        const token = attrValue.trim();
        if (!token) return undefined;
        const hit = this.findUssSelectorHit(
          (el) => el.name === token,
          document.uri.fsPath || fileName,
        );
        if (hit) {
          return new vscode.Location(vscode.Uri.file(hit.assetPath), new vscode.Position(hit.line, 0));
        }
        return undefined;
      }
    }

    return undefined;
  }

  private extractTokenAtPosition(attrValue: string, rawOffset: number): string {
    if (!attrValue) return '';
    const offset = Math.max(0, Math.min(attrValue.length, rawOffset));
    let left = offset;
    while (left > 0 && !/\s/.test(attrValue[left - 1])) {
      left--;
    }
    let right = offset;
    while (right < attrValue.length && !/\s/.test(attrValue[right])) {
      right++;
    }
    return attrValue.slice(left, right);
  }

  private findUssSelectorHit(
    predicate: (el: UiToolkitElementRef) => boolean,
    currentDocPath: string,
  ): UiToolkitElementRef | undefined {
    const matches = this.getElements().filter(
      (el) =>
        predicate(el) &&
        el.assetPath.toLowerCase().endsWith('.uss') &&
        isExistingFile(el.assetPath),
    );
    if (matches.length === 0) return undefined;
    const docDir = path.dirname(path.resolve(currentDocPath));
    return (
      matches.find((el) => path.dirname(path.resolve(el.assetPath)) === docDir) ?? matches[0]
    );
  }

  private resolveUxmlSrcPath(rawSrc: string, currentDocPath: string): string | undefined {
    let cleaned = rawSrc.trim().replace(/[?#].*$/, '');
    if (!cleaned) return undefined;

    cleaned = cleaned.replace(/^project:\/\/database\/?/i, '');
    try {
      cleaned = decodeURIComponent(cleaned);
    } catch {
      // Keep raw path if percent-encoding is malformed
    }
    cleaned = cleaned.replace(/\\/g, '/');
    if (!cleaned) return undefined;

    const docDir = path.dirname(path.resolve(currentDocPath));
    const withoutLeadingSlash = cleaned.replace(/^\/+/, '');
    const candidates: string[] = [];

    if (!cleaned.startsWith('/')) {
      candidates.push(path.resolve(docDir, cleaned));
    }
    if (withoutLeadingSlash) {
      candidates.push(path.resolve(this.projectRoot, withoutLeadingSlash));
      if (!/^Assets\//i.test(withoutLeadingSlash) && !/^Packages\//i.test(withoutLeadingSlash)) {
        candidates.push(path.resolve(this.projectRoot, 'Assets', withoutLeadingSlash));
      }
    }

    const pkgMatch = /^Packages\/([^/]+)\/(.+)$/i.exec(withoutLeadingSlash);
    if (pkgMatch) {
      const pkgName = pkgMatch[1];
      const rest = pkgMatch[2];
      const cacheRoot = path.join(this.projectRoot, 'Library', 'PackageCache');
      if (isExistingDirectory(cacheRoot)) {
        try {
          const entries = fs.readdirSync(cacheRoot, { withFileTypes: true });
          const matchingDirs = entries
            .filter((entry) => {
              const entryDir = path.join(cacheRoot, entry.name);
              const isDir = entry.isDirectory() || (entry.isSymbolicLink() && isExistingDirectory(entryDir));
              return isDir && (entry.name === pkgName || entry.name.startsWith(`${pkgName}@`));
            })
            .map((entry) => entry.name)
            .sort()
            .reverse();
          for (const dirName of matchingDirs) {
            candidates.push(path.resolve(cacheRoot, dirName, rest));
          }
        } catch {
          // Ignore unreadable PackageCache
        }
      }
    }

    for (const candidate of candidates) {
      if (isExistingFile(candidate)) {
        return candidate;
      }
    }

    return undefined;
  }
}
