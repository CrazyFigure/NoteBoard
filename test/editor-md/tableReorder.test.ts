// 表格行 / 列重排内核（tableReorder）
// 行列移动、首行表头修正、光标跟随与合并单元格保护

import { afterAll, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import { getMarkdownManager, parseMarkdown } from '../../src/features/editor-md/serialize';
import {
  isTableReorderable,
  moveTableAxisTr,
  reorderIndexes,
  resolveDropIndex,
  selectTableAxisTr,
} from '../../src/features/editor-md/tableReorder';

const editor = new Editor({ element: null, extensions: buildExtensions('table-reorder-test'), content: '' });

afterAll(() => {
  editor.destroy();
});

const TABLE = '| a | b | c |\n| --- | --- | --- |\n| d | e | f |\n| g | h | i |';

/** 表格各单元格文本（按行） */
function grid(table: ProseMirrorNode): string[][] {
  const rows: string[][] = [];
  table.forEach((row) => {
    const cells: string[] = [];
    row.forEach((cell) => cells.push(`${cell.type.name === 'tableHeader' ? '#' : ''}${cell.textContent}`));
    rows.push(cells);
  });
  return rows;
}

function tablePosOf(doc: ProseMirrorNode): number {
  let found = -1;
  doc.forEach((node, pos) => {
    if (found < 0 && node.type.name === 'table') found = pos;
  });
  return found;
}

function textPos(doc: ProseMirrorNode, text: string): number {
  let result = -1;
  doc.descendants((node, pos) => {
    if (result >= 0) return false;
    if (node.isText && node.text!.includes(text)) result = pos + node.text!.indexOf(text);
    return true;
  });
  return result;
}

describe('表格行列重排', () => {
  it('reorderIndexes：移除后插入到目标下标', () => {
    expect(reorderIndexes(4, 0, 2)).toEqual([1, 2, 0, 3]);
    expect(reorderIndexes(4, 3, 1)).toEqual([0, 3, 1, 2]);
  });

  describe('resolveDropIndex：拖动落点', () => {
    // 三列等宽 0~100 / 100~200 / 200~300；位移已被限制在表格范围内
    const columns = [{ start: 0, end: 100 }, { start: 100, end: 200 }, { start: 200, end: 300 }];
    // 三行不等高：表头 0~40，正文 40~80、80~120
    const rows = [{ start: 0, end: 40 }, { start: 40, end: 80 }, { start: 80, end: 120 }];

    it('拖到第一个位置：位移到边界即可落到首位（修正前中心恰在中线、无法交换）', () => {
      expect(resolveDropIndex(columns, 1, -100)).toBe(0);
      expect(resolveDropIndex(columns, 2, -200)).toBe(0);
    });

    it('拖到最后一个位置：位移到边界即可落到末位（修正前同样无法交换）', () => {
      expect(resolveDropIndex(rows, 1, 40)).toBe(2);
      expect(resolveDropIndex(columns, 0, 200)).toBe(2);
    });

    it('前沿越过相邻元素中线才交换，未越过保持原位', () => {
      expect(resolveDropIndex(columns, 1, -49)).toBe(1);
      expect(resolveDropIndex(columns, 1, -51)).toBe(0);
      expect(resolveDropIndex(columns, 1, 49)).toBe(1);
      expect(resolveDropIndex(columns, 1, 51)).toBe(2);
      expect(resolveDropIndex(columns, 0, 160)).toBe(2);
      expect(resolveDropIndex(columns, 0, 0)).toBe(0);
    });
  });

  it('移动正文行', () => {
    parseMarkdown(editor, TABLE);
    const tr = moveTableAxisTr(editor.state, tablePosOf(editor.state.doc), 'row', 2, 1)!;
    expect(grid(tr.doc.nodeAt(tablePosOf(tr.doc))!)).toEqual([
      ['#a', '#b', '#c'], ['g', 'h', 'i'], ['d', 'e', 'f'],
    ]);
  });

  it('正文行移到首行：成为表头，原表头变为正文', () => {
    parseMarkdown(editor, TABLE);
    const tr = moveTableAxisTr(editor.state, tablePosOf(editor.state.doc), 'row', 2, 0)!;
    expect(grid(tr.doc.nodeAt(tablePosOf(tr.doc))!)).toEqual([
      ['#g', '#h', '#i'], ['a', 'b', 'c'], ['d', 'e', 'f'],
    ]);
  });

  it('移动列：每行同步移动，Markdown 输出跟随', () => {
    parseMarkdown(editor, TABLE);
    const tr = moveTableAxisTr(editor.state, tablePosOf(editor.state.doc), 'column', 0, 2)!;
    expect(grid(tr.doc.nodeAt(tablePosOf(tr.doc))!)).toEqual([
      ['#b', '#c', '#a'], ['e', 'f', 'd'], ['h', 'i', 'g'],
    ]);
    editor.view.dispatch(tr);
    expect(getMarkdownManager(editor)!.serialize!(editor.getJSON()).trim().split('\n')[0]).toBe('| b | c | a |');
  });

  it('光标跟随所在单元格移动', () => {
    parseMarkdown(editor, TABLE);
    const pos = textPos(editor.state.doc, 'e') + 1;
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)));
    const tr = moveTableAxisTr(editor.state, tablePosOf(editor.state.doc), 'column', 1, 0)!;
    const $head = tr.selection.$head;
    expect($head.parent.textContent).toBe('e');
    expect($head.parentOffset).toBe(1);
    expect(tr.doc.resolve($head.before(-1)).index()).toBe(0);
  });

  it('单击把手选中整行 / 整列', () => {
    parseMarkdown(editor, TABLE);
    const tablePos = tablePosOf(editor.state.doc);
    const row = selectTableAxisTr(editor.state, tablePos, 'row', 1)!.selection as CellSelection;
    expect(row).toBeInstanceOf(CellSelection);
    expect(row.isRowSelection()).toBe(true);
    const col = selectTableAxisTr(editor.state, tablePos, 'column', 2)!.selection as CellSelection;
    expect(col.isColSelection()).toBe(true);
    const texts: string[] = [];
    col.forEachCell((cell) => texts.push(cell.textContent));
    expect(texts).toEqual(['c', 'f', 'i']);
  });

  it('含合并单元格的表格不支持重排', () => {
    editor.commands.setContent('<table><tr><th colspan="2"><p>a</p></th></tr><tr><td><p>b</p></td><td><p>c</p></td></tr></table>');
    const tablePos = tablePosOf(editor.state.doc);
    expect(isTableReorderable(editor.state.doc.nodeAt(tablePos)!)).toBe(false);
    expect(moveTableAxisTr(editor.state, tablePos, 'row', 1, 0)).toBeNull();
  });
});
