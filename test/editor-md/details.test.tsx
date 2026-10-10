// NoteBoard 折叠块（<details>）往返测试
// 规范化约束：标准写法逐字往返并解析为可编辑的折叠块；非标准写法继续按块级 HTML 原样保留。

import { afterAll, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import { parseMarkdown, serializeMarkdown } from '../../src/features/editor-md/serialize';
import {
  DEFAULT_DETAILS_SUMMARY,
  DETAILS_SOURCE_SNIPPET,
  exitDetailsFromEmptyParagraph,
  insertDetailsContent,
  matchDetailsBlock,
} from '../../src/features/editor-md/detailsExtension';
import { splitSections } from '../../src/features/editor-md/sectionDocument';

const editor = new Editor({ element: null, extensions: buildExtensions('details-test'), content: '' });

afterAll(() => {
  editor.destroy();
});

/** 解析后序列化 */
function roundTrip(markdown: string): string {
  expect(parseMarkdown(editor, markdown)).toBe(true);
  return serializeMarkdown(editor);
}

/** 当前文档所有节点类型（深度优先） */
function nodeTypes(): string[] {
  const types: string[] = [];
  editor.state.doc.descendants((node) => {
    types.push(node.type.name);
  });
  return types;
}

describe('折叠块：标准写法逐字往返', () => {
  const lossless: Array<[string, string]> = [
    ['基本写法', '<details>\n<summary>标题</summary>\n\n正文\n\n</details>'],
    ['标题含实体', '<details>\n<summary>S &amp; T &lt;x&gt;</summary>\n\nbody\n\n</details>'],
    ['open 属性', '<details open>\n<summary>默认展开</summary>\n\n正文\n\n</details>'],
    ['空正文', '<details>\n<summary>空</summary>\n\n</details>'],
    ['空标题', '<details>\n<summary></summary>\n\n正文\n\n</details>'],
    ['多块正文', '<details>\n<summary>多块</summary>\n\n# 标题\n\n- a\n- b\n\n```js\nconst a = 1;\n```\n\n> 引用\n\n</details>'],
    ['前后有其他块', 'before\n\n<details>\n<summary>x</summary>\n\nbody\n\n</details>\n\nafter\n'],
    ['嵌套折叠块', '<details>\n<summary>外层</summary>\n\n<details>\n<summary>内层</summary>\n\n内容\n\n</details>\n\n</details>'],
    ['代码围栏中的结束标签', '<details>\n<summary>x</summary>\n\n```html\n</details>\n```\n\n</details>'],
    // 列表项内块间的空行写法沿用列表序列化规则（与引用、代码块一致），此处使用其输出形式
    ['列表中的折叠块', '- item\n  <details>\n  <summary>x</summary>\n  \n  body\n  \n  </details>'],
    ['引用中的折叠块', '> <details>\n> <summary>x</summary>\n>\n> body\n>\n> </details>'],
    ['正文首尾空行', '<details>\n<summary>x</summary>\n\n\n\nbody\n\n\n\n</details>'],
  ];

  it.each(lossless)('%s', (_name, markdown) => {
    const output = roundTrip(markdown);
    expect(output).toBe(markdown);
    const firstDoc = JSON.stringify(editor.getJSON());
    expect(roundTrip(output)).toBe(output);
    expect(JSON.stringify(editor.getJSON())).toBe(firstDoc);
  });

  it('标准写法解析为折叠块，标题与 open 属性正确', () => {
    roundTrip('<details open>\n<summary>S &amp; T</summary>\n\n**粗体**\n\n</details>');
    const node = editor.state.doc.firstChild!;
    expect(node.type.name).toBe('detailsBlock');
    expect(node.attrs.summary).toBe('S & T');
    expect(node.attrs.open).toBe(true);
    expect(node.firstChild?.type.name).toBe('paragraph');
  });

  it('嵌套折叠块解析为两层节点', () => {
    roundTrip('<details>\n<summary>外</summary>\n\n<details>\n<summary>内</summary>\n\n内容\n\n</details>\n\n</details>');
    expect(nodeTypes().filter((type) => type === 'detailsBlock')).toHaveLength(2);
  });

  it('列表中的折叠块正文仍是段落', () => {
    roundTrip('- item\n\n  <details>\n  <summary>x</summary>\n\n  body\n\n  </details>');
    const types = nodeTypes();
    expect(types).toContain('detailsBlock');
    expect(types[types.indexOf('detailsBlock') + 1]).toBe('paragraph');
  });
});

describe('折叠块：非标准写法保持原样 HTML', () => {
  const preserved: Array<[string, string]> = [
    ['无空行', '<details>\n<summary>x</summary>\nbody\n</details>'],
    ['标题含标签', '<details>\n<summary><b>x</b></summary>\n\nbody\n\n</details>'],
    ['单行写法', '<details><summary>x</summary>body</details>'],
    ['带其他属性', '<details class="x">\n<summary>x</summary>\n\nbody\n\n</details>'],
    ['未闭合', '<details>\n<summary>x</summary>\n\nbody'],
    ['结束标签后紧跟文字', '<details>\n<summary>x</summary>\n\nbody\n\n</details>\nafter'],
  ];

  it.each(preserved)('%s', (_name, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
    expect(nodeTypes()).not.toContain('detailsBlock');
  });
});

describe('折叠块：可视化插入后序列化', () => {
  it('新插入的折叠块输出标准写法并可再次解析', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'x' }] },
        {
          type: 'detailsBlock',
          attrs: { summary: 'a < b & c' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }],
        },
      ],
    });
    const output = serializeMarkdown(editor);
    expect(output).toBe('x\n\n<details>\n<summary>a &lt; b &amp; c</summary>\n\nhi\n\n</details>');
    parseMarkdown(editor, output);
    expect(editor.state.doc.lastChild?.attrs.summary).toBe('a < b & c');
  });

  it('正文只有空段落时输出空正文写法', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'detailsBlock', attrs: { summary: '详情' }, content: [{ type: 'paragraph' }] }],
    });
    expect(serializeMarkdown(editor)).toBe('<details>\n<summary>详情</summary>\n\n</details>');
  });

  it('正文首尾的空段落往返稳定', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'detailsBlock',
          attrs: { summary: 'x' },
          content: [
            { type: 'paragraph' },
            { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
            { type: 'paragraph' },
          ],
        },
      ],
    });
    const output = serializeMarkdown(editor);
    expect(roundTrip(output)).toBe(output);
    expect(nodeTypes()).toContain('detailsBlock');
  });
});

