// NoteBoard 多色高亮往返测试
// 约束：默认黄色写作 `==x==`，其它颜色写作 `<mark style="background-color: …">x</mark>`，保存后重新解析颜色不丢失。

import { afterAll, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import type { JSONContent } from '@tiptap/core';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import { parseMarkdown, serializeMarkdown } from '../../src/features/editor-md/serialize';
import { renderHighlightSource } from '../../src/features/editor-md/markdownInlineMarks';

const editor = new Editor({ element: null, extensions: buildExtensions('highlight-color-test'), content: '' });

afterAll(() => {
  editor.destroy();
});

/** 解析后序列化 */
function roundTrip(markdown: string): string {
  expect(parseMarkdown(editor, markdown)).toBe(true);
  return serializeMarkdown(editor);
}

/** 当前文档中所有高亮文本及其颜色 */
function highlights(): Array<[string, string | null]> {
  const result: Array<[string, string | null]> = [];
  editor.state.doc.descendants((node) => {
    const mark = node.marks.find((item) => item.type.name === 'highlight');
    if (node.isText && mark) result.push([node.text ?? '', mark.attrs.color || null]);
  });
  return result;
}

/** 带高亮的文本节点 */
const highlighted = (text: string, color: string | null, extraMarks: JSONContent['marks'] = []): JSONContent => ({
  type: 'text',
  text,
  marks: [...extraMarks, { type: 'highlight', attrs: { color } }],
});

describe('多色高亮：序列化保留颜色', () => {
  it('非默认颜色写作 <mark>，默认黄色与无颜色写作 ==，且不残留冗余转义', () => {
    expect(parseMarkdown(editor, '192.168.12.79[tmn] scp 到 黄色 默认')).toBe(true);
    // 段落内文本从位置 1 开始
    editor.chain().setTextSelection({ from: 1, to: 19 }).toggleHighlight({ color: '#bbf7d0' }).run();
    editor.chain().setTextSelection({ from: 26, to: 28 }).toggleHighlight({ color: '#fef08a' }).run();
    editor.chain().setTextSelection({ from: 29, to: 31 }).toggleHighlight().run();
    const markdown = serializeMarkdown(editor);
    expect(markdown).toBe('<mark style="background-color: #bbf7d0">192.168.12.79[tmn]</mark> scp 到 ==黄色== ==默认==');
    expect(parseMarkdown(editor, markdown)).toBe(true);
    expect(highlights()).toEqual([
      ['192.168.12.79[tmn]', '#bbf7d0'],
      ['黄色', null],
      ['默认', null],
    ]);
    expect(serializeMarkdown(editor)).toBe(markdown);
  });

  it('彩色高亮内部的行内格式在往返后保持', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [highlighted('普通 ', '#bfdbfe'), highlighted('粗体', '#bfdbfe', [{ type: 'bold' }])],
      }],
    });
    const markdown = serializeMarkdown(editor);
    expect(markdown).toBe('<mark style="background-color: #bfdbfe">普通 **粗体**</mark>');
    expect(parseMarkdown(editor, markdown)).toBe(true);
    let boldHighlighted = false;
    editor.state.doc.descendants((node) => {
      if (node.text === '粗体') {
        boldHighlighted = node.marks.some((mark) => mark.type.name === 'bold')
          && node.marks.some((mark) => mark.type.name === 'highlight' && mark.attrs.color === '#bfdbfe');
      }
    });
    expect(boldHighlighted).toBe(true);
  });
});

describe('多色高亮：标准写法逐字往返', () => {
  const lossless: Array<[string, string]> = [
    ['默认高亮', 'a ==x== b'],
    ['彩色高亮', 'a <mark style="background-color: #bbf7d0">x</mark> b'],
    ['彩色与默认混排', '<mark style="background-color: #e9d5ff">紫</mark> 与 ==黄=='],
    ['列表中的彩色高亮', '- <mark style="background-color: #bbf7d0">a</mark>\n- ==b=='],
    ['内部转义保持', '<mark style="background-color: #bbf7d0">x \\*a\\*</mark>'],
  ];
  it.each(lossless)('%s', (_name, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
  });

  it('旧写法 background 简写保留原始颜色值', () => {
    expect(roundTrip('<mark style="background: #bbf7d0">x</mark>')).toBe('<mark style="background-color: #bbf7d0">x</mark>');
    expect(highlights()).toEqual([['x', '#bbf7d0']]);
  });
});

describe('源码模式高亮插入', () => {
  it('与可视化序列化写法一致', () => {
    expect(renderHighlightSource('x', '#fef08a')).toBe('==x==');
    expect(renderHighlightSource('x', '#bbf7d0')).toBe('<mark style="background-color: #bbf7d0">x</mark>');
  });

  it('不安全的颜色值不写入 style 属性', () => {
    expect(renderHighlightSource('x', '#fff" onclick="a')).toBe('==x==');
  });
});
