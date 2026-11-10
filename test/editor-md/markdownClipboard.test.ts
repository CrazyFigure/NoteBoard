// 通过真实剪贴板事件验证复制与剪切，覆盖 Markdown 语法、局部选区、表格与撤销。
import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { CellSelection } from '@tiptap/pm/tables';
import { buildExtensions } from '@/features/editor-md/extensions';
import { buildCoreExtensions } from '@/features/editor-md/extensions/core';
import { MarkdownClipboard } from '@/features/editor-md/markdownClipboard';
import { TableClipboard } from '@/features/editor-md/tableClipboard';
import { parseMarkdown, serializeMarkdown } from '@/features/editor-md/serialize';

const editors: Editor[] = [];

/** 挂载真实文档规则与剪贴板插件，省去依赖 React 与浏览器布局的界面装饰插件。 */
function createEditor(source: string, markdownClipboard = true): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [...buildCoreExtensions(), TableClipboard, ...(markdownClipboard ? [MarkdownClipboard] : [])],
    content: '',
  });
  editors.push(editor);
  expect(parseMarkdown(editor, source)).toBe(true);
  editor.commands.selectAll();
  return editor;
}

/** 模拟浏览器提供的剪贴板，保留事件是否拦截和所有 MIME 数据，检查 HTML 不会抢占 Markdown。 */
function copySelection(editor: Editor, type: 'copy' | 'cut' = 'copy') {
  const data = new Map<string, string>();
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      clearData: () => data.clear(),
      setData: (mime: string, text: string) => data.set(mime, text),
    },
  });
  editor.view.dom.dispatchEvent(event);
  return { data, event, text: data.get('text/plain') };
}

/** 按正文定位局部文本，避免将 Markdown 标记长度误当成可视化文档位置。 */
function selectText(editor: Editor, text: string): void {
  let from = -1;
  editor.state.doc.descendants((node, pos) => {
    if (from < 0 && node.isText && node.text?.includes(text)) from = pos + node.text.indexOf(text);
  });
  expect(from).toBeGreaterThanOrEqual(0);
  editor.commands.setTextSelection({ from, to: from + text.length });
}

afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()));

