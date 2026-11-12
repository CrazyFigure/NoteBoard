// NoteBoard Markdown 表格行 / 列拖动把手
// 鼠标悬停单元格或光标位于单元格内时，在该行左边框、该列上边框显示把手：
// 单击选中整行 / 整列，按住拖动调整顺序。拖动中其余行列实时让位，松手后平滑落位。
//
// 实现要点：单元格由 ProseMirror 管理，直接改其 style / class 会被当成 DOM 变更重新解析。
// 因此位移全部通过注入的样式表（按行列序号选择单元格）与 <table> 上的 CSS 变量完成，
// 表格节点视图（TableView）会忽略 <table> 自身的属性变更。

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { Editor } from '@tiptap/core';
import type { ResolvedPos } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { CellSelection } from '@tiptap/pm/tables';
import { Tooltip } from '../../components/Tooltip';
import { isTableReorderable, moveTableAxisTr, selectTableAxisTr, type TableAxis } from './tableReorder';
import '../../styles/tableDragHandle.css';

/** 超过此位移才进入拖动，避免单击把手时误触排序 */
const DRAG_START_DISTANCE = 4;
/** 落位动画时长，需与 tableDragHandle.css 中的过渡时长一致 */
const SETTLE_DURATION = 240;
/** 指针离开单元格后把手的保留时间，便于移到把手上 */
const HIDE_DELAY = 160;
/** 拖动行时靠近滚动视口上下边缘的自动滚动热区与最大步长 */
const AUTO_SCROLL_EDGE = 48;
const AUTO_SCROLL_MAX_STEP = 12;

/** 把手指向的单元格：表格位置与行列号 */
interface CellTarget {
  tablePos: number;
  row: number;
  col: number;
}

/** 滚动内容坐标系下的矩形（与把手同一坐标系） */
interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface HandleLayout {
  target: CellTarget;
  row: { x: number; y: number };
  /** 列中心滚出表格横向可视区时不显示列把手 */
  column: { x: number; y: number } | null;
  rowBox: Box;
  columnBox: Box;
}

/** 沿拖动方向的一段区间（行的上下沿 / 列的左右沿） */
interface Segment {
  start: number;
  end: number;
}

interface DragSession {
  axis: TableAxis;
  tablePos: number;
  index: number;
  pointerId: number;
  handle: HTMLElement;
  scrollParent: HTMLElement;
  startClientX: number;
  startClientY: number;
  /** 按下时指针在滚动内容坐标系中沿拖动方向的位置 */
  startContent: number;
  dragging: boolean;
  settling: boolean;
  tableEl: HTMLTableElement | null;
  styleEl: HTMLStyleElement | null;
  id: string;
  segments: Segment[];
  frame: Box;
  delta: number;
  target: number;
  settleTimer: ReturnType<typeof setTimeout> | null;
  originalBodyCursor: string;
  originalBodyUserSelect: string;
}

interface DragView {
  axis: TableAxis;
  frame: Box;
  phase: 'dragging' | 'settling';
}

let sessionSeq = 0;

/** 从编辑器向外查找真正承载滚动的容器（与块拖拽把手一致） */
function findScrollParent(editorDom: HTMLElement): HTMLElement {
  let current = editorDom.parentElement;
  while (current) {
    const { overflowY } = window.getComputedStyle(current);
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return current;
    current = current.parentElement;
  }
  return editorDom.parentElement ?? editorDom;
}

/** 视口坐标换算到滚动内容坐标的偏移量 */
function contentOffset(scrollParent: HTMLElement): { x: number; y: number } {
  const rect = scrollParent.getBoundingClientRect();
  return { x: scrollParent.scrollLeft - rect.left, y: scrollParent.scrollTop - rect.top };
}

/** 表格节点对应的 <table> 元素（节点视图外层是 tableWrapper） */
function getTableElement(view: EditorView, tablePos: number): HTMLTableElement | null {
  const dom = view.nodeDOM(tablePos);
  if (dom instanceof HTMLTableElement) return dom;
  if (!(dom instanceof HTMLElement)) return null;
  for (const child of Array.from(dom.children)) {
    if (child instanceof HTMLTableElement) return child;
  }
  return null;
}

