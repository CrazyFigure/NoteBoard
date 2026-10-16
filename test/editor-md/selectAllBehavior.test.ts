// 可视化模式 Ctrl/Cmd+A：第一次只选中光标所在文本块的内容，再按一次才全选整个文档

import { afterAll, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { AllSelection, TextSelection } from '@tiptap/pm/state';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import { parseMarkdown } from '../../src/features/editor-md/serialize';

const editor = new Editor({ element: null, extensions: buildExtensions('select-all-behavior-test'), content: '' });

afterAll(() => {
  editor.destroy();
});

/** 模拟按下 Mod-a：按插件顺序分发 keydown（编辑器未挂载，只分发给无 state 的 keymap 类插件） */
function pressModA() {
  // jsdom 非 Mac 平台，Mod 对应 Ctrl
  const event = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true });
  for (const plugin of editor.extensionManager.plugins) {
    if (plugin.spec.state) continue;
    const handled = plugin.props.handleKeyDown?.call(plugin, editor.view, event);
    if (handled) return;
  }
}

/** 载入 Markdown 并把光标放到标记文字之后 */
function placeCursor(markdown: string, marker: string) {
  parseMarkdown(editor, markdown);
  let target = -1;
  editor.state.doc.descendants((node, pos) => {
    if (target >= 0 || !node.isText || !node.text) return;
    const index = node.text.indexOf(marker);
    if (index >= 0) target = pos + index + marker.length;
  });
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, target)));
}

/** 当前选中的文本 */
function selectedText() {
  const { from, to } = editor.state.selection;
  return editor.state.doc.textBetween(from, to, '\n');
}

describe('Ctrl+A 先选当前块，再全选文档', () => {
  const cases: Array<[string, string, string, string]> = [
    ['代码块', '前文\n\n```js\nconst a = 1;\nconst b = 2;\n```\n\n后文', 'const a', 'const a = 1;\nconst b = 2;'],
    ['普通段落', '第一段内容\n\n第二段内容', '第二', '第二段内容'],
    ['标题', '# 标题文字\n\n正文', '标题', '标题文字'],
    ['列表项', '- 第一项\n- 第二项', '第二', '第二项'],
    ['引用块内段落', '前文\n\n> 引用内容', '引用', '引用内容'],
    ['表格单元格', '| a | b |\n| --- | --- |\n| 单元格 | 2 |', '单元', '单元格'],
  ];

  it.each(cases)('%s', (_name, markdown, marker, expected) => {
    placeCursor(markdown, marker);
    pressModA();
    expect(editor.state.selection).toBeInstanceOf(TextSelection);
    expect(selectedText()).toBe(expected);

    pressModA();
    expect(editor.state.selection).toBeInstanceOf(AllSelection);
  });

  it('选区跨越多个段落时直接全选', () => {
    placeCursor('第一段\n\n第二段', '第一');
    const { doc } = editor.state;
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(doc, 2, doc.content.size - 1)));
    pressModA();
    expect(editor.state.selection).toBeInstanceOf(AllSelection);
  });
});
