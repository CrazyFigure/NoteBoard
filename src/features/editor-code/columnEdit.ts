// NoteBoard 列编辑模式：矩形选区 + 每行一个光标，所有文本类 CodeMirror 编辑器共用
// 入口：Alt / Option + 拖动、鼠标中键拖动、Alt+Shift+Insert、Ctrl+Alt+↑↓、工具栏按钮（触屏设备唯一入口）
// 退出：Esc、中键单击、单按 Alt、普通点击、徽标关闭按钮；设置关闭时立即退出
// 平时继续用原生选区贴合字形（见 theme.ts），只有出现多选区时才临时切到 drawSelection

import {
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  Transaction,
  findClusterBreak,
  type Extension,
  type Line,
  type Text,
  type TransactionSpec,
} from '@codemirror/state';
import { foldedRanges, unfoldEffect } from '@codemirror/language';
import { EditorView, ViewPlugin, drawSelection, keymap, type ViewUpdate } from '@codemirror/view';
import { emit } from '../../core/emitter';
import { useSettingsStore } from '../../stores/settingsStore';

/** 单按 Alt 的最长按住时间：更久视为准备拖动后放弃，不算退出 */
const ALT_TAP_MS = 400;
/** 中键松开后屏蔽粘贴的时长：Linux 的主选区粘贴紧随 mouseup 触发 */
const MIDDLE_PASTE_GUARD_MS = 100;

// ── 显示列 ──

/** 东亚全角字符与常见 emoji 占两列，中英混排时选区在等宽字体下仍是矩形 */
const WIDE_CHARACTER = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u;

/** 跨过 offset 处的字符后到达的显示列：Tab 展开到下一制表位 */
function columnAfter(text: string, offset: number, column: number, tabSize: number): number {
  if (text.charCodeAt(offset) === 9) return column + tabSize - (column % tabSize);
  return column + (WIDE_CHARACTER.test(String.fromCodePoint(text.codePointAt(offset)!)) ? 2 : 1);
}

/** 行内偏移对应的显示列 */
export function displayColumn(text: string, offset: number, tabSize: number): number {
  let column = 0;
  for (let index = 0; index < offset; index = findClusterBreak(text, index)) {
    column = columnAfter(text, index, column, tabSize);
  }
  return column;
}

/** 显示列对应的行内偏移：落在宽字符或 Tab 中间时取最近的字符边界，超过行尾时停在行尾 */
export function offsetAtColumn(text: string, column: number, tabSize: number): number {
  let current = 0;
  for (let index = 0; index < text.length;) {
    const next = findClusterBreak(text, index);
    const after = columnAfter(text, index, current, tabSize);
    if (after > column) return column - current <= after - column ? index : next;
    current = after;
    index = next;
  }
  return text.length;
}

function columnAt(doc: Text, pos: number, tabSize: number): number {
  const line = doc.lineAt(pos);
  return displayColumn(line.text, pos - line.from, tabSize);
}

// ── 列块模型 ──

/** 光标的目标列：短行上实际位置被夹到行尾，目标列保留，回到足够长的行时仍能对齐 */
interface ColumnCaret {
  anchor: number;
  head: number;
}

export interface ColumnBlock {
  /** 块首行行号（从 1 起），carets[i] 落在第 firstLine + i 行 */
  firstLine: number;
  /** 每行一个光标，行号连续 */
  carets: readonly ColumnCaret[];
  /** 活动端在块顶还是块底，决定主光标和 Shift+↑↓ 的伸缩方向 */
  headAtTop: boolean;
}

interface ColumnPoint {
  line: number;
  column: number;
}

const setColumnBlock = StateEffect.define<ColumnBlock | null>();

function rectangleBlock(anchor: ColumnPoint, head: ColumnPoint): ColumnBlock {
  const caret = { anchor: anchor.column, head: head.column };
  return {
    firstLine: Math.min(anchor.line, head.line),
    carets: new Array<ColumnCaret>(Math.abs(head.line - anchor.line) + 1).fill(caret),
    headAtTop: head.line < anchor.line,
  };
}