describe('Markdown 文档剪贴板', () => {
  it('完整装配点按文档选项启用，不影响默认嵌入式编辑器', () => {
    expect(buildExtensions('', { markdownClipboard: true }).some((extension) => extension.name === 'markdownClipboard')).toBe(true);
    expect(buildExtensions().some((extension) => extension.name === 'markdownClipboard')).toBe(false);
  });
  it.each([
    ['标题与行内格式', '## 标题\n\n**粗体**和*斜体*、~~删除~~、`代码`'],
    ['嵌套列表与引用', '- 第一项\n    - 子项\n- 第二项\n\n> 引用'],
    ['任务与编号', '- [x] 完成\n- [ ] 待办\n\n7. 第七项\n8. 第八项'],
    ['链接与图片', '[说明](https://example.com/a)\n\n![图片](images/a.png)'],
    ['代码与公式', '```ts\nconst s = "&amp;";\n```\n\n$x + y$\n\n$$\nx^2\n$$'],
    ['表格混合正文', '## 表格\n\n| A | B |\n| --- | --- |\n| **甲** | 001 |\n\n后文'],
    ['Markdown 字面量与路径', '\\# 普通正文\n\nC:\\Users\\notes\\a.md'],
    ['原样 HTML 与双链', '<div class="custom">原文</div>\n\n[[笔记|别名]]'],
  ])('复制%s保留 Markdown，且不修改文档', (_name, source) => {
    const editor = createEditor(source);
    const before = editor.state.doc;
    const { text, data, event } = copySelection(editor);
    expect(text).toBe(source);
    expect([...data.keys()]).toEqual(['text/plain']);
    expect(event.defaultPrevented).toBe(true);
    expect(editor.state.doc).toBe(before);
  });

  it('只复制局部粗体文字，不携带选区外正文和文件末尾换行', () => {
    const editor = createEditor('前文**局部粗体文字**后文\n');
    selectText(editor, '粗体');
    expect(copySelection(editor).text).toBe('**粗体**');
  });

  it('局部标题文字保留标题级别', () => {
    const editor = createEditor('### 标题的一部分');
    selectText(editor, '一部分');
    expect(copySelection(editor).text).toBe('### 一部分');
  });

  it('从有序列表中途复制时保留选中项的编号', () => {
    const editor = createEditor('7. 第七项\n8. 第八项\n9. 第九项');
    selectText(editor, '第八项');
    expect(copySelection(editor).text).toBe('8. 第八项');
  });

  it('复制列表子项保留列表与嵌套关系，且不带入未选中的正文', () => {
    const editor = createEditor('- 父项\n    - **子项**\n- 下一项');
    selectText(editor, '子项');
    const text = copySelection(editor).text!;
    expect(text).toContain('**子项**');
    expect(text).not.toContain('父项');
    expect(text).not.toContain('下一项');
    expect(text).toMatch(/- /);
  });

  it('矩形单元格选区补回 Markdown 表格，保留单元格格式和前导零', () => {
    const editor = createEditor('| H1 | H2 |\n| --- | --- |\n| **A1** | 001 |\n| A2 | B2 |');
    const cells = new Map<string, number>();
    editor.state.doc.descendants((node, pos) => {
      if (node.type.spec.tableRole === 'cell') cells.set(node.textContent, pos);
    });
    editor.view.dispatch(editor.state.tr.setSelection(new CellSelection(
      editor.state.doc.resolve(cells.get('A1')!), editor.state.doc.resolve(cells.get('B2')!),
    )));
    const text = copySelection(editor).text!;
    expect(text).toContain('**A1**');
    expect(text).toContain('001');
    expect(text).toMatch(/\|\s*-{3,}/);
    expect(text).not.toContain('\t');
    expect(text).not.toContain('H1');
    expect(text).toBe('| **A1** | 001 |\n| --- | --- |\n| A2 | B2 |');
    // 重新解析后仍只有所选的两行；首行带原有格式，源文档未被提升为表头。
    const pasted = createEditor(text);
    expect(pasted.state.doc.firstChild?.childCount).toBe(2);
    expect(pasted.state.doc.firstChild?.firstChild?.firstChild?.textContent).toBe('A1');
    expect(serializeMarkdown(editor)).toBe('| H1 | H2 |\n| --- | --- |\n| **A1** | 001 |\n| A2 | B2 |');
  });

  it.each([
    ['单行', 'A2', 'B2', '| A2 | B2 |\n| --- | --- |'],
    ['单格', 'A2', 'A2', '| A2 |\n| --- |'],
    ['单列', 'A1', 'A2', '| A1 |\n| --- |\n| A2 |'],
    ['反向矩形', 'B2', 'A1', '| A1 | B1 |\n| --- | --- |\n| A2 | B2 |'],
    ['包含原表头', 'H1', 'B1', '| H1 | H2 |\n| --- | --- |\n| A1 | B1 |'],
  ])('%s单元格复制不增加空行，剪切可撤销', (_name, anchor, head, expected) => {
    const source = '| H1 | H2 | H3 |\n| --- | --- | --- |\n| A1 | B1 | C1 |\n| A2 | B2 | C2 |';
    const editor = createEditor(source);
    const before = editor.state.doc;
    const cells = new Map<string, number>();
    before.descendants((node, pos) => {
      if (['cell', 'header_cell'].includes(node.type.spec.tableRole ?? '')) cells.set(node.textContent, pos);
    });
    editor.view.dispatch(editor.state.tr.setSelection(new CellSelection(
      before.resolve(cells.get(anchor)!), before.resolve(cells.get(head)!),
    )));
    expect(copySelection(editor).text).toBe(expected);
    expect(editor.state.doc).toBe(before);
    expect(copySelection(editor, 'cut').text).toBe(expected);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.eq(before)).toBe(true);
  });

  it('真实选中的空白表头不会被删除', () => {
    const source = '|  |  |\n| --- | --- |\n| 甲 | 乙 |';
    expect(copySelection(createEditor(source)).text).toBe(source);
  });

  it('剪切同样写入 Markdown，只删除选区，且可撤销恢复', () => {
    const editor = createEditor('前文**选中文字**后文');
    const before = editor.state.doc;
    selectText(editor, '选中文字');
    const { text, data } = copySelection(editor, 'cut');
    expect(text).toBe('**选中文字**');
    expect([...data.keys()]).toEqual(['text/plain']);
    expect(serializeMarkdown(editor)).toBe('前文后文');
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.eq(before)).toBe(true);
  });

  it('空选区不覆盖剪贴板，只读模式仍可复制且不能剪切', () => {
    const editor = createEditor('**正文**');
    editor.commands.setTextSelection(1);
    expect(copySelection(editor).event.defaultPrevented).toBe(false);
    expect(copySelection(editor, 'cut').data.size).toBe(0);
    editor.commands.selectAll();
    editor.setEditable(false);
    expect(copySelection(editor).text).toBe('**正文**');
    expect(copySelection(editor, 'cut').data.size).toBe(0);
    expect(serializeMarkdown(editor)).toBe('**正文**');
  });

  it('嵌入式编辑器未启用时保持原有富文本剪贴板', () => {
    const editor = createEditor('**正文**', false);
    const { text, data } = copySelection(editor);
    expect(text).toBe('正文');
    expect(data.get('text/html')).toContain('<strong>正文</strong>');
  });
});
