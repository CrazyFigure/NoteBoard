// Markdown 可视化模式 Tab 回归：按生产扩展的优先级分发按键，验证处理结果和文档变化。
import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import { parseMarkdown, serializeMarkdown } from '../../src/features/editor-md/serialize';
import { useSettingsStore } from '../../src/stores/settingsStore';

const editors: Editor[] = [];
const initialSettings = useSettingsStore.getState().settings;

/** 只修改测试内存设置，不触发后端持久化。 */
function setIndentation(tabSize: number, insertSpaces = true) {
  useSettingsStore.setState({ settings: { ...initialSettings, editor: { ...initialSettings.editor, tabSize, insertSpaces } } });
}

/** 使用生产扩展创建无视图编辑器，按文本定位光标；真实焦点遍历另在浏览器验证。 */
function createEditor(markdown: string, marker: string): Editor {
  const editor = new Editor({ element: null, extensions: buildExtensions('tab-key-test'), content: '' });
  editors.push(editor);
  parseMarkdown(editor, markdown);
  let target = -1;
  editor.state.doc.descendants((node, pos) => {
    if (target >= 0 || !node.isText || !node.text) return;
    const index = node.text.indexOf(marker);
    if (index >= 0) target = pos + index + marker.length;
  });
  expect(target).toBeGreaterThanOrEqual(0);
  editor.commands.setTextSelection(target);
  return editor;
}

/** 按顺序执行无状态按键插件，保留列表、表格、代码块等生产快捷键的优先级。 */
function pressTab(editor: Editor, modifiers: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent('keydown', {
    key: 'Tab', code: 'Tab', keyCode: 9, bubbles: true, cancelable: true, ...modifiers,
  });
  for (const plugin of editor.extensionManager.plugins) {
    if (plugin.spec.state) continue;
    if (plugin.props.handleKeyDown?.call(plugin, editor.view, event)) return true;
  }
  return false;
}

afterEach(() => {
  for (const editor of editors.splice(0)) {
    editor.destroy();
  }
  useSettingsStore.setState({ settings: initialSettings });
});