function blockFromSelection(state: EditorState): ColumnBlock {
  const point = (pos: number): ColumnPoint => ({
    line: state.doc.lineAt(pos).number,
    column: columnAt(state.doc, pos, state.tabSize),
  });
  const { anchor, head } = state.selection.main;
  return rectangleBlock(point(anchor), point(head));
}

function selectionForBlock(doc: Text, tabSize: number, block: ColumnBlock): EditorSelection {
  const ranges = block.carets.map((caret, index) => {
    const line = doc.line(block.firstLine + index);
    return EditorSelection.range(
      line.from + offsetAtColumn(line.text, caret.anchor, tabSize),
      line.from + offsetAtColumn(line.text, caret.head, tabSize),
    );
  });
  // 主光标跟随活动端：滚动定位和统一历史记录都以主选区为准
  return EditorSelection.create(ranges, block.headAtTop ? 0 : ranges.length - 1);
}

/** 选区是否仍是"每行一段、行号连续"，是则返回首行行号 */
function columnFirstLine(doc: Text, selection: EditorSelection, count: number): number | null {
  if (selection.ranges.length !== count) return null;
  const firstLine = doc.lineAt(selection.ranges[0].from).number;
  if (firstLine + count - 1 > doc.lines) return null;
  const aligned = selection.ranges.every((range, index) => {
    const line = doc.line(firstLine + index);
    return range.from >= line.from && range.to <= line.to;
  });
  return aligned ? firstLine : null;
}

/** 事务落地后重算目标列：编辑时保留短行超出行尾的部分，纯移动时以实际位置为准 */
function remapBlock(block: ColumnBlock, tr: Transaction): ColumnBlock | null {
  if (tr.isUserEvent('select.pointer')) return null;
  const { startState, newDoc, newSelection } = tr;
  if (!tr.docChanged && newSelection.eq(startState.selection)) return block;
  const firstLine = columnFirstLine(newDoc, newSelection, block.carets.length);
  if (firstLine === null) return null;
  const { tabSize } = startState;
  const carets = block.carets.map((caret, index) => {
    const range = newSelection.ranges[index];
    const anchor = columnAt(newDoc, range.anchor, tabSize);
    const head = columnAt(newDoc, range.head, tabSize);
    if (!tr.docChanged) return { anchor, head };
    const before = startState.selection.ranges[index];
    const anchorOverflow = caret.anchor - columnAt(startState.doc, before.anchor, tabSize);
    const headOverflow = caret.head - columnAt(startState.doc, before.head, tabSize);
    if (!range.empty) return { anchor: anchor + anchorOverflow, head: head + headOverflow };
    // 选区被替换成光标后，块的左缘才是新的基准
    const column = head + Math.min(anchorOverflow, headOverflow);
    return { anchor: column, head: column };
  });
  return { firstLine, carets, headAtTop: block.headAtTop };
}

const columnField = StateField.define<ColumnBlock | null>({
  create: () => null,
  update(block, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setColumnBlock)) return effect.value;
    }
    if (!block || (!tr.docChanged && !tr.selection)) return block;
    return remapBlock(block, tr);
  },
});

/**
 * 统一历史导航整篇替换正文、只带主选区，会把列块打散。
 * 行数未变且主选区仍在活动行时，按快照的列重建整块，撤销和重做不中断列编辑。
 */
function blockAfterHistoryJump(tr: Transaction, block: ColumnBlock): ColumnBlock | null {
  if (!tr.docChanged || !tr.selection || tr.selection.ranges.length !== 1) return null;
  if (tr.annotation(Transaction.addToHistory) !== false) return null;
  if (tr.newDoc.lines !== tr.startState.doc.lines) return null;
  const { anchor, head } = tr.selection.main;
  const headLine = block.headAtTop ? block.firstLine : block.firstLine + block.carets.length - 1;
  if (tr.newDoc.lineAt(anchor).number !== headLine || tr.newDoc.lineAt(head).number !== headLine) return null;
  const { tabSize } = tr.startState;
  const caret = { anchor: columnAt(tr.newDoc, anchor, tabSize), head: columnAt(tr.newDoc, head, tabSize) };
  return { ...block, carets: block.carets.map(() => caret) };
}

