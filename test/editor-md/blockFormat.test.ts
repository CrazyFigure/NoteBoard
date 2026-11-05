// NoteBoard 对齐 / 缩进与字体颜色往返测试
// 约束：可视化设置的格式写作固定的标准写法，重新解析后逐字一致；非标准写法原样保留，不被静默改写。

import { afterAll, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import { parseMarkdown, serializeMarkdown } from '../../src/features/editor-md/serialize';
import {
  activeBlockAlign,
  canChangeBlockIndent,
  canSetBlockAlign,
  changeBlockIndent,
  setBlockAlign,
} from '../../src/features/editor-md/blockFormat';
import { renderTextColorSource } from '../../src/features/editor-md/markdownInlineMarks';

const editor = new Editor({ element: null, extensions: buildExtensions('block-format-test'), content: '' });

afterAll(() => {
  editor.destroy();
});

/** 解析后序列化 */
function roundTrip(markdown: string): string {
  expect(parseMarkdown(editor, markdown)).toBe(true);
  return serializeMarkdown(editor);
}

/** 文档顶层节点的类型与格式属性 */
function topLevelFormats(): Array<[string, unknown, unknown]> {
  const result: Array<[string, unknown, unknown]> = [];
  editor.state.doc.forEach((node) => result.push([node.type.name, node.attrs.textAlign ?? null, node.attrs.indent ?? 0]));
  return result;
}

describe('对齐与缩进：标准写法逐字往返', () => {
  it.each([
    '<div align="center">\n\n居中段落 **粗体**\n\n</div>',
    '<div align="right">\n\n## 右对齐标题\n\n</div>',
    '<div style="margin-left: 4em">\n\n缩进两级\n\n</div>',
    '<div align="center" style="margin-left: 2em">\n\n居中且缩进\n\n</div>',
    '前文\n\n<div align="center">\n\n居中\n\n</div>\n\n后文',
    '> 引用\n>\n> <div align="right">\n>\n> 引用内右对齐\n>\n> </div>',
    '<div align="center">\n\n第一行  \n第二行\n\n</div>',
  ])('%j', (markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
  });

  it('解析为带属性的段落与标题', () => {
    roundTrip('<div align="center">\n\n居中\n\n</div>\n\n<div align="right" style="margin-left: 2em">\n\n# 标题\n\n</div>\n\n普通');
    expect(topLevelFormats()).toEqual([
      ['paragraph', 'center', 0],
      ['heading', 'right', 1],
      ['paragraph', null, 0],
    ]);
  });

  it.each([
    // 多块正文、显式左对齐、非整级缩进、额外属性、缺少空行：均为手写 HTML，原样保留
    '<div align="center">\n\n段一\n\n段二\n\n</div>',
    '<div align="left">\n\n左\n\n</div>',
    '<div style="margin-left: 3em">\n\n三\n\n</div>',
    '<div align="center" class="x">\n\n类\n\n</div>',
    '<div align="center">\n居中\n</div>',
    '<div align="center">\n\n- 列表\n\n</div>',
  ])('非标准写法原样保留：%j', (markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
    expect(topLevelFormats().every(([, align, indent]) => align === null && indent === 0)).toBe(true);
  });
});

describe('对齐与缩进：命令', () => {
  it('设置对齐后序列化为标准写法，左对齐恢复为普通段落', () => {
    roundTrip('段落一\n\n段落二');
    editor.commands.setTextSelection({ from: 1, to: 8 });
    expect(canSetBlockAlign(editor)).toBe(true);
    expect(setBlockAlign(editor, 'center')).toBe(true);
    expect(activeBlockAlign(editor)).toBe('center');
    const markdown = serializeMarkdown(editor);
    expect(markdown).toBe('<div align="center">\n\n段落一\n\n</div>\n\n<div align="center">\n\n段落二\n\n</div>');
    expect(roundTrip(markdown)).toBe(markdown);
    editor.commands.setTextSelection({ from: 1, to: 1 });
    setBlockAlign(editor, 'left');
    expect(serializeMarkdown(editor)).toBe('段落一\n\n<div align="center">\n\n段落二\n\n</div>');
  });

  it('段落缩进有上下限，空段落的格式同样可往返', () => {
    roundTrip('文字');
    editor.commands.setTextSelection(1);
    expect(canChangeBlockIndent(editor, -1)).toBe(false);
    for (let i = 0; i < 10; i += 1) changeBlockIndent(editor, 1);
    expect(canChangeBlockIndent(editor, 1)).toBe(false);
    expect(serializeMarkdown(editor)).toBe('<div style="margin-left: 12em">\n\n文字\n\n</div>');
    changeBlockIndent(editor, -1);
    expect(serializeMarkdown(editor)).toBe('<div style="margin-left: 10em">\n\n文字\n\n</div>');

    editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph', attrs: { textAlign: 'right' } }] });
    const empty = serializeMarkdown(editor);
    expect(roundTrip(empty)).toBe(empty);
    expect(topLevelFormats()).toEqual([['paragraph', 'right', 0]]);
  });

  it('列表项内不提供对齐，缩进改为调整列表层级', () => {
    roundTrip('- 一\n- 二');
    // 第二项文字位置：bulletList(0) > listItem(1) > paragraph(2) 「一」… 第二项段落从 8 开始
    editor.commands.setTextSelection(8);
    expect(canSetBlockAlign(editor)).toBe(false);
    expect(canChangeBlockIndent(editor, 1)).toBe(true);
    expect(changeBlockIndent(editor, 1)).toBe(true);
    expect(serializeMarkdown(editor)).toBe('- 一\n  - 二');
  });
});

describe('字体颜色', () => {
  it.each([
    '<span style="color: #d44c47">红字</span>',
    '前<span style="color: #337ea9">蓝 **粗体** `代码`</span>后',
    // 同时带高亮时按 schema 中标记的先后嵌套：高亮在外
    '<mark style="background-color: #bfdbfe"><span style="color: #448361">绿字蓝底</span></mark>',
    '[<span style="color: #9065b0">链接文字</span>](https://example.com)',
  ])('标准写法逐字往返：%j', (markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
    let colored = false;
    editor.state.doc.descendants((node) => {
      if (node.marks.some((mark) => mark.type.name === 'textColor' && mark.attrs.color)) colored = true;
    });
    expect(colored).toBe(true);
  });

  it.each([
    '<span style="color:red">无空格</span>',
    '<span class="x">其它 span</span>',
    '<span style="color: #d44c47"><span>嵌套</span></span>',
  ])('非标准写法原样保留：%j', (markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
  });

  it('设置颜色后序列化与源码模式写法一致', () => {
    roundTrip('彩色文字');
    editor.chain().setTextSelection({ from: 1, to: 3 }).setMark('textColor', { color: '#d9730d' }).run();
    const markdown = serializeMarkdown(editor);
    expect(markdown).toBe(`${renderTextColorSource('彩色', '#d9730d')}文字`);
    expect(roundTrip(markdown)).toBe(markdown);
  });
});
