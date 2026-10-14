// 表格外拖选进表格时选区被吞掉的修正（tableSelectionFix）
// 验证一端在表格外、终点落在段落开头的文本选区不再被收缩成单元格光标；两端都在单元格内的规整规则保持不变

import { afterAll, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { EditorState, TextSelection, type Plugin } from '@tiptap/pm/state';
import { tableEditing } from '@tiptap/pm/tables';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import { fixTableEditingSelection } from '../../src/features/editor-md/tableSelectionFix';

// 未挂载的编辑器只用来取 schema 与文档
const editor = new Editor({ element: null, extensions: buildExtensions('table-selection-fix-test'), content: '' });

afterAll(() => {
  editor.destroy();
});

// 文档结构：3x3 空表格（占 0~44）+ 段落 1111（44~50）+ 空段落（50~52）+ 段落 abc（52~57）
const row = (tag: string) => `<tr>${`<${tag}><p></p></${tag}>`.repeat(3)}</tr>`;
editor.commands.setContent(`<table>${row('th')}${row('td')}${row('td')}</table><p>1111</p><p></p><p>abc</p>`);
const doc = editor.state.doc;

/** 在只装配表格编辑插件的状态上设置文本选区，返回经插件规整后的锚点与焦点 */
function select(plugins: Plugin[], anchor: number, head: number) {
  const state = EditorState.create({ doc, plugins });
  const { state: next } = state.applyTransaction(state.tr.setSelection(TextSelection.create(doc, anchor, head)));
  return { anchor: next.selection.anchor, head: next.selection.head };
}

const fixed = () => fixTableEditingSelection([tableEditing()]);

describe('表格选区规整修正', () => {
  it('官方规则会把「表格外空段落 → 单元格」的选区收缩成单元格光标（修正前的问题）', () => {
    expect(select([tableEditing()], 51, 4)).toEqual({ anchor: 4, head: 4 });
  });

  it('从表格外的空段落向上拖进表格：选区保留', () => {
    expect(select(fixed(), 51, 4)).toEqual({ anchor: 51, head: 4 });
  });

  it('从表格外的段落开头向上拖进表格：选区保留', () => {
    expect(select(fixed(), 53, 4)).toEqual({ anchor: 53, head: 4 });
  });

  it('从单元格向下拖到表格外的段落开头：选区保留', () => {
    expect(select(fixed(), 4, 45)).toEqual({ anchor: 4, head: 45 });
  });

  it('从段落文字末尾拖进表格（原本就正常）：选区保留', () => {
    expect(select(fixed(), 56, 4)).toEqual({ anchor: 56, head: 4 });
  });

  it('两端都在单元格内、终点落在下一格开头：仍按原规则收缩到起点单元格', () => {
    // 第一个表头单元格内（4）到第二个表头单元格开头（8）
    expect(select(fixed(), 4, 8)).toEqual({ anchor: 4, head: 4 });
  });

  it('编辑器实际装配的插件已接入修正', () => {
    expect(select(editor.extensionManager.plugins, 51, 4)).toEqual({ anchor: 51, head: 4 });
  });
});
