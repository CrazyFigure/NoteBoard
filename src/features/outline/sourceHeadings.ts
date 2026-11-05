// NoteBoard 大纲 - 源码标题提取
// 源码模式（含不挂载可视化内核的大文档）直接扫描 Markdown 原文行，不依赖 TipTap 文档。
// 识别 ATX（# 标题）与 Setext（下划线 = / -）标题，跳过文首 front matter 与围栏代码；
// 单趟线性扫描，47 万字的文档也只需数毫秒。

import type { HeadingItem } from './useHeadings';

/** 源码标题：pos 为标题所在行首偏移，[textFrom, textTo) 为标题文字在原文中的范围（重命名用） */
export interface SourceHeadingItem extends HeadingItem {
  textFrom: number;
  textTo: number;
}

// 与可视化解析器的 front matter 识别保持一致：首行 ---，首个非空内容行是 YAML 键
const FRONT_MATTER_OPEN = /^---[ \t]*$/;
const FRONT_MATTER_CLOSE = /^(?:---|\.\.\.)[ \t]*$/;
const YAML_KEY_LINE = /^[\w"'-][^:\n]*:(?:[ \t]|$)/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ATX_HEADING = /^( {0,3}#{1,6})(?:([ \t]+)(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
// 列表、引用、表格、HTML 等块会中断段落，其后的 --- / === 不能把它们变成 Setext 标题
const PARAGRAPH_INTERRUPTER = /^ {0,3}(?:[-+*][ \t]|\d+[.)][ \t]|>|\||<)/;
// 缩进代码不能开始段落（但可以作为已有段落的懒续行）
const INDENTED_CODE = /^(?: {4,}|\t)/;

/** 去掉常见行内标记，得到与可视化大纲相近的纯文本 */
function plainHeadingText(raw: string): string {
  return raw
    // 图片与链接只保留文字
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    // 双链取别名，否则取目标
    .replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_, target: string, alias?: string) => alias ?? target)
    .replace(/<[^>]+>/g, '')
    .replace(/(\*\*|__|~~|==|`)/g, '')
    .replace(/(^|[^\\])\*/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!|~=<>])/g, '$1')
    .trim();
}

/** 文首 front matter 结束行号（不存在时返回 -1） */
function findFrontMatterEnd(lines: readonly string[]): number {
  if (!FRONT_MATTER_OPEN.test(lines[0] ?? '')) return -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (FRONT_MATTER_CLOSE.test(lines[index])) {
      const firstContent = lines.slice(1, index).find((line) => line.trim() !== '');
      return firstContent !== undefined && YAML_KEY_LINE.test(firstContent) ? index : -1;
    }
  }
  return -1;
}

/**
 * 从源码行提取标题（lines 与 `text.split('\n')` 等价，可直接传入 CodeMirror 的 doc.toJSON()）
 */
export function extractSourceHeadings(lines: readonly string[]): SourceHeadingItem[] {
  const items: SourceHeadingItem[] = [];
  const frontMatterEnd = findFrontMatterEnd(lines);
  let offset = 0;
  let fence: { character: string; length: number } | null = null;
  // 当前段落的起始行号与行首偏移（-1 表示不在段落中），Setext 标题以整段为标题文字
  let paragraphStart = -1;
  let paragraphOffset = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r$/, '');
    const lineStart = offset;
    offset += lines[index].length + 1;

    if (index <= frontMatterEnd) continue;

    if (fence) {
      const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(line)?.[1];
      if (closing && closing[0] === fence.character && closing.length >= fence.length) fence = null;
      continue;
    }

    const opening = FENCE_OPEN.exec(line);
    // 反引号围栏的信息串不能再含反引号（否则是行内代码）
    if (opening && (opening[1][0] === '~' || !opening[2].includes('`'))) {
      fence = { character: opening[1][0], length: opening[1].length };
      paragraphStart = -1;
      continue;
    }

    const atx = ATX_HEADING.exec(line);
    if (atx) {
      const text = plainHeadingText(atx[3] ?? '');
      if (text) {
        const textFrom = lineStart + atx[1].length + (atx[2]?.length ?? 0);
        items.push({
          id: `h-${lineStart}`,
          level: atx[1].trim().length,
          text,
          pos: lineStart,
          textFrom,
          textTo: textFrom + (atx[3] ?? '').length,
        });
      }
      paragraphStart = -1;
      continue;
    }

    if (line.trim() === '') {
      paragraphStart = -1;
      continue;
    }

    const underline = SETEXT_UNDERLINE.exec(line);
    if (underline && paragraphStart >= 0) {
      const textLines = lines.slice(paragraphStart, index).map((part) => part.replace(/\r$/, ''));
      const text = plainHeadingText(textLines.map((part) => part.trim()).join(' '));
      if (text) {
        const leading = /^[ \t]*/.exec(textLines[0])?.[0].length ?? 0;
        const lastLine = textLines[textLines.length - 1];
        items.push({
          id: `h-${paragraphOffset}`,
          level: underline[1][0] === '=' ? 1 : 2,
          text,
          pos: paragraphOffset,
          textFrom: paragraphOffset + leading,
          textTo: lineStart - 1 - (lines[index - 1].length - lastLine.trimEnd().length),
        });
      }
      paragraphStart = -1;
      continue;
    }

    // 不跟在段落后的 --- / *** / ___ 是分隔线
    if (PARAGRAPH_INTERRUPTER.test(line) || THEMATIC_BREAK.test(line)) {
      paragraphStart = -1;
      continue;
    }
    if (paragraphStart < 0) {
      if (INDENTED_CODE.test(line)) continue;
      paragraphStart = index;
      paragraphOffset = lineStart;
    }
  }
  return items;
}
