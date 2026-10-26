// NoteBoard 高亮块往返测试
// 规范化约束：标准写法逐字往返并解析为可编辑的高亮块；非标准写法继续按块级 HTML 原样保留。

import { afterAll, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import { parseMarkdown, serializeMarkdown } from '../../src/features/editor-md/serialize';
import {
  calloutSourceSnippet,
  createCalloutContent,
  exitCalloutFromEmptyParagraph,
  insertCalloutBlock,
  matchCalloutBlock,
  renderCalloutOpenTag,
  setCalloutAttrs,
  unwrapCallout,
} from '../../src/features/editor-md/calloutExtension';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  CALLOUT_EMOJI_GROUPS,
  CALLOUT_ICON_GROUPS,
  isCalloutEmoji,
  normalizeHexInput,
} from '../../src/features/editor-md/calloutPickers';
import { splitSections } from '../../src/features/editor-md/sectionDocument';

const editor = new Editor({ element: null, extensions: buildExtensions('callout-test'), content: '' });

afterAll(() => {
  editor.destroy();
});

/** 生成高亮块标准写法 */
const callout = (body: string, color = 'blue', icon = 'lightbulb') =>
  body === ''
    ? `${renderCalloutOpenTag(color, icon)}\n\n</div>`
    : `${renderCalloutOpenTag(color, icon)}\n\n${body}\n\n</div>`;

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

describe('高亮块：标准写法逐字往返', () => {
  const lossless: Array<[string, string]> = [
    ['默认', callout('提示内容')],
    ['不带图标', callout('纯色块', 'gray', '')],
    ['自定义颜色', callout('自定义', '#ff6a00', 'rocket')],
    ['未知图标名保持不变', callout('x', 'teal', 'some-other-icon')],
    ['彩色表情图标', callout('表情', 'yellow', 'emoji-100')],
    ['空正文', callout('')],
    ['多块正文', callout('# 标题\n\n- a\n- b\n\n```js\nconst a = 1;\n```\n\n> 引用\n\n| a   | b   |\n| --- | --- |\n| 1   | 2   |')],
    ['块内 HTML', callout('<p align="center">居中</p>\n\n**粗体** 与 `code` 与 <kbd>Ctrl</kbd>')],
    ['块内折叠块', callout('<details>\n<summary>x</summary>\n\nbody\n\n</details>')],
    ['块内分栏', callout('<div class="nb-columns" style="display: flex; gap: 16px;">\n<div class="nb-column" style="flex: 50; min-width: 0;">\n\na\n\n</div>\n<div class="nb-column" style="flex: 50; min-width: 0;">\n\nb\n\n</div>\n</div>')],
    ['嵌套高亮块', callout(callout('内层', 'red', 'flame'))],
    ['代码围栏中的结束标签', callout('```html\n</div>\n```')],
    ['前后有其他块', `before\n\n${callout('a')}\n\nafter\n`],
    ['引用中的高亮块', `> ${renderCalloutOpenTag('green', 'leaf')}\n>\n> a\n>\n> </div>`],
  ];

  it.each(lossless)('%s', (_name, markdown) => {
    const output = roundTrip(markdown);
    expect(output).toBe(markdown);
    const firstDoc = JSON.stringify(editor.getJSON());
    expect(roundTrip(output)).toBe(output);
    expect(JSON.stringify(editor.getJSON())).toBe(firstDoc);
  });

  it('标准写法解析为高亮块，颜色与图标正确', () => {
    roundTrip(callout('**a**', '#ff6a00', 'rocket'));
    const node = editor.state.doc.firstChild!;
    expect(node.type.name).toBe('calloutBlock');
    expect(node.attrs.color).toBe('#ff6a00');
    expect(node.attrs.icon).toBe('rocket');
    expect(node.firstChild?.type.name).toBe('paragraph');

    roundTrip(callout('b', 'gray', ''));
    expect(editor.state.doc.firstChild!.attrs.icon).toBe('');
  });

  it('列表中的高亮块正文仍是段落', () => {
    roundTrip(`- item\n\n  ${renderCalloutOpenTag('blue', 'info')}\n\n  body\n\n  </div>`);
    const types = nodeTypes();
    expect(types).toContain('calloutBlock');
    expect(types[types.indexOf('calloutBlock') + 1]).toBe('paragraph');
  });
});

describe('高亮块：非标准写法保持原样 HTML', () => {
  const open = renderCalloutOpenTag('blue', 'lightbulb');
  const preserved: Array<[string, string]> = [
    ['无空行', `${open}\nbody\n</div>`],
    ['样式被手改', `${open.replace('padding: 12px 16px', 'padding: 4px')}\n\nbody\n\n</div>`],
    ['样式与颜色不一致', `${renderCalloutOpenTag('red', 'lightbulb').replace('data-color="red"', 'data-color="blue"')}\n\nbody\n\n</div>`],
    ['未知预设色', `${open.replace('data-color="blue"', 'data-color="navy"')}\n\nbody\n\n</div>`],
    ['大写十六进制色', `${renderCalloutOpenTag('#ff6a00', '').replace('#ff6a00', '#FF6A00')}\n\nbody\n\n</div>`],
    ['外层无样式', '<div class="nb-callout" data-color="blue">\n\nbody\n\n</div>'],
    ['未闭合', `${open}\n\nbody`],
    ['结束标签后紧跟文字', `${callout('a')}\nafter`],
  ];

  it.each(preserved)('%s', (_name, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
    expect(nodeTypes()).not.toContain('calloutBlock');
  });
});

