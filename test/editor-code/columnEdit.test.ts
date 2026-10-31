// 列编辑模式：显示列换算、方向键与删除的列语义、退出路径、设置开关和撤销恢复
// 鼠标拖动依赖真实布局（posAtCoords），在无头 Chrome 中验证，这里覆盖其余状态逻辑

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Compartment, EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { EditorView, keymap, runScopeHandlers } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import {
  columnClipboardText,
  createColumnEditExtension,
  displayColumn,
  exitColumnMode,
  extendColumnBlock,
  getColumnBlock,
  isColumnModeActive,
  offsetAtColumn,
  pasteIntoSelection,
  toggleColumnMode,
} from '../../src/features/editor-code/columnEdit';
import { useSettingsStore } from '../../src/stores/settingsStore';

let views: EditorView[] = [];

function createView(doc: string, anchor = 0, head = anchor): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor, head },
      extensions: [createColumnEditExtension(), keymap.of(defaultKeymap), EditorState.tabSize.of(4)],
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

/** 在 doc 指定位置进入列模式，并向下扩展 lines 行 */
function enterBlock(doc: string, pos: number, lines: number): EditorView {
  const view = createView(doc, pos);
  toggleColumnMode(view);
  extendColumnBlock(view, lines);
  return view;
}

function press(view: EditorView, key: string, modifiers: KeyboardEventInit = {}): boolean {
  return runScopeHandlers(view, new KeyboardEvent('keydown', { key, ...modifiers }), 'editor');
}

/** 各光标所在的行号与行内偏移 */
function carets(view: EditorView): Array<[number, number]> {
  return view.state.selection.ranges.map((range) => {
    const line = view.state.doc.lineAt(range.head);
    return [line.number, range.head - line.from];
  });
}

function type(view: EditorView, text: string) {
  view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.type' });
}

beforeEach(() => {
  useSettingsStore.setState((state) => ({
    settings: { ...state.settings, editor: { ...state.settings.editor, enableColumnEdit: true } },
  }));
});

afterEach(() => {
  views.forEach((view) => view.destroy());
  views = [];
});

describe('显示列', () => {
  it('Tab 展开到制表位，全角字符占两列', () => {
    expect(displayColumn('\tab', 1, 4)).toBe(4);
    expect(displayColumn('a\tb', 2, 4)).toBe(4);
    expect(displayColumn('你好a', 2, 4)).toBe(4);
    expect(displayColumn('你好a', 3, 4)).toBe(5);
  });

  it('列号落在宽字符中间时取最近边界，超过行尾停在行尾', () => {
    expect(offsetAtColumn('你好', 2, 4)).toBe(1);
    expect(offsetAtColumn('你好', 3, 4)).toBe(1);
    expect(offsetAtColumn('abc', 99, 4)).toBe(3);
    expect(offsetAtColumn('', 5, 4)).toBe(0);
  });
});

