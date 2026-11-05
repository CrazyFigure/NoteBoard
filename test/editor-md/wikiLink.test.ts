// 双链节点：Markdown 往返逐字保留、表格竖线转义、代码中不解析
import { afterAll, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import { parseMarkdown, serializeMarkdown } from '../../src/features/editor-md/serialize';
import { embedHeightOf } from '../../src/features/editor-md/wikiLinkEmbed';
import { placeEmbedAsBlock } from '../../src/features/editor-md/wikiLinkBlock';

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
    ['嵌入笔记的卡片高度', '![[笔记|400]]'],
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

  it('嵌入高度：纯数字才算高度，并限制在可调范围内', () => {
    expect(embedHeightOf('笔记|400')).toBe(400);
    expect(embedHeightOf('笔记#节|20')).toBe(80);
    expect(embedHeightOf('笔记|9999')).toBe(2000);
    expect(embedHeightOf('笔记')).toBeNull();
    expect(embedHeightOf('笔记|别名')).toBeNull();
  });

  describe('嵌入独占段落', () => {
    /** 在文本 marker 所在位置（或文档末尾）插入嵌入 b，返回序列化结果 */
    function insertEmbedAt(markdown: string, marker?: string): string {
      parseMarkdown(editor, markdown);
      let at = editor.state.doc.content.size - 1;
      if (marker) {
        editor.state.doc.descendants((node, pos) => {
          if (node.isText && node.text?.includes(marker)) at = pos + node.text.indexOf(marker);
        });
      }
      editor
        .chain()
        .command(({ tr, state }) => {
          placeEmbedAsBlock(tr, at, at + (marker?.length ?? 0), state.schema.nodes.wikiLink.create({ inner: 'b', embed: true }));
          return true;
        })
        .run();
      return serializeMarkdown(editor);
    }

    it('紧跟在已有嵌入后面插入时另起一段', () => {
      expect(insertEmbedAt('![[a]]')).toBe('![[a]]\n\n![[b]]');
    });

    it('插在文字中间时把段落拆开', () => {
      expect(insertEmbedAt('前文@后文', '@')).toBe('前文\n\n![[b]]\n\n后文');
    });

    it('插在段首时放到该段之前', () => {
      expect(insertEmbedAt('@正文', '@')).toBe('![[b]]\n\n正文');
    });

    it('空段落原地放置', () => {
      expect(insertEmbedAt('@', '@')).toBe('![[b]]');
    });

    it('标题中退化为行内插入', () => {
      expect(insertEmbedAt('# 标题@', '@')).toBe('# 标题![[b]]');
    });
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
