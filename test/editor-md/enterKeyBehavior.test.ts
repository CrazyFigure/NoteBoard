// 通过编辑器的按键处理验证普通回车、块内回车与 Ctrl+Enter 的跳出位置。

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Editor, type JSONContent } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import { buildCoreExtensions } from '../../src/features/editor-md/extensions/core';
import { parseMarkdown, serializeMarkdown } from '../../src/features/editor-md/serialize';
import { EnterKeyBehavior, insertParagraphBelow } from '../../src/features/editor-md/enterKeyBehavior';

const editor = new Editor({ element: null, extensions: buildExtensions('enter-key-behavior-test'), content: '' });

afterAll(() => {
  editor.destroy();
});

describe('可视化编辑器的回车按键', () => {
  let mounted: Editor;

  beforeEach(() => {
    // 挂载真实键位插件。jsdom 不计算布局，跳过默认的光标滚动处理。
    mounted = new Editor({
      element: document.createElement('div'),
      extensions: [...buildCoreExtensions(), EnterKeyBehavior],
      editorProps: { handleScrollToSelection: () => true },
    });
  });

  afterEach(() => mounted.destroy());

  /** 将按键事件交给实际挂载的编辑器，检查浏览器默认行为已被接管。 */
  function pressEnter(modifiers: KeyboardEventInit = {}) {
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...modifiers });
    mounted.view.dom.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  }

  function typeText(text: string) {
    mounted.view.dispatch(mounted.state.tr.insertText(text));
  }

  it('正文 Enter 换段，Shift+Enter 保留硬换行', () => {
    parseMarkdown(mounted, '正文');
    mounted.commands.setTextSelection(3);
    pressEnter({ shiftKey: true });
    typeText('续行');
    pressEnter();
    typeText('新段');
    expect(serializeMarkdown(mounted)).toBe('正文  \n续行\n\n新段');
  });

  it('有序列表回车自动续号，切回源码保留原有的文末空行', () => {
    const prefix = '正文\n\n-------\n\n1. 页面报错';
    const tail = '\n'.repeat(8);
    expect(parseMarkdown(mounted, (prefix + tail).replaceAll('\n', '\r\n'))).toBe(true);
    const { doc } = mounted.state;
    mounted.commands.setTextSelection(doc.child(0).nodeSize + doc.child(1).nodeSize + doc.child(2).nodeSize - 3);
    pressEnter();
    expect(mounted.state.doc.child(2).childCount).toBe(2);
    expect(serializeMarkdown(mounted)).toBe(`${prefix}\n2. ${tail}`);
    typeText('处理步骤');
    const saved = serializeMarkdown(mounted);
    expect(saved).toBe(`${prefix}\n2. 处理步骤${tail}`);
    expect(parseMarkdown(mounted, saved)).toBe(true);
    expect(mounted.state.doc.child(2).childCount).toBe(2);
    expect(serializeMarkdown(mounted)).toBe(saved);
  });

  it.each(['blockquote', 'githubAlert', 'detailsBlock', 'calloutBlock', 'columnBlock'])('%s 内连续回车保持在当前块', (type) => {
    const block: JSONContent = {
      type,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '正文' }] }],
    };
    const topLevel = type === 'columnBlock' ? { type: 'columnsBlock', content: [block] } : block;
    mounted.commands.setContent({ type: 'doc', content: [topLevel] });
    mounted.commands.setTextSelection(type === 'columnBlock' ? 5 : 4);
    pressEnter();
    pressEnter();
    pressEnter();
    typeText('块内续写');
    const { $from } = mounted.state.selection;
    expect($from.node(-1).type.name).toBe(type);
    expect($from.node(-1).childCount).toBe(4);
    expect($from.parent.textContent).toBe('块内续写');
  });

  it.each([
    ['顶层代码块', '', ''],
    ['列表内代码块', '1. 列表项\n', '   '],
  ])('%s 末尾连续回车保留所有换行', (_name, prefix, indent) => {
    const source = (body: string) => prefix + ['```text', ...body.split('\n'), '```'].map((line) => indent + line).join('\n');
    parseMarkdown(mounted, source('代码'));
    mounted.state.doc.descendants((node, pos) => {
      if (node.type.name === 'codeBlock') mounted.commands.setTextSelection(pos + 1 + node.content.size);
    });
    for (let count = 0; count < 4; count++) pressEnter();
    typeText('续行');
    expect(mounted.state.selection.$from.parent.type.name).toBe('codeBlock');
    expect(serializeMarkdown(mounted)).toBe(source('代码\n\n\n\n续行'));
  });
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