describe('进入与退出', () => {
  it('Alt+Shift+Insert 切换列模式，退出后收拢为单光标', () => {
    const view = createView('abc\nabc');
    expect(press(view, 'Insert', { altKey: true, shiftKey: true })).toBe(true);
    expect(isColumnModeActive(view)).toBe(true);
    extendColumnBlock(view, 1);
    expect(view.state.selection.ranges).toHaveLength(2);
    expect(press(view, 'Insert', { altKey: true, shiftKey: true })).toBe(true);
    expect(isColumnModeActive(view)).toBe(false);
    expect(view.state.selection.ranges).toHaveLength(1);
  });

  it('已有跨行选区时以两角为矩形', () => {
    const view = createView('abcdef\nabcdef\nabcdef', 1, 18);
    toggleColumnMode(view);
    expect(view.state.selection.ranges.map((range) => view.state.sliceDoc(range.from, range.to)))
      .toEqual(['bcd', 'bcd', 'bcd']);
  });

  it('Esc 退出列模式，未进入时不拦截', () => {
    const view = enterBlock('ab\nab\nab', 1, 2);
    expect(press(view, 'Escape')).toBe(true);
    expect(isColumnModeActive(view)).toBe(false);
    expect(view.state.selection.ranges).toHaveLength(1);
    expect(exitColumnMode(view)).toBe(false);
  });

  it('单按 Alt 退出，组合键和长按不退出', () => {
    const view = enterBlock('ab\nab', 1, 1);
    const key = (type: string, init: KeyboardEventInit, timeStamp: number) => {
      const event = new KeyboardEvent(type, { bubbles: true, ...init });
      Object.defineProperty(event, 'timeStamp', { value: timeStamp });
      view.contentDOM.dispatchEvent(event);
    };
    key('keydown', { key: 'Alt', altKey: true }, 100);
    key('keydown', { key: 'Shift', altKey: true, shiftKey: true }, 120);
    key('keyup', { key: 'Alt' }, 140);
    expect(isColumnModeActive(view)).toBe(true);

    key('keydown', { key: 'Alt', altKey: true }, 200);
    key('keyup', { key: 'Alt' }, 900);
    expect(isColumnModeActive(view)).toBe(true);

    key('keydown', { key: 'Alt', altKey: true }, 1000);
    key('keyup', { key: 'Alt' }, 1100);
    expect(isColumnModeActive(view)).toBe(false);
  });

  it('普通单击位置（select.pointer）退出，即使列块只有一行', () => {
    const view = createView('abc\nabc', 1);
    toggleColumnMode(view);
    view.dispatch({ selection: { anchor: 5 }, userEvent: 'select.pointer' });
    expect(isColumnModeActive(view)).toBe(false);
  });

  it('全选、跳到文档首尾时退出', () => {
    const view = enterBlock('ab\nab\nab', 1, 1);
    press(view, 'a', { ctrlKey: true });
    expect(isColumnModeActive(view)).toBe(false);
  });

  it('关闭设置立即退出且不可再进入，重新打开后恢复', async () => {
    const view = enterBlock('ab\nab', 1, 1);
    await useSettingsStore.getState().setEditor({ enableColumnEdit: false });
    expect(isColumnModeActive(view)).toBe(false);
    expect(view.state.selection.ranges).toHaveLength(1);
    expect(toggleColumnMode(view)).toBe(false);
    expect(press(view, 'Insert', { altKey: true, shiftKey: true })).toBe(false);

    await useSettingsStore.getState().setEditor({ enableColumnEdit: true });
    expect(toggleColumnMode(view)).toBe(true);
  });

  it('设置关闭时创建的编辑器没有列模式', async () => {
    await useSettingsStore.getState().setEditor({ enableColumnEdit: false });
    const view = createView('ab\nab');
    expect(toggleColumnMode(view)).toBe(false);
    expect(view.state.facet(EditorState.allowMultipleSelections)).toBe(false);
  });

  it('变为只读（沉浸阅读）时自动退出，只读状态下不可进入', async () => {
    const readOnly = new Compartment();
    const view = new EditorView({
      state: EditorState.create({
        doc: 'ab\nab',
        extensions: [createColumnEditExtension(), readOnly.of([])],
      }),
      parent: document.body,
    });
    views.push(view);
    toggleColumnMode(view);
    extendColumnBlock(view, 1);
    view.dispatch({ effects: readOnly.reconfigure(EditorView.editable.of(false)) });
    await Promise.resolve();
    expect(isColumnModeActive(view)).toBe(false);
    expect(view.state.selection.ranges).toHaveLength(1);
    expect(toggleColumnMode(view)).toBe(false);
  });

  it('徽标显示行数，退出后移除', () => {
    const view = enterBlock('ab\nab\nab', 1, 2);
    const badge = view.dom.querySelector('.cm-nbColumnBadge');
    expect(badge?.textContent).toContain('列编辑');
    expect(badge?.textContent).toContain('3 行');
    exitColumnMode(view);
    expect(view.dom.querySelector('.cm-nbColumnBadge')).toBeNull();
  });

  it('徽标按钮可扩行和退出（触屏入口）', () => {
    const view = createView('ab\nab\nab', 1);
    toggleColumnMode(view);
    const button = (label: string) => view.dom.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    button('向下扩展一行').click();
    expect(view.state.selection.ranges).toHaveLength(2);
    button('向上扩展一行').click();
    expect(view.state.selection.ranges).toHaveLength(1);
    button('退出列编辑').click();
    expect(isColumnModeActive(view)).toBe(false);
  });
});