/** 多行内容（回车、行数不符的粘贴）会打散列块：退出时收拢到主光标，不留下无提示的多光标 */
const columnConsistency = EditorState.transactionFilter.of((tr) => {
  const block = tr.startState.field(columnField, false);
  if (!block || (!tr.docChanged && !tr.selection)) return tr;
  if (tr.effects.some((effect) => effect.is(setColumnBlock))) return tr;
  const restored = blockAfterHistoryJump(tr, block);
  if (restored) {
    return [tr, {
      selection: selectionForBlock(tr.newDoc, tr.startState.tabSize, restored),
      effects: setColumnBlock.of(restored),
      sequential: true,
    }];
  }
  const { ranges, main } = tr.newSelection;
  if (ranges.length > 1 && columnFirstLine(tr.newDoc, tr.newSelection, block.carets.length) === null) {
    return [tr, { selection: EditorSelection.cursor(main.head), sequential: true }];
  }
  return tr;
});

// ── 多选区渲染 ──

/** 原生选区只能画一段；多选区期间换成 CodeMirror 自绘，单选区立即切回原生 */
const selectionDrawing = new Compartment();
const drawnSelection = drawSelection();

const selectionDrawingSwitch = EditorState.transactionExtender.of((tr) => {
  const wanted = tr.newSelection.ranges.length > 1;
  const current = selectionDrawing.get(tr.startState) === drawnSelection;
  if (wanted === current) return null;
  return { effects: selectionDrawing.reconfigure(wanted ? drawnSelection : []) };
});

// ── 模式进出 ──

function isEditable(state: EditorState): boolean {
  return !state.readOnly && state.facet(EditorView.editable);
}

export function getColumnBlock(state: EditorState): ColumnBlock | null {
  return state.field(columnField, false) ?? null;
}

export function isColumnModeActive(view: EditorView): boolean {
  return getColumnBlock(view.state) !== null;
}

/** 组装列块事务：列块覆盖到的折叠内容自动展开，避免改动看不见的行 */
function blockSpec(state: EditorState, block: ColumnBlock, scrollIntoView: boolean) {
  const selection = selectionForBlock(state.doc, state.tabSize, block);
  const { from } = selection.ranges[0];
  const { to } = selection.ranges[selection.ranges.length - 1];
  const effects: StateEffect<unknown>[] = [setColumnBlock.of(block)];
  foldedRanges(state).between(from, to, (foldFrom, foldTo) => {
    if (foldFrom < to && foldTo > from) effects.push(unfoldEffect.of({ from: foldFrom, to: foldTo }));
  });
  return { selection, effects, scrollIntoView, userEvent: 'select' };
}

/** 提交列块；所有光标都走到头时不改目标列，否则反向按键要先抵消空走的步数才有反应 */
function commitBlock(view: EditorView, block: ColumnBlock): boolean {
  const spec = blockSpec(view.state, block, true);
  if (!spec.selection.eq(view.state.selection)) view.dispatch(spec);
  return true;
}

export function exitColumnMode(view: EditorView): boolean {
  if (!isColumnModeActive(view)) return false;
  view.dispatch({
    selection: EditorSelection.cursor(view.state.selection.main.head),
    effects: setColumnBlock.of(null),
  });
  return true;
}

/** 工具栏与 Alt+Shift+Insert 共用：已有跨行选区时以两角为矩形，否则从当前光标开始 */
export function toggleColumnMode(view: EditorView): boolean {
  if (view.state.field(columnField, false) === undefined || !isEditable(view.state)) return false;
  if (isColumnModeActive(view)) return exitColumnMode(view);
  view.dispatch(blockSpec(view.state, blockFromSelection(view.state), true));
  return true;
}

// ── 光标移动 ──

