// NoteBoard 空列表项退格行为单元测试
//
// 覆盖场景：可视化模式下列表中间存在空列表项时按 Backspace，
// 期望只删除该空节点、后续同级项整体上移且层级不变；
// 并保留「非空列表项减少缩进」「带子列表的空项」等原有行为。

import { afterEach, describe, expect, it } from 'vitest';
import { Editor, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { buildCoreExtensions } from '@/features/editor-md/extensions/core';
import { parseMarkdown, serializeMarkdown } from '@/features/editor-md/serialize';
import {
  ListEmptyItemBackspaceFix,
  removeEmptyListItem,
} from '@/features/editor-md/listItemBackspace';

const editors: Editor[] = [];

/** 用与生产一致的内置扩展集创建编辑器，可按需附加修复扩展 */
function createEditor(content: string, withFix = true, preserveLeadingParagraph = false): Editor {
  const editor = new Editor({
    extensions: withFix ? [StarterKit, ListEmptyItemBackspaceFix.configure({ preserveLeadingParagraph })] : [StarterKit],
    content,
  });
  editors.push(editor);
  return editor;
}

/** 把光标放到第一个「列表项内的空段落」中，返回是否找到 */
function selectFirstEmptyListItem(editor: Editor): boolean {
  let target = -1;
  editor.state.doc.descendants((node, pos) => {
    if (target >= 0) return false;
    if (
      node.type.name === 'paragraph' &&
      node.content.size === 0 &&
      ['listItem', 'taskItem'].includes(editor.state.doc.resolve(pos).parent.type.name)
    ) {
      target = pos + 1;
      return false;
    }
    return true;
  });
  if (target < 0) return false;
  editor.commands.setTextSelection(target);
  return true;
}

/** 把光标放到指定文本的开头位置 */
function selectTextStart(editor: Editor, text: string): boolean {
  let target = -1;
  editor.state.doc.descendants((node, pos) => {
    if (target >= 0) return false;
    if (node.isText && node.text === text) {
      target = pos;
      return false;
    }
    return true;
  });
  if (target < 0) return false;
  editor.commands.setTextSelection(target);
  return true;
}

/**
 * 走 ProseMirror 真实的 handleKeyDown 链路触发按键，
 * 以验证扩展优先级（而非直接调用命令）下的最终行为。
 */
function pressBackspace(editor: Editor): boolean {
  const event = new KeyboardEvent('keydown', {
    key: 'Backspace',
    bubbles: true,
    cancelable: true,
  });
  return Boolean(
    editor.view.someProp('handleKeyDown', (handler) => handler(editor.view, event)),
  );
}

/** 取出列表各项第一个段落的纯文本 */
function textsOf(list: JSONContent | undefined): string[] {
  return (list?.content ?? []).map((item) => item.content?.[0]?.content?.[0]?.text ?? '');
}

/** 顶层列表 */
function topListOf(editor: Editor): JSONContent | undefined {
  return editor.getJSON().content?.[0];
}

/** 顶层第一个列表项内的子列表（即「云盘：」下面的那一层） */
function innerListOf(editor: Editor): JSONContent | undefined {
  return topListOf(editor)?.content?.[0]?.content?.[1];
}

/** 嵌套无序列表：云盘 下有 4 个子项，其中第 2 项为空 */
const NESTED_BULLET_HTML = [
  '<ul>',
  '<li><p>云盘：</p><ul>',
  '<li><p>同步盘：百度网盘。</p></li>',
  '<li><p></p></li>',
  '<li><p>webdav：123云盘、坚果云。</p></li>',
  '<li><p>追踪更新：夸克网盘。</p></li>',
  '</ul></li>',
  '</ul>',
].join('');

/** 嵌套有序列表：结构同上，用于确认有序列表同样生效 */
const NESTED_ORDERED_HTML = [
  '<ol>',
  '<li><p>云盘：</p><ol>',
  '<li><p>同步盘：百度网盘。</p></li>',
  '<li><p></p></li>',
  '<li><p>webdav：123云盘、坚果云。</p></li>',
  '<li><p>追踪更新：夸克网盘。</p></li>',
  '</ol></li>',
  '</ol>',
].join('');

const EXPECTED_INNER_TEXTS = [
  '同步盘：百度网盘。',
  'webdav：123云盘、坚果云。',
  '追踪更新：夸克网盘。',
];

afterEach(() => {
  while (editors.length > 0) editors.pop()?.destroy();
});

describe('可视化模式空列表项退格', () => {
  it('回归基线：未加载修复扩展时，内置逻辑会把后续同级项收编为子列表', () => {
    const editor = createEditor(NESTED_BULLET_HTML, false);
    expect(selectFirstEmptyListItem(editor)).toBe(true);
    expect(pressBackspace(editor)).toBe(true);

    // 空项被提升为顶层第二项，后面的 webdav 等成为它的子列表
    expect(topListOf(editor)?.content).toHaveLength(2);
    expect(innerListOf(editor)?.content).toHaveLength(1);
  });

  it('空列表项按 Backspace 只删除该节点，后续同级项保持原层级', () => {
    const editor = createEditor(NESTED_BULLET_HTML);
    expect(selectFirstEmptyListItem(editor)).toBe(true);
    expect(pressBackspace(editor)).toBe(true);

    // 顶层仍只有「云盘：」一项，说明空项没有被提升出来
    expect(topListOf(editor)?.content).toHaveLength(1);
    expect(textsOf(innerListOf(editor))).toEqual(EXPECTED_INNER_TEXTS);
  });

  it('有序列表同样只删除空节点，不改变后续项层级', () => {
    const editor = createEditor(NESTED_ORDERED_HTML);
    expect(selectFirstEmptyListItem(editor)).toBe(true);
    expect(pressBackspace(editor)).toBe(true);

    expect(topListOf(editor)?.content).toHaveLength(1);
    expect(textsOf(innerListOf(editor))).toEqual(EXPECTED_INNER_TEXTS);
  });

  it('Markdown 内层首个空项仍只删除自身，后续同级项不会被重挂', () => {
    const editor = createEditor('<ul><li><p>父项</p><ul><li><p></p></li><li><p>子项</p></li></ul></li></ul>', true, true);
    expect(selectFirstEmptyListItem(editor)).toBe(true);
    expect(pressBackspace(editor)).toBe(true);
    expect(topListOf(editor)?.content).toHaveLength(1);
    expect(textsOf(innerListOf(editor))).toEqual(['子项']);
  });

  it('带子列表的空项不接管，避免连带丢失下级内容', () => {
    const html = [
      '<ul>',
      '<li><p>云盘：</p><ul>',
      '<li><p>同步盘：百度网盘。</p></li>',
      '<li><p></p><ul><li><p>webdav：123云盘、坚果云。</p></li></ul></li>',
      '</ul></li>',
      '</ul>',
    ].join('');
    const editor = createEditor(html);
    expect(selectFirstEmptyListItem(editor)).toBe(true);
    expect(removeEmptyListItem(editor.state, (tr) => editor.view.dispatch(tr))).toBe(false);
  });

  it('非空列表项开头退格不接管，保留原有减少缩进行为', () => {
    const editor = createEditor(NESTED_BULLET_HTML);
    expect(selectTextStart(editor, '同步盘：百度网盘。')).toBe(true);
    expect(removeEmptyListItem(editor.state, (tr) => editor.view.dispatch(tr))).toBe(false);
  });

  it('列表仅剩一个空项时不接管，交回默认逻辑退出列表', () => {
    const editor = createEditor('<ul><li><p>云盘：</p></li></ul><ul><li><p></p></li></ul>');
    expect(selectFirstEmptyListItem(editor)).toBe(true);
    expect(removeEmptyListItem(editor.state, (tr) => editor.view.dispatch(tr))).toBe(false);
  });

  it('删除后光标落到前一个同级列表项末尾', () => {
    const editor = createEditor(NESTED_BULLET_HTML);
    expect(selectFirstEmptyListItem(editor)).toBe(true);
    expect(pressBackspace(editor)).toBe(true);

    const { $from } = editor.state.selection;
    expect($from.parent.textContent).toBe('同步盘：百度网盘。');
    expect($from.parentOffset).toBe($from.parent.content.size);
  });
});

describe('Markdown 文档的列表首项退格', () => {
  it.each([
    ['taskList', '- [ ] \n- [ ] hhh\n- [x] ash idew', '\n\n- [ ] hhh\n- [x] ash idew'],
    ['bulletList', '-\n- hhh\n- ash idew', '\n\n- hhh\n- ash idew'],
    ['orderedList', '3. \n4. hhh\n5. ash idew', '\n\n3. hhh\n4. ash idew'],
    ['blockquote', '> - [ ] \n> - [ ] hhh\n> - [x] ash idew', '>\n>\n> - [ ] hhh\n> - [x] ash idew'],
  ])('%s 的首个空项变成同层正文，源码往返保留空段', (type, source, saved) => {
    // 挂载文档解析核心和退格扩展，通过视图触发真实按键链及撤销/重做。
    const editor = new Editor({
      extensions: [...buildCoreExtensions(), ListEmptyItemBackspaceFix.configure({ preserveLeadingParagraph: true })],
      editorProps: { handleScrollToSelection: () => true },
    });
    editors.push(editor);
    expect(parseMarkdown(editor, source)).toBe(true);
    expect(selectFirstEmptyListItem(editor)).toBe(true);
    const before = editor.state.doc;
    const event = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
    editor.view.dom.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

    const container = type === 'blockquote' ? editor.state.doc.firstChild! : editor.state.doc;
    const { $from } = editor.state.selection;
    // 剩余项目、复选状态及层级都应可再次从源码加载。
    expect($from.parent).toBe(container.firstChild);
    expect($from.parent.type.name).toBe('paragraph');
    expect($from.parent.content.size).toBe(0);
    expect(textsOf(container.child(1).toJSON())).toEqual(['hhh', 'ash idew']);
    expect(serializeMarkdown(editor)).toBe(saved);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(editor.commands.redo()).toBe(true);
    expect(serializeMarkdown(editor)).toBe(saved);
    expect(parseMarkdown(editor, saved)).toBe(true);
    const reopened = type === 'blockquote' ? editor.state.doc.firstChild! : editor.state.doc;
    expect(reopened.firstChild?.type.name).toBe('paragraph');
    expect(reopened.firstChild?.content.size).toBe(0);
    expect(reopened.child(1).type.name).toBe(type === 'blockquote' ? 'taskList' : type);
    expect(serializeMarkdown(editor)).toBe(saved);
  });
});