describe('方向键', () => {
  it('左右移动整列且不跨行', () => {
    const view = enterBlock('abc\nabc\nabc', 0, 2);
    press(view, 'ArrowLeft');
    expect(carets(view)).toEqual([[1, 0], [2, 0], [3, 0]]);
    press(view, 'ArrowRight');
    press(view, 'ArrowRight');
    press(view, 'ArrowRight');
    press(view, 'ArrowRight');
    expect(carets(view)).toEqual([[1, 3], [2, 3], [3, 3]]);
    expect(isColumnModeActive(view)).toBe(true);
  });

  it('短行光标停在行尾，走回来后仍与长行对齐', () => {
    const view = enterBlock('abcdef\nab\nabcdef', 4, 2);
    expect(carets(view)).toEqual([[1, 4], [2, 2], [3, 4]]);
    press(view, 'ArrowRight');
    press(view, 'ArrowRight');
    expect(carets(view)).toEqual([[1, 6], [2, 2], [3, 6]]);
    press(view, 'ArrowLeft');
    press(view, 'ArrowLeft');
    press(view, 'ArrowLeft');
    press(view, 'ArrowLeft');
    press(view, 'ArrowLeft');
    expect(carets(view)).toEqual([[1, 1], [2, 1], [3, 1]]);
  });

  it('所有光标到头后反向一步立即有反应', () => {
    const view = enterBlock('ab\nab', 2, 1);
    press(view, 'ArrowRight');
    press(view, 'ArrowRight');
    press(view, 'ArrowLeft');
    expect(carets(view)).toEqual([[1, 1], [2, 1]]);
  });

  it('End 后光标错落，左移时各自走一步', () => {
    const view = enterBlock('abcd\nab', 0, 1);
    press(view, 'End');
    expect(carets(view)).toEqual([[1, 4], [2, 2]]);
    expect(isColumnModeActive(view)).toBe(true);
    press(view, 'ArrowLeft');
    expect(carets(view)).toEqual([[1, 3], [2, 1]]);
  });

  it('上下平移整块，到文档边界停住且光标不丢失', () => {
    const view = enterBlock('ab\nab\nab', 1, 1);
    press(view, 'ArrowDown');
    expect(carets(view)).toEqual([[2, 1], [3, 1]]);
    press(view, 'ArrowDown');
    expect(carets(view)).toEqual([[2, 1], [3, 1]]);
    press(view, 'ArrowUp');
    press(view, 'ArrowUp');
    expect(carets(view)).toEqual([[1, 1], [2, 1]]);
  });

  it('上下平移经过短行不会丢失原来的列', () => {
    const view = enterBlock('abcdef\nabcdef\n\nabcdef', 4, 1);
    press(view, 'ArrowDown');
    expect(carets(view)).toEqual([[2, 4], [3, 0]]);
    press(view, 'ArrowDown');
    expect(carets(view)).toEqual([[3, 0], [4, 4]]);
  });

  it('Shift+左右调整块宽，不按 Shift 时收拢到对应边缘', () => {
    const view = enterBlock('abcdef\nabcdef', 1, 1);
    press(view, 'ArrowRight', { shiftKey: true });
    press(view, 'ArrowRight', { shiftKey: true });
    expect(view.state.selection.ranges.map((range) => view.state.sliceDoc(range.from, range.to))).toEqual(['bc', 'bc']);
    press(view, 'ArrowRight');
    expect(carets(view)).toEqual([[1, 3], [2, 3]]);
  });

  it('Shift+上下按活动端伸缩，收缩到一行后可反向扩展', () => {
    const view = enterBlock('ab\nab\nab\nab', 4, 1);
    expect(carets(view)).toEqual([[2, 1], [3, 1]]);
    press(view, 'ArrowDown', { shiftKey: true });
    expect(carets(view)).toEqual([[2, 1], [3, 1], [4, 1]]);
    press(view, 'ArrowUp', { shiftKey: true });
    press(view, 'ArrowUp', { shiftKey: true });
    expect(carets(view)).toEqual([[2, 1]]);
    press(view, 'ArrowUp', { shiftKey: true });
    expect(carets(view)).toEqual([[1, 1], [2, 1]]);
    expect(view.state.selection.main.head).toBe(1);
  });

  it('全角字符逐字移动，混排时上下仍按显示列对齐', () => {
    const view = enterBlock('你好世界\nabcdefgh', 1, 1);
    expect(carets(view)).toEqual([[1, 1], [2, 2]]);
    press(view, 'ArrowRight');
    expect(carets(view)).toEqual([[1, 2], [2, 3]]);
  });

  it('词级移动不跨行', () => {
    const view = enterBlock('foo bar\nfoo bar', 0, 1);
    press(view, 'ArrowRight', { ctrlKey: true });
    press(view, 'ArrowRight', { ctrlKey: true });
    press(view, 'ArrowRight', { ctrlKey: true });
    expect(carets(view)).toEqual([[1, 7], [2, 7]]);
    expect(isColumnModeActive(view)).toBe(true);
  });
});

