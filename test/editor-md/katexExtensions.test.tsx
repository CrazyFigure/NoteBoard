// NoteBoard Markdown 数学公式集成测试
// 覆盖行内/块级公式解析、引用列表嵌套、源码往返，以及普通美元符号防误判。

import { describe, expect, it } from 'vitest';
import { Editor, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { MathBlock, MathInline } from '../../src/features/editor-md/katexExtensions';
import { buildCoreExtensions } from '../../src/features/editor-md/extensions/core';
import { MarkdownInlineAtomMarks } from '../../src/features/editor-md/markdownInlineMarks';
import { MarkdownHtmlEntity } from '../../src/features/editor-md/markdownHtmlEntities';
import { parseMarkdown, serializeMarkdown } from '../../src/features/editor-md/serialize';
import {
  customClipboardTextSerializer,
  TableClipboard,
} from '../../src/features/editor-md/tableClipboard';

/** 创建只装配正文与数学节点的真实编辑器，避免其他 NodeView 干扰语法集成测试。 */
function createMathEditor(): Editor {
  return new Editor({
    extensions: [StarterKit, TableClipboard, MathInline, MathBlock, MarkdownInlineAtomMarks, MarkdownHtmlEntity, Markdown],
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
  it('LaTeX 圆括号行内公式应保留命令、上下标与相邻 Markdown 标记', () => {
    const editor = createMathEditor();
    const markdown = String.raw`结果为 \(\frac{a_1}{b^2}\)，以及 **\(x + y\)** 和 $z$。`;
    try {
      parseMarkdown(editor, markdown);
      const formulas = collectNodes(editor.getJSON(), 'mathInline');
      expect(formulas.map((node) => node.attrs?.latex)).toEqual(['\\frac{a_1}{b^2}', 'x + y', 'z']);
      expect(formulas[1].marks).toContainEqual({ type: 'bold' });
      const serialized = serializeMarkdown(editor);
      parseMarkdown(editor, serialized);
      expect(collectNodes(editor.getJSON(), 'mathInline')).toEqual(formulas);
    } finally {
      editor.destroy();
    }
  });

  it.each(['\n', '\r\n'])('LaTeX 方括号块公式支持单行、多行、紧邻正文与嵌套容器（%j）', (newline) => {
    const editor = createMathEditor();
    const markdown = [
      '前文',
      '\\[',
      '\\sum_{i=1}^n i = \\frac{n(n+1)}{2}',
      '\\]',
      '后文',
      '',
      '\\[ E = mc^2 \\]',
      '',
      '\\[\\frac{a}{b}',
      '+ \\frac{c}{d}\\]',
      '',
      '> - 行内 \\(a_1\\) 与 $b^2$',
      '>   \\[',
      '>   \\begin{aligned}',
      '>   x &= 1 \\\\',
      '>   y &= 2',
      '>   \\end{aligned}',
      '>   \\]',
    ].join(newline);
    try {
      parseMarkdown(editor, markdown);
      const formulas = collectNodes(editor.getJSON(), 'mathBlock');
      expect(formulas.map((node) => node.attrs?.latex)).toEqual([
        '\\sum_{i=1}^n i = \\frac{n(n+1)}{2}',
        'E = mc^2',
        '\\frac{a}{b}\n+ \\frac{c}{d}',
        '\\begin{aligned}\nx &= 1 \\\\\ny &= 2\n\\end{aligned}',
      ]);
      expect(collectNodes(editor.getJSON(), 'mathInline').map((node) => node.attrs?.latex)).toEqual(['a_1', 'b^2']);
      expect(editor.getText()).toContain('前文');
      expect(editor.getText()).toContain('后文');
      const serialized = serializeMarkdown(editor);
      parseMarkdown(editor, serialized);
      expect(collectNodes(editor.getJSON(), 'mathBlock')).toEqual(formulas);
    } finally {
      editor.destroy();
    }
  });

  it.each([
    ['代码示例', '`\\(x\\)` 与 `\\[y\\]`\n\n```latex\n\\(x\\)\n\\[\ny\n\\]\n```'],
    ['缩进代码', '    \\[x\\]'],
    ['转义定界符', String.raw`\\(x\\) 与 \\[y\\]`],
    ['普通括号', '(x + y) 与 [x + y]'],
    ['行首普通方括号', '[x + y]'],
    ['列表内普通方括号', '> - [x + y]'],
    ['未闭合行内公式', '\\(x + y'],
    ['跨行行内公式', '\\(x\n+y\\)'],
    ['跨越行内代码', '\\(x `示例` y\\)'],
    ['未闭合块公式', '\\[\nx + y\n\n下一段'],
    ['混用块定界符', '\\[\nx + y\n$$'],
    ['转义块闭合符', String.raw`\[x\\]`],
  ])('%s 应保持原有文本或代码语义', (_name, markdown) => {
    const editor = createMathEditor();
    try {
      parseMarkdown(editor, markdown);
      expect(collectNodes(editor.getJSON(), 'mathInline')).toHaveLength(0);
      expect(collectNodes(editor.getJSON(), 'mathBlock')).toHaveLength(0);
      const content = editor.getJSON().content;
      parseMarkdown(editor, serializeMarkdown(editor));
      expect(editor.getJSON().content).toEqual(content);
    } finally {
      editor.destroy();
    }
  });

  it('正式共享内核应逐字保留未编辑公式，并在编辑后保持公式语义', () => {
    const editor = new Editor({ element: null, extensions: buildCoreExtensions(), content: '' });
    const markdown = '公式 \\(\\text{&amp;} + x\\)。\n\n\\[\n\\frac{a}{b}\n\\]\n';
    try {
      expect(parseMarkdown(editor, markdown)).toBe(true);
      expect(collectNodes(editor.getJSON(), 'mathInline')[0].attrs?.latex).toBe('\\text{&amp;} + x');
      expect(collectNodes(editor.getJSON(), 'mathBlock')[0].attrs?.latex).toBe('\\frac{a}{b}');
      expect(serializeMarkdown(editor)).toBe(markdown);
      editor.view.dispatch(editor.state.tr.insertText('新增', 1));
      const serialized = serializeMarkdown(editor);
      expect(serialized).toContain('\\[\n\\frac{a}{b}\n\\]');
      parseMarkdown(editor, serialized);
      expect(collectNodes(editor.getJSON(), 'mathInline')[0].attrs?.latex).toBe('\\text{&amp;} + x');
      expect(editor.getText()).toContain('新增公式');
    } finally {
      editor.destroy();
    }
  });

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