/** 位置所在的单元格；单元格深度至少为 3（表格可嵌在列表等容器内） */
function targetFromResolved($pos: ResolvedPos): CellTarget | null {
  for (let depth = $pos.depth; depth >= 3; depth--) {
    const role = $pos.node(depth).type.spec.tableRole;
    if (role === 'cell' || role === 'header_cell') {
      return { tablePos: $pos.before(depth - 2), row: $pos.index(depth - 2), col: $pos.index(depth - 1) };
    }
  }
  return null;
}

function targetFromSelection(state: EditorState): CellTarget | null {
  const { selection, doc } = state;
  if (selection instanceof CellSelection) return targetFromResolved(doc.resolve(selection.$headCell.pos + 1));
  return targetFromResolved(selection.$head);
}

function targetFromCellElement(view: EditorView, cell: HTMLElement): CellTarget | null {
  try {
    return targetFromResolved(view.state.doc.resolve(view.posAtDOM(cell, 0)));
  } catch {
    return null;
  }
}

function sameTarget(a: CellTarget | null, b: CellTarget | null): boolean {
  return a === b || (!!a && !!b && a.tablePos === b.tablePos && a.row === b.row && a.col === b.col);
}

/** 表格在横向滚动容器中实际可见的左右范围（视口坐标） */
function visibleRange(tableEl: HTMLTableElement): { left: number; right: number } {
  const tableRect = tableEl.getBoundingClientRect();
  const wrapperRect = (tableEl.parentElement ?? tableEl).getBoundingClientRect();
  return { left: Math.max(tableRect.left, wrapperRect.left), right: Math.min(tableRect.right, wrapperRect.right) };
}

/** 读取目标单元格所在行列的把手坐标与高亮框 */
function measure(view: EditorView, scrollParent: HTMLElement, target: CellTarget): HandleLayout | null {
  const table = view.state.doc.nodeAt(target.tablePos);
  if (!table || !isTableReorderable(table)) return null;
  const tableEl = getTableElement(view, target.tablePos);
  const rowEl = tableEl?.rows[target.row];
  const cellEl = rowEl?.cells[target.col];
  if (!tableEl || !rowEl || !cellEl) return null;

  const tableRect = tableEl.getBoundingClientRect();
  // 表格不可见（如位于收起的折叠块内）
  if (tableRect.width === 0 && tableRect.height === 0) return null;
  const offset = contentOffset(scrollParent);
  const visible = visibleRange(tableEl);
  const rowRect = rowEl.getBoundingClientRect();
  const cellRect = cellEl.getBoundingClientRect();
  const columnCenter = (cellRect.left + cellRect.right) / 2;
  const columnLeft = Math.max(cellRect.left, visible.left);
  const columnRight = Math.min(cellRect.right, visible.right);

  return {
    target,
    row: { x: visible.left + offset.x, y: (rowRect.top + rowRect.bottom) / 2 + offset.y },
    column: columnCenter >= visible.left + 6 && columnCenter <= visible.right - 6
      ? { x: columnCenter + offset.x, y: tableRect.top + offset.y }
      : null,
    rowBox: {
      left: visible.left + offset.x,
      top: rowRect.top + offset.y,
      width: visible.right - visible.left,
      height: rowRect.height,
    },
    columnBox: {
      left: columnLeft + offset.x,
      top: tableRect.top + offset.y,
      width: Math.max(0, columnRight - columnLeft),
      height: tableRect.height,
    },
  };
}

/** 第 index 行 / 列全部单元格的选择器；tag 限定 th 或 td */
function cellSelector(session: DragSession, index: number, tag = '*'): string {
  const base = `.ProseMirror table[data-nb-table-dnd="${session.id}"] > tbody > tr`;
  return session.axis === 'row'
    ? `${base}:nth-child(${index + 1}) > ${tag}`
    : `${base} > ${tag}:nth-child(${index + 1})`;
}

/**
 * 写入本次拖动的单元格位移规则
 * @param moved 被拖动（或落位中）的行列序号，其位移由 CSS 变量驱动
 * @param withShifts 是否让其余行列让位（仅拖动中）
 * @param follow 被拖动行列是否跟手（关闭过渡）
 */
