// 拖选到收起的代码块 / 折叠块上时，选区头按锚点方向对齐到块内容边界，使收起块被完整选中

import { afterAll, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import { parseMarkdown } from '../../src/features/editor-md/serialize';
import { alignHeadToCollapsedBlock, type CollapsedBlockRange } from '../../src/features/editor-md/collapsedBlockSelection';

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
