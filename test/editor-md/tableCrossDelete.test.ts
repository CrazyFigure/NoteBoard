// 跨表格边界的文本选区删除（tableCrossDelete）
// 完整选中的表格整块删除、部分选中只清空单元格，表格结构不被打乱，也不残留单格表格

import { afterAll, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Selection, TextSelection } from '@tiptap/pm/state';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import { parseMarkdown } from '../../src/features/editor-md/serialize';
import { deleteSelectionAcrossTables } from '../../src/features/editor-md/tableCrossDelete';

const editor = new Editor({ element: null, extensions: buildExtensions('table-cross-delete-test'), content: '' });

afterAll(() => {
  editor.destroy();
});

const TABLE = '| a | b | c |\n| --- | --- | --- |\n| d | e | f |\n| g | h | i |';

/** 文档中第一个表格的位置与节点 */
function findTable(doc: ProseMirrorNode): { pos: number; node: ProseMirrorNode } {
  let found: { pos: number; node: ProseMirrorNode } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === 'table') {
      found = { pos, node };
      return false;
    }
    return true;
  });
  return found!;
}

/** 文本 text 在文档中的起始位置 */
function textPos(doc: ProseMirrorNode, text: string): number {
  let result = -1;
  doc.descendants((node, pos) => {
    if (result >= 0) return false;
    if (node.isText && node.text!.includes(text)) result = pos + node.text!.indexOf(text);
    return true;
  });
  return result;
}

/** 在 markdown 文档上按 anchor/head 选区执行跨表格删除，返回结果文档 */
function run(markdown: string, pick: (doc: ProseMirrorNode) => [number, number]) {
  parseMarkdown(editor, markdown);
  const { doc } = editor.state;
  const [anchor, head] = pick(doc);
  const state = editor.state.apply(editor.state.tr.setSelection(TextSelection.create(doc, anchor, head)));
  const tr = deleteSelectionAcrossTables(state);
  return { tr, doc: tr?.doc ?? null, selection: tr?.selection ?? null };
}

describe('跨表格选区删除', () => {
  it('从首格开头选到表格下方空段落末尾：表格与空段落一并删除，留下一个空段落（修正前残留单格表格）', () => {
    const { doc, selection } = run(`前文\n\n${TABLE}\n\n`, (d) => {
      const table = findTable(d);
      return [Selection.findFrom(d.resolve(table.pos), 1, true)!.from, d.content.size - 1];
    });
    expect(doc!.toString()).toBe('doc(paragraph("前文"), paragraph)');
    expect(selection!.$from.parent.type.name).toBe('paragraph');
    expect(selection!.from).toBe(5);
  });

  it('反向（从下方段落末尾拖到首格开头）结果相同', () => {
    const { doc } = run(`前文\n\n${TABLE}\n\n后`, (d) => {
      const table = findTable(d);
      return [d.content.size - 1, Selection.findFrom(d.resolve(table.pos), 1, true)!.from];
    });
    expect(doc!.toString()).toBe('doc(paragraph("前文"), paragraph)');
  });

  it('从上方段落中间选到末格结尾：表格整块删除，上方段落保留未选部分', () => {
    const { doc } = run(`前文\n\n${TABLE}\n\n后`, (d) => [textPos(d, '文'), textPos(d, 'i') + 1]);
    expect(doc!.toString()).toBe('doc(paragraph("前"), paragraph("后"))');
  });

  it('从上方段落开头选到末格结尾：段落与表格整块删除后补一个空段落', () => {
    const { doc, selection } = run(`前文

${TABLE}

后`, (d) => [1, textPos(d, 'i') + 1]);
    expect(doc!.toString()).toBe('doc(paragraph, paragraph("后"))');
    expect(selection!.from).toBe(1);
  });

  it('选区两端都在同一表格内：属于单元格选区范畴，不接管', () => {
    expect(run(TABLE, (d) => [textPos(d, 'a'), textPos(d, 'i') + 1]).tr).toBeNull();
  });

  it('从上方段落选到表格中间：只清空被覆盖的单元格，表格结构不变', () => {
    const { doc } = run(`前文\n\n${TABLE}\n\n后`, (d) => [textPos(d, '文'), textPos(d, 'e') + 1]);
    expect(doc!.toString()).toBe(
      'doc(paragraph("前"), table(tableRow(tableHeader(paragraph), tableHeader(paragraph), tableHeader(paragraph)), '
      + 'tableRow(tableCell(paragraph), tableCell(paragraph), tableCell(paragraph("f"))), '
      + 'tableRow(tableCell(paragraph("g")), tableCell(paragraph("h")), tableCell(paragraph("i")))), paragraph("后"))',
    );
  });

  it('从表格中间选到下方段落：清空起点之后的单元格，下方段落删除已选部分', () => {
    const { doc, selection } = run(`前文\n\n${TABLE}\n\n后面`, (d) => [textPos(d, 'h') , textPos(d, '面')]);
    expect(doc!.toString()).toBe(
      'doc(paragraph("前文"), table(tableRow(tableHeader(paragraph("a")), tableHeader(paragraph("b")), tableHeader(paragraph("c"))), '
      + 'tableRow(tableCell(paragraph("d")), tableCell(paragraph("e")), tableCell(paragraph("f"))), '
      + 'tableRow(tableCell(paragraph("g")), tableCell(paragraph), tableCell(paragraph))), paragraph("面"))',
    );
    // 光标留在起点单元格
    expect(selection!.$from.parent.type.name).toBe('paragraph');
    expect(selection!.$from.node(-1).type.name).toBe('tableCell');
  });

  it('选区不涉及表格边界时不接管', () => {
    expect(run(`前文\n\n${TABLE}\n\n后`, () => [1, 3]).tr).toBeNull();
    expect(run(`前文\n\n${TABLE}\n\n后`, (d) => [textPos(d, 'a'), textPos(d, 'a') + 1]).tr).toBeNull();
  });

  it('文档只有表格且被完整选中到末尾空段落：留下一个空段落', () => {
    const { doc } = run(`${TABLE}\n\n`, (d) => {
      const table = findTable(d);
      return [Selection.findFrom(d.resolve(table.pos), 1, true)!.from, d.content.size - 1];
    });
    expect(doc!.toString()).toBe('doc(paragraph)');
  });
});
