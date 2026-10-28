// 中文标点紧邻粗体闭合标记时，连接词不能被扩入粗体范围，源码也不能被合并改写。
import { afterAll, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { Marked } from 'marked';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import { getMarkdownManager, parseMarkdown, serializeMarkdown, serializeMarkdownFromDoc } from '../../src/features/editor-md/serialize';
import { createIsolatedMarkdownParser } from '../../src/features/editor-md/markdownBlockStart';

const editor = new Editor({ element: null, extensions: buildExtensions('bold-boundary'), content: '' });
afterAll(() => editor.destroy());

/** 读取实际文本节点上的粗体范围，而不是只比较同一个解析器往返后的等价性。 */
function boldRanges(): string[] {
  const ranges: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.isText && node.marks.some((mark) => mark.type.name === 'bold')) ranges.push(node.text ?? '');
  });
  return ranges;
}

describe('中文粗体边界', () => {
  it('两个括号结尾的粗体片段之间的“和”保持普通文本', () => {
    const source = '**Window Cache（小容量LRU）**和**Main Cache（两层）**';
    expect(parseMarkdown(editor, source)).toBe(true);
    expect(boldRanges()).toEqual(['Window Cache（小容量LRU）', 'Main Cache（两层）']);
    expect(serializeMarkdown(editor)).toBe(source);
    const plainConnector = editor.state.doc.child(0).content.content.find((node) => node.text === '和');
    expect(plainConnector?.marks).toHaveLength(0);
    expect(editor.getHTML()).toContain('<strong>Window Cache（小容量LRU）</strong>和<strong>Main Cache（两层）</strong>');
  });

  it.each([
    ['中文冒号', '**提示：**正文', ['提示：']],
    ['中文引号', '**“标题”**正文', ['“标题”']],
    ['英文括号接中文', '**(A)**和**(B)**', ['(A)', '(B)']],
    ['中文括号包裹整个片段', '前文**（甲）**和**（乙）**后文', ['（甲）', '（乙）']],
    ['补充平面符号', '**完成😀**后续', ['完成😀']],
    ['首尾均有普通文字', '前文**甲）**与**乙）**后文', ['甲）', '乙）']],
    ['三个独立粗体片段', '**甲）**和**乙）**以及**丙）**', ['甲）', '乙）', '丙）']],
    ['允许段内软换行', '**第一行\n结束）**和**第二段）**', ['第一行\n结束）', '第二段）']],
    ['引用与列表中的原行结构', '> - 将缓存划分为**Window Cache（小容量LRU）**和**Main Cache（两层）**。', ['Window Cache（小容量LRU）', 'Main Cache（两层）']],
    ['表格中的加粗范围', '| 内容 |\n| --- |\n| **甲）**和**乙）** |', ['甲）', '乙）']],
  ])('%s 保持原标记与实际加粗范围', (_name, source, expected) => {
    expect(parseMarkdown(editor, source)).toBe(true);
    expect(boldRanges()).toEqual(expected);
    const serialized = serializeMarkdown(editor);
    expect(serialized).toBe(source);
    expect(parseMarkdown(editor, serialized)).toBe(true);
    expect(boldRanges()).toEqual(expected);
    expect(serializeMarkdown(editor)).toBe(source);
  });

  it('编辑普通连接词后不把新文字并入加粗范围，快照仍保留原来的范围', () => {
    const source = '**甲）**和**乙）**';
    expect(parseMarkdown(editor, source)).toBe(true);
    const snapshot = editor.state.doc;
    let connectorPosition = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === '和') connectorPosition = pos;
    });
    editor.view.dispatch(editor.state.tr.insertText('以及', connectorPosition, connectorPosition + 1));
    expect(boldRanges()).toEqual(['甲）', '乙）']);
    expect(serializeMarkdown(editor)).toBe('**甲）**以及**乙）**');
    expect(serializeMarkdownFromDoc(getMarkdownManager(editor)!, editor.schema, snapshot)).toBe(source);
  });

  it('粗体中有代码标记时，代码自身与外面的普通连接词都保持正确范围', () => {
    const source = '**甲 `code`）**和**乙）**';
    expect(parseMarkdown(editor, source)).toBe(true);
    const nodes = editor.state.doc.child(0).content.content;
    expect(nodes.find((node) => node.text === '和')?.marks).toHaveLength(0);
    expect(nodes.find((node) => node.text === 'code')?.marks.map((mark) => mark.type.name)).toEqual(['bold', 'code']);
    expect(serializeMarkdown(editor)).toBe(source);
  });

  it.each([true, false])('粗体内的行内公式保留相同标记与源码范围，双链启用状态：%s', (wikiLinks) => {
    const mathEditor = new Editor({ element: null, extensions: buildExtensions('bold-math', { wikiLinks }), content: '' });
    try {
      const source = '作为**相对时间零点（$T_0$）**重置对齐。';
      expect(parseMarkdown(mathEditor, source)).toBe(true);
      let formulaIsBold = false;
      mathEditor.state.doc.descendants((node) => {
        if (node.type.name === 'mathInline') formulaIsBold = node.marks.some((mark) => mark.type.name === 'bold');
      });
      expect(formulaIsBold).toBe(true);
      expect(serializeMarkdown(mathEditor)).toBe(source);
      expect(parseMarkdown(mathEditor, source)).toBe(true);
      expect(serializeMarkdown(mathEditor)).toBe(source);
    } finally { mathEditor.destroy(); }
  });
});

describe('原有强调与保护区域', () => {
  it.each([
    ['普通英文标点边界', '**(A)**and**(B)**'],
    ['三个星号的粗斜体', '***甲）***和***乙）***'],
    ['粗体内嵌斜体', '**外层 *斜体* 结束**'],
    ['下划线强调', '__甲）__和__乙）__'],
    ['行内代码原文', '`**甲）**和**乙）**`'],
    ['代码里的疑似闭合标记', '**示例 `**甲）**和**乙）**` 结束**'],
    ['链接目标原文', '[链接](https://example.com/**甲）**和**乙）**)'],
    ['反斜杠转义', String.raw`\*\*甲）\*\*和\*\*乙）\*\*`],
    ['内侧空白的无效标记', '** 甲）**和** 乙）**'],
  ])('%s 与原生 Marked 的分词一致', (_name, source) => {
    const parser = createIsolatedMarkdownParser();
    const native = new Marked();
    expect(parser.lexer(source)).toEqual(native.lexer(source));
  });
});
