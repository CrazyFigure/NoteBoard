// 回写必须保留代码、公式原文，以及包裹行内原子节点的标记范围。
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import { createMarkdownTrailingPlugin } from '../../src/features/editor-md/markdownTrailingNode';
import { getMarkdownManager, isMarkdownSerializationStable, parseMarkdown, serializeMarkdown, serializeMarkdownFromDoc } from '../../src/features/editor-md/serialize';

const editor = new Editor({ element: null, extensions: buildExtensions('literal-content'), content: '' });
afterAll(() => editor.destroy());

describe('受保护正文的逐字回写', () => {
  it.each([
    ['引用代码', '> ```text\n> a &amp; b &gt; c &lt; d \\* \\_\n> ```'],
    ['有序列表代码', '10. 示例\n    ```text\n    a &amp; b\n    ```'],
    ['深层列表代码', '- 示例\n    - 子项\n        ```text\n        a &amp; b\n        ```'],
    ['引用中的波浪围栏', '> ~~~~text\n> &amp;gt; &gt;\n> ~~~~'],
    ['引用图表', '> ```mermaid\n> graph TD\n> A["&amp;"]\n> ```'],
    ['列表图表', '- 示例\n  ```infographic\n  infographic list-row-simple-horizontal\n    data\n      title &amp;\n  ```'],
    ['普通代码', '```text\na &amp; b\n```'],
    ['行内代码', '`a &amp; b`'],
    ['行内公式', '$\\text{&amp;} + x$'],
    ['块公式', '$$\n\\text{&amp;} + x\n$$'],
    ['引用公式', '> $$\n> \\text{&amp;} + x\n> $$'],
    ['列表公式', '- 示例\n  $$\n  \\text{&amp;} + x\n  $$'],
  ])('%s 不解码实体、不删除反斜杠，反复打开与快照均一致', (_name, source) => {
    expect(parseMarkdown(editor, source)).toBe(true);
    const snapshot = editor.state.doc;
    expect(serializeMarkdown(editor)).toBe(source);
    expect(parseMarkdown(editor, serializeMarkdown(editor))).toBe(true);
    expect(serializeMarkdown(editor)).toBe(source);
    expect(editor.state.doc.eq(snapshot)).toBe(true);
    parseMarkdown(editor, '另一份内容');
    expect(serializeMarkdownFromDoc(getMarkdownManager(editor)!, editor.schema, snapshot)).toBe(source);
  });
});

describe('回写稳定性校验', () => {
  it.each([
    ['列表标记', '* a', '- a'],
    ['斜体标记', '_内容_', '*内容*'],
    ['代码围栏', '~~~text\na &amp; b\n~~~', '```text\na &amp; b\n```'],
    ['引用中的代码原文', '> ```text\n> &amp;\n> ```', '> ```text\n> &amp;\n> ```'],
  ])('%s 仅改变源码写法时通过且不修改编辑器', (_name, source, candidate) => {
    expect(parseMarkdown(editor, source)).toBe(true);
    const snapshot = editor.state.doc;
    expect(isMarkdownSerializationStable(editor, candidate)).toBe(true);
    expect(editor.state.doc).toBe(snapshot);
  });

  it.each([
    ['文字', '原文字', '新文字'],
    ['粗体范围', '**甲**和**乙**', '**甲和乙**'],
    ['标题层级', '## 标题', '# 标题'],
    ['链接地址', '[说明](a.md)', '[说明](b.md)'],
    ['代码正文', '> ```text\n> &amp;\n> ```', '> ```text\n> &\n> ```'],
    ['公式正文', '$\\text{&amp;}$', '$\\text{&}$'],
    ['独立硬换行', '**<br>**', ''],
    ['只有空白的原文', '\n\n\n', ''],
  ])('%s 变化时不能被当作安全的格式调整', (_name, source, candidate) => {
    expect(parseMarkdown(editor, source)).toBe(true);
    const snapshot = editor.state.doc;
    expect(isMarkdownSerializationStable(editor, candidate)).toBe(false);
    expect(editor.state.doc).toBe(snapshot);
  });

  it('每次校验只解析一次，解析异常保守返回且不修改编辑器', () => {
    parseMarkdown(editor, '**内容**');
    const manager = getMarkdownManager(editor)!;
    const parse = vi.spyOn(manager as Required<Pick<typeof manager, 'parse'>>, 'parse');
    try {
      expect(isMarkdownSerializationStable(editor, '**内容**')).toBe(true);
      expect(parse).toHaveBeenCalledTimes(1);
      parse.mockImplementationOnce(() => { throw new Error('解析不可用'); });
      expect(isMarkdownSerializationStable(editor, '**内容**')).toBe(false);
      expect(serializeMarkdown(editor)).toBe('**内容**');
    } finally { parse.mockRestore(); }
  });
});

