// NoteBoard 原始 HTML 标签扫描与空行拆块合并测试
// 约束：纯 HTML 被空行拆开时合并为一块且原文逐字不变；夹有 Markdown 的写法、折叠块等标准写法保持原有解析。

import { afterAll, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import { parseMarkdown, serializeMarkdown } from '../../src/features/editor-md/serialize';
import { isBalancedHtml, matchSplitHtmlBlock } from '../../src/features/editor-md/rawHtmlScan';

describe('标签配对：原始文本与注释', () => {
  it.each([
    ['style 中的 < 不计', '<div><style>a<b{color:red}</style></div>', true],
    ['script 中的标签不计', '<div><script>if (a<b) document.write("<p>")</script></div>', true],
    ['DOCTYPE 跳过', '<!DOCTYPE html><html><body><p>x</p></body></html>', true],
    ['style 未闭合', '<div><style>a{}</div>', false],
    ['注释未闭合', '<div><!-- </div>', false],
  ])('%s', (_name, raw, expected) => {
    expect(isBalancedHtml(raw)).toBe(expected);
  });
});

describe('空行拆块合并', () => {
  it.each([
    ['块间空行', '<div>\n<p>a</p>\n\n<p>b</p>\n</div>'],
    ['缩进的后续块', '<table>\n  <tr>\n    <td>a</td>\n\n    <td>b</td>\n  </tr>\n</table>'],
    ['style 内含空行与 Markdown 状文本', '<div>\n<style>\n.a { color: red; }\n\n# 不是标题\n</style>\n<p class="a">x</p>\n</div>'],
    ['pre 内含空行与文本', '<div>\n<pre>\nline 1\n\nline 2\n</pre>\n</div>'],
    ['整页文档', '<!DOCTYPE html>\n\n<html>\n<head>\n<style>\nbody { margin: 0; }\n</style>\n</head>\n\n<body>\n<p>x</p>\n</body>\n</html>'],
  ])('%s', (_name, raw) => {
    expect(matchSplitHtmlBlock(`${raw}\n\n正文`)).toBe(raw);
  });

  it.each([
    ['首块已配对（交还默认解析）', '<div>a</div>\n\n<p>b</p>'],
    ['中间夹 Markdown', '<div align="center">\n\n# 标题\n\n</div>'],
    ['中间夹 Markdown 图片', '<div align="center">\n\n![logo](a.png)\n\n</div>'],
    ['直到文末未闭合', '<div>\n<p>a</p>\n\n<p>b</p>'],
    ['孤立结束标签开头', '</div>\n\n<p>a</p>'],
    ['行内标签开头的段落', '<span>a\n\n<b>b</b></span>'],
    ['第 1 类 HTML 块', '<pre>\na\n\nb\n</pre>'],
    ['自动链接开头的后续块', '<div>\n\n<https://a.example>\n\n</div>'],
  ])('不合并：%s', (_name, raw) => {
    expect(matchSplitHtmlBlock(raw)).toBeNull();
  });

  it('累计扫描量耗尽后不再尝试合并', () => {
    const key = {};
    const unclosed = Array.from({ length: 200 }, (_, index) => `<div class="c${index}">\n<span>x</span>`).join('\n\n');
    // 首次尝试会扫描到文末并失败，消耗预算
    expect(matchSplitHtmlBlock(unclosed, key)).toBeNull();
    for (let round = 0; round < 20; round += 1) matchSplitHtmlBlock(unclosed, key);
    expect(matchSplitHtmlBlock('<div>\n<p>a</p>\n\n<p>b</p>\n</div>', key)).toBeNull();
    expect(matchSplitHtmlBlock('<div>\n<p>a</p>\n\n<p>b</p>\n</div>', {})).not.toBeNull();
  });
});

describe('空行拆块合并：编辑器解析与往返', () => {
  const editor = new Editor({ element: null, extensions: buildExtensions('raw-html-merge-test'), content: '' });
  afterAll(() => editor.destroy());

  /** 解析后顶层节点类型及块级 HTML 的原文 */
  function topLevel(markdown: string) {
    expect(parseMarkdown(editor, markdown)).toBe(true);
    const nodes: Array<{ type: string; raw?: string }> = [];
    editor.state.doc.forEach((node) => {
      nodes.push(node.type.name === 'rawHtmlBlock' ? { type: node.type.name, raw: String(node.attrs.raw) } : { type: node.type.name });
    });
    return nodes;
  }

  it('纯 HTML 合并为一个块，原文逐字不变', () => {
    const html = '<div class="card">\n  <h2>标题</h2>\n\n\n  <p>正文</p>\n</div>';
    const markdown = `前文\n\n${html}\n\n后文`;
    expect(topLevel(markdown)).toEqual([{ type: 'paragraph' }, { type: 'rawHtmlBlock', raw: html }, { type: 'paragraph' }]);
    expect(serializeMarkdown(editor)).toBe(markdown);
  });

  it('README 写法保持拆开，中间的 Markdown 仍是标题', () => {
    const markdown = '<div align="center">\n\n# 标题\n\n段落\n\n</div>';
    expect(topLevel(markdown).map((node) => node.type)).toEqual(['rawHtmlBlock', 'heading', 'paragraph', 'rawHtmlBlock']);
    expect(serializeMarkdown(editor)).toBe(markdown);
  });

  it('只包裹一个标题的居中写法解析为居中标题', () => {
    const markdown = '<div align="center">\n\n# 标题\n\n</div>';
    expect(topLevel(markdown).map((node) => node.type)).toEqual(['heading']);
    expect(editor.state.doc.firstChild?.attrs.textAlign).toBe('center');
    expect(serializeMarkdown(editor)).toBe(markdown);
  });

  it('标准写法的折叠块仍由折叠块解析', () => {
    const markdown = '<details>\n<summary>标题</summary>\n\n<p>正文</p>\n\n</details>';
    expect(topLevel(markdown).map((node) => node.type)).toEqual(['detailsBlock']);
  });

  it('列表内的拆开 HTML 同样合并', () => {
    const markdown = '- 项目\n\n  <div>\n  <p>a</p>\n\n  <p>b</p>\n  </div>';
    expect(parseMarkdown(editor, markdown)).toBe(true);
    const raws: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'rawHtmlBlock') raws.push(String(node.attrs.raw));
    });
    expect(raws).toEqual(['<div>\n<p>a</p>\n\n<p>b</p>\n</div>']);
  });
});
