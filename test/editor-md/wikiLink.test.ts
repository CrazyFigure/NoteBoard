// 双链节点：Markdown 往返逐字保留、表格竖线转义、代码中不解析
import { afterAll, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import { parseMarkdown, serializeMarkdown } from '../../src/features/editor-md/serialize';

const editor = new Editor({ element: null, extensions: buildExtensions('wiki-link-test'), content: '' });

afterAll(() => {
  editor.destroy();
});

function roundTrip(markdown: string): string {
  expect(parseMarkdown(editor, markdown)).toBe(true);
  return serializeMarkdown(editor);
}

/** 当前文档中全部双链节点的 inner 属性 */
function wikiInners(): string[] {
  const inners: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'wikiLink') inners.push(String(node.attrs.inner));
  });
  return inners;
}

describe('双链 Markdown 往返', () => {
  const lossless: Array<[string, string]> = [
    ['基本写法', '见 [[笔记]] 与 [[dir/笔记#小节|别名]]。'],
    ['当前文档标题', '回到 [[#开头]]'],
    ['列表与强调中', '- **重点** [[任务_清单]]\n- [[a*b*c]]'],
    ['表格中的显示名', '| 链接 | 说明 |\n| --- | --- |\n| [[笔记\\|别名]] | x |'],
    ['行内代码不解析', '`[[不是链接]]` 与 [[是链接]]'],
    ['转义保持为文字', '\\[\\[不是链接\\]\\]'],
    ['围栏代码不解析', '```\n[[代码]]\n```'],
    ['嵌入图片与笔记', '![[架构图.png|300]]\n\n正文 ![[笔记#小节]] 结束'],
    ['普通图片语法不受影响', '![图](a.png) 与 ![[b.png]]'],
    ['完整路径与相对路径', '[[C:/笔记/外部]] 与 [[../上级/笔记|上级]]'],
  ];

  it.each(lossless)('%s', (_name, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
  });

  it('解析为原子节点并保留原文', () => {
    roundTrip('见 [[dir/笔记#小节|别名]]，`[[代码]]`');
    expect(wikiInners()).toEqual(['dir/笔记#小节|别名']);
  });

  it('嵌入解析为 embed 属性', () => {
    roundTrip('![[图.png|300]] 与 [[链接]]');
    const embeds: boolean[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'wikiLink') embeds.push(node.attrs.embed === true);
    });
    expect(embeds).toEqual([true, false]);
    expect(editor.getText()).toContain('![[图.png|300]]');
  });

  it('表格中的竖线写入节点后不带转义', () => {
    roundTrip('| 链接 |\n| --- |\n| [[a\\|b]] |');
    expect(wikiInners()).toEqual(['a|b']);
  });

  it('纯文本通道保留原始写法', () => {
    roundTrip('前 [[笔记|别名]] 后');
    expect(editor.getText()).toContain('[[笔记|别名]]');
  });
});
