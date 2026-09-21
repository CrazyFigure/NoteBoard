// NoteBoard 空列表项退格行为单元测试
//
// 覆盖场景：可视化模式下列表中间存在空列表项时按 Backspace，
// 期望只删除该空节点、后续同级项整体上移且层级不变；
// 并保留「非空列表项减少缩进」「带子列表的空项」等原有行为。

import { afterEach, describe, expect, it } from 'vitest';
import { Editor, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {
  ListEmptyItemBackspaceFix,
  removeEmptyListItem,
} from '@/features/editor-md/listItemBackspace';

const editors: Editor[] = [];

/** 用与生产一致的内置扩展集创建编辑器，可按需附加修复扩展 */
function createEditor(content: string, withFix = true): Editor {
  const editor = new Editor({
    extensions: withFix ? [StarterKit, ListEmptyItemBackspaceFix] : [StarterKit],
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
      editor.state.doc.resolve(pos).parent.type.name === 'listItem'
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