describe('Markdown 可视化 Tab 按键', () => {
  it.each([1, 4, 8])('正文和代码块读取设置中的 %i 格缩进', (width) => {
    setIndentation(width);
    for (const markdown of ['正文', '```js\n正文\n```']) {
      const editor = createEditor(markdown, '正文');
      editor.commands.setTextSelection(editor.state.selection.$from.start());
      expect(pressTab(editor)).toBe(true);
      expect(editor.state.doc.textContent).toBe(' '.repeat(width) + '正文');
      expect(pressTab(editor, { shiftKey: true })).toBe(true);
      expect(editor.state.doc.textContent).toBe('正文');
    }
  });

  it('已打开的正文和代码块即时采用新的宽度及制表符偏好', () => {
    const paragraph = createEditor('正文', '正文');
    const code = createEditor('```js\ncode\n```', 'code');
    setIndentation(4);
    pressTab(paragraph);
    pressTab(code);
    expect(paragraph.state.doc.textContent).toBe('正文    ');
    expect(code.state.doc.textContent).toBe('code    ');
    setIndentation(8, false);
    pressTab(paragraph);
    pressTab(code);
    expect(paragraph.state.doc.textContent).toBe('正文    \t');
    expect(code.state.doc.textContent).toBe('code    \t');
  });

  it('代码块多行反向选区缩进保留选区方向，Shift+Tab 可完整还原', () => {
    setIndentation(4);
    const editor = createEditor('```js\nfirst\nsecond\nthird\n```', 'first');
    const start = editor.state.selection.$from.start();
    editor.commands.setTextSelection({ from: start + 14, to: start });
    expect(pressTab(editor)).toBe(true);
    expect(editor.state.doc.textContent).toBe('    first\n    second\n    third');
    expect(editor.state.selection.anchor).toBeGreaterThan(editor.state.selection.head);
    expect(pressTab(editor, { shiftKey: true })).toBe(true);
    expect(editor.state.doc.textContent).toBe('first\nsecond\nthird');
  });

  it('代码块选区结束于下一行开头时不改下一行，空白缩进可以安全删除', () => {
    const editor = createEditor('```js\nfirst\nsecond\n```', 'first');
    const start = editor.state.selection.$from.start();
    editor.commands.setTextSelection({ from: start, to: start + 6 });
    pressTab(editor);
    expect(editor.state.doc.textContent).toBe('  first\nsecond');
    editor.commands.setTextSelection({ from: start, to: start + 2 });
    pressTab(editor, { shiftKey: true });
    expect(editor.state.doc.textContent).toBe('first\nsecond');
  });
  it.each([
    ['正文', '前半后半', '前半'],
    ['标题', '# 前半后半', '前半'],
    ['引用', '> 前半后半', '前半'],
  ])('%s 插入两个空格并阻止焦点遍历', (_name, markdown, marker) => {
    const editor = createEditor(markdown, marker);
    expect(pressTab(editor)).toBe(true);
    expect(editor.state.selection.$from.parent.textContent).toBe('前半  后半');
    expect(serializeMarkdown(editor)).toContain('前半  后半');
  });

  it('代码块 Tab 缩进、Shift+Tab 减少缩进，保存后保留空格', () => {
    const editor = createEditor('```js\ncode\n```', 'code');
    editor.commands.setTextSelection(editor.state.selection.$from.start());
    expect(pressTab(editor)).toBe(true);
    expect(editor.state.selection.$from.parent.textContent).toBe('  code');
    expect(serializeMarkdown(editor)).toContain('\n  code\n');
    expect(pressTab(editor, { shiftKey: true })).toBe(true);
    expect(editor.state.selection.$from.parent.textContent).toBe('code');
  });

  it('正文 Shift+Tab 删除行首缩进，不能减少时仍阻止焦点遍历', () => {
    const editor = createEditor('正文', '正文');
    editor.commands.setTextSelection(1);
    pressTab(editor);
    expect(editor.state.doc.textContent).toBe('  正文');
    expect(pressTab(editor, { shiftKey: true })).toBe(true);
    expect(editor.state.doc.textContent).toBe('正文');
    expect(pressTab(editor, { shiftKey: true })).toBe(true);
    expect(editor.state.doc.textContent).toBe('正文');
  });

  it.each([
    ['无序列表', '- 第一项\n- 第二项', 'listItem'],
    ['有序列表', '1. 第一项\n2. 第二项', 'listItem'],
    ['任务列表', '- [ ] 第一项\n- [ ] 第二项', 'taskItem'],
  ])('%s 保留嵌套和提升行为', (_name, markdown, itemType) => {
    const editor = createEditor(markdown, '第二项');
    const initialDepth = editor.state.selection.$from.depth;
    expect(pressTab(editor)).toBe(true);
    expect(editor.state.selection.$from.depth).toBe(initialDepth + 2);
    expect(editor.state.selection.$from.node(initialDepth + 1).type.name).toBe(itemType);
    expect(pressTab(editor, { shiftKey: true })).toBe(true);
    expect(editor.state.selection.$from.depth).toBe(initialDepth);
    expect(editor.state.doc.textContent).toBe('第一项第二项');
  });

  it('首个列表项无法继续缩进时不插入空白、不遍历控件', () => {
    const editor = createEditor('- 第一项\n- 第二项', '第一项');
    const before = editor.getJSON();
    expect(pressTab(editor)).toBe(true);
    expect(editor.getJSON()).toEqual(before);
  });

  it('表格保留前后单元格导航，首格反向导航也不离开编辑器', () => {
    const editor = createEditor('| 首格 | 次格 |\n| --- | --- |\n| 三格 | 末格 |', '首格');
    expect(pressTab(editor, { shiftKey: true })).toBe(true);
    expect(editor.state.selection.$from.parent.textContent).toBe('首格');
    expect(pressTab(editor)).toBe(true);
    expect(editor.state.selection.$from.parent.textContent).toBe('次格');
    expect(pressTab(editor, { shiftKey: true })).toBe(true);
    expect(editor.state.selection.$from.parent.textContent).toBe('首格');
  });

  it('修饰键组合不接管，保留系统和应用快捷键', () => {
    const editor = createEditor('正文', '正文');
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      expect(pressTab(editor, modifiers)).toBe(false);
    }
    expect(editor.state.doc.textContent).toBe('正文');
  });
});