describe('高亮块：可视化插入与操作', () => {
  it('插入后光标在块内，序列化为标准写法', () => {
    parseMarkdown(editor, 'before');
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.insertContent({ type: 'paragraph' });
    insertCalloutBlock(editor, { color: 'yellow', icon: 'triangle-alert' });
    const { $from } = editor.state.selection;
    expect($from.node($from.depth - 1).type.name).toBe('calloutBlock');
    editor.commands.insertContent('注意');
    const output = serializeMarkdown(editor);
    expect(output).toBe(`before\n\n${callout('注意', 'yellow', 'triangle-alert')}`);
    expect(roundTrip(output)).toBe(output);
  });

  it('修改颜色与图标、取消高亮块', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          ...createCalloutContent('blue', 'lightbulb'),
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
          ],
        },
      ],
    });
    expect(setCalloutAttrs(editor, 0, { color: '#123abc' })).toBe(true);
    expect(setCalloutAttrs(editor, 0, { icon: '' })).toBe(true);
    // 属性未变化时不产生事务
    expect(setCalloutAttrs(editor, 0, { icon: '' })).toBe(false);
    expect(serializeMarkdown(editor)).toBe(callout('a\n\nb', '#123abc', ''));

    expect(unwrapCallout(editor, 0)).toBe(true);
    expect(serializeMarkdown(editor)).toBe('a\n\nb');
  });

  it('末尾空段落按回车跳出到高亮块后方', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          ...createCalloutContent(),
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'paragraph' }],
        },
      ],
    });
    const block = editor.state.doc.firstChild!;
    // 光标放到末尾空段落：高亮块结束(-1)、段落内(-1)
    editor.commands.setTextSelection(block.nodeSize - 2);
    let next: EditorState | null = null;
    expect(exitCalloutFromEmptyParagraph(editor.state, (tr) => {
      next = editor.state.apply(tr);
    })).toBe(true);
    const result = next as unknown as EditorState;
    const types: string[] = [];
    result.doc.forEach((node) => types.push(node.type.name));
    expect(types).toEqual(['calloutBlock', 'paragraph']);
    expect(result.selection.$from.depth).toBe(1);
  });

  it('只有一个空段落时不拦截回车', () => {
    editor.commands.setContent({ type: 'doc', content: [createCalloutContent()] });
    editor.commands.setTextSelection(2);
    expect(exitCalloutFromEmptyParagraph(editor.state, () => undefined)).toBe(false);
  });

  it('源码模式插入片段本身是标准写法', () => {
    expect(matchCalloutBlock(calloutSourceSnippet().trimStart())?.body).toBe('高亮块内容');
    expect(matchCalloutBlock(calloutSourceSnippet({ color: 'gray', icon: '' }).trimStart())?.icon).toBe('');
  });

  it('十六进制输入规范化', () => {
    expect(normalizeHexInput('FF6A00')).toBe('#ff6a00');
    expect(normalizeHexInput(' #abc ')).toBe('#aabbcc');
    expect(normalizeHexInput('#12345')).toBeNull();
    expect(normalizeHexInput('red')).toBeNull();
  });
});

describe('大文档分段不切开高亮块', () => {
  it('切点落在高亮块之后', () => {
    const filler = Array.from({ length: 2400 }, (_, index) => `段落 ${index}`).join('\n\n');
    const inner = Array.from({ length: 1600 }, (_, index) => `内部 ${index}`).join('\n\n');
    const content = `${filler.slice(0, 20_000)}\n\n${callout(inner)}\n\ntail`;
    const sections = splitSections(content);
    // 必须实际切段且逐字保留正文，不能通过返回单段绕过容器边界保护。
    expect(sections).toHaveLength(2);
    expect(sections[0].end).toBe(content.lastIndexOf('tail'));
    expect(sections.map((section) => section.content).join('')).toBe(content);
    for (const section of sections) {
      const opens = section.content.match(/<div[\s>]/g)?.length ?? 0;
      const closes = section.content.match(/<\/div>/g)?.length ?? 0;
      expect(opens).toBe(closes);
    }
  });
});

describe('高亮块：彩色表情图标', () => {
  const emojis = CALLOUT_EMOJI_GROUPS.flatMap((group) => group.icons);

  it('表情图标名合法、唯一且不与线性图标重名', () => {
    const lineIds = new Set(CALLOUT_ICON_GROUPS.flatMap((group) => group.icons.map((icon) => icon.id)));
    const ids = emojis.map((emoji) => emoji.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      // 须满足 data-icon 的属性格式，才能被标准写法接管
      expect(id).toMatch(/^emoji-[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(lineIds.has(id)).toBe(false);
      expect(isCalloutEmoji(id)).toBe(true);
    }
    expect(isCalloutEmoji('lightbulb')).toBe(false);
  });

  it('每个表情都有对应的本地 SVG 文件', () => {
    for (const emoji of emojis) {
      // 测试在项目根目录运行，按 public 目录拼出文件路径
      const file = join(process.cwd(), 'public', emoji.src);
      expect(existsSync(file), emoji.src).toBe(true);
    }
  });
});