function writeRules(session: DragSession, moved: number, withShifts: boolean, follow: boolean) {
  if (!session.styleEl) return;
  const { axis, index, target, segments } = session;
  const variable = axis === 'row' ? 'translate3d(0, var(--nb-dnd-y, 0px), 0)' : 'translate3d(var(--nb-dnd-x, 0px), 0, 0)';
  const rules = [
    `${cellSelector(session, moved)} { transform: ${variable}; z-index: 3;${follow ? ' transition: none;' : ''} }`,
    // 被拖动的单元格需不透明底色盖住让位的单元格；表头叠加表头底色
    `${cellSelector(session, moved, 'td')} { background-color: var(--editor-bg); }`,
    `${cellSelector(session, moved, 'th')} { background: linear-gradient(var(--editor-code-bg), var(--editor-code-bg)), var(--editor-bg); }`,
  ];
  if (withShifts && target !== index) {
    const size = segments[index].end - segments[index].start;
    // 向后拖：中间的行列前移一个拖动元素的尺寸；向前拖：后移
    const shift = target > index ? -size : size;
    const [from, to] = target > index ? [index + 1, target] : [target, index - 1];
    for (let current = from; current <= to; current++) {
      const translate = axis === 'row' ? `translate3d(0, ${shift}px, 0)` : `translate3d(${shift}px, 0, 0)`;
      rules.push(`${cellSelector(session, current)} { transform: ${translate}; }`);
    }
  }
  session.styleEl.textContent = rules.join('\n');
}

/** 六点抓手图标：行把手竖排、列把手横排 */
function GripIcon({ axis }: { axis: TableAxis }) {
  const dots = axis === 'row'
    ? [[2, 2], [6, 2], [2, 6], [6, 6], [2, 10], [6, 10]]
    : [[2, 2], [6, 2], [10, 2], [2, 6], [6, 6], [10, 6]];
  const width = axis === 'row' ? 8 : 12;
  const height = axis === 'row' ? 12 : 8;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {dots.map(([cx, cy]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={1.1} fill="currentColor" />)}
    </svg>
  );
}

