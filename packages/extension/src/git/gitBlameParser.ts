export interface GitBlameCommitInfo {
  sha: string;
  shortSha: string;
  author: string;
  authorMail: string;
  authorTime: number; // Unix seconds
  authorTz: string;
  summary: string;
  isUncommitted: boolean;
}

export interface GitBlameLineInfo {
  lineNumber: number; // 1-based line number in current file
  commit: GitBlameCommitInfo;
  isGroupStart: boolean;
}

export type GitBlameDateFormat = string;

export type GitBlameAuthorDisplay =
  | 'name'
  | 'email'
  | 'emailLocalPart'
  | 'nameAndEmail'
  | 'none';

export interface GitBlameColumnFormatOptions {
  dateFormat?: string;
  authorDisplay?: GitBlameAuthorDisplay;
  columnFormat?: string;
  columnWidth?: number;
  groupConsecutiveCommits?: boolean;
  nowMs?: number;
}

export interface GitBlameInlineFormatOptions {
  dateFormat?: string;
  authorDisplay?: GitBlameAuthorDisplay;
  inlineFormat?: string;
  nowMs?: number;
}

export const DEFAULT_BLAME_DATE_FORMAT = 'YY-MM-DD';
export const DEFAULT_BLAME_AUTHOR_DISPLAY: GitBlameAuthorDisplay = 'name';
export const DEFAULT_BLAME_COLUMN_FORMAT = '${date}  ${author}';
export const DEFAULT_BLAME_COLUMN_WIDTH = 20;
export const DEFAULT_BLAME_INLINE_FORMAT = '${author} - ${date} - ${summary}';

const UNCOMMITTED_SHA = '0000000000000000000000000000000000000000';
const HEADER_RE = /^([0-9a-f]{40})\s+(\d+)\s+(\d+)(?:\s+(\d+))?$/;
const DATE_TOKEN_RE = /YYYY|YY|MM|M|DD|D|HH|H|mm|m|ss|s/g;

export function parseGitBlamePorcelain(output: string): GitBlameLineInfo[] {
  if (!output) return [];

  const rawLines = output.split(/\r?\n/);
  const commits = new Map<string, GitBlameCommitInfo>();
  const results: GitBlameLineInfo[] = [];

  let currentSha: string | null = null;
  let currentLineNumber = 0;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!line) continue;

    if (line.startsWith('\t')) {
      if (currentSha && currentLineNumber > 0) {
        const commit = commits.get(currentSha) ?? {
          sha: currentSha,
          shortSha: currentSha.slice(0, 8),
          author: currentSha === UNCOMMITTED_SHA ? 'Not Committed Yet' : 'Unknown',
          authorMail: '',
          authorTime: 0,
          authorTz: '+0000',
          summary: '',
          isUncommitted: currentSha === UNCOMMITTED_SHA,
        };
        const prev = results.length > 0 ? results[results.length - 1] : undefined;
        const isGroupStart = !prev || prev.commit.sha !== commit.sha || prev.lineNumber + 1 !== currentLineNumber;
        results.push({
          lineNumber: currentLineNumber,
          commit,
          isGroupStart,
        });
      }
      currentSha = null;
      currentLineNumber = 0;
      continue;
    }

    if (!currentSha) {
      const m = HEADER_RE.exec(line);
      if (m) {
        const sha = m[1];
        currentSha = sha;
        currentLineNumber = Number.parseInt(m[3], 10);
        if (!commits.has(sha)) {
          const isUncommitted = sha === UNCOMMITTED_SHA;
          commits.set(sha, {
            sha,
            shortSha: isUncommitted ? '00000000' : sha.slice(0, 8),
            author: isUncommitted ? 'Not Committed Yet' : 'Unknown',
            authorMail: '',
            authorTime: 0,
            authorTz: '+0000',
            summary: '',
            isUncommitted,
          });
        }
      }
      continue;
    }

    const commit = commits.get(currentSha);
    if (!commit) continue;

    const spaceIdx = line.indexOf(' ');
    if (spaceIdx <= 0) continue;
    const key = line.slice(0, spaceIdx);
    const val = line.slice(spaceIdx + 1);

    if (key === 'author') {
      commit.author = commit.isUncommitted ? 'Not Committed Yet' : val;
    } else if (key === 'author-mail') {
      commit.authorMail = val.replace(/^<|>$/g, '');
    } else if (key === 'author-time') {
      const parsed = Number.parseInt(val, 10);
      if (!Number.isNaN(parsed)) commit.authorTime = parsed;
    } else if (key === 'author-tz') {
      commit.authorTz = val;
    } else if (key === 'summary') {
      commit.summary = val;
    }
  }

  return results;
}