describe('行内原子节点的标记范围', () => {
  it.each([
    ['粗体脚注', '**重点[^n]继续**\n\n[^n]: 注释', 'footnoteReference', 'bold'],
    ['删除线脚注', '~~重点[^n]继续~~\n\n[^n]: 注释', 'footnoteReference', 'strike'],
    ['斜体脚注', '*重点[^n]继续*\n\n[^n]: 注释', 'footnoteReference', 'italic'],
    ['高亮脚注', '==重点[^n]继续==\n\n[^n]: 注释', 'footnoteReference', 'highlight'],
    ['粗体 HTML', '**按 <kbd>Ctrl</kbd> 继续**', 'rawHtmlInline', 'bold'],
    ['带标记公式', '**$\\text{&amp;}$**', 'mathInline', 'bold'],
  ])('%s 保留节点上的实际标记，回写不拆分范围', (_name, source, atomType, markType) => {
    expect(parseMarkdown(editor, source)).toBe(true);
    const atoms: string[][] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === atomType) atoms.push(node.marks.map((mark) => mark.type.name));
    });
    expect(atoms.length).toBeGreaterThan(0);
    expect(atoms.every((marks) => marks.includes(markType))).toBe(true);
    expect(serializeMarkdown(editor)).toBe(source);
    expect(parseMarkdown(editor, serializeMarkdown(editor))).toBe(true);
    expect(serializeMarkdown(editor)).toBe(source);
  });
});

describe('组合格式与表格中的正文', () => {
  it.each([
    ['高亮包裹代码', '==`代码 &amp;`=='],
    ['下划线包裹代码', '++`代码 &amp;`++'],
    ['彩色高亮包裹代码', '<mark style="background-color: red">`code`</mark>'],
    ['表格连续空格', '| 内容 |\n| --- |\n| 前文   后文 |'],
    ['表格代码中的连续空格', '| 内容 |\n| --- |\n| `前文   后文` |'],
    ['表格代码高亮', '| 内容 |\n| --- |\n| ==`代码`== |'],
    ['表格正文中的制表符', '| 内容 |\n| --- |\n| 前文\t后文 |'],
    ['表格正文中的不间断空格', '| 内容 |\n| --- |\n| 前文\u00a0\u00a0后文 |'],
  ])('%s 保留正文与实际标记', (_name, source) => {
    expect(parseMarkdown(editor, source)).toBe(true);
    const snapshot = editor.state.doc;
    expect(serializeMarkdown(editor)).toBe(source);
    expect(parseMarkdown(editor, serializeMarkdown(editor))).toBe(true);
    expect(editor.state.doc.eq(snapshot)).toBe(true);
    expect(serializeMarkdown(editor)).toBe(source);
  });
});

/** 无头默认不装配插件；单独注册真实尾段插件以验证追加事务，浏览器另验完整挂载。 */
function editorWithTrailingNode(): Editor {
  const target = new Editor({ element: null, extensions: buildExtensions('trailing-node'), content: '' });
  target.registerPlugin(createMarkdownTrailingPlugin());
  return target;
}

describe('启用尾段插件后的辅助输入段落', () => {
  it.each([
    ['表格', '| a |\n| --- |\n| b |'],
    ['引用', '> 引用'],
    ['代码块', '```text\ncode\n```'],
    ['列表', '- 项目'],
  ])('%s 后仍可继续输入，但辅助空段不造成规范化差异', (_name, source) => {
    const mounted = editorWithTrailingNode();
    try {
      expect(parseMarkdown(mounted, source)).toBe(true);
      expect(mounted.state.doc.lastChild?.attrs.sourceTrailingPlaceholder).toBe(true);
      expect(serializeMarkdown(mounted)).toBe(source);
      expect(isMarkdownSerializationStable(mounted, source)).toBe(true);
      const snapshot = mounted.state.doc;
      const start = snapshot.content.size - snapshot.lastChild!.nodeSize + 1;
      mounted.commands.insertContentAt(start, '新正文');
      expect(mounted.state.doc.lastChild?.attrs.sourceTrailingPlaceholder).toBe(false);
      expect(serializeMarkdown(mounted)).toBe(`${source}\n\n新正文`);
      expect(serializeMarkdownFromDoc(getMarkdownManager(mounted)!, mounted.schema, snapshot)).toBe(source);
      // 删除刚输入的正文是作者的真实操作，不能再把留下的空段当作辅助段删除。
      mounted.commands.deleteRange({ from: start, to: start + 3 });
      expect(serializeMarkdown(mounted)).toBe(`${source}\n\n`);
    } finally { mounted.destroy(); }
  });

  it('在辅助空段按回车后，两个实际空段均保留', () => {
    const mounted = editorWithTrailingNode();
    try {
      const source = '| a |\n| --- |\n| b |';
      parseMarkdown(mounted, source);
      mounted.commands.setTextSelection(mounted.state.doc.content.size - 1);
      mounted.commands.splitBlock();
      expect(mounted.state.doc.content.content.slice(-2).every((node) => !node.attrs.sourceTrailingPlaceholder)).toBe(true);
      // 多个空段沿用现有 &nbsp; 表示，确保再次解析时仍能区分作者主动留下的空段。
      expect(serializeMarkdown(mounted)).toBe(`${source}\n\n\n\n&nbsp;`);
    } finally { mounted.destroy(); }
  });
});
