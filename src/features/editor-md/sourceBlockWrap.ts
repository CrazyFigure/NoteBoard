// NoteBoard 源码模式：把选区所在的整行包进块级写法（提示块、高亮块、折叠块、代码块、引用块）
// 与可视化模式「有选区时选中内容成为块正文」保持一致：按整行（对应可视化的整块）包裹，不拆分行内文字

import type { Text } from '@codemirror/state';
import { renderFencedCode } from './markdownFence';

/** 一次源码替换：替换范围、插入文本与插入后的选区 */
export interface SourceWrapEdit {
  from: number;
  to: number;
  insert: string;
  anchor: number;
  head: number;
}

/**
 * 计算把 [from, to] 覆盖的整行包成块的替换
 * - 选区止于下一行行首时不包含该行；首尾空行不进入正文
 * - 与上下相邻的非空行之间补空行，避免块与相邻段落粘连（如引用块的惰性续行吞掉下一段）
 * - 选中的全是空行时返回 null，由调用方按无选区处理
 */
export function wrapSourceLines(doc: Text, from: number, to: number, wrap: (body: string) => string): SourceWrapEdit | null {
  const first = doc.lineAt(from);
  const last = doc.lineAt(to > from && doc.lineAt(to).from === to ? to - 1 : to);
  const lines = doc.sliceString(first.from, last.to).split('\n');
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length === 0) return null;

  const block = wrap(lines.join('\n'));
  const before = first.number > 1 && doc.line(first.number - 1).text.trim() !== '' ? '\n' : '';
  const after = last.number < doc.lines && doc.line(last.number + 1).text.trim() !== '' ? '\n' : '';
  // 包裹后选中整个新块，与工具栏加粗等包裹操作一致
  const anchor = first.from + before.length;
  return { from: first.from, to: last.to, insert: `${before}${block}${after}`, anchor, head: anchor + block.length };
}

/** 每行加引用前缀（空行只留 `>`，保持在同一个引用块内） */
export function quoteSourceBlock(body: string): string {
  return body
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
    .join('\n');
}

/** GitHub 提示块写法 */
export function alertSourceBlock(kind: string, body: string): string {
  return `> [!${kind.toUpperCase()}]\n${quoteSourceBlock(body)}`;
}

/** 代码块写法：围栏长度随正文中的反引号自适应 */
export function codeSourceBlock(body: string): string {
  return renderFencedCode('', body);
}
