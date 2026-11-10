// 使用真实 schema 和菜单验证纯文本提取、选区边界、剪贴板写入及失败反馈。
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { CellSelection } from '@tiptap/pm/tables';
import { buildCoreExtensions } from '@/features/editor-md/extensions/core';
import { serializeSelectionPlainText } from '@/features/editor-md/plainTextClipboard';
import { EditorContextMenu } from '@/features/editor-md/EditorContextMenu';
import { parseMarkdown } from '@/features/editor-md/serialize';
import { useToastStore } from '@/stores/toastStore';

const editors: Editor[] = [];
const roots: Array<{ root: Root; host: HTMLElement }> = [];
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

/** 真实解析 Markdown 后选中全文，测试格式由节点结构剥离而非文本替换。 */
function createEditor(source: string): Editor {
  const editor = new Editor({ extensions: buildCoreExtensions(), content: '' });
  editors.push(editor);
  expect(parseMarkdown(editor, source)).toBe(true);
  editor.commands.selectAll();
  return editor;
}

afterEach(async () => {
  for (const { root, host } of roots.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
  editors.splice(0).forEach((editor) => editor.destroy());
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
  vi.restoreAllMocks();
});

describe('纯文本复制选区', () => {
  it.each([
    ['标题与文字格式', '## 标题\n\n**粗体***斜体*~~删除~~`code`', '标题\n\n粗体斜体删除code'],
    ['链接与双链', '[说明](https://example.com)与[[笔记|别名]]', '说明与别名'],
    ['列表和任务', '- 第一项\n    - 子项\n- 第二项\n\n- [x] 已完成\n- [ ] 待办', '第一项\n子项\n第二项\n\n已完成\n待办'],
    ['字面符号', '\\*不是格式\\*与`**原样代码**`', '*不是格式*与**原样代码**'],
    ['代码块', '```ts\nconst a = "**hello**";\n```', 'const a = "**hello**";'],
    ['公式', '公式 $x + y$\n\n$$\nx^2\n$$', '公式 x + y\n\nx^2'],
    ['图片说明', '![示意图](images/a.png)', '示意图'],
    ['无说明图片', '![](images/a.png)', 'images/a.png'],
    ['HTML', '<div><p>甲 &amp; 乙</p><p>丙<br>丁</p><script>隐藏</script></div>', '甲 & 乙\n丙\n丁'],
    ['折叠块', '<details>\n<summary>摘要</summary>\n\n**正文**\n\n</details>', '摘要\n\n正文'],
    ['流程图', '```mermaid\ngraph TD\nA --> B\n```', 'graph TD\nA --> B'],
    ['前置信息', '---\ntitle: 测试\n---', 'title: 测试'],
    ['脚注', '正文[^1]\n\n[^1]: **说明**', '正文1\n\n说明'],
    ['混合表格', '前文\n\n| A | B |\n| --- | --- |\n| **甲** | 001 |\n\n后文', '前文\n\nA\tB\n甲\t001\n\n后文'],
  ])('%s保留可读内容', (_name, source, expected) => {
    const editor = createEditor(source);
    const before = editor.state.doc;
    expect(serializeSelectionPlainText(editor)).toBe(expected);
    expect(editor.state.doc).toBe(before);
  });

  it('局部选区不携带相邻正文或折叠标题', () => {
    const editor = createEditor('<details>\n<summary>摘要</summary>\n\n前文**所选**后文\n\n</details>');
    let from = 0;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === '所选') from = pos;
    });
    editor.commands.setTextSelection({ from, to: from + 2 });
    expect(serializeSelectionPlainText(editor)).toBe('所选');
    editor.commands.setTextSelection(from);
    expect(serializeSelectionPlainText(editor)).toBe('');
  });

  it('反向矩形选区只输出所选行列，保留空单元格和原子节点', () => {
    const editor = createEditor('| H1 | H2 | H3 |\n| --- | --- | --- |\n| **甲** | $x^2$ | 外部 |\n|  | 001 | 外部 |');
    const cells: number[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.spec.tableRole === 'cell') cells.push(pos);
    });
    editor.view.dispatch(editor.state.tr.setSelection(new CellSelection(
      editor.state.doc.resolve(cells[4]), editor.state.doc.resolve(cells[0]),
    )));
    expect(serializeSelectionPlainText(editor)).toBe('甲\tx^2\n\t001');
  });
});

/** 挂载真实右键菜单；读取操作名称及顺序，模拟用户点击写入系统剪贴板的边界。 */
async function renderMenu(editor: Editor) {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push({ root, host });
  const onClose = vi.fn();
  await act(async () => root.render(<EditorContextMenu editor={editor} position={{ x: 10, y: 50 }} hasSelection={!editor.state.selection.empty} onClose={onClose} />));
  const buttons = Array.from(host.querySelectorAll('button'));
  const button = buttons.find((item) => item.textContent === '纯文本复制')!;
  expect(button).toBeTruthy();
  expect(buttons[buttons.indexOf(button) - 1].textContent).toContain('粘贴');
  expect(host.textContent).not.toContain('纯文本粘贴');
  return { button, onClose };
}

describe('纯文本复制右键菜单', () => {
  it('在粘贴下面复制选区，复制后文档和选区保持不变', async () => {
    const editor = createEditor('**正文**');
    const before = editor.state;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const { button, onClose } = await renderMenu(editor);
    await act(async () => button.click());
    expect(writeText).toHaveBeenCalledWith('正文');
    expect(onClose).toHaveBeenCalledOnce();
    expect(editor.state.doc).toBe(before.doc);
    expect(editor.state.selection.eq(before.selection)).toBe(true);
  });

  it('没有选区时禁用，不能误复制整篇', async () => {
    const editor = createEditor('正文');
    editor.commands.setTextSelection(1);
    const { button } = await renderMenu(editor);
    expect(button.disabled).toBe(true);
  });

  it('剪贴板拒绝时显示失败反馈', async () => {
    const editor = createEditor('正文');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    const { button } = await renderMenu(editor);
    await act(async () => button.click());
    expect(useToastStore.getState().toasts.at(-1)?.message).toContain('纯文本复制失败');
  });
});