describe('编辑', () => {
  it('输入作用于所有行，短行追加到行尾后目标列仍同步', () => {
    const view = enterBlock('abcd\na\nabcd', 3, 2);
    type(view, 'XY');
    expect(view.state.doc.toString()).toBe('abcXYd\naXY\nabcXYd');
    expect(isColumnModeActive(view)).toBe(true);
    press(view, 'ArrowLeft');
    press(view, 'ArrowLeft');
    expect(carets(view)).toEqual([[1, 3], [2, 3], [3, 3]]);
  });

  it('退格在行首不合并行，列模式保持', () => {
    const view = enterBlock('ab\nab', 1, 1);
    press(view, 'Backspace');
    expect(view.state.doc.toString()).toBe('b\nb');
    press(view, 'Backspace');
    expect(view.state.doc.toString()).toBe('b\nb');
    expect(isColumnModeActive(view)).toBe(true);
  });

  it('Delete 在行尾不合并行', () => {
    const view = enterBlock('a\nab', 1, 1);
    press(view, 'Delete');
    expect(view.state.doc.toString()).toBe('a\na');
    press(view, 'Delete');
    expect(view.state.doc.toString()).toBe('a\na');
  });

  it('删除块选区时不误删短行行尾', () => {
    const view = createView('abcdef\nab\nabcdef', 3, 14);
    toggleColumnMode(view);
    expect(view.state.selection.ranges.map((range) => range.empty)).toEqual([false, true, false]);
    press(view, 'Backspace');
    expect(view.state.doc.toString()).toBe('abcef\nab\nabcef');
    expect(isColumnModeActive(view)).toBe(true);
  });

  it('回车打散列块时退出并收拢到主光标', () => {
    const view = enterBlock('ab\nab', 1, 1);
    press(view, 'Enter');
    expect(view.state.doc.toString()).toBe('a\nb\na\nb');
    expect(isColumnModeActive(view)).toBe(false);
    expect(view.state.selection.ranges).toHaveLength(1);
  });

  it('展开被折叠的行，避免改动看不见的内容', async () => {
    const { codeFolding, foldEffect, foldedRanges } = await import('@codemirror/language');
    const view = new EditorView({
      state: EditorState.create({ doc: 'a\nb\nc\nd', extensions: [createColumnEditExtension(), codeFolding()] }),
      parent: document.body,
    });
    views.push(view);
    view.dispatch({ effects: foldEffect.of({ from: 3, to: 5 }) });
    view.dispatch({ selection: { anchor: 0 } });
    toggleColumnMode(view);
    extendColumnBlock(view, 2);
    expect(foldedRanges(view.state).size).toBe(0);
  });
});

