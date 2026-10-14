// NoteBoard 正文表情测试
// 约束：文件中只写标准 Unicode 表情（逐字往返）；可视化模式仅对表情库内、非代码、非组合序列的字符做 SVG 装饰。

import { afterAll, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import type { Decoration } from '@tiptap/pm/view';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import { parseMarkdown, serializeMarkdown } from '../../src/features/editor-md/serialize';
import { INLINE_EMOJIS, createInlineEmojiPlugin, inlineEmojiKey, insertInlineEmoji } from '../../src/features/editor-md/inlineEmoji';
import { slashSuggestion } from '../../src/features/editor-md/slashCommand';

const editor = new Editor({ element: null, extensions: buildExtensions('inline-emoji-test'), content: '' });

afterAll(() => {
  editor.destroy();
});

// 无头编辑器不挂载视图插件，装饰插件单独装入一个 EditorState 中验证
let state: EditorState;

/** 解析 Markdown，并以解析结果新建带表情插件的状态 */
function load(markdown: string) {
  expect(parseMarkdown(editor, markdown)).toBe(true);
  state = EditorState.create({ doc: editor.state.doc, plugins: [createInlineEmojiPlugin()] });
}

/** 当前状态的表情装饰：[被装饰文本, SVG 地址] */
function emojiDecorations(): Array<[string, string]> {
  const set = inlineEmojiKey.getState(state);
  const decorations: Decoration[] = set ? set.find() : [];
  return decorations
    .sort((a, b) => a.from - b.from)
    .map((decoration) => {
      const style = String((decoration as unknown as { type: { attrs: Record<string, string> } }).type.attrs.style ?? '');
      return [state.doc.textBetween(decoration.from, decoration.to), style.replace(/^.*url\("(.*)"\).*$/, '$1')];
    });
}

describe('正文表情：数据', () => {
  it('每个表情都有唯一的 Unicode 字符', () => {
    const chars = INLINE_EMOJIS.map((emoji) => emoji.char);
    expect(chars.length).toBe(112);
    expect(new Set(chars).size).toBe(chars.length);
    for (const char of chars) {
      // 必须是表情字符而非空串或普通文字
      expect(char).toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});

describe('正文表情：Markdown 逐字往返', () => {
  it('表情字符原样写回文件', () => {
    const markdown = '上线了 🎉 完成 ✅ 爱心 ❤️ 与无变体 ❤ 叹气 😮‍💨 点赞 👍🏽\n\n- 列表里的 🚀\n\n`代码 🎉`';
    expect(parseMarkdown(editor, markdown)).toBe(true);
    expect(serializeMarkdown(editor)).toBe(markdown);
  });

  it('插入命令写入的是 Unicode 字符', () => {
    expect(parseMarkdown(editor, '第二段')).toBe(true);
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    insertInlineEmoji(editor, '👍');
    expect(serializeMarkdown(editor)).toBe('第二段👍');
  });
});

describe('正文表情：可视化装饰', () => {
  it('表情库内的字符显示为对应 SVG，带不带变体选择符都识别', () => {
    load('庆祝 🎉 爱心 ❤️ 和 ❤ 结束');
    expect(emojiDecorations()).toEqual([
      ['🎉', '/callout-emoji/tada.svg'],
      ['❤️', '/callout-emoji/heart.svg'],
      ['❤', '/callout-emoji/heart.svg'],
    ]);
  });

  it('零宽连接序列整体匹配，不拆开渲染', () => {
    load('叹气 😮‍💨 惊讶 😮');
    expect(emojiDecorations()).toEqual([
      ['😮‍💨', '/callout-emoji/sigh.svg'],
      ['😮', '/callout-emoji/surprised.svg'],
    ]);
  });

  it('肤色修饰与组合表情、行内代码、代码块均保持系统字体原样', () => {
    load('肤色 👍🏽 组合 ❤️‍🔥 代码 `🎉`\n\n```\n🎉\n```');
    expect(emojiDecorations()).toEqual([]);
  });

  it('插入、删除、补全变体选择符与合并段落时增量更新', () => {
    load('第一段 🚀\n\n第二段');
    expect(emojiDecorations()).toEqual([['🚀', '/callout-emoji/rocket.svg']]);

    // 第二段末尾插入
    state = state.apply(state.tr.insertText('👍', state.doc.content.size - 1));
    expect(emojiDecorations()).toEqual([
      ['🚀', '/callout-emoji/rocket.svg'],
      ['👍', '/callout-emoji/thumbs-up.svg'],
    ]);

    // 删除第一段的火箭
    const start = 1 + state.doc.firstChild!.textContent.indexOf('🚀');
    state = state.apply(state.tr.delete(start, start + '🚀'.length));
    expect(emojiDecorations()).toEqual([['👍', '/callout-emoji/thumbs-up.svg']]);

    // 先输入 ❤ 再补变体选择符，装饰随之覆盖完整字符
    const end = state.doc.content.size - 1;
    state = state.apply(state.tr.insertText('❤', end));
    state = state.apply(state.tr.insertText('️', end + 1));
    expect(emojiDecorations()).toEqual([
      ['👍', '/callout-emoji/thumbs-up.svg'],
      ['❤️', '/callout-emoji/heart.svg'],
    ]);

    // 第二段并入第一段后仍正确识别
    state = state.apply(state.tr.join(state.doc.firstChild!.nodeSize));
    expect(state.doc.childCount).toBe(1);
    expect(emojiDecorations()).toEqual([
      ['👍', '/callout-emoji/thumbs-up.svg'],
      ['❤️', '/callout-emoji/heart.svg'],
    ]);
  });
});

describe('正文表情：斜杠命令搜索', () => {
  const ids = (query: string) => slashSuggestion.items({ query }).map((item) => item.id);

  it('英文名、中文名精确命中时排在首位', () => {
    expect(ids('rocket')[0]).toBe('emoji-rocket');
    expect(ids('庆祝')[0]).toBe('emoji-party');
  });

  it('单字母查询不被表情抢占', () => {
    for (const query of ['t', 'c', 'h']) {
      expect(ids(query).slice(0, 5).some((id) => id.startsWith('emoji-'))).toBe(false);
    }
  });

  it('输入「表情」列出全部表情', () => {
    expect(ids('表情').filter((id) => id.startsWith('emoji-')).length).toBe(112);
  });
});