/** 活动端朝外走一行时扩展，朝内走时收缩；行数足够时始终保留至少一行 */
function resizeBlock(doc: Text, block: ColumnBlock, lines: number): ColumnBlock {
  const carets = [...block.carets];
  const down = lines > 0;
  let { firstLine, headAtTop } = block;
  for (let step = Math.abs(lines); step > 0; step -= 1) {
    if (carets.length === 1) headAtTop = !down;
    if (headAtTop === down) {
      if (headAtTop) {
        carets.shift();
        firstLine += 1;
      } else {
        carets.pop();
      }
      continue;
    }
    const nextLine = headAtTop ? firstLine - 1 : firstLine + carets.length;
    if (nextLine < 1 || nextLine > doc.lines) break;
    if (headAtTop) {
      carets.unshift(carets[0]);
      firstLine -= 1;
    } else {
      carets.push(carets[carets.length - 1]);
    }
  }
  return { firstLine, carets, headAtTop };
}

/** 在当前列块上增减行；未进入列模式时从当前光标开始 */
export function extendColumnBlock(view: EditorView, lines: number): boolean {
  if (!isEditable(view.state)) return false;
  const block = getColumnBlock(view.state) ?? blockFromSelection(view.state);
  return commitBlock(view, resizeBlock(view.state.doc, block, lines));
}

function moveVertically(view: EditorView, block: ColumnBlock, lines: number, extend: boolean): boolean {
  if (extend) return commitBlock(view, resizeBlock(view.state.doc, block, lines));
  // 整块平移且不越过文档首尾，光标不会在边界处合并丢失
  const lastFirstLine = view.state.doc.lines - block.carets.length + 1;
  const firstLine = Math.max(1, Math.min(block.firstLine + lines, lastFirstLine));
  const carets = block.carets.map(({ head }) => ({ anchor: head, head }));
  return commitBlock(view, { ...block, firstLine, carets });
}

function pageLines(view: EditorView): number {
  return Math.max(1, Math.floor(view.scrollDOM.clientHeight / view.defaultLineHeight) - 1);
}

/** 单个光标横向走一步，绝不跨行：行尾之外只推进目标列 */
function stepColumn(view: EditorView, line: Line, column: number, forward: boolean, byGroup: boolean): number {
  const { tabSize } = view.state;
  const width = displayColumn(line.text, line.length, tabSize);
  if (column > width || (forward && column === width)) return column + (forward ? 1 : -1);
  const offset = offsetAtColumn(line.text, column, tabSize);
  const next = byGroup
    ? Math.min(Math.max(view.moveByGroup(EditorSelection.cursor(line.from + offset), forward).head, line.from), line.to) - line.from
    : findClusterBreak(line.text, offset, forward);
  return displayColumn(line.text, next, tabSize);
}

function moveHorizontally(view: EditorView, block: ColumnBlock, forward: boolean, extend: boolean, byGroup: boolean): boolean {
  const { doc, tabSize } = view.state;
  // 鼠标可以拖到所有行的行尾之外，先收回到最长行，否则左移要空走若干步
  const widest = block.carets.reduce((width, _, index) => {
    const line = doc.line(block.firstLine + index);
    return Math.max(width, displayColumn(line.text, line.length, tabSize));
  }, 0);
  const carets = block.carets.map((caret, index) => {
    // 与普通选区一致：不按 Shift 时有宽度的块先收拢到对应边缘
    if (!extend && caret.anchor !== caret.head) {
      const edge = (forward ? Math.max : Math.min)(caret.anchor, caret.head);
      return { anchor: edge, head: edge };
    }
    const head = stepColumn(view, doc.line(block.firstLine + index), Math.min(caret.head, widest), forward, byGroup);
    return { anchor: extend ? caret.anchor : head, head };
  });
  return commitBlock(view, { ...block, carets });
}

// ── 删除 ──

/** 删除块内选中的文字；短行上的空范围没有内容可删，保持不动 */
function deleteBlockContent(state: EditorState) {
  return state.changeByRange((range) => ({
    changes: { from: range.from, to: range.to },
    range: EditorSelection.cursor(range.from),
  }));
}