describe('剪贴板', () => {
  it('短行以空行占位，保持行对应', () => {
    const view = createView('abcdef\na\nabcdef', 1, 12);
    toggleColumnMode(view);
    expect(columnClipboardText(view.state)).toBe('bc\n\nbc');
  });

  it('未进入列模式或没有选中内容时交回默认逻辑', () => {
    const plain = createView('abc', 0, 2);
    expect(columnClipboardText(plain.state)).toBeNull();
    const empty = enterBlock('ab\nab', 1, 1);
    expect(columnClipboardText(empty.state)).toBeNull();
  });

  it('行数等于光标数时逐行分发，末尾换行不算一行', () => {
    const view = enterBlock('a\na', 1, 1);
    view.dispatch(pasteIntoSelection(view.state, '1\n2\n'));
    expect(view.state.doc.toString()).toBe('a1\na2');
    expect(isColumnModeActive(view)).toBe(true);
  });

  it('单行内容粘到每一行', () => {
    const view = enterBlock('a\na', 1, 1);
    view.dispatch(pasteIntoSelection(view.state, 'X'));
    expect(view.state.doc.toString()).toBe('aX\naX');
  });

  it('普通单光标不受影响', () => {
    const view = createView('a', 1);
    view.dispatch(pasteIntoSelection(view.state, '1\n2\n'));
    expect(view.state.doc.toString()).toBe('a1\n2\n');
  });
});

describe('统一历史导航', () => {
  /** 模拟 CodeEditor 的 applyEntry：整篇替换、只带主选区、不进入原生历史 */
  function applyHistoryEntry(view: EditorView, content: string, anchor: number, head = anchor) {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      selection: { anchor, head },
      annotations: Transaction.addToHistory.of(false),
    });
  }

  it('撤销列输入后整块光标回到原位，列模式不中断', () => {
    const view = enterBlock('ab\nab\nab', 1, 2);
    const mainBefore = view.state.selection.main.head;
    type(view, 'X');
    applyHistoryEntry(view, 'ab\nab\nab', mainBefore);
    expect(isColumnModeActive(view)).toBe(true);
    expect(carets(view)).toEqual([[1, 1], [2, 1], [3, 1]]);
  });

  it('快照落在其它位置时退出列模式', () => {
    const view = enterBlock('ab\nab\nab', 1, 1);
    applyHistoryEntry(view, 'ab\nab\nab', 7);
    expect(isColumnModeActive(view)).toBe(false);
    expect(view.state.selection.ranges).toHaveLength(1);
  });

  it('行数变化时退出列模式', () => {
    const view = enterBlock('ab\nab\nab', 1, 1);
    applyHistoryEntry(view, 'ab\nab', 4);
    expect(isColumnModeActive(view)).toBe(false);
  });
});

describe('渲染与副作用隔离', () => {
  it('平时使用原生选区，多选区期间才切换自绘', () => {
    const view = createView('ab\nab', 1);
    expect(view.dom.querySelector('.cm-selectionLayer')).toBeNull();
    toggleColumnMode(view);
    expect(view.dom.querySelector('.cm-selectionLayer')).toBeNull();
    extendColumnBlock(view, 1);
    expect(view.dom.querySelector('.cm-selectionLayer')).not.toBeNull();
    exitColumnMode(view);
    expect(view.dom.querySelector('.cm-selectionLayer')).toBeNull();
  });

  it('Ctrl+Alt+↑↓ 进入列模式，不产生游离的多光标', () => {
    const view = createView('ab\nab\nab', 1);
    press(view, 'ArrowDown', { ctrlKey: true, altKey: true });
    expect(isColumnModeActive(view)).toBe(true);
    expect(getColumnBlock(view.state)?.carets).toHaveLength(2);
  });

  it('Ctrl+单击不添加选区', () => {
    const view = createView('ab');
    const event = new MouseEvent('mousedown', { ctrlKey: true, metaKey: true });
    expect(view.state.facet(EditorView.clickAddsSelectionRange).every((test) => !test(event))).toBe(true);
  });

  it('外部设置单选区不受影响', () => {
    const view = createView('ab\nab');
    view.dispatch({ selection: EditorSelection.single(1, 4) });
    expect(view.state.selection.main.from).toBe(1);
    expect(isColumnModeActive(view)).toBe(false);
  });
});
