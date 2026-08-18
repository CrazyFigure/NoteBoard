// NoteBoard 大文档分段
// markdown-it 只做块级 token 解析求安全边界
// 只在完整块边界切（不切开代码围栏/表格/frontmatter）
// 目标 24,000 / 上限 64,000
// 详见 docs/09-开发路线图.md 11.3

import MarkdownIt from 'markdown-it';

/** 目标段大小 */
export const TARGET_SECTION_SIZE = 24_000;
/** 最大段大小 */
export const MAX_SECTION_SIZE = 64_000;

/** 分段结果 */
export interface Section {
  index: number;
  start: number;
  end: number;
  content: string;
}

/**
 * 创建 markdown-it 实例（只做块级解析）
 */
function createParser(): MarkdownIt {
  return new MarkdownIt({
    html: false,
    linkify: false,
    typographer: false,
    breaks: false,
  });
}

/**
 * 查找安全切点：从 start 开始找到下一个块级边界
 * 不切开代码围栏、表格、frontmatter
 */
function findSafeCutPoint(md: MarkdownIt, content: string, start: number, maxEnd: number): number {
  // 从 start 往后扫描，找下一个空白行（段落边界）
  let pos = start;

  // 至少扫描到 TARGET_SECTION_SIZE
  const minEnd = Math.min(start + TARGET_SECTION_SIZE, content.length, maxEnd);

  while (pos < minEnd) {
    pos++;
  }

  // 从 minEnd 开始找最近的块级边界
  pos = minEnd;

  while (pos < Math.min(start + MAX_SECTION_SIZE, maxEnd)) {
    // 检查是否在代码围栏内
    if (isInsideFence(content, pos)) {
      pos++;
      continue;
    }

    // 检查是否在表格内
    if (isInsideTable(content, pos)) {
      pos++;
      continue;
    }

    // 检查是否在 frontmatter 内
    if (isInsideFrontmatter(content, pos)) {
      pos++;
      continue;
    }

    // 检查是否是块级边界（空行后非空行开头）
    if (isBlockBoundary(content, pos)) {
      return pos;
    }

    pos++;
  }

  // 如果找不到安全切点，在上限处强制切
  return Math.min(start + MAX_SECTION_SIZE, maxEnd);
}

/** 检查 pos 是否在代码围栏内 */
function isInsideFence(content: string, pos: number): boolean {
  // 从行首开始检查
  let lineStart = content.lastIndexOf('\n', pos - 1) + 1;
  const before = content.substring(0, lineStart);

  let fenceCount = 0;
  const lines = before.split('\n');
  for (const line of lines) {
    if (/^(\s*)(```|~~~)/.test(line)) {
      fenceCount++;
    }
  }
  return fenceCount % 2 === 1;
}

/** 检查 pos 是否在表格内 */
function isInsideTable(content: string, pos: number): boolean {
  let lineStart = content.lastIndexOf('\n', pos - 1) + 1;
  const before = content.substring(0, lineStart);
  const lines = before.split('\n');

  // 从后往前找，检查是否在表格内
  let inTable = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (/^\|.*\|/.test(line)) {
      inTable = true;
    } else if (line.trim() === '') {
      break;
    } else if (inTable) {
      // 表格结束
      break;
    }
  }
  return inTable;
}

/** 检查 pos 是否在 frontmatter 内 */
function isInsideFrontmatter(content: string, pos: number): boolean {
  if (!content.startsWith('---\n')) return false;
  const endMarker = content.indexOf('\n---\n', 4);
  return pos < endMarker;
}

/** 检查 pos 是否是块级边界 */
function isBlockBoundary(content: string, pos: number): boolean {
  if (pos <= 0 || pos >= content.length) return false;
  // 当前位置是行首
  if (content[pos - 1] !== '\n') return false;

  // 前一行是空行
  const prevLine = content.substring(content.lastIndexOf('\n', pos - 2) + 1, pos - 1);
  if (prevLine.trim() !== '') return false;

  // 当前行非空
  const nextLine = content.substring(pos, content.indexOf('\n', pos));
  if (nextLine.trim() === '') return false;

  return true;
}

/**
 * 将文档分段
 */
export function splitSections(content: string): Section[] {
  const md = createParser();
  const sections: Section[] = [];
  let start = 0;
  const total = content.length;

  while (start < total) {
    const end = findSafeCutPoint(md, content, start, total);
    const sectionContent = content.substring(start, end);

    sections.push({
      index: sections.length,
      start,
      end,
      content: sectionContent,
    });

    start = end;

    // 防止死循环
    if (end <= sections[sections.length - 1].start) {
      break;
    }
  }

  return sections;
}

/**
 * 回写活动段：替换原文对应区间 + 重算受影响段边界
 */
export function applySectionEdit(
  originalContent: string,
  section: Section,
  newContent: string,
): { content: string; affectedSections: number[] } {
  const before = originalContent.substring(0, section.start);
  const after = originalContent.substring(section.end);
  const newFull = before + newContent + after;

  // 重算受影响段
  const affectedSections: number[] = [];
  const sections = splitSections(newFull);
  for (const s of sections) {
    if (s.start >= section.start && s.start <= section.end + newContent.length) {
      affectedSections.push(s.index);
    }
  }

  return {
    content: newFull,
    affectedSections,
  };
}

/**
 * 从原文提取标题（分段模式专用，11.9）
 * 使用 markdown-it 解析 token
 */
export function extractHeadingsFromSource(content: string): { level: number; text: string; pos: number }[] {
  const md = createParser();
  const tokens = md.parse(content, {});
  const headings: { level: number; text: string; pos: number }[] = [];

  let pos = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'heading_open') {
      const level = parseInt(token.tag.replace('h', ''), 10);
      // 下一个 token 是 inline，包含 text
      const nextToken = tokens[i + 1];
      if (nextToken && nextToken.type === 'inline') {
        const text = nextToken.content;
        headings.push({ level, text, pos });
      }
    }
    pos += token.content.length;
  }

  return headings;
}