export function formatBlameDate(
  authorTimeSec: number,
  format: GitBlameDateFormat = DEFAULT_BLAME_DATE_FORMAT,
  nowMs: number = Date.now(),
): string {
  const effectiveFormat =
    typeof format === 'string' && format.trim().length > 0
      ? format.trim()
      : DEFAULT_BLAME_DATE_FORMAT;

  if (!authorTimeSec || authorTimeSec <= 0) {
    if (effectiveFormat.toLowerCase() === 'relative') {
      return '--------';
    }
    const sampleLen = Math.max(4, effectiveFormat.length);
    return '-'.repeat(sampleLen);
  }

  if (effectiveFormat.toLowerCase() === 'relative') {
    const diffSec = Math.max(0, Math.floor(nowMs / 1000) - authorTimeSec);
    if (diffSec < 60) return '방금 전';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}분 전`;
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return `${diffHour}시간 전`;
    const diffDay = Math.floor(diffHour / 24);
    if (diffDay < 7) return `${diffDay}일 전`;
    const diffWeek = Math.floor(diffDay / 7);
    if (diffWeek < 5) return `${diffWeek}주 전`;
    const diffMonth = Math.floor(diffDay / 30);
    if (diffMonth < 12) return `${diffMonth}개월 전`;
    const diffYear = Math.floor(diffDay / 365);
    return `${diffYear}년 전`;
  }

  const d = new Date(authorTimeSec * 1000);
  const fullYear = String(d.getFullYear());
  const shortYear = fullYear.slice(-2);
  const monthNum = d.getMonth() + 1;
  const dayNum = d.getDate();
  const hourNum = d.getHours();
  const minNum = d.getMinutes();
  const secNum = d.getSeconds();

  const tokenMap: Record<string, string> = {
    YYYY: fullYear,
    YY: shortYear,
    MM: String(monthNum).padStart(2, '0'),
    M: String(monthNum),
    DD: String(dayNum).padStart(2, '0'),
    D: String(dayNum),
    HH: String(hourNum).padStart(2, '0'),
    H: String(hourNum),
    mm: String(minNum).padStart(2, '0'),
    m: String(minNum),
    ss: String(secNum).padStart(2, '0'),
    s: String(secNum),
  };

  return effectiveFormat.replace(DATE_TOKEN_RE, (tok) => tokenMap[tok] ?? tok);
}

export function formatFullBlameDateTime(authorTimeSec: number): string {
  if (!authorTimeSec || authorTimeSec <= 0) return '미커밋';
  return formatBlameDate(authorTimeSec, 'YYYY-MM-DD HH:mm');
}

export function extractEmailLocalPart(email: string): string {
  const cleaned = email.trim().replace(/^<|>$/g, '');
  if (!cleaned) return '';
  const atIdx = cleaned.indexOf('@');
  return atIdx > 0 ? cleaned.slice(0, atIdx) : cleaned;
}

export function formatBlameAuthor(
  commit: GitBlameCommitInfo,
  display: GitBlameAuthorDisplay = DEFAULT_BLAME_AUTHOR_DISPLAY,
): string {
  if (commit.isUncommitted) {
    return 'Not Committed Yet';
  }
  const name = commit.author || 'Unknown';
  const email = commit.authorMail.trim().replace(/^<|>$/g, '');
  const emailUser = extractEmailLocalPart(email);

  switch (display) {
    case 'email':
      return email || name;
    case 'emailLocalPart':
      return emailUser || name;
    case 'nameAndEmail':
      return email ? `${name} <${email}>` : name;
    case 'none':
      return '';
    case 'name':
    default:
      return name;
  }
}

function charDisplayWidth(codePoint: number): number {
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60)
  ) {
    return 2;
  }
  return 1;
}

export function measureDisplayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    width += charDisplayWidth(cp);
  }
  return width;
}

export function truncateDisplayWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (measureDisplayWidth(text) <= maxWidth) return text;
  if (maxWidth === 1) return '…';

  const maxPrefixWidth = maxWidth - 1;
  let out = '';
  let width = 0;
  for (const ch of text) {
    const w = charDisplayWidth(ch.codePointAt(0) ?? 0);
    if (width + w > maxPrefixWidth) {
      break;
    }
    out += ch;
    width += w;
  }
  return `${out}…`;
}

export function padOrTruncateDisplayWidth(text: string, targetWidth: number): string {
  if (targetWidth <= 0) return '';
  const truncated = truncateDisplayWidth(text, targetWidth);
  const currentWidth = measureDisplayWidth(truncated);
  if (currentWidth < targetWidth) {
    return truncated + '\u00a0'.repeat(targetWidth - currentWidth);
  }
  return truncated;
}

function toNonBreakingSpaces(text: string): string {
  return text.replace(/ /g, '\u00a0');
}

function clampColumnWidth(width: number | undefined): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) {
    return DEFAULT_BLAME_COLUMN_WIDTH;
  }
  return Math.max(6, Math.min(80, Math.round(width)));
}

export function formatBlameGutterColumnText(
  info: GitBlameLineInfo,
  dateFormatOrOptions: GitBlameDateFormat | GitBlameColumnFormatOptions = DEFAULT_BLAME_DATE_FORMAT,
  nowMsArg: number = Date.now(),
  groupConsecutiveCommitsArg = false,
): string {
  const opts: GitBlameColumnFormatOptions =
    typeof dateFormatOrOptions === 'object' && dateFormatOrOptions !== null
      ? dateFormatOrOptions
      : {
          dateFormat: dateFormatOrOptions,
          nowMs: nowMsArg,
          groupConsecutiveCommits: groupConsecutiveCommitsArg,
        };

  const totalWidth = clampColumnWidth(opts.columnWidth);
  const groupConsecutive = Boolean(opts.groupConsecutiveCommits);
  if (groupConsecutive && !info.isGroupStart) {
    return '\u00a0'.repeat(totalWidth);
  }

  if (info.commit.isUncommitted) {
    return padOrTruncateDisplayWidth(toNonBreakingSpaces('미커밋 · Not Committed'), totalWidth);
  }

  const nowMs = opts.nowMs ?? Date.now();
  const dateFormat = opts.dateFormat ?? DEFAULT_BLAME_DATE_FORMAT;
  const authorDisplay = opts.authorDisplay ?? DEFAULT_BLAME_AUTHOR_DISPLAY;
  const template =
    typeof opts.columnFormat === 'string' && opts.columnFormat.length > 0
      ? opts.columnFormat
      : DEFAULT_BLAME_COLUMN_FORMAT;

  const dateStr = formatBlameDate(info.commit.authorTime, dateFormat, nowMs);
  const rawAuthor = formatBlameAuthor(info.commit, authorDisplay);
  const rawName = info.commit.author || 'Unknown';
  const rawEmail = info.commit.authorMail.trim().replace(/^<|>$/g, '') || rawName;
  const rawEmailUser = extractEmailLocalPart(rawEmail) || rawName;
  const rawHash = info.commit.shortSha;
  const rawSummary = info.commit.summary || '';

  // Compute width of fixed tokens + literals first so variable-length author/summary
  // never pushes trailing ${date} or ${hash} off the right edge when placed first.
  const withoutFlexTokens = template
    .replace(/\$\{date\}/g, dateStr)
    .replace(/\$\{hash\}/g, rawHash)
    .replace(/\$\{(?:author|name|email|emailUser|summary)\}/g, '');
  const fixedWidth = measureDisplayWidth(withoutFlexTokens);
  const flexTokenMatches = template.match(/\$\{(?:author|name|email|emailUser|summary)\}/g) ?? [];
  const flexBudget =
    flexTokenMatches.length > 0
      ? Math.max(1, Math.floor((totalWidth - fixedWidth) / flexTokenMatches.length))
      : totalWidth;

  const rendered = template.replace(
    /\$\{(date|author|name|email|emailUser|hash|summary)\}/g,
    (_m, key: string) => {
      switch (key) {
        case 'date':
          return dateStr;
        case 'hash':
          return rawHash;
        case 'author':
          return truncateDisplayWidth(rawAuthor, flexBudget);
        case 'name':
          return truncateDisplayWidth(rawName, flexBudget);
        case 'email':
          return truncateDisplayWidth(rawEmail, flexBudget);
        case 'emailUser':
          return truncateDisplayWidth(rawEmailUser, flexBudget);
        case 'summary':
          return truncateDisplayWidth(rawSummary, flexBudget);
        default:
          return '';
      }
    },
  );

  return padOrTruncateDisplayWidth(toNonBreakingSpaces(rendered.trimEnd()), totalWidth);
}

export function formatBlameInlineText(
  info: GitBlameLineInfo,
  nowMsOrOptions: number | GitBlameInlineFormatOptions = Date.now(),
): string {
  if (info.commit.isUncommitted) {
    return '   Not Committed Yet';
  }

  const opts: GitBlameInlineFormatOptions =
    typeof nowMsOrOptions === 'number' ? { nowMs: nowMsOrOptions } : nowMsOrOptions;
  const nowMs = opts.nowMs ?? Date.now();
  const dateFormat = opts.dateFormat ?? DEFAULT_BLAME_DATE_FORMAT;
  const authorDisplay = opts.authorDisplay ?? DEFAULT_BLAME_AUTHOR_DISPLAY;
  const template =
    typeof opts.inlineFormat === 'string' && opts.inlineFormat.trim().length > 0
      ? opts.inlineFormat
      : DEFAULT_BLAME_INLINE_FORMAT;

  const dateStr = formatBlameDate(info.commit.authorTime, dateFormat, nowMs);
  const authorStr = formatBlameAuthor(info.commit, authorDisplay);
  const nameStr = info.commit.author || 'Unknown';
  const emailStr = info.commit.authorMail.trim().replace(/^<|>$/g, '') || nameStr;
  const emailUserStr = extractEmailLocalPart(emailStr) || nameStr;
  const summaryStr = info.commit.summary || '';

  let rendered = template.replace(
    /\$\{(date|author|name|email|emailUser|hash|summary)\}/g,
    (_m, key: string) => {
      switch (key) {
        case 'date':
          return dateStr;
        case 'author':
          return authorStr;
        case 'name':
          return nameStr;
        case 'email':
          return emailStr;
        case 'emailUser':
          return emailUserStr;
        case 'hash':
          return info.commit.shortSha;
        case 'summary':
          return summaryStr;
        default:
          return '';
      }
    },
  );

  // Clean up trailing or leading dangling separators when summary or author is empty
  rendered = rendered
    .replace(/\s*(?:-|·|\|)\s*$/g, '')
    .replace(/^\s*(?:-|·|\|)\s*/g, '')
    .trim();

  return rendered ? `   ${rendered}` : '';
}

export function computeHeatStripColor(
  authorTimeSec: number,
  isUncommitted: boolean,
  nowMs: number = Date.now(),
): string {
  if (isUncommitted) return '#E5C07B';
  if (!authorTimeSec || authorTimeSec <= 0) return 'rgba(130, 140, 155, 0.28)';

  const ageDays = Math.max(0, (nowMs / 1000 - authorTimeSec) / 86400);
  if (ageDays <= 3) return '#38BDF8';
  if (ageDays <= 14) return '#60A5FA';
  if (ageDays <= 60) return '#818CF8';
  if (ageDays <= 180) return 'rgba(148, 163, 184, 0.55)';
  return 'rgba(148, 163, 184, 0.25)';
}

export function computeHeatBackgroundColor(
  authorTimeSec: number,
  isUncommitted: boolean,
  nowMs: number = Date.now(),
): string {
  if (isUncommitted) return 'rgba(229, 192, 123, 0.20)';
  if (!authorTimeSec || authorTimeSec <= 0) return 'rgba(148, 163, 184, 0.04)';

  const ageDays = Math.max(0, (nowMs / 1000 - authorTimeSec) / 86400);
  if (ageDays <= 3) return 'rgba(56, 139, 253, 0.34)';
  if (ageDays <= 14) return 'rgba(56, 139, 253, 0.24)';
  if (ageDays <= 60) return 'rgba(99, 132, 244, 0.16)';
  if (ageDays <= 180) return 'rgba(148, 163, 184, 0.10)';
  return 'rgba(148, 163, 184, 0.04)';
}