export function TableDragHandles({ editor }: { editor: Editor | null }) {
  const [hoverTarget, setHoverTarget] = useState<CellTarget | null>(null);
  const [cursorTarget, setCursorTarget] = useState<CellTarget | null>(null);
  const [layout, setLayout] = useState<HandleLayout | null>(null);
  const [layoutTick, setLayoutTick] = useState(0);
  const [hoveredHandle, setHoveredHandle] = useState<TableAxis | null>(null);
  const [dragView, setDragView] = useState<DragView | null>(null);
  // 正文按住鼠标拖选期间把手不截获指针
  const [isTextSelecting, setIsTextSelecting] = useState(false);
  const sessionRef = useRef<DragSession | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overHandleRef = useRef(false);
  const frameRequestRef = useRef<number | null>(null);

  /** 合并同一帧内的多次重新测量请求 */
  const requestLayout = useCallback(() => {
    if (frameRequestRef.current !== null) return;
    frameRequestRef.current = requestAnimationFrame(() => {
      frameRequestRef.current = null;
      setLayoutTick((tick) => tick + 1);
    });
  }, []);

  const clearHideTimer = useCallback(() => {
    if (!hideTimerRef.current) return;
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);

  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current || sessionRef.current) return;
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null;
      if (!overHandleRef.current && !sessionRef.current) setHoverTarget(null);
    }, HIDE_DELAY);
  }, []);

  /** 结束拖动会话：撤掉表格上的临时属性、样式表与全局光标 */
  const cleanupSession = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    if (session.settleTimer) clearTimeout(session.settleTimer);
    if (session.tableEl) {
      session.tableEl.removeAttribute('data-nb-table-dnd');
      session.tableEl.removeAttribute('data-nb-table-dnd-phase');
      session.tableEl.style.removeProperty('--nb-dnd-x');
      session.tableEl.style.removeProperty('--nb-dnd-y');
    }
    session.styleEl?.remove();
    if (session.dragging) {
      document.body.style.cursor = session.originalBodyCursor;
      document.body.style.userSelect = session.originalBodyUserSelect;
      document.body.removeAttribute('data-nb-table-dragging');
    }
    if (session.handle.hasPointerCapture?.(session.pointerId)) {
      session.handle.releasePointerCapture(session.pointerId);
    }
    setDragView(null);
    requestLayout();
  }, [requestLayout]);

  // 悬停单元格时显示该行列的把手；离开表格后延迟收起
  useEffect(() => {
    if (!editor) return;
    const editorDom = editor.view.dom;
    const handleMouseMove = (event: MouseEvent) => {
      if (sessionRef.current) return;
      const cell = (event.target as Element | null)?.closest?.('td, th');
      if (cell instanceof HTMLElement && editorDom.contains(cell) && editor.isEditable) {
        const target = targetFromCellElement(editor.view, cell);
        if (target) {
          clearHideTimer();
          setHoverTarget((current) => (sameTarget(current, target) ? current : target));
          return;
        }
      }
      scheduleHide();
    };
    const handleMouseLeave = () => scheduleHide();
    editorDom.addEventListener('mousemove', handleMouseMove);
    editorDom.addEventListener('mouseleave', handleMouseLeave);
    return () => {
      editorDom.removeEventListener('mousemove', handleMouseMove);
      editorDom.removeEventListener('mouseleave', handleMouseLeave);
      clearHideTimer();
    };
  }, [clearHideTimer, editor, scheduleHide]);

  // 光标所在单元格（编辑器聚焦时）同样显示把手；文档变化时把悬停目标映射到新位置
  useEffect(() => {
    if (!editor) return;
    const syncCursor = () => {
      const target = editor.isEditable && editor.view.hasFocus() ? targetFromSelection(editor.state) : null;
      setCursorTarget((current) => (sameTarget(current, target) ? current : target));
      requestLayout();
    };
    const handleTransaction = ({ transaction }: { transaction: { docChanged: boolean; mapping: { mapResult: (pos: number) => { pos: number; deleted: boolean } } } }) => {
      if (transaction.docChanged) {
        setHoverTarget((current) => {
          if (!current) return current;
          const mapped = transaction.mapping.mapResult(current.tablePos);
          return mapped.deleted ? null : { ...current, tablePos: mapped.pos };
        });
      }
      syncCursor();
    };
    syncCursor();
    editor.on('transaction', handleTransaction);
    editor.on('focus', syncCursor);
    editor.on('blur', syncCursor);
    return () => {
      editor.off('transaction', handleTransaction);
      editor.off('focus', syncCursor);
      editor.off('blur', syncCursor);
    };
  }, [editor, requestLayout]);

  // 表格横向滚动、窗口与编辑区尺寸变化时重新测量
  useEffect(() => {
    if (!editor) return;
    const editorDom = editor.view.dom;
    editorDom.addEventListener('scroll', requestLayout, true);
    window.addEventListener('resize', requestLayout);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(requestLayout) : null;
    observer?.observe(editorDom);
    return () => {
      editorDom.removeEventListener('scroll', requestLayout, true);
      window.removeEventListener('resize', requestLayout);
      observer?.disconnect();
      if (frameRequestRef.current !== null) cancelAnimationFrame(frameRequestRef.current);
      frameRequestRef.current = null;
    };
  }, [editor, requestLayout]);

  // 跟踪正文拖选：编辑器内左键按下开始，松开或窗口失焦时结束
  useEffect(() => {
    if (!editor) return;
    const editorDom = editor.view.dom;
    const handleMouseDown = (event: MouseEvent) => {
      if (event.button === 0) setIsTextSelecting(true);
    };
    const handleMouseUp = () => setIsTextSelecting(false);
    editorDom.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mouseup', handleMouseUp, true);
    window.addEventListener('blur', handleMouseUp);
    return () => {
      editorDom.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mouseup', handleMouseUp, true);
      window.removeEventListener('blur', handleMouseUp);
    };
  }, [editor]);

  const activeTarget = hoverTarget ?? cursorTarget;

  // 拖动期间冻结把手布局，其余时间按目标单元格重新测量
  useLayoutEffect(() => {
    if (!editor || sessionRef.current) return;
    const next = activeTarget ? measure(editor.view, findScrollParent(editor.view.dom), activeTarget) : null;
    setLayout(next);
    if (!next) setHoveredHandle(null);
  }, [activeTarget, editor, layoutTick]);

  /** 拖动中：自动滚动、计算位移与目标序号，必要时更新让位规则 */
  const updateDrag = useCallback((session: DragSession, clientX: number, clientY: number) => {
    const { scrollParent, axis, segments, index } = session;
    if (axis === 'row') {
      const rect = scrollParent.getBoundingClientRect();
      if (clientY < rect.top + AUTO_SCROLL_EDGE) {
        const ratio = Math.min(1, (rect.top + AUTO_SCROLL_EDGE - clientY) / AUTO_SCROLL_EDGE);
        scrollParent.scrollTop -= Math.ceil(AUTO_SCROLL_MAX_STEP * ratio);
      } else if (clientY > rect.bottom - AUTO_SCROLL_EDGE) {
        const ratio = Math.min(1, (clientY - rect.bottom + AUTO_SCROLL_EDGE) / AUTO_SCROLL_EDGE);
        scrollParent.scrollTop += Math.ceil(AUTO_SCROLL_MAX_STEP * ratio);
      }
    }
    const offset = contentOffset(scrollParent);
    const pointer = axis === 'row' ? clientY + offset.y : clientX + offset.x;
    const source = segments[index];
    const size = source.end - source.start;
    // 拖动元素限制在表格范围内
    const min = segments[0].start - source.start;
    const max = segments[segments.length - 1].end - source.end;
    const delta = Math.max(min, Math.min(max, pointer - session.startContent));
    session.delta = delta;

    // 拖动元素中心越过相邻元素中线即交换
    const center = source.start + delta + size / 2;
    let target = index;
    segments.forEach((segment, current) => {
      const middle = (segment.start + segment.end) / 2;
      if (current < index && center < middle) target = Math.min(target, current);
      if (current > index && center > middle) target = Math.max(target, current);
    });
    if (target !== session.target) {
      session.target = target;
      writeRules(session, index, true, true);
    }
    session.tableEl?.style.setProperty(axis === 'row' ? '--nb-dnd-y' : '--nb-dnd-x', `${delta}px`);
    const frame = axis === 'row'
      ? { ...session.frame, top: session.frame.top + delta }
      : { ...session.frame, left: session.frame.left + delta };
    setDragView({ axis, frame, phase: 'dragging' });
  }, []);

  /** 越过拖动阈值：切换表格为拖动态并记录各行列的区间 */
  const beginDrag = useCallback((session: DragSession): boolean => {
    if (!editor) return false;
    const tableEl = getTableElement(editor.view, session.tablePos);
    if (!tableEl || !tableEl.rows.length) return false;
    session.id = `t${++sessionSeq}`;
    session.tableEl = tableEl;
    tableEl.setAttribute('data-nb-table-dnd', session.id);
    tableEl.setAttribute('data-nb-table-dnd-phase', 'drag');
    session.styleEl = document.createElement('style');
    document.head.appendChild(session.styleEl);

    // 切换为分离边框后再测量，区间与拖动中的真实布局一致
    const offset = contentOffset(session.scrollParent);
    const rows = Array.from(tableEl.rows);
    session.segments = session.axis === 'row'
      ? rows.map((row) => {
        const rect = row.getBoundingClientRect();
        return { start: rect.top + offset.y, end: rect.bottom + offset.y };
      })
      : Array.from(rows[0].cells).map((cell) => {
        const rect = cell.getBoundingClientRect();
        return { start: rect.left + offset.x, end: rect.right + offset.x };
      });
    const source = session.segments[session.index];
    if (!source) return false;
    const tableRect = tableEl.getBoundingClientRect();
    const visible = visibleRange(tableEl);
    session.frame = session.axis === 'row'
      ? { left: visible.left + offset.x, top: source.start, width: visible.right - visible.left, height: source.end - source.start }
      : { left: source.start, top: tableRect.top + offset.y, width: source.end - source.start, height: tableRect.height };

    session.dragging = true;
    session.target = session.index;
    writeRules(session, session.index, true, true);
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
    document.body.setAttribute('data-nb-table-dragging', '');
    return true;
  }, [editor]);

  /** 松手或取消：提交移动并让单元格从当前位置平滑落到新位置 */
  const finishDrag = useCallback((session: DragSession, commit: boolean) => {
    if (!editor || !session.tableEl) {
      cleanupSession();
      return;
    }
    const { axis, index, target, segments, tableEl } = session;
    const variable = axis === 'row' ? '--nb-dnd-y' : '--nb-dnd-x';
    const size = segments[index].end - segments[index].start;
    session.settling = true;

    let settledIndex = index;
    let finalStart = segments[index].start;
    const tr = commit && target !== index ? moveTableAxisTr(editor.state, session.tablePos, axis, index, target) : null;
    if (tr) {
      // 移动后该行列的自然位置；剩余位移 = 当前视觉位置 - 自然位置
      finalStart = target > index ? segments[target].end - size : segments[target].start;
      const remaining = segments[index].start + session.delta - finalStart;
      // 关闭过渡后同步切换文档顺序：让位的行列已处在最终位置，被拖动的行列以剩余位移停在原处
      tableEl.setAttribute('data-nb-table-dnd-phase', 'instant');
      writeRules(session, target, false, true);
      tableEl.style.setProperty(variable, `${remaining}px`);
      editor.view.dispatch(tr);
      settledIndex = target;
      // 指针仍停在把手上：把手目标跟随到移动后的行列
      setHoverTarget((current) => (current && current.tablePos === session.tablePos
        ? { ...current, [axis === 'row' ? 'row' : 'col']: target }
        : current));
      // 表格视图被重建时无法衔接动画，直接结束
      if (getTableElement(editor.view, session.tablePos) !== tableEl) {
        cleanupSession();
        return;
      }
      // 强制回流，使剩余位移先生效，再开启过渡归零
      void tableEl.offsetWidth;
    }
    tableEl.setAttribute('data-nb-table-dnd-phase', 'settle');
    writeRules(session, settledIndex, false, false);
    tableEl.style.setProperty(variable, '0px');
    const frame = axis === 'row'
      ? { ...session.frame, top: finalStart }
      : { ...session.frame, left: finalStart };
    setDragView({ axis, frame, phase: 'settling' });
    document.body.style.cursor = session.originalBodyCursor;
    document.body.style.userSelect = session.originalBodyUserSelect;
    session.settleTimer = setTimeout(cleanupSession, SETTLE_DURATION + 40);
  }, [cleanupSession, editor]);

  // 窗口失焦、按 Esc 时取消拖动；卸载时清理残留
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const session = sessionRef.current;
      if (event.key !== 'Escape' || !session?.dragging || session.settling) return;
      event.preventDefault();
      event.stopPropagation();
      finishDrag(session, false);
    };
    const handleBlur = () => {
      const session = sessionRef.current;
      if (session?.dragging && !session.settling) finishDrag(session, false);
      else if (session && !session.dragging) cleanupSession();
    };
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('blur', handleBlur);
    };
  }, [cleanupSession, finishDrag]);

  useEffect(() => () => cleanupSession(), [cleanupSession]);

  const handlePointerDown = useCallback((axis: TableAxis, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!editor || !layout || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    // 上一次落位动画尚未结束：立即收尾
    if (sessionRef.current) cleanupSession();
    clearHideTimer();
    const scrollParent = findScrollParent(editor.view.dom);
    const offset = contentOffset(scrollParent);
    event.currentTarget.setPointerCapture(event.pointerId);
    sessionRef.current = {
      axis,
      tablePos: layout.target.tablePos,
      index: axis === 'row' ? layout.target.row : layout.target.col,
      pointerId: event.pointerId,
      handle: event.currentTarget,
      scrollParent,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startContent: axis === 'row' ? event.clientY + offset.y : event.clientX + offset.x,
      dragging: false,
      settling: false,
      tableEl: null,
      styleEl: null,
      id: '',
      segments: [],
      frame: { left: 0, top: 0, width: 0, height: 0 },
      delta: 0,
      target: 0,
      settleTimer: null,
      originalBodyCursor: document.body.style.cursor,
      originalBodyUserSelect: document.body.style.userSelect,
    };
  }, [cleanupSession, clearHideTimer, editor, layout]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const session = sessionRef.current;
    if (!session || session.pointerId !== event.pointerId || session.settling) return;
    event.preventDefault();
    if (!session.dragging) {
      const distance = Math.hypot(event.clientX - session.startClientX, event.clientY - session.startClientY);
      if (distance < DRAG_START_DISTANCE) return;
      if (!beginDrag(session)) {
        cleanupSession();
        return;
      }
    }
    updateDrag(session, event.clientX, event.clientY);
  }, [beginDrag, cleanupSession, updateDrag]);

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const session = sessionRef.current;
    if (!session || session.pointerId !== event.pointerId || session.settling) return;
    event.preventDefault();
    if (session.handle.hasPointerCapture(event.pointerId)) session.handle.releasePointerCapture(event.pointerId);
    // 未越过拖动阈值即单击：选中整行 / 整列
    if (!session.dragging) {
      cleanupSession();
      if (!editor) return;
      const tr = selectTableAxisTr(editor.state, session.tablePos, session.axis, session.index);
      if (tr) {
        editor.view.dispatch(tr);
        editor.view.focus();
      }
      return;
    }
    finishDrag(session, true);
  }, [cleanupSession, editor, finishDrag]);

  const handlePointerCancel = useCallback(() => {
    const session = sessionRef.current;
    if (!session || session.settling) return;
    if (session.dragging) finishDrag(session, false);
    else cleanupSession();
  }, [cleanupSession, finishDrag]);

  if (!editor || (!layout && !dragView)) return null;

  const dragging = dragView?.phase === 'dragging' ? dragView.axis : null;
  const busy = dragView !== null;

  /** 渲染一个把手；拖动中把手跟随浮起框移动 */
  const renderHandle = (axis: TableAxis) => {
    if (!layout) return null;
    if (dragView && dragView.axis !== axis) return null;
    const anchor = axis === 'row' ? layout.row : layout.column;
    if (!anchor) return null;
    let { x, y } = anchor;
    if (dragView) {
      if (axis === 'row') y = dragView.frame.top + dragView.frame.height / 2;
      else x = dragView.frame.left + dragView.frame.width / 2;
    }
    const label = axis === 'row' ? '拖动排序，单击选中整行' : '拖动排序，单击选中整列';
    return (
      // 拖动中不切换 disabled（会重建按钮、打断指针捕获），改由 body 上的拖动标记隐藏提示
      <Tooltip key={`${axis}-${layout.target.tablePos}`} content={label} side={axis === 'row' ? 'left' : 'top'} sideOffset={6}>
        <button
          type="button"
          className={[
            'nb-table-handle',
            axis === 'row' ? 'is-row' : 'is-column',
            hoveredHandle === axis ? 'is-hovered' : '',
            dragging === axis ? 'is-dragging' : '',
            isTextSelecting && !busy ? 'is-passive' : '',
          ].filter(Boolean).join(' ')}
          style={{ left: x, top: y }}
          aria-label={axis === 'row' ? '拖动表格行' : '拖动表格列'}
          onPointerDown={(event) => handlePointerDown(axis, event)}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onMouseEnter={() => {
            overHandleRef.current = true;
            clearHideTimer();
            setHoveredHandle(axis);
          }}
          onMouseLeave={() => {
            overHandleRef.current = false;
            setHoveredHandle((current) => (current === axis ? null : current));
            scheduleHide();
          }}
        >
          <GripIcon axis={axis} />
        </button>
      </Tooltip>
    );
  };

  // 浮起框：拖动 / 落位中跟随被拖动的行列；平时悬停把手时标出整行 / 整列
  const frameBox = dragView?.frame
    ?? (layout && hoveredHandle ? (hoveredHandle === 'row' ? layout.rowBox : layout.columnBox) : null);

  return (
    <>
      {frameBox && (
        <div
          key={dragView ? 'drag-frame' : `hint-${hoveredHandle}`}
          className={`nb-table-axis-frame${dragView ? ` is-${dragView.phase}` : ''}`}
          style={{ left: frameBox.left, top: frameBox.top, width: frameBox.width, height: frameBox.height }}
          aria-hidden="true"
        />
      )}
      {renderHandle('row')}
      {renderHandle('column')}
    </>
  );
}
