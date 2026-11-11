// 拖选到收起的代码块 / 折叠块上时，选区头按锚点方向对齐到块内容边界，使收起块被完整选中

import { afterAll, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import { parseMarkdown } from '../../src/features/editor-md/serialize';
import {
  alignHeadToCollapsedBlock,
  alignHeadToNonEditable,
  type CollapsedBlockRange,
  type NonEditableTarget,
} from '../../src/features/editor-md/collapsedBlockSelection';

const editor = new Editor({ element: null, extensions: buildExtensions('collapsed-block-selection-test'), content: '' });

afterAll(() => {
  editor.destroy();
});

/** 文档中第 index 个指定类型的顶层块范围 */
function blockRange(doc: ProseMirrorNode, type: string, index = 0): CollapsedBlockRange {
  const found: CollapsedBlockRange[] = [];
  doc.forEach((node, pos) => {
    if (node.type.name === type) found.push({ from: pos, to: pos + node.nodeSize });
  });
  return found[index];
}

describe('收起块的选区头对齐', () => {
  it('连续两个代码块：自下而上拖到第一个上时整块选中，不越到上方', () => {
    parseMarkdown(editor, '前文\n\n```\nniaho\n```\n\n```json\n\n```\n\n后文');
    const { doc } = editor.state;
    const first = blockRange(doc, 'codeBlock', 0);
    const anchor = doc.content.size - 1;
    const head = alignHeadToCollapsedBlock(doc, first, anchor);
    expect(head).toBe(first.from + 1);
    expect(doc.textBetween(head!, anchor, '|')).toBe('niaho||后文');
  });

  it('自上而下拖到第一个代码块上时止于块尾，不越到第二个代码块', () => {
    const { doc } = editor.state;
    const first = blockRange(doc, 'codeBlock', 0);
    const head = alignHeadToCollapsedBlock(doc, first, 1);
    expect(head).toBe(first.to - 1);
    expect(doc.textBetween(1, head!, '|')).toBe('前文|niaho');
  });

  it('空代码块同样可以对齐', () => {
    const { doc } = editor.state;
    const empty = blockRange(doc, 'codeBlock', 1);
    expect(alignHeadToCollapsedBlock(doc, empty, 1)).toBe(empty.from + 1);
    expect(alignHeadToCollapsedBlock(doc, empty, doc.content.size - 1)).toBe(empty.from + 1);
  });

  it('折叠块：对齐到正文首末段落', () => {
    parseMarkdown(editor, '前文\n\n<details>\n<summary>标题</summary>\n\n第一段\n\n第二段\n\n</details>\n\n后文');
    const { doc } = editor.state;
    const details = blockRange(doc, 'detailsBlock');
    const down = alignHeadToCollapsedBlock(doc, details, 1);
    expect(doc.textBetween(1, down!, '|')).toBe('前文|第一段|第二段');
    const anchor = doc.content.size - 1;
    const up = alignHeadToCollapsedBlock(doc, details, anchor);
    expect(doc.textBetween(up!, anchor, '|')).toBe('第一段|第二段|后文');
  });

  it('锚点在块内时不修正', () => {
    parseMarkdown(editor, '```\nabc\n```');
    const { doc } = editor.state;
    const block = blockRange(doc, 'codeBlock');
    expect(alignHeadToCollapsedBlock(doc, block, block.from + 2)).toBeNull();
  });
});

/** 文档中第 index 个指定类型节点（任意层级）的范围；at 取节点开头，对应正文前的装饰区（复选框、标题栏） */
function nodeTarget(doc: ProseMirrorNode, type: string, index = 0): NonEditableTarget {
  const found: NonEditableTarget[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === type) found.push({ from: pos, to: pos + node.nodeSize, at: node.isLeaf ? pos : pos + 1 });
  });
  return found[index];
}

describe('不可编辑区域的选区头对齐', () => {
  it('任务复选框：自下而上拖到第一项复选框上时整项选中', () => {
    parseMarkdown(editor, '- [x] 第一项\n- [x] 第二项\n- [ ] \n\n末段');
    const { doc } = editor.state;
    const anchor = doc.content.size - 1;
    const head = alignHeadToNonEditable(doc, nodeTarget(doc, 'taskItem', 0), anchor);
    expect(doc.textBetween(head!, anchor, '|')).toBe('第一项|第二项||末段');
  });

  it('任务复选框：自上而下拖到某项复选框上时止于该项正文开头', () => {
    const { doc } = editor.state;
    const head = alignHeadToNonEditable(doc, nodeTarget(doc, 'taskItem', 1), 3);
    expect(doc.textBetween(3, head!, '|')).toBe('第一项|');
  });

  it('嵌套任务：拖到父项复选框上时对齐到父项自身正文，而非子任务', () => {
    parseMarkdown(editor, '- [ ] 父项\n  - [ ] 子项\n\n末段');
    const { doc } = editor.state;
    const anchor = doc.content.size - 1;
    const head = alignHeadToNonEditable(doc, nodeTarget(doc, 'taskItem', 0), anchor);
    expect(doc.textBetween(head!, anchor, '|')).toBe('父项|子项|末段');
  });

  it('原子节点（分割线）：按锚点方向越过整个节点', () => {
    parseMarkdown(editor, '前文\n\n---\n\n后文');
    const { doc } = editor.state;
    const rule = nodeTarget(doc, 'horizontalRule');
    const up = alignHeadToNonEditable(doc, rule, doc.content.size - 1);
    expect(up).toBe(rule.from - 1);
    expect(doc.textBetween(up!, doc.content.size - 1, '|')).toBe('|后文');
    const down = alignHeadToNonEditable(doc, rule, 1);
    expect(down).toBe(rule.to + 1);
    expect(doc.textBetween(1, down!, '|')).toBe('前文|');
  });

  it('装饰区位于正文之后时对齐到正文末尾', () => {
    parseMarkdown(editor, '前文\n\n- [ ] 任务\n\n后文');
    const { doc } = editor.state;
    const item = nodeTarget(doc, 'taskItem');
    const head = alignHeadToNonEditable(doc, { ...item, at: item.to - 1 }, 1);
    expect(doc.textBetween(1, head!, '|')).toBe('前文|任务');
  });
});
