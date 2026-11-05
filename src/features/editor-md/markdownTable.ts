// NoteBoard Markdown 表格序列化
// 官方序列化总是用空格把各列补齐，且按字符数计宽：紧凑写法的表格一进入可视化就被整表改写，
// 含中文的表格补齐后反而对不齐。这里按原文风格输出：
// - compact：每格只留一个空格（`| a | b |` / `| --- |`），原文未对齐时沿用；
// - compact-bare：同 compact，但分隔行不带空格（`|---|---|`，常见于 README）；
// - aligned：按显示宽度（中日韩全角字符计 2）补齐，分隔行与内容行等宽；新建表格默认使用；
// - aligned-chars：按字符数补齐、对齐标记加在虚线外侧（旧版官方序列化的输出），保证已按它保存的文档不再变化。

import { DEFAULT_CELL_LINE_SEPARATOR } from '@tiptap/extension-table';
import type { JSONContent, MarkdownRendererHelpers, MarkdownToken } from '@tiptap/core';

export type TableMarkdownStyle = 'compact' | 'compact-bare' | 'aligned' | 'aligned-chars';

type CellAlign = 'left' | 'right' | 'center' | null;

interface RenderedCell {
  text: string;
  isHeader: boolean;
  align: CellAlign;
}

/** 字符的显示宽度：东亚宽字符与全角符号、常见表情计 2，其余计 1 */
function charWidth(codePoint: number): number {
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** 文本在等宽字体下的显示宽度 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) width += charWidth(character.codePointAt(0) ?? 0);
  return width;
}

/** 所有行的宽度是否一致 */
function allEqual(lines: string[], measure: (line: string) => number): boolean {
  const first = measure(lines[0]);
  return lines.every((line) => measure(line) === first);
}

/**
 * 从表格原文识别书写风格（解析时调用）。
 * 1. 单元格没有多余补齐空格、分隔行均为 3 个短横线时为紧凑写法（单字符单元格的紧凑表格各行也可能碰巧等宽）；
 * 2. 否则比较内容行（表头 + 数据行）是否等宽；仅有表头时才把分隔行纳入比较。
 */
export function detectTableMarkdownStyle(raw: string): TableMarkdownStyle {
  const lines = raw.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim() !== '');
  if (lines.length < 2) return 'compact';
  const delimiter = lines[1];
  const contentLines = lines.length > 2 ? [lines[0], ...lines.slice(2)] : lines;
  const hasPadding = contentLines.some((line) => /[^\s|] {2,}\|/.test(line));
  const delimiterCells = delimiter.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|');
  if (!hasPadding && delimiterCells.every((cell) => /^:?-{3}:?$/.test(cell.trim()))) {
    // 分隔行完全不含空白时为 `|---|---|` 写法
    return /\s/.test(delimiter.trim()) ? 'compact' : 'compact-bare';
  }
  if (allEqual(contentLines, displayWidth) && displayWidth(delimiter) === displayWidth(contentLines[0])) {
    return 'aligned';
  }
  if (allEqual(contentLines, (line) => line.length)) return 'aligned-chars';
  return 'compact';
}

/** 从 marked 的 table token 读取原文风格 */
export function tableMarkdownStyleOf(token: MarkdownToken): TableMarkdownStyle {
  return typeof token.raw === 'string' ? detectTableMarkdownStyle(token.raw) : 'aligned';
}

function normalizeAlign(value: unknown): CellAlign {
  return value === 'left' || value === 'right' || value === 'center' ? value : null;
}

/** 把表格节点渲染为单元格文本矩阵：多段以 <br> 连接，保留正文内部的连续空白。 */
function renderCells(node: JSONContent, h: MarkdownRendererHelpers): RenderedCell[][] {
  return (node.content ?? []).map((rowNode) =>
    (rowNode.content ?? []).map((cellNode) => {
      const raw =
        cellNode.content && cellNode.content.length > 1
          ? cellNode.content.map((child) => h.renderChildren(child)).join(DEFAULT_CELL_LINE_SEPARATOR)
          : cellNode.content
            ? h.renderChildren(cellNode.content)
            : '';
      // 单元格必须保持单行：换行转为 <br>（解析器会把 <br> 还原为硬换行）
      const text = raw
        .split(DEFAULT_CELL_LINE_SEPARATOR)
        .join('\n')
        .replace(/[ \t]*\r?\n[ \t]*/g, '<br>')
        // 单元格两侧的排版空格可去除；词间空格、制表符和不间断空格属于正文，不能全局折叠。
        .trim();
      return { text, isHeader: cellNode.type === 'tableHeader', align: normalizeAlign(cellNode.attrs?.align) };
    }),
  );
}

/** 分隔行单元格：dashCount 个短横线，对齐冒号加在两侧 */
function delimiterCell(align: CellAlign, dashCount: number): string {
  const dashes = '-'.repeat(dashCount);
  if (align === 'left') return `:${dashes}`;
  if (align === 'right') return `${dashes}:`;
  if (align === 'center') return `:${dashes}:`;
  return dashes;
}

/** 按指定风格把表格节点序列化为 Markdown（首尾带换行，与官方实现一致，由调用方修剪） */
export function renderTableMarkdown(
  node: JSONContent,
  h: MarkdownRendererHelpers,
  style: TableMarkdownStyle,
): string {
  const rows = renderCells(node, h);
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (columnCount === 0) return '';

  // 每列对齐方式取该列第一个设置了对齐的单元格
  const alignments: CellAlign[] = Array.from({ length: columnCount }, (_, index) =>
    rows.find((row) => row[index]?.align)?.[index]?.align ?? null,
  );

  // 表头：文档有表头行时使用，否则输出空表头，保证解析器仍能识别为表格
  const hasHeader = rows[0].some((cell) => cell.isHeader);
  const headerTexts = Array.from({ length: columnCount }, (_, index) => (hasHeader ? rows[0][index]?.text ?? '' : ''));
  const bodyTexts = (hasHeader ? rows.slice(1) : rows).map((row) =>
    Array.from({ length: columnCount }, (_, index) => row[index]?.text ?? ''),
  );
  const line = (cells: string[]) => `| ${cells.join(' | ')} |\n`;

  if (style === 'compact' || style === 'compact-bare') {
    const delimiterCells = alignments.map((align) => delimiterCell(align, 3));
    const delimiterLine = style === 'compact-bare' ? `|${delimiterCells.join('|')}|\n` : line(delimiterCells);
    return `\n${line(headerTexts)}${delimiterLine}${bodyTexts.map(line).join('')}`;
  }

  const measure = style === 'aligned' ? displayWidth : (text: string) => text.length;
  // 列宽至少为 3，保证分隔行能写下 `---` / `:-:`
  const widths = Array.from({ length: columnCount }, (_, index) =>
    Math.max(3, measure(headerTexts[index]), ...bodyTexts.map((row) => measure(row[index]))),
  );
  const pad = (text: string, index: number) => text + ' '.repeat(Math.max(0, widths[index] - measure(text)));
  const delimiters = alignments.map((align, index) => {
    if (style === 'aligned-chars') return delimiterCell(align, widths[index]);
    // aligned：对齐标记计入列宽，分隔行与内容行等宽
    const colons = align === 'center' ? 2 : align ? 1 : 0;
    return delimiterCell(align, widths[index] - colons);
  });

  return `\n${line(headerTexts.map(pad))}${line(delimiters)}${bodyTexts.map((row) => line(row.map(pad))).join('')}`;
}
