// Markdown 性能回归：验证解析器实例隔离、普通段落的快速排除和合法列表/表格语义。
import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { buildExtensions } from '@/features/editor-md/extensions';
import { parseMarkdown, serializeMarkdown } from '@/features/editor-md/serialize';
import { createIndexedBlockStart, createIsolatedMarkdownParser } from '@/features/editor-md/markdownBlockStart';

/** 创建真实内核，避免只测代理 tokenizer 而遗漏装配时的共享解析器问题。 */
function createEditor(key: string): Editor {
  return new Editor({ element: null, extensions: buildExtensions(key), content: '' });
}

describe('Markdown 解析性能回归', () => {
  it('索引与原正则在相邻块、嵌套块及任意后缀上的起点完全一致', () => {
    const parser = createIsolatedMarkdownParser();
    const patterns = [/(?:^|\n) {0,3}> \[!(?:NOTE|TIP)\]/, /^ {0,3}\$\$(?=[ \t]*(?:\r?\n|[^\r\n]*\$\$[ \t]*(?:\r?\n|$)))/m, /(?:^|\n) {0,3}\[\^[^\]\n]+\]:/];
    const starts = patterns.map(createIndexedBlockStart);
    let checked = 0;
    parser.use({ extensions: [{ name: '起点检查', level: 'block', tokenizer(source) {
      // tokenizer 与 start 共享真实 Lexer；逐后缀比较，覆盖裁去缩进/换行后才出现的新起点。
      for (let offset = 0; offset <= source.length; offset += 1) {
        const suffix = source.slice(offset);
        patterns.forEach((pattern, index) => {
          const match = pattern.exec(suffix);
          const expected = match ? match.index + (match[0].startsWith('\n') ? 1 : 0) : -1;
          expect(starts[index].call(this, suffix)).toBe(expected);
          checked += 1;
        });
      }
      return undefined;
    } }] });
    parser.lexer('普通段落\n\n> 引用内容\n> \n> [!TIP]\n> 提示\n\n    > [!NOTE]\n> [!TIP]\n\n$$a$$\n$$b$$\n\n[^a]: 脚注\n[^b]: 最后一项');
    expect(checked).toBeGreaterThan(500);
  });

  it('反复创建和销毁编辑器不会给已有解析器追加规则', () => {
    const first = createEditor('first-parser');
    try {
      const firstManager = first.storage.markdown.manager;
      const initialBlocks = firstManager.instance.defaults.extensions?.block?.length;
      for (let index = 0; index < 4; index += 1) {
        const next = createEditor(`next-parser-${index}`);
        try {
          expect(next.storage.markdown.manager.instance).not.toBe(firstManager.instance);
          expect(next.storage.markdown.manager.instance.defaults.extensions?.block?.length).toBe(initialBlocks);
        } finally {
          next.destroy();
        }
      }
      expect(firstManager.instance.defaults.extensions?.block?.length).toBe(initialBlocks);
    } finally {
      first.destroy();
    }
  });

  it('大量普通段落完整解析，列表与表格写法仍能往返', () => {
    const editor = createEditor('paragraph-parser');
    try {
      // 保留足以触发原全文重复扫描的规模，不用依赖机器速度的毫秒阈值作断言。
      const paragraphs = Array.from({ length: 3_000 }, (_, index) => `段落 ${index}`).join('\n\n');
      const parsed = editor.storage.markdown.manager.parse(paragraphs);
      expect(parsed.content).toHaveLength(3_000);
      expect(parsed.content?.at(-1)?.content?.[0]?.text).toBe('段落 2999');
      for (const markdown of [
        '1. 第一项\n2. 第二项',
        'a. 第一项\nb. 第二项',
        'i. 第一项\nii. 第二项',
        '- [ ] 第一项\n\n- [x] 第二项',
        '| A | B |\n|---|---|\n| 一 | 二 |',
      ]) {
        expect(parseMarkdown(editor, markdown)).toBe(true);
        expect(serializeMarkdown(editor)).toBe(markdown);
      }
    } finally {
      editor.destroy();
    }
  });
});