/** 退格和 Delete 只删本行内容：行首行尾不合并行，否则列块立刻被打散 */
function deleteWithinLine(view: EditorView, forward: boolean, byGroup: boolean): boolean {
  const { state } = view;
  if (state.readOnly) return false;
  if (state.selection.ranges.some((range) => !range.empty)) {
    view.dispatch(deleteBlockContent(state), {
      scrollIntoView: true,
      userEvent: forward ? 'delete.forward' : 'delete.backward',
    });
    return true;
  }
  const changes = state.changeByRange((range) => {
    const line = state.doc.lineAt(range.head);
    const target = byGroup
      ? Math.min(Math.max(view.moveByGroup(range, forward).head, line.from), line.to)
      : line.from + findClusterBreak(line.text, range.head - line.from, forward);
    const from = Math.min(range.head, target);
    const to = Math.max(range.head, target);
    return { changes: { from, to }, range: EditorSelection.cursor(from) };
  });
  view.dispatch(changes, { scrollIntoView: true, userEvent: forward ? 'delete.forward' : 'delete.backward' });
  return true;
}

// ── 快捷键 ──

function onBlock(run: (view: EditorView, block: ColumnBlock) => boolean) {
  return (view: EditorView) => {
    const block = getColumnBlock(view.state);
    return block ? run(view, block) : false;
  };
}

const moveColumn = (forward: boolean, extend: boolean, byGroup = false) =>
  onBlock((view, block) => moveHorizontally(view, block, forward, extend, byGroup));
const moveLines = (lines: number, extend: boolean) =>
  onBlock((view, block) => moveVertically(view, block, lines, extend));
const movePage = (direction: 1 | -1, extend: boolean) =>
  onBlock((view, block) => moveVertically(view, block, direction * pageLines(view), extend));
const deleteColumn = (forward: boolean, byGroup = false) =>
  onBlock((view) => deleteWithinLine(view, forward, byGroup));

// Home / End 等未列出的按键沿用默认命令：它们逐光标执行且不跨行，remapBlock 会同步目标列
const columnKeymap = Prec.highest(keymap.of([
  { key: 'Escape', run: exitColumnMode, stopPropagation: true },
  { key: 'ArrowLeft', run: moveColumn(false, false), shift: moveColumn(false, true) },
  { key: 'ArrowRight', run: moveColumn(true, false), shift: moveColumn(true, true) },
  { key: 'Mod-ArrowLeft', mac: 'Alt-ArrowLeft', run: moveColumn(false, false, true), shift: moveColumn(false, true, true) },
  { key: 'Mod-ArrowRight', mac: 'Alt-ArrowRight', run: moveColumn(true, false, true), shift: moveColumn(true, true, true) },
  { key: 'ArrowUp', run: moveLines(-1, false), shift: moveLines(-1, true) },
  { key: 'ArrowDown', run: moveLines(1, false), shift: moveLines(1, true) },
  { key: 'PageUp', run: movePage(-1, false), shift: movePage(-1, true) },
  { key: 'PageDown', run: movePage(1, false), shift: movePage(1, true) },
  { key: 'Backspace', run: deleteColumn(false), shift: deleteColumn(false) },
  { key: 'Delete', run: deleteColumn(true) },
  { key: 'Mod-Backspace', mac: 'Alt-Backspace', run: deleteColumn(false, true) },
  { key: 'Mod-Delete', mac: 'Alt-Delete', run: deleteColumn(true, true) },
  // 顶替 CodeMirror 默认的逐个加光标，键盘操作同样落在列模式里
  { key: 'Mod-Alt-ArrowUp', run: (view) => extendColumnBlock(view, -1) },
  { key: 'Mod-Alt-ArrowDown', run: (view) => extendColumnBlock(view, 1) },
  { key: 'Alt-Shift-Insert', run: toggleColumnMode },
]));

// ── 鼠标 ──

function pointAtEvent(view: EditorView, event: MouseEvent): ColumnPoint {
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
  const line = view.state.doc.lineAt(pos);
  let column = displayColumn(line.text, pos - line.from, view.state.tabSize);
  // 拖到行尾右侧时按字符宽度继续计列，短行上起笔也能选中长行
  if (pos === line.to) {
    const lineEnd = view.coordsAtPos(pos);
    if (lineEnd && event.clientX > lineEnd.right) {
      column += Math.round((event.clientX - lineEnd.right) / view.defaultCharacterWidth);
    }
  }
  return { line: line.number, column };
}

