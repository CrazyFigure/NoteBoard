// 验证各类 CodeMirror 文档共用缩进设置、设置热更新及 Esc 后 Tab 不切换焦点。
import { afterEach, describe, expect, it } from 'vitest';
import { EditorSelection, EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { indentUnit } from '@codemirror/language';
import { undo } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import { xml } from '@codemirror/lang-xml';
import { markdown } from '@codemirror/lang-markdown';
import { createBaseExtensions } from '../../src/features/editor-code/setup';
import { useSettingsStore } from '../../src/stores/settingsStore';

const views: EditorView[] = [];
const initialSettings = useSettingsStore.getState().settings;

/** 在内存中更改宽度与空格偏好，触发与设置界面相同的订阅。 */
function setIndentation(tabSize: number, insertSpaces = true) {
  useSettingsStore.setState({ settings: { ...initialSettings, editor: { ...initialSettings.editor, tabSize, insertSpaces } } });
}

/** 挂载真实 CodeMirror 视图，保留默认快捷键和设置监听。 */
function createView(doc: string, language: Extension = json()): EditorView {
  const view = new EditorView({ state: EditorState.create({ doc, extensions: [createBaseExtensions(), language] }) });
  document.body.append(view.dom);
  views.push(view);
  return view;
}

/** 通过 DOM 派发按键，包含真实键码以覆盖 CodeMirror 的临时焦点模式分支。 */
function pressKey(view: EditorView, key: string, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, keyCode: key === 'Tab' ? 9 : 27, bubbles: true, cancelable: true, shiftKey });
  view.contentDOM.dispatchEvent(event);
  return event;
}

afterEach(() => {
  for (const view of views.splice(0)) { view.destroy(); view.dom.remove(); }
  useSettingsStore.setState({ settings: initialSettings });
});

describe('各类文本文档统一 Tab 行为', () => {
  it.each([
    ['TXT', '正文', []], ['JSON', '{"a":1}', json()],
    ['XML', '<root/>', xml()], ['Markdown 源码', '# 标题', markdown()],
  ] as const)('%s 按设置缩进，Esc 后也不触发焦点遍历', (_name, doc, language) => {
    setIndentation(4);
    const view = createView(doc, language);
    expect(pressKey(view, 'Tab').defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe('    ' + doc);
    pressKey(view, 'Escape');
    expect(pressKey(view, 'Tab').defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe('        ' + doc);
    expect(pressKey(view, 'Tab', true).defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe('    ' + doc);
  });

  it.each([
    ['行首', 0], ['行中', 2], ['行尾', 4],
  ] as const)('TXT 在%s光标处插入缩进，并可撤销', (_name, anchor) => {
    setIndentation(4);
    const view = createView('测试正文', []);
    view.dispatch({ selection: { anchor } });
    expect(pressKey(view, 'Tab').defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe('测试正文'.slice(0, anchor) + '    ' + '测试正文'.slice(anchor));
    expect(view.state.selection.main.anchor).toBe(anchor + 4);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('测试正文');
  });

  it('TXT 在光标处插入真正的制表符，Esc 后也保留插入位置', () => {
    setIndentation(4, false);
    const view = createView('前文后文', []);
    view.dispatch({ selection: { anchor: 2 } });
    pressKey(view, 'Escape');
    expect(pressKey(view, 'Tab').defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe('前文\t后文');
    expect(view.state.selection.main.anchor).toBe(3);
  });

  it('多个光标分别插入缩进，不移动到各自行首', () => {
    setIndentation(2);
    const view = createView('abcd\nefgh', [EditorState.allowMultipleSelections.of(true)]);
    view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(7)]) });
    pressKey(view, 'Tab');
    expect(view.state.doc.toString()).toBe('ab  cd\nef  gh');
    expect(view.state.selection.ranges.map((range) => range.anchor)).toEqual([4, 11]);
  });

  it('选中文本时仍缩进各行，Shift+Tab 还原缩进并保留正文', () => {
    setIndentation(2);
    const view = createView('first\nsecond', []);
    view.dispatch({ selection: { anchor: 1, head: 9 } });
    pressKey(view, 'Tab');
    expect(view.state.doc.toString()).toBe('  first\n  second');
    pressKey(view, 'Tab', true);
    expect(view.state.doc.toString()).toBe('first\nsecond');
  });

  it('多个已打开实例即时更新宽度和制表符偏好，不清除撤销历史', () => {
    const first = createView('one');
    const second = createView('two');
    pressKey(first, 'Tab');
    setIndentation(8, false);
    for (const view of [first, second]) {
      expect(view.state.tabSize).toBe(8);
      expect(view.state.facet(indentUnit)).toBe('\t');
      const before = view.state.doc.toString();
      const anchor = view.state.selection.main.anchor;
      pressKey(view, 'Tab');
      expect(view.state.doc.toString()).toBe(before.slice(0, anchor) + '\t' + before.slice(anchor));
    }
    expect(undo(first)).toBe(true);
    expect(first.state.doc.toString()).toBe('  one');
    expect(undo(first)).toBe(true);
    expect(first.state.doc.toString()).toBe('one');
    first.setTabFocusMode(true);
    expect(pressKey(first, 'Tab').defaultPrevented).toBe(true);
    expect(first.state.doc.toString()).toBe('\tone');
  });

  it('只读文档吞掉 Tab / Shift+Tab，但不改正文', () => {
    const view = new EditorView({ state: EditorState.create({ doc: 'readonly', extensions: [createBaseExtensions(), EditorState.readOnly.of(true)] }) });
    views.push(view);
    expect(pressKey(view, 'Tab').defaultPrevented).toBe(true);
    expect(pressKey(view, 'Tab', true).defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe('readonly');
  });
});