describe('折叠块：菜单插入', () => {
  it('在空段落插入后光标位于折叠块正文内', () => {
    parseMarkdown(editor, 'before');
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.insertContent(insertDetailsContent());
    const details = editor.state.doc.lastChild!;
    expect(details.type.name).toBe('detailsBlock');
    expect(details.attrs.summary).toBe(DEFAULT_DETAILS_SUMMARY);
    // 光标在正文中：节点视图据此在默认收起时也先展开，并聚焦标题
    const detailsPos = editor.state.doc.content.size - details.nodeSize;
    const { from } = editor.state.selection;
    expect(from).toBeGreaterThan(detailsPos);
    expect(from).toBeLessThan(detailsPos + details.nodeSize);
    expect(serializeMarkdown(editor)).toBe('before\n\n<details>\n<summary>标题</summary>\n\n</details>');
  });

  it('正文末尾空段落按回车跳出到折叠块后方', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'detailsBlock',
          attrs: { summary: 'x' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'paragraph' }],
        },
      ],
    });
    // 光标放到折叠块内最后一个空段落
    const details = editor.state.doc.firstChild!;
    editor.commands.setTextSelection(details.nodeSize - 2);
    let next: EditorState | null = null;
    expect(exitDetailsFromEmptyParagraph(editor.state, (tr) => {
      next = editor.state.apply(tr);
    })).toBe(true);
    const result = next as unknown as EditorState;
    const types: string[] = [];
    result.doc.forEach((node) => types.push(node.type.name));
    expect(types).toEqual(['detailsBlock', 'paragraph']);
    expect(result.doc.firstChild!.childCount).toBe(1);
    expect(result.selection.$from.depth).toBe(1);
    expect(result.selection.$from.parent.type.name).toBe('paragraph');
  });

  it('非末尾空段落或唯一段落时不拦截回车', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'detailsBlock', attrs: { summary: 'x' }, content: [{ type: 'paragraph' }] }],
    });
    editor.commands.setTextSelection(2);
    expect(exitDetailsFromEmptyParagraph(editor.state, () => undefined)).toBe(false);
  });

  it('源码模式插入片段本身是标准写法', () => {
    expect(matchDetailsBlock(DETAILS_SOURCE_SNIPPET.trimStart())?.body).toBe('折叠内容');
  });
});

describe('大文档分段不切开折叠块', () => {
  it('切点落在折叠块之后', () => {
    const filler = Array.from({ length: 2400 }, (_, index) => `段落 ${index}`).join('\n\n');
    const details = `<details>\n<summary>x</summary>\n\n${Array.from({ length: 800 }, (_, index) => `内部 ${index}`).join('\n\n')}\n\n</details>`;
    const content = `${filler.slice(0, 20_000)}\n\n${details}\n\ntail`;
    for (const section of splitSections(content)) {
      const opens = section.content.match(/<details>/g)?.length ?? 0;
      const closes = section.content.match(/<\/details>/g)?.length ?? 0;
      expect(opens).toBe(closes);
    }
  });
});

describe('matchDetailsBlock', () => {
  it('结束标签只与同层配对', () => {
    const src = '<details>\n<summary>a</summary>\n\n<details>\n<summary>b</summary>\n\nx\n\n</details>\n\n</details>\n\nafter';
    const match = matchDetailsBlock(src);
    expect(match?.raw).toBe(src.slice(0, src.indexOf('\n\nafter') + 1));
    expect(match?.body).toBe('<details>\n<summary>b</summary>\n\nx\n\n</details>');
  });
});