const columnMouseSelection = Prec.high(EditorView.mouseSelectionStyle.of((view, event) => {
  const middle = event.button === 1;
  const altDrag = event.button === 0 && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
  if ((!middle && !altDrag) || !isEditable(view.state)) return null;
  // 只能在这里阻止默认行为：提前阻止会让 CodeMirror 跳过 mousedown 处理。
  // 这同时关掉了 Windows 中键自动滚动和按在选区上时的原生文本拖拽。
  event.preventDefault();

  const wasActive = isColumnModeActive(view);
  const pressedAt = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
  let start = pointAtEvent(view, event);
  let dragged = false;
  const { scrollDOM } = view;
  const { ownerDocument } = scrollDOM;
  scrollDOM.style.cursor = 'crosshair';

  const handleMouseUp = (up: MouseEvent) => {
    if (up.button !== event.button) return;
    ownerDocument.removeEventListener('mouseup', handleMouseUp, true);
    scrollDOM.style.cursor = '';
    if (!middle) return;
    view.plugin(columnModePlugin)?.blockMiddlePaste(up.timeStamp);
    // 中键按下又松开没有拖动：退出列模式
    if (!dragged && wasActive) exitColumnMode(view);
  };
  ownerDocument.addEventListener('mouseup', handleMouseUp, true);

  return {
    update(update) {
      if (!update.docChanged) return;
      const lineStart = update.startState.doc.line(start.line).from;
      start = { line: update.state.doc.lineAt(update.changes.mapPos(lineStart)).number, column: start.column };
    },
    get(current) {
      const point = pointAtEvent(view, current);
      dragged ||= point.line !== start.line || point.column !== start.column;
      // 未拖动时：Alt+单击等同普通单击，中键单击不动光标
      if (!dragged) return middle ? view.state.selection : EditorSelection.single(pressedAt);
      const block = rectangleBlock(start, point);
      const { state } = view;
      if (block.carets.length === 1) return selectionForBlock(state.doc, state.tabSize, block);
      view.dispatch(blockSpec(state, block, false));
      return view.state.selection;
    },
  };
}));

// ── 剪贴板 ──

/** 列块内的短行以空行占位，粘贴时每行才能回到原来的列 */
export function columnClipboardText(state: EditorState): string | null {
  const { ranges } = state.selection;
  if (!getColumnBlock(state) || ranges.every((range) => range.empty)) return null;
  return ranges.map((range) => state.sliceDoc(range.from, range.to)).join(state.lineBreak);
}

function dropTrailingBreak(text: string, state: EditorState): string {
  return getColumnBlock(state) ? text.replace(/\r?\n$/, '') : text;
}

/** 右键菜单粘贴：与键盘粘贴一致，行数等于光标数时逐行分发 */
export function pasteIntoSelection(state: EditorState, text: string): TransactionSpec {
  const lines = state.toText(dropTrailingBreak(text, state));
  if (state.selection.ranges.length === 1 || lines.lines !== state.selection.ranges.length) {
    return state.replaceSelection(text);
  }
  let lineNumber = 1;
  return state.changeByRange((range) => {
    const line = lines.line(lineNumber);
    lineNumber += 1;
    return {
      changes: { from: range.from, to: range.to, insert: line.text },
      range: EditorSelection.cursor(range.from + line.length),
    };
  });
}

function writeColumnClipboard(view: EditorView, event: ClipboardEvent, cut: boolean): boolean {
  const text = columnClipboardText(view.state);
  if (text === null || !event.clipboardData) return false;
  event.clipboardData.clearData();
  event.clipboardData.setData('text/plain', text);
  if (cut && !view.state.readOnly) {
    view.dispatch(deleteBlockContent(view.state), { scrollIntoView: true, userEvent: 'delete.cut' });
  }
  return true;
}

// ── 状态徽标与事件 ──

function createBadgeButton(label: string, text: string, className: string, onPress: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = text;
  button.setAttribute('aria-label', label);
  button.addEventListener('click', onPress);
  return button;
}

