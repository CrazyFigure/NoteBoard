// 回车类按键统一行为（enterKeyBehavior）：Ctrl+Enter「跳出到下方新建段落」的定位规则
// 按键分发（Enter / Shift+Enter 与互换开关）依赖真实键盘事件，已在可视化模式中逐项验证

import { afterAll, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import { parseMarkdown, serializeMarkdown } from '../../src/features/editor-md/serialize';
import { insertParagraphBelow } from '../../src/features/editor-md/enterKeyBehavior';

const editor = new Editor({ element: null, extensions: buildExtensions('enter-key-behavior-test'), content: '' });

afterAll(() => {
  editor.destroy();
});

/** 载入 Markdown，把光标放到标记文字之后，执行 Ctrl+Enter 的插入逻辑，返回结果 Markdown 与光标所在节点路径 */
function ctrlEnterAt(markdown: string, marker: string) {
  parseMarkdown(editor, markdown);
  let target = -1;
  editor.state.doc.descendants((node, pos) => {
    if (target >= 0 || !node.isText || !node.text) return;
    const index = node.text.indexOf(marker);
    if (index >= 0) target = pos + index + marker.length;
  });
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, target)));
  const handled = insertParagraphBelow(editor.state, (tr) => editor.view.dispatch(tr));
  const { $from } = editor.state.selection;
  const path: string[] = [];
  for (let depth = 1; depth <= $from.depth; depth++) path.push($from.node(depth).type.name);
  return { handled, markdown: serializeMarkdown(editor), path: path.join('>') };
}

describe('Ctrl+Enter 跳出到下方新建段落', () => {
  it('普通段落中间：在段落下方新建段落，不拆分当前内容', () => {
    const result = ctrlEnterAt('前半后半\n\n下一段', '前半');
    expect(result.handled).toBe(true);
    expect(result.path).toBe('paragraph');
    // 新建的空段落在两段之间序列化为一个额外的空行
    expect(result.markdown).toContain('前半后半\n\n\n\n下一段');
  });

  it('列表项内：跳出整个列表', () => {
    const result = ctrlEnterAt('- 一\n- 二\n\n下一段', '一');
    expect(result.path).toBe('paragraph');
    expect(result.markdown).toContain('- 一\n- 二\n\n\n\n下一段');
  });

  it('引用块内的代码块：只跳出代码块，仍留在引用块中', () => {
    const result = ctrlEnterAt('> ```js\n> code\n> ```', 'code');
    expect(result.path).toBe('blockquote>paragraph');
  });

  it('表格单元格内：跳出到表格下方', () => {
    const result = ctrlEnterAt('| a | b |\n| --- | --- |\n| 格 | 2 |\n\n下一段', '格');
    expect(result.path).toBe('paragraph');
    expect(result.markdown).toMatch(/\| 格 +\| 2 +\|\n\n\n\n下一段/);
  });

  it('提示块内：跳出到提示块下方', () => {
    const result = ctrlEnterAt('> [!NOTE]\n> 提示\n\n下一段', '提示');
    expect(result.path).toBe('paragraph');
    expect(result.markdown).toContain('> 提示\n\n\n\n下一段');
  });

  it('选中整个块节点（公式块）：在其下方新建段落', () => {
    parseMarkdown(editor, '$$\nx\n$$\n\n下一段');
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)));
    expect(insertParagraphBelow(editor.state, (tr) => editor.view.dispatch(tr))).toBe(true);
    expect(editor.state.selection.$from.parent.type.name).toBe('paragraph');
    expect(serializeMarkdown(editor)).toContain('$$\nx\n$$\n\n\n\n下一段');
  });
});
