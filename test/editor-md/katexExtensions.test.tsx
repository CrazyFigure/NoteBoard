// NoteBoard Markdown 数学公式集成测试
// 覆盖行内/块级公式解析、引用列表嵌套、源码往返，以及普通美元符号防误判。

import { describe, expect, it } from 'vitest';
import { Editor, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { MathBlock, MathInline } from '../../src/features/editor-md/katexExtensions';
import { parseMarkdown, serializeMarkdown } from '../../src/features/editor-md/serialize';
import {
  customClipboardTextSerializer,
  TableClipboard,
} from '../../src/features/editor-md/tableClipboard';

/** 创建只装配正文与数学节点的真实编辑器，避免其他 NodeView 干扰语法集成测试。 */
function createMathEditor(): Editor {
  return new Editor({
    extensions: [StarterKit, TableClipboard, MathInline, MathBlock, Markdown],
    content: '',
  });
}

/** 递归收集指定类型的 JSON 节点。 */
function collectNodes(root: JSONContent, type: string, result: JSONContent[] = []): JSONContent[] {
  if (root.type === type) result.push(root);
  root.content?.forEach((child) => collectNodes(child, type, result));
  return result;
}

describe('Markdown 数学公式', () => {
  it('引用列表中的多个行内公式应解析为数学节点并无损往返', () => {
    const editor = createMathEditor();
    const markdown = '> - **IO密集型**：线程数为 $2 \\times N_{cpu}$ 或 $\\frac{N_{cpu}}{1 - b}$。';

    parseMarkdown(editor, markdown);
    const formulas = collectNodes(editor.getJSON(), 'mathInline');
    expect(formulas.map((node) => node.attrs?.latex)).toEqual([
      '2 \\times N_{cpu}',
      '\\frac{N_{cpu}}{1 - b}',
    ]);

    const serialized = serializeMarkdown(editor);
    expect(serialized).toContain('$2 \\times N_{cpu}$');
    expect(serialized).toContain('$\\frac{N_{cpu}}{1 - b}$');
    editor.destroy();
  });

  it('多行与单行块公式都应解析，并统一序列化为标准多行格式', () => {
    const editor = createMathEditor();
    const markdown = [
      '$$',
      '\\sum_{i=1}^n i = \\frac{n(n+1)}{2}',
      '$$',
      '',
      '$$ E = mc^2 $$',
    ].join('\n');

    parseMarkdown(editor, markdown);
    const formulas = collectNodes(editor.getJSON(), 'mathBlock');
    expect(formulas.map((node) => node.attrs?.latex)).toEqual([
      '\\sum_{i=1}^n i = \\frac{n(n+1)}{2}',
      'E = mc^2',
    ]);

    const serialized = serializeMarkdown(editor);
    expect(serialized).toContain('$$\n\\sum_{i=1}^n i = \\frac{n(n+1)}{2}\n$$');
    expect(serialized).toContain('$$\nE = mc^2\n$$');
    editor.destroy();
  });

  it('转义美元符号、未闭合金额和代码中的美元符号不能误判为公式', () => {
    const editor = createMathEditor();
    const markdown = '价格为 $100，转义 \\$ 保持文本，代码 `$HOME` 与正文中的 $$not-block$$ 也保持原样。';

    parseMarkdown(editor, markdown);
    expect(collectNodes(editor.getJSON(), 'mathInline')).toHaveLength(0);
    expect(editor.getText()).toContain('$100');
    expect(editor.getText()).toContain('$HOME');
    expect(editor.getText()).toContain('$$not-block$$');
    editor.destroy();
  });

  it('复制文字与行内公式的混合选区时应保留完整 Markdown 公式', () => {
    const editor = createMathEditor();
    const markdown = '线程数为 $2 \\times N_{cpu}$ 或 $\\frac{N_{cpu}}{1 - b}$。';
    parseMarkdown(editor, markdown);
    editor.commands.selectAll();

    const copied = customClipboardTextSerializer(
      editor.state.selection.content(),
      editor.view,
    );
    expect(copied).toBe(markdown);
    editor.destroy();
  });

  it('复制块公式时应输出可再次解析的标准 Markdown', () => {
    const editor = createMathEditor();
    parseMarkdown(editor, '计算结果：\n\n$$\n\\sum_{i=1}^n i\n$$\n\n结束。');
    editor.commands.selectAll();

    const copied = customClipboardTextSerializer(
      editor.state.selection.content(),
      editor.view,
    );
    expect(copied).toContain('计算结果：\n\n$$\n\\sum_{i=1}^n i\n$$\n\n结束。');
    editor.destroy();
  });
});