const columnModePlugin = ViewPlugin.fromClass(class {
  private badge: HTMLElement | null = null;
  private lineCount: HTMLElement | null = null;
  private altPressedAt = -1;
  private pasteBlockedUntil = 0;

  constructor(readonly view: EditorView) {
    this.render(getColumnBlock(view.state));
  }

  update(update: ViewUpdate) {
    const block = getColumnBlock(update.state);
    const before = getColumnBlock(update.startState);
    // 进入沉浸阅读或只读共享时退出：update 期间不能派发事务
    if (block && !isEditable(update.state)) queueMicrotask(() => exitColumnMode(this.view));
    if (block === before) return;
    this.render(block);
    if (!block !== !before) emit('column-edit-changed', undefined);
  }

  destroy() {
    this.badge?.remove();
  }

  blockMiddlePaste(releasedAt: number) {
    this.pasteBlockedUntil = releasedAt + MIDDLE_PASTE_GUARD_MS;
  }

  isPasteBlocked(event: Event) {
    return event.timeStamp < this.pasteBlockedUntil;
  }

  /** 只有单独轻按 Alt 才算退出：组合键、拖动和切窗口都不触发 */
  trackAltKey(event: KeyboardEvent) {
    if (event.key !== 'Alt') {
      this.altPressedAt = -1;
    } else if (!event.repeat) {
      this.altPressedAt = event.ctrlKey || event.shiftKey || event.metaKey ? -1 : event.timeStamp;
    }
  }

  releaseAltKey(event: KeyboardEvent) {
    if (event.key !== 'Alt' || this.altPressedAt < 0) return;
    const tapped = event.timeStamp - this.altPressedAt < ALT_TAP_MS;
    this.altPressedAt = -1;
    if (tapped) exitColumnMode(this.view);
  }

  cancelAltTap() {
    this.altPressedAt = -1;
  }

  private render(block: ColumnBlock | null) {
    if (!block) {
      this.badge?.remove();
      this.badge = null;
      this.lineCount = null;
      return;
    }
    if (!this.badge) this.mountBadge();
    this.lineCount!.textContent = `${block.carets.length} 行`;
  }

  private mountBadge() {
    const { view } = this;
    const pressed = (run: () => void) => () => {
      run();
      view.focus();
    };
    const badge = document.createElement('div');
    badge.className = 'cm-nbColumnBadge';
    badge.setAttribute('role', 'status');
    // 点击徽标不抢走编辑器焦点，触屏上软键盘也不会收起
    badge.addEventListener('mousedown', (event) => event.preventDefault());
    const title = document.createElement('span');
    title.className = 'cm-nbColumnBadge-title';
    title.textContent = '列编辑';
    const lineCount = document.createElement('span');
    const hint = document.createElement('span');
    hint.className = 'cm-nbColumnBadge-hint';
    hint.textContent = 'Esc 退出';
    badge.append(
      title,
      lineCount,
      hint,
      // 触屏没有 Shift+方向键，用按钮增减行；鼠标设备上隐藏
      createBadgeButton('向上扩展一行', '↑', 'cm-nbColumnBadge-extend', pressed(() => extendColumnBlock(view, -1))),
      createBadgeButton('向下扩展一行', '↓', 'cm-nbColumnBadge-extend', pressed(() => extendColumnBlock(view, 1))),
      createBadgeButton('退出列编辑', '×', '', pressed(() => exitColumnMode(view))),
    );
    view.dom.appendChild(badge);
    this.badge = badge;
    this.lineCount = lineCount;
  }
}, {
  eventObservers: {
    keydown(event) { this.trackAltKey(event); },
    keyup(event) { this.releaseAltKey(event); },
    mousedown() { this.cancelAltTap(); },
    blur() { this.cancelAltTap(); },
  },
  eventHandlers: {
    paste(event) { return this.isPasteBlocked(event); },
    // 多选区下拖动文本只会搬走主选区，一律不启动
    dragstart() { return isColumnModeActive(this.view); },
    copy(event) { return writeColumnClipboard(this.view, event, false); },
    cut(event) { return writeColumnClipboard(this.view, event, true); },
  },
});

// 分屏编辑器没有 nbEditorTheme，自绘光标和选区的配色在这里统一，随主题变量切换
const columnTheme = EditorView.theme({
  '.cm-cursor': { borderLeftColor: 'var(--cm-cursor)', borderLeftWidth: '2px' },
  '.cm-selectionLayer .cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    background: 'var(--cm-selection-bg)',
  },
  '@keyframes cm-nbColumnBadge-in': {
    from: { opacity: '0', transform: 'translateY(4px)' },
    to: { opacity: '1', transform: 'none' },
  },
  '.cm-nbColumnBadge': {
    position: 'absolute',
    right: '16px',
    bottom: '12px',
    zIndex: '300',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    height: '24px',
    padding: '0 3px 0 10px',
    borderRadius: '12px',
    border: '1px solid var(--editor-border)',
    background: 'var(--editor-surface)',
    color: 'var(--editor-text-muted)',
    fontFamily: 'var(--ui-font-family, inherit)',
    fontSize: '11px',
    lineHeight: '1',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.12)',
    userSelect: 'none',
    cursor: 'default',
    animation: 'cm-nbColumnBadge-in 120ms ease-out',
  },
  '.cm-nbColumnBadge-title': { color: 'var(--accent-strong)', fontWeight: '600' },
  '.cm-nbColumnBadge-hint': { opacity: '0.75' },
  '.cm-nbColumnBadge button': {
    width: '18px',
    height: '18px',
    padding: '0',
    border: 'none',
    borderRadius: '50%',
    background: 'transparent',
    color: 'inherit',
    fontFamily: 'inherit',
    fontSize: '13px',
    lineHeight: '18px',
    cursor: 'pointer',
    transition: 'background 100ms ease, color 100ms ease',
  },
  // 触屏点按后 :hover 会一直粘着，只在能悬停的设备上生效
  '@media (hover: hover)': {
    '.cm-nbColumnBadge button:hover': {
      background: 'color-mix(in srgb, var(--editor-text) 10%, transparent)',
      color: 'var(--editor-text)',
    },
  },
  '.cm-nbColumnBadge button:active': {
    background: 'color-mix(in srgb, var(--editor-text) 18%, transparent)',
  },
  '.cm-nbColumnBadge-extend': { display: 'none' },
  // 触屏没有 Esc，换成扩行按钮，并放大点按区域
  '@media (pointer: coarse)': {
    '.cm-nbColumnBadge': { height: '32px', borderRadius: '16px', gap: '8px' },
    '.cm-nbColumnBadge-hint': { display: 'none' },
    '.cm-nbColumnBadge-extend': { display: 'inline-block' },
    '.cm-nbColumnBadge button': { width: '26px', height: '26px', lineHeight: '26px' },
  },
});

const columnEditCore: Extension = [
  EditorState.allowMultipleSelections.of(true),
  // 多选区只服务列模式：Ctrl+单击保持原有行为（Markdown 源码里用于跳转双向链接）
  EditorView.clickAddsSelectionRange.of(() => false),
  // 多行文本末尾带换行时不算多一行，否则会整段粘到每个光标
  EditorView.clipboardInputFilter.of(dropTrailingBreak),
  columnField,
  columnConsistency,
  selectionDrawing.of([]),
  selectionDrawingSwitch,
  columnKeymap,
  columnMouseSelection,
  columnModePlugin,
  columnTheme,
];

/** 每个实例独立持有开关；设置关闭时立即退出列模式，其它窗口改设置时同样生效 */
export function createColumnEditExtension(): Extension {
  const compartment = new Compartment();
  const isEnabled = () => useSettingsStore.getState().settings.editor.enableColumnEdit !== false;
  return [
    compartment.of(isEnabled() ? columnEditCore : []),
    ViewPlugin.define((view) => {
      const unsubscribe = useSettingsStore.subscribe((state, previous) => {
        const enabled = state.settings.editor.enableColumnEdit !== false;
        if (enabled === (previous.settings.editor.enableColumnEdit !== false)) return;
        view.dispatch({
          selection: enabled ? undefined : view.state.selection.asSingle(),
          effects: compartment.reconfigure(enabled ? columnEditCore : []),
        });
      });
      return { destroy: unsubscribe };
    }),
  ];
}
