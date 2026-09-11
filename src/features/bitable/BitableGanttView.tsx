// NoteBoard 多维表格甘特图视图 (Gantt View)
// 左侧为可配置并始终固定的字段列，右侧为时间轴：条形支持整体拖动与两端拉伸改期，
// 支持周 / 月 / 季 / 年四档刻度、仅工作日模式与「今天」定位。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type BitableColumn,
  type BitableRow,
  type ColumnOptionAction,
  type GanttColorMode,
  type GanttViewConfig,
  type GanttZoom,
  type SelectOptionColor,
  type SortRule,
} from './bitableTypes';
import { BitableCellEditor } from './BitableCellEditor';
import { FieldSelectButton, getFieldTypeMeta } from './BitableFieldMeta';
import { DragGhost, FloatingPanel, getAnchorRect, type AnchorRect } from './BitableFloating';
import { OptionBadge } from './BitableOptions';
import { SortRulesPanel } from './BitableSortPanel';
import { BITABLE_PALETTE, getOptionColor } from './bitableConverter';
import { usePointerReorder } from './usePointerReorder';
import { Tooltip } from '../../components/Tooltip';
import { showToast } from '../../stores/toastStore';
import {
  GANTT_DAY_WIDTH,
  buildDateFieldValue,
  buildGanttDayAxis,
  buildGanttTimeBands,
  calculateAutoFillValues,
  collectDescendantRowIds,
  countWorkdays,
  createRow,
  dateToDayIndex,
  dayIndexToDate,
  extractDatePart,
  formatCellValue,
  ganttAxisIndexEnd,
  ganttAxisIndexStart,
  groupFlatTreeRows,
  isSlotNoop,
  isWeekendDay,
  parseClipboardMatrix,
  slotToSpliceIndex,
  tileMatrix,
  todayDayIndex,
} from './bitableUtils';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CalendarRange,
  Check,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Copy,
  CornerDownRight,
  Eraser,
  Eye,
  EyeOff,
  IndentDecrease,
  IndentIncrease,
  Lock,
  Maximize2,
  MoveLeft,
  MoveRight,
  Pin,
  Plus,
  Scissors,
  Settings2,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';

/** 左侧序号列宽度 */
const NUM_COL_WIDTH = 44;
/** 数据行高 */
const ROW_HEIGHT = 40;
/** 双层表头总高（上下各 28） */
const HEADER_HEIGHT = 56;
/** 条形高度 */
const BAR_HEIGHT = 22;
/** 单条时间轴最多渲染的天数，避免极端数据把时间轴拉成几万像素 */
const MAX_AXIS_DAYS = 1830;
/** 甘特图可用的日期字段类型 */
const GANTT_DATE_TYPES = new Set(['date', 'dateTime']);

const ZOOM_OPTIONS: Array<{ id: GanttZoom; label: string }> = [
  { id: 'week', label: '周' },
  { id: 'month', label: '月' },
  { id: 'quarter', label: '季' },
  { id: 'year', label: '年' },
];

const COLOR_MODE_OPTIONS: Array<{ id: GanttColorMode; label: string }> = [
  { id: 'auto', label: '跟随标签颜色' },
  { id: 'custom', label: '自定义颜色' },
];

/** 甘特图视图属性 */
export interface GanttViewProps {
  columns: BitableColumn[];
  rows: BitableRow[];
  config: GanttViewConfig;
  /** 视图配置局部更新（开始/结束日期、标题、颜色、工作日、左侧列、刻度） */
  onUpdateConfig: (partial: Partial<GanttViewConfig>) => void;
  /** 多字段排序规则与分组依据：与表格视图共用视图配置 */
  sortRules?: SortRule[];
  groupByColumnId?: string;
  onUpdateGroupByColumnId?: (colId: string) => void;
  onUpdateSortRules?: (sortRules: SortRule[]) => void;
  /** 区域粘贴：行数不足时由上层自动补建新行 */
  onPasteCells?: (rowId: string, colId: string, matrix: string[][]) => void;
  /** 批量更新单元格（单次事务合并撤销记录） */
  onBatchUpdateCells?: (
    updates: Array<{ rowId: string; colId: string; value: unknown }>,
    newRowsToAppend?: BitableRow[],
  ) => void;
  onUpdateRow: (rowId: string, colId: string, val: unknown) => void;
  onManageColumnOption?: (colId: string, action: ColumnOptionAction) => void;
  onAddRow: () => void;
  onAddSubRow?: (parentRowId: string) => void;
  onOutdentRow?: (rowId: string) => void;
  onIndentRow?: (rowId: string) => void;
  onInsertRowAbove?: (rowId: string) => void;
  onInsertRowBelow?: (rowId: string) => void;
  onDeleteRow: (rowId: string) => void;
  onAddColumn: (direction: 'left' | 'right', referenceColId?: string) => void;
  onDeleteColumn: (colId: string) => void;
  onClearColumn?: (colId: string) => void;
  /** 拖拽 `#` 换行序：把 draggedRowId 连同子树插到 beforeRowId 之前 */
  onMoveRow?: (draggedRowId: string, beforeRowId: string | null, parentId?: string) => void;
  onOpenRecord?: (rowId: string) => void;
  /** 当前视图没有任何日期字段时，一键补齐「开始日期 / 结束日期」字段并完成配置 */
  onCreateDateFields?: () => void;
}

/** 条形拖拽状态 */
interface BarDrag {
  rowId: string;
  mode: 'move' | 'resize-start' | 'resize-end';
  startX: number;
  origStartAxis: number;
  origEndAxis: number;
  delta: number;
}

/** 左侧面板的扁平树行（与表格视图同构，可直接交给分组工具函数） */
interface GanttRowNode {
  row: BitableRow;
  depth: number;
  hasChildren: boolean;
  isCollapsed: boolean;
  rowNumber: number;
}

/** 左侧面板渲染项：分组标题或数据行 */
type GanttItem =
  | { type: 'group'; key: string; label: string; count: number; color?: SelectOptionColor }
  | { type: 'row'; node: GanttRowNode };

/** 冻结面板选区：单元格矩形区域或整行 */
type GanttSelection =
  | { type: 'none' }
  | { type: 'range'; startRowId: string; startColId: string; endRowId: string; endColId: string }
  | { type: 'row'; startRowId: string; endRowId: string };

/** 可拖拽的行槽位：groupStart / groupEnd 为该行所属分组在可见序列中的区间 [groupStart, groupEnd) */
interface GanttRowSlot {
  rowId: string;
  parentId?: string;
  groupStart: number;
  groupEnd: number;
}

/** 自动填充拖拽预览 */
interface FillPreview {
  direction: 'forward' | 'backward';
  axis: 'row' | 'col';
  fromRow: number;
  toRow: number;
  fromCol: number;
  toCol: number;
}

/**
 * 为新建的甘特图视图推导一份开箱即用的配置
 * 优先取已有的日期字段；标题取首个文本字段；左侧列默认只展示标题列，保持时间轴视野开阔。
 */
export function createGanttConfig(columns: BitableColumn[]): GanttViewConfig {
  const dateCols = columns.filter((c) => GANTT_DATE_TYPES.has(c.type));
  const titleCol =
    columns.find((c) => c.type === 'text') ||
    columns.find((c) => c.type === 'longText') ||
    columns[0];
  return {
    startColumnId: dateCols[0]?.id,
    endColumnId: dateCols[1]?.id ?? dateCols[0]?.id,
    titleColumnId: titleCol?.id,
    colorMode: 'custom',
    color: 'blue',
    workdaysOnly: false,
    zoom: 'month',
    leftColumnIds: titleCol ? [titleCol.id] : [],
  };
}

export function BitableGanttView({
  columns,
  rows,
  config,
  onUpdateConfig,
  sortRules = [],
  groupByColumnId,
  onUpdateGroupByColumnId,
  onUpdateSortRules,
  onPasteCells,
  onBatchUpdateCells,
  onUpdateRow,
  onManageColumnOption,
  onAddRow,
  onAddSubRow,
  onOutdentRow,
  onIndentRow,
  onInsertRowAbove,
  onInsertRowBelow,
  onDeleteRow,
  onAddColumn,
  onDeleteColumn,
  onClearColumn,
  onMoveRow,
  onOpenRecord,
  onCreateDateFields,
}: GanttViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // 行 DOM 节点表：用于测量行位置，支撑「拖拽 # 换行序」的落点计算
  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());

  // 工具条浮层（甘特图配置 / 字段）
  const [panel, setPanel] = useState<{
    kind: 'config' | 'fields';
    anchor: AnchorRect;
    trigger: HTMLElement;
  } | null>(null);
  const configBtnRef = useRef<HTMLButtonElement>(null);
  const fieldsBtnRef = useRef<HTMLButtonElement>(null);

  // 颜色显示方式的下拉浮层
  const [colorMenu, setColorMenu] = useState<{ anchor: AnchorRect; trigger: HTMLElement } | null>(null);
  const colorBtnRef = useRef<HTMLButtonElement>(null);

  // 行悬浮：空行展示「点击排期」的虚线加号
  const [hoverRowId, setHoverRowId] = useState<string | null>(null);

  // ── 左侧固定面板的树展开 / 分组折叠（与表格视图一致的交互语义） ──
  const [collapsedRowIds, setCollapsedRowIds] = useState<Set<string>>(new Set());
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<Set<string>>(new Set());

  // ── 冻结面板的单元格交互（选区 / 右键 / 自动填充 / 剪贴板） ──
  const [selection, setSelection] = useState<GanttSelection>({ type: 'none' });
  const isSelectingCellsRef = useRef(false);
  const dragStartCellRef = useRef<{ rowId: string; colId: string } | null>(null);
  const [fillPreview, setFillPreview] = useState<FillPreview | null>(null);
  const [cellContextMenu, setCellContextMenu] = useState<{
    x: number;
    y: number;
    targetRowId: string;
    targetColId: string;
  } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  // 隐藏剪贴板代理：持有焦点以接收原生 copy / cut / paste
  const clipboardProxyRef = useRef<HTMLTextAreaElement>(null);
  const rowBodyRef = useRef<HTMLTableSectionElement>(null);

  const focusClipboardProxy = useCallback(() => {
    window.setTimeout(() => clipboardProxyRef.current?.focus({ preventScroll: true }), 0);
  }, []);
  const blurClipboardProxy = useCallback(() => {
    clipboardProxyRef.current?.blur();
  }, []);

  // 多字段排序面板
  const [sortPanelOpen, setSortPanelOpen] = useState(false);
  const [sortPanelAnchor, setSortPanelAnchor] = useState<AnchorRect | null>(null);
  const [sortPanelTrigger, setSortPanelTrigger] = useState<HTMLElement | null>(null);

  // 条形拖拽预览
  const barDragRef = useRef<BarDrag | null>(null);
  const [barDrag, setBarDrag] = useState<BarDrag | null>(null);
  const commitBarDragRef = useRef<(cur: BarDrag) => void>(() => {});

  // ── 配置解析（外部数据可能缺项，统一在此补默认值） ──
  const dateColumns = useMemo(
    () => columns.filter((c) => GANTT_DATE_TYPES.has(c.type)),
    [columns],
  );
  const startCol = dateColumns.find((c) => c.id === config.startColumnId) || dateColumns[0];
  const endCol =
    dateColumns.find((c) => c.id === config.endColumnId) ||
    dateColumns.find((c) => c.id !== startCol?.id) ||
    startCol;
  const titleCol =
    columns.find((c) => c.id === config.titleColumnId) ||
    columns.find((c) => c.type === 'text') ||
    columns.find((c) => c.type === 'longText') ||
    columns[0];

  const leftColumnIds = useMemo(() => {
    const valid = (config.leftColumnIds || []).filter((id) => columns.some((c) => c.id === id));
    if (valid.length > 0) return valid;
    return titleCol ? [titleCol.id] : columns.slice(0, 1).map((c) => c.id);
  }, [config.leftColumnIds, columns, titleCol]);

  const leftColumns = useMemo(
    () => leftColumnIds.map((id) => columns.find((c) => c.id === id)).filter((c): c is BitableColumn => Boolean(c)),
    [leftColumnIds, columns],
  );

  // ── 左侧面板的扁平树（含子任务层级与折叠） ──
  const flatRows = useMemo(() => {
    const parentToChildren = new Map<string | undefined, BitableRow[]>();
    rows.forEach((row) => {
      const list = parentToChildren.get(row.parentId) || [];
      list.push(row);
      parentToChildren.set(row.parentId, list);
    });

    const result: GanttRowNode[] = [];
    let counter = 0;
    const traverse = (parentId: string | undefined, depth: number) => {
      (parentToChildren.get(parentId) || []).forEach((r) => {
        counter += 1;
        const hasKids = (parentToChildren.get(r.id) || []).length > 0;
        const isCollapsed = collapsedRowIds.has(r.id);
        result.push({ row: r, depth, hasChildren: hasKids, isCollapsed, rowNumber: counter });
        if (hasKids && !isCollapsed) traverse(r.id, depth + 1);
      });
    };
    traverse(undefined, 0);
    return result;
  }, [rows, collapsedRowIds]);

  const groupColumn = useMemo(
    () => columns.find((c) => c.id === groupByColumnId),
    [columns, groupByColumnId],
  );

  // ── 渲染项：分组标题 + 数据行（与表格视图使用同一套分组工具） ──
  const items = useMemo<GanttItem[]>(() => {
    if (!groupByColumnId || !groupColumn) {
      return flatRows.map((node) => ({ type: 'row', node }) as GanttItem);
    }
    const groups = groupFlatTreeRows(flatRows, groupColumn);
    const out: GanttItem[] = [];
    groups.forEach((group) => {
      out.push({
        type: 'group',
        key: group.meta.key,
        label: group.meta.label,
        count: group.rows.length,
        color: group.meta.color,
      });
      if (!collapsedGroupKeys.has(group.meta.key)) {
        group.rows.forEach((node) => out.push({ type: 'row', node }));
      }
    });
    return out;
  }, [flatRows, groupByColumnId, groupColumn, collapsedGroupKeys]);

  /** 当前实际渲染的数据行序列：选区索引与填充落点都以它为基准 */
  const visibleRows = useMemo(
    () => items.filter((item): item is { type: 'row'; node: GanttRowNode } => item.type === 'row').map((item) => item.node),
    [items],
  );
  const rowIdxMap = useMemo(
    () => new Map(visibleRows.map((node, idx) => [node.row.id, idx])),
    [visibleRows],
  );
  const colIdxMap = useMemo(
    () => new Map(leftColumns.map((col, idx) => [col.id, idx])),
    [leftColumns],
  );

  /** 规整化选区矩形（min/max 行列索引） */
  const normalizedSelection = useMemo(() => {
    if (selection.type === 'range') {
      const sRow = rowIdxMap.get(selection.startRowId);
      const sCol = colIdxMap.get(selection.startColId);
      const eRow = rowIdxMap.get(selection.endRowId);
      const eCol = colIdxMap.get(selection.endColId);
      if (sRow === undefined || sCol === undefined || eRow === undefined || eCol === undefined) return null;

      const minRowIdx = Math.min(sRow, eRow);
      const maxRowIdx = Math.max(sRow, eRow);
      const minColIdx = Math.min(sCol, eCol);
      const maxColIdx = Math.max(sCol, eCol);
      return {
        minRowIdx,
        maxRowIdx,
        minColIdx,
        maxColIdx,
        anchorRowIdx: sRow,
        anchorColIdx: sCol,
        isSingleCell: minRowIdx === maxRowIdx && minColIdx === maxColIdx,
        selectedRowIds: visibleRows.slice(minRowIdx, maxRowIdx + 1).map((n) => n.row.id),
        selectedColIds: leftColumns.slice(minColIdx, maxColIdx + 1).map((c) => c.id),
      };
    }

    if (selection.type === 'row') {
      const sRow = rowIdxMap.get(selection.startRowId);
      const eRow = selection.endRowId ? rowIdxMap.get(selection.endRowId) : sRow;
      if (sRow === undefined) return null;
      const minRowIdx = Math.min(sRow, eRow ?? sRow);
      const maxRowIdx = Math.max(sRow, eRow ?? sRow);
      return {
        minRowIdx,
        maxRowIdx,
        minColIdx: 0,
        maxColIdx: Math.max(0, leftColumns.length - 1),
        anchorRowIdx: sRow,
        anchorColIdx: 0,
        isSingleCell: false,
        selectedRowIds: visibleRows.slice(minRowIdx, maxRowIdx + 1).map((n) => n.row.id),
        selectedColIds: leftColumns.map((c) => c.id),
      };
    }

    return null;
  }, [selection, rowIdxMap, colIdxMap, visibleRows, leftColumns]);

  // ── 拖拽 # 换行序（与表格视图同一套「插入槽位」语义） ──

  /** 可见数据行槽位序列：分组标题行不占位，组内区间用于把落点夹在本组内 */
  const rowSlots = useMemo<GanttRowSlot[]>(() => {
    const raw: Array<{ rowId: string; parentId?: string; groupKey: string | null }> = [];
    let currentKey: string | null = null;
    items.forEach((item) => {
      if (item.type === 'group') {
        currentKey = item.key;
        return;
      }
      raw.push({ rowId: item.node.row.id, parentId: item.node.row.parentId, groupKey: currentKey });
    });

    const ranges = new Map<string | null, { start: number; end: number }>();
    raw.forEach((slot, idx) => {
      const range = ranges.get(slot.groupKey);
      if (!range) ranges.set(slot.groupKey, { start: idx, end: idx + 1 });
      else range.end = idx + 1;
    });

    return raw.map((slot) => {
      const range = ranges.get(slot.groupKey)!;
      return { rowId: slot.rowId, parentId: slot.parentId, groupStart: range.start, groupEnd: range.end };
    });
  }, [items]);

  /**
   * 把槽位换算为落点描述；返回 null 表示非法落点（不画指示线、不提交）
   * 1) 落点参照行必须跳过被拖行自己的后代（否则「拖到紧邻自己子树之后」会被算成有效移动）；
   * 2) 新父级不能是被拖行自身或其后代，否则父行会被塞进自己的子树形成环。
   */
  const resolveRowDropTarget = useCallback(
    (fromIdx: number, toIdx: number) => {
      const dragged = rowSlots[fromIdx];
      if (!dragged) return null;
      const descendants = collectDescendantRowIds(rows, dragged.rowId);
      const rest = rowSlots.filter((_, i) => i !== fromIdx);

      let cursor = toIdx;
      while (cursor < rest.length && descendants.has(rest[cursor].rowId)) cursor += 1;
      const before = rest[cursor] ?? null;

      const restWithoutSubtree = rest.filter((slot) => !descendants.has(slot.rowId));
      const insertIdx = before
        ? restWithoutSubtree.findIndex((slot) => slot.rowId === before.rowId)
        : restWithoutSubtree.length;

      if (insertIdx === fromIdx) return null;

      const parentId = before
        ? before.parentId
        : restWithoutSubtree[restWithoutSubtree.length - 1]?.parentId;
      if (parentId && (parentId === dragged.rowId || descendants.has(parentId))) return null;

      return { beforeRowId: before ? before.rowId : null, parentId, insertIdx };
    },
    [rowSlots, rows],
  );

  // 视图存在排序规则时行序由排序决定，手动拖拽会被立刻覆盖，故禁用并按提示说明
  const rowDragEnabled = Boolean(onMoveRow) && sortRules.length === 0;

  const {
    drag: rowDrag,
    startDrag: startRowDrag,
    grabOffset: rowGrabOffset,
    consumeDraggedFlag: consumeRowDraggedFlag,
  } = usePointerReorder<GanttRowSlot>({
    items: rowSlots,
    getElement: (slot) => rowRefs.current.get(slot.rowId),
    axis: 'y',
    disabled: !rowDragEnabled,
    clampSlot: (insertAt, fromIdx) => {
      const slot = rowSlots[fromIdx];
      if (!slot) return insertAt;
      return Math.max(slot.groupStart, Math.min(insertAt, slot.groupEnd));
    },
    isSlotValid: (insertAt, fromIdx) =>
      resolveRowDropTarget(fromIdx, slotToSpliceIndex(insertAt, fromIdx)) !== null,
    onReorder: (fromIdx, toIdx) => {
      const draggedId = rowSlots[fromIdx]?.rowId;
      const target = resolveRowDropTarget(fromIdx, toIdx);
      if (!draggedId || !target || !onMoveRow) return;
      onMoveRow(draggedId, target.beforeRowId, target.parentId);
    },
  });

  /** 行落点指示线：命名为顶边 / 底边，分组下末行落在「本行之下」 */
  const getRowIndicator = useCallback(
    (idx: number): 'top' | 'bottom' | null => {
      if (!rowDrag || !rowDrag.valid) return null;
      const { fromIdx, insertAt } = rowDrag;
      if (isSlotNoop(insertAt, fromIdx)) return null;
      if (insertAt === idx) return 'top';
      const slot = rowSlots[fromIdx];
      if (!slot) return null;
      if (insertAt === slot.groupEnd && idx === slot.groupEnd - 1) return 'bottom';
      if (insertAt === rowSlots.length && idx === rowSlots.length - 1) return 'bottom';
      return null;
    },
    [rowDrag, rowSlots],
  );

  /** 落点最终序号（从 1 起）：分组视图下折算为组内序号，与「在这一组里挪到第几位」一致 */
  const rowDropPosition = useMemo(() => {
    if (!rowDrag) return 0;
    const target = resolveRowDropTarget(rowDrag.fromIdx, slotToSpliceIndex(rowDrag.insertAt, rowDrag.fromIdx));
    if (!target) return 0;
    const offset = rowSlots[rowDrag.fromIdx]?.groupStart ?? 0;
    return target.insertIdx - offset + 1;
  }, [rowDrag, rowSlots, resolveRowDropTarget]);

  // ── 折叠 / 展开 ──
  const toggleCollapse = (rowId: string) => {
    setCollapsedRowIds((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  };

  const toggleGroupCollapse = (key: string) => {
    setCollapsedGroupKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // ── 冻结面板选区：与表格视图同款交互（点击 / Shift 扩展 / 拖拽框选） ──
  const handleCellMouseDown = (e: React.MouseEvent, rowId: string, colId: string) => {
    setCellContextMenu(null);
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // 单元格内部的编辑控件、填充柄、按钮不应触发框选
    if (target.closest('[data-fill-handle], [data-no-drag], input, textarea, button')) return;

    focusClipboardProxy();

    if (e.shiftKey && selection.type === 'range') {
      e.preventDefault();
      setSelection({
        type: 'range',
        startRowId: selection.startRowId,
        startColId: selection.startColId,
        endRowId: rowId,
        endColId: colId,
      });
      return;
    }

    isSelectingCellsRef.current = true;
    dragStartCellRef.current = { rowId, colId };
    setSelection({ type: 'range', startRowId: rowId, startColId: colId, endRowId: rowId, endColId: colId });
  };

  const handleCellMouseEnter = (rowId: string, colId: string) => {
    if (!isSelectingCellsRef.current || !dragStartCellRef.current) return;
    setSelection({
      type: 'range',
      startRowId: dragStartCellRef.current.rowId,
      startColId: dragStartCellRef.current.colId,
      endRowId: rowId,
      endColId: colId,
    });
  };

  // 松开鼠标结束框选（拖到表格外松开也要能结束）
  useEffect(() => {
    const handleUp = () => {
      isSelectingCellsRef.current = false;
    };
    window.addEventListener('mouseup', handleUp);
    return () => window.removeEventListener('mouseup', handleUp);
  }, []);

  const handleCellContextMenu = (e: React.MouseEvent, rowId: string, colId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const rIdx = rowIdxMap.get(rowId) ?? -1;
    const cIdx = colIdxMap.get(colId) ?? -1;
    const isInsideSelection =
      normalizedSelection !== null &&
      rIdx >= normalizedSelection.minRowIdx &&
      rIdx <= normalizedSelection.maxRowIdx &&
      cIdx >= normalizedSelection.minColIdx &&
      cIdx <= normalizedSelection.maxColIdx;
    if (!isInsideSelection) {
      setSelection({ type: 'range', startRowId: rowId, startColId: colId, endRowId: rowId, endColId: colId });
    }
    setCellContextMenu({ x: e.clientX, y: e.clientY, targetRowId: rowId, targetColId: colId });
  };

  const handleRowContextMenu = (e: React.MouseEvent, rowId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (selection.type !== 'row' || normalizedSelection === null || !normalizedSelection.selectedRowIds.includes(rowId)) {
      setSelection({ type: 'row', startRowId: rowId, endRowId: rowId });
    }
    setCellContextMenu({
      x: e.clientX,
      y: e.clientY,
      targetRowId: rowId,
      targetColId: leftColumns[0]?.id || '',
    });
  };

  // 右键菜单：点击外部 / Esc / 任意滚动即关闭
  useEffect(() => {
    if (!cellContextMenu) return;
    const handleDown = (e: MouseEvent) => {
      if (contextMenuRef.current?.contains(e.target as Node)) return;
      setCellContextMenu(null);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCellContextMenu(null);
    };
    const handleScroll = () => setCellContextMenu(null);
    document.addEventListener('mousedown', handleDown, true);
    document.addEventListener('keydown', handleKey, true);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleScroll);
    return () => {
      document.removeEventListener('mousedown', handleDown, true);
      document.removeEventListener('keydown', handleKey, true);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleScroll);
    };
  }, [cellContextMenu]);

  // ── 剪贴板：把选区序列化为 TSV / 按矩阵写回 ──

  const buildClipboardPayload = useCallback((): string | null => {
    if (!normalizedSelection) return null;
    const lines: string[] = [];
    for (let r = normalizedSelection.minRowIdx; r <= normalizedSelection.maxRowIdx; r += 1) {
      const node = visibleRows[r];
      if (!node) continue;
      const cells: string[] = [];
      for (let c = normalizedSelection.minColIdx; c <= normalizedSelection.maxColIdx; c += 1) {
        const col = leftColumns[c];
        if (!col) continue;
        cells.push(formatCellValue(col, node.row[col.id]));
      }
      lines.push(cells.join('\t'));
    }
    return lines.join('\n');
  }, [normalizedSelection, visibleRows, leftColumns]);

  const clearSelectedRange = useCallback(() => {
    if (!normalizedSelection) return;
    const updates: Array<{ rowId: string; colId: string; value: unknown }> = [];
    for (let r = normalizedSelection.minRowIdx; r <= normalizedSelection.maxRowIdx; r += 1) {
      const node = visibleRows[r];
      if (!node) continue;
      for (let c = normalizedSelection.minColIdx; c <= normalizedSelection.maxColIdx; c += 1) {
        const col = leftColumns[c];
        if (!col) continue;
        updates.push({ rowId: node.row.id, colId: col.id, value: null });
      }
    }
    if (updates.length === 0) return;
    if (onBatchUpdateCells) onBatchUpdateCells(updates);
    else updates.forEach((u) => onUpdateRow(u.rowId, u.colId, u.value));
  }, [normalizedSelection, visibleRows, leftColumns, onBatchUpdateCells, onUpdateRow]);

  const applyPaste = useCallback(
    (text: string) => {
      const matrix = parseClipboardMatrix(text);
      const startNode = normalizedSelection ? visibleRows[normalizedSelection.minRowIdx] : undefined;
      if (!matrix.length || !normalizedSelection || !startNode) {
        showToast('请先选中单元格后再粘贴');
        return;
      }

      const selRows = normalizedSelection.maxRowIdx - normalizedSelection.minRowIdx + 1;
      const selCols = normalizedSelection.maxColIdx - normalizedSelection.minColIdx + 1;
      const targetRows = normalizedSelection.isSingleCell ? matrix.length : selRows;
      const targetCols = normalizedSelection.isSingleCell ? matrix[0]?.length || 1 : selCols;
      const finalMatrix = tileMatrix(matrix, targetRows, targetCols);

      const startRowIdx = normalizedSelection.minRowIdx;
      const startColIdx = normalizedSelection.minColIdx;
      const updates: Array<{ rowId: string; colId: string; value: unknown }> = [];
      const newRowsToAppend: BitableRow[] = [];

      finalMatrix.forEach((line, rOffset) => {
        const rIdx = startRowIdx + rOffset;
        let targetRowId: string;
        if (rIdx < visibleRows.length) {
          targetRowId = visibleRows[rIdx].row.id;
        } else {
          // 行数不足时按锚点行的层级补建新行
          const anchorParentId = visibleRows[startRowIdx]?.row.parentId;
          const newRow: BitableRow = { ...createRow(columns), parentId: anchorParentId };
          newRowsToAppend.push(newRow);
          targetRowId = newRow.id;
        }
        line.forEach((val, cOffset) => {
          const cIdx = startColIdx + cOffset;
          if (cIdx >= leftColumns.length) return;
          updates.push({ rowId: targetRowId, colId: leftColumns[cIdx].id, value: val });
        });
      });

      if (onBatchUpdateCells) {
        onBatchUpdateCells(updates, newRowsToAppend);
      } else if (onPasteCells) {
        onPasteCells(startNode.row.id, leftColumns[startColIdx].id, matrix);
      } else {
        updates.forEach((u) => onUpdateRow(u.rowId, u.colId, u.value));
      }
      showToast(updates.length > 1 ? '已粘贴区域数据' : '已粘贴数据');
    },
    [
      normalizedSelection,
      visibleRows,
      leftColumns,
      columns,
      onBatchUpdateCells,
      onPasteCells,
      onUpdateRow,
    ],
  );

  /** 自动填充执行入口：按轴向复制 / 步进选区数据 */
  const applyAutoFill = useCallback(
    (range: NonNullable<typeof normalizedSelection>, preview: FillPreview) => {
      const updates: Array<{ rowId: string; colId: string; value: unknown }> = [];
      const newRowsToAppend: BitableRow[] = [];

      if (preview.axis === 'row') {
        const targetRowCount = preview.toRow - preview.fromRow + 1;
        if (targetRowCount <= 0) return;

        const targetRowIds: string[] = [];
        for (let r = preview.fromRow; r <= preview.toRow; r += 1) {
          if (r < visibleRows.length) {
            targetRowIds.push(visibleRows[r].row.id);
          } else {
            const anchorParentId = visibleRows[range.maxRowIdx]?.row.parentId;
            const newRow: BitableRow = { ...createRow(columns), parentId: anchorParentId };
            newRowsToAppend.push(newRow);
            targetRowIds.push(newRow.id);
          }
        }

        for (let c = range.minColIdx; c <= range.maxColIdx; c += 1) {
          const col = leftColumns[c];
          if (!col) continue;
          const sourceValues: unknown[] = [];
          for (let r = range.minRowIdx; r <= range.maxRowIdx; r += 1) {
            sourceValues.push(visibleRows[r]?.row[col.id]);
          }
          const filled = calculateAutoFillValues(col, sourceValues, targetRowCount, preview.direction);
          filled.forEach((val, idx) => {
            const rowId = targetRowIds[idx];
            if (rowId) updates.push({ rowId, colId: col.id, value: val });
          });
        }
      } else {
        const targetColCount = preview.toCol - preview.fromCol + 1;
        if (targetColCount <= 0) return;
        for (let r = range.minRowIdx; r <= range.maxRowIdx; r += 1) {
          const node = visibleRows[r];
          if (!node) continue;
          const sourceValues: unknown[] = [];
          for (let c = range.minColIdx; c <= range.maxColIdx; c += 1) {
            const col = leftColumns[c];
            if (col) sourceValues.push(node.row[col.id]);
          }
          for (let c = preview.fromCol; c <= preview.toCol; c += 1) {
            const targetCol = leftColumns[c];
            if (!targetCol) continue;
            const offset = preview.direction === 'forward' ? c - preview.fromCol : preview.toCol - c;
            const filled = calculateAutoFillValues(targetCol, sourceValues, targetColCount, preview.direction);
            updates.push({ rowId: node.row.id, colId: targetCol.id, value: filled[offset] });
          }
        }
      }

      if (updates.length === 0 && newRowsToAppend.length === 0) return;
      if (onBatchUpdateCells) onBatchUpdateCells(updates, newRowsToAppend);
      else updates.forEach((u) => onUpdateRow(u.rowId, u.colId, u.value));
      showToast('已自动填充数据');
    },
    [visibleRows, leftColumns, columns, onBatchUpdateCells, onUpdateRow],
  );

  /** 拖拽填充柄：按指针位置推断填充方向与范围 */
  const startFillDrag = (e: React.MouseEvent, range: NonNullable<typeof normalizedSelection>) => {
    e.preventDefault();
    e.stopPropagation();
    isSelectingCellsRef.current = false;

    const startMaxRow = range.maxRowIdx;
    const startMinRow = range.minRowIdx;
    const startMaxCol = range.maxColIdx;
    const startMinCol = range.minColIdx;
    let current: FillPreview | null = null;

    const onMouseMove = (ev: MouseEvent) => {
      const target = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const td = target?.closest('td[data-gantt-row-idx]') as HTMLTableCellElement | null;
      let hoverRow = startMaxRow;
      let hoverCol = startMaxCol;

      if (td) {
        const rStr = td.getAttribute('data-gantt-row-idx');
        const cStr = td.getAttribute('data-gantt-col-idx');
        if (rStr !== null) hoverRow = parseInt(rStr, 10);
        if (cStr !== null) hoverCol = parseInt(cStr, 10);
      } else {
        const body = rowBodyRef.current;
        if (body) {
          const rect = body.getBoundingClientRect();
          if (ev.clientY > rect.bottom) {
            hoverRow = visibleRows.length - 1 + Math.floor((ev.clientY - rect.bottom) / ROW_HEIGHT) + 1;
          }
        }
      }

      const dDown = hoverRow - startMaxRow;
      const dUp = startMinRow - hoverRow;
      const dRight = hoverCol - startMaxCol;
      const dLeft = startMinCol - hoverCol;
      const maxDelta = Math.max(dDown, dUp, dRight, dLeft);

      if (maxDelta <= 0) {
        current = null;
        setFillPreview(null);
        return;
      }

      if (maxDelta === dDown) {
        current = { direction: 'forward', axis: 'row', fromRow: startMaxRow + 1, toRow: hoverRow, fromCol: startMinCol, toCol: startMaxCol };
      } else if (maxDelta === dUp) {
        current = { direction: 'backward', axis: 'row', fromRow: Math.max(0, hoverRow), toRow: startMinRow - 1, fromCol: startMinCol, toCol: startMaxCol };
      } else if (maxDelta === dRight) {
        current = { direction: 'forward', axis: 'col', fromRow: startMinRow, toRow: startMaxRow, fromCol: startMaxCol + 1, toCol: Math.min(leftColumns.length - 1, hoverCol) };
      } else {
        current = { direction: 'backward', axis: 'col', fromRow: startMinRow, toRow: startMaxRow, fromCol: Math.max(0, hoverCol), toCol: startMinCol - 1 };
      }
      setFillPreview(current);
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      setFillPreview(null);
      if (current) applyAutoFill(range, current);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  /** 双击填充柄：向下快速填充到末行 */
  const handleDoubleClickFill = (e: React.MouseEvent, range: NonNullable<typeof normalizedSelection>) => {
    e.preventDefault();
    e.stopPropagation();
    if (visibleRows.length - 1 <= range.maxRowIdx) return;
    applyAutoFill(range, {
      direction: 'forward',
      axis: 'row',
      fromRow: range.maxRowIdx + 1,
      toRow: visibleRows.length - 1,
      fromCol: range.minColIdx,
      toCol: range.maxColIdx,
    });
  };

  // ── 剪贴板代理输入框事件 ──
  const handleProxyCopy = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const payload = buildClipboardPayload();
    if (payload === null) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', payload);
    showToast(normalizedSelection?.isSingleCell ? '已复制单元格数据' : '已复制选区数据');
  };

  const handleProxyCut = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const payload = buildClipboardPayload();
    if (payload === null) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', payload);
    clearSelectedRange();
    showToast('已剪切选区数据');
  };

  const handleProxyPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    applyPaste(text);
  };

  const handleProxyKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      clearSelectedRange();
      return;
    }
    if (e.key === 'Escape') {
      setSelection({ type: 'none' });
      blurClipboardProxy();
      return;
    }
    if (e.key === 'Enter' && normalizedSelection) {
      const node = visibleRows[normalizedSelection.anchorRowIdx];
      if (node && onOpenRecord) onOpenRecord(node.row.id);
    }
  };

  const zoom: GanttZoom = config.zoom || 'month';
  const colorMode: GanttColorMode = config.colorMode || 'custom';
  const workdaysOnly = Boolean(config.workdaysOnly);
  const dayWidth = GANTT_DAY_WIDTH[zoom];

  // ── 时间轴范围与轴 ──
  const padDays = zoom === 'week' ? 7 : zoom === 'month' ? 10 : zoom === 'quarter' ? 31 : 61;

  const { axis, todayX, timelineWidth } = useMemo(() => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;

    if (startCol) {
      rows.forEach((row) => {
        const s = extractDatePart(row[startCol.id]);
        const e = endCol ? extractDatePart(row[endCol.id]) : null;
        const sDay = s ? dateToDayIndex(s) : null;
        const eDay = e ? dateToDayIndex(e) : null;
        const from = sDay ?? eDay;
        const to = eDay ?? sDay;
        if (from === null || to === null) return;
        min = Math.min(min, from);
        max = Math.max(max, Math.max(from, to));
      });
    }

    const today = todayDayIndex();
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      min = today - 7;
      max = today + 14;
    }
    // 始终把「今天」纳入视野，保证今日线与「今天」按钮始终有效
    min = Math.min(min, today);
    max = Math.max(max, today);

    const from = min - padDays;
    let to = max + padDays;
    if (to - from > MAX_AXIS_DAYS) to = from + MAX_AXIS_DAYS;

    const builtAxis = buildGanttDayAxis(from, to, workdaysOnly);
    const todayIdx = builtAxis.indexOf.get(today);
    return {
      axis: builtAxis,
      todayX: todayIdx === undefined ? null : todayIdx * dayWidth,
      timelineWidth: builtAxis.days.length * dayWidth,
    };
  }, [rows, startCol, endCol, workdaysOnly, padDays, dayWidth]);

  const primaryBands = useMemo(() => buildGanttTimeBands(axis.days, zoom, 'primary'), [axis, zoom]);
  const secondaryBands = useMemo(() => buildGanttTimeBands(axis.days, zoom, 'secondary'), [axis, zoom]);

  /** 周末底色：合并连续周末为一个色块，控制节点数与视觉噪声 */
  const weekendRects = useMemo(() => {
    if (workdaysOnly) return [] as Array<{ left: number; width: number }>;
    const rects: Array<{ left: number; width: number }> = [];
    let runStart: number | null = null;
    axis.days.forEach((day, idx) => {
      if (isWeekendDay(day)) {
        if (runStart === null) runStart = idx;
      } else if (runStart !== null) {
        rects.push({ left: runStart * dayWidth, width: (idx - runStart) * dayWidth });
        runStart = null;
      }
    });
    if (runStart !== null) {
      rects.push({ left: runStart * dayWidth, width: (axis.days.length - runStart) * dayWidth });
    }
    return rects;
  }, [axis, dayWidth, workdaysOnly]);

  /**
   * 时间轴网格线
   * 用周期渐变代替「逐格 DOM」，避免每行渲染成百上千个节点。
   * 周视图的周界线与 x=0 不重合时按天偏移对齐，否则线与表头周分栏会错开半周。
   */
  const gridBackground = useMemo(() => {
    const line = 'var(--editor-border, #f1f5f9)';
    if (zoom === 'month') {
      return {
        backgroundImage: `repeating-linear-gradient(to right, ${line} 0 1px, transparent 1px ${dayWidth}px)`,
      };
    }
    if (zoom === 'week') {
      const firstDay = axis.days[0];
      const daysSinceMonday = (new Date(firstDay * 86400000).getUTCDay() + 6) % 7;
      const period = dayWidth * 7;
      return {
        backgroundImage: `repeating-linear-gradient(to right, ${line} 0 1px, transparent 1px ${period}px)`,
        backgroundPosition: `${-daysSinceMonday * dayWidth}px 0`,
      };
    }
    // 季 / 年刻度下逐日线过密，交由表头分栏表达时间粒度
    return {};
  }, [zoom, dayWidth, axis]);

  // ── 每行条形数据 ──
  const barsByRow = useMemo(() => {
    const map = new Map<
      string,
      { startDay: number; endDay: number; aStart: number; aEnd: number; durationDays: number }
    >();
    if (!startCol) return map;

    rows.forEach((row) => {
      const sStr = extractDatePart(row[startCol.id]);
      const eStr = endCol ? extractDatePart(row[endCol.id]) : null;
      let sDay = sStr ? dateToDayIndex(sStr) : null;
      let eDay = eStr ? dateToDayIndex(eStr) : null;
      if (sDay === null && eDay === null) return;
      if (sDay === null) sDay = eDay;
      if (eDay === null) eDay = sDay;
      if (sDay === null || eDay === null) return;
      if (eDay < sDay) {
        const swap = sDay;
        sDay = eDay;
        eDay = swap;
      }

      map.set(row.id, {
        startDay: sDay,
        endDay: eDay,
        aStart: ganttAxisIndexStart(axis, sDay),
        aEnd: ganttAxisIndexEnd(axis, eDay),
        durationDays: workdaysOnly ? countWorkdays(sDay, eDay) : eDay - sDay + 1,
      });
    });
    return map;
  }, [rows, startCol, endCol, axis, workdaysOnly]);

  // ── 左侧固定列偏移量 ──
  const leftOffsets = useMemo(() => {
    const offsets: number[] = [];
    let acc = NUM_COL_WIDTH;
    leftColumns.forEach((col, idx) => {
      offsets[idx] = acc;
      acc += col.width || 160;
    });
    return offsets;
  }, [leftColumns]);
  const leftPaneWidth = useMemo(
    () => NUM_COL_WIDTH + leftColumns.reduce((sum, col) => sum + (col.width || 160), 0),
    [leftColumns],
  );

  // ── 条形拖拽 ──
  const commitBarDrag = useCallback(
    (cur: BarDrag) => {
      if (!startCol || cur.delta === 0) return;
      const lastAxis = axis.days.length - 1;
      const clampAxis = (i: number) => Math.max(0, Math.min(lastAxis, i));

      let aStart = cur.origStartAxis;
      let aEnd = cur.origEndAxis;

      if (cur.mode === 'move') {
        aStart = clampAxis(cur.origStartAxis + cur.delta);
        aEnd = clampAxis(cur.origEndAxis + cur.delta);
        if (aStart > aEnd) aStart = aEnd;
      } else if (cur.mode === 'resize-start') {
        aStart = clampAxis(cur.origStartAxis + cur.delta);
        if (aStart > aEnd) aStart = aEnd;
      } else {
        aEnd = clampAxis(cur.origEndAxis + cur.delta);
        if (aEnd < aStart) aEnd = aStart;
      }

      const newStartDate = dayIndexToDate(axis.days[aStart]);
      const newEndDate = dayIndexToDate(axis.days[aEnd]);

      onUpdateRow(cur.rowId, startCol.id, buildDateFieldValue(newStartDate, startCol.type));
      if (endCol && endCol.id !== startCol.id) {
        onUpdateRow(cur.rowId, endCol.id, buildDateFieldValue(newEndDate, endCol.type));
      }
    },
    [axis, startCol, endCol, onUpdateRow],
  );
  // 拖拽监听器与提交函数通过 ref 解耦，避免每次渲染重绑事件
  commitBarDragRef.current = commitBarDrag;

  useEffect(() => {
    if (!barDrag) return;
    const handleMove = (e: MouseEvent) => {
      const cur = barDragRef.current;
      if (!cur) return;
      const delta = Math.round((e.clientX - cur.startX) / dayWidth);
      if (delta === cur.delta) return;
      const next = { ...cur, delta };
      barDragRef.current = next;
      setBarDrag(next);
    };
    const handleUp = () => {
      const cur = barDragRef.current;
      barDragRef.current = null;
      setBarDrag(null);
      if (cur) commitBarDragRef.current(cur);
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [barDrag, dayWidth]);

  const startBarDrag = (
    e: React.MouseEvent,
    rowId: string,
    mode: BarDrag['mode'],
    origStartAxis: number,
    origEndAxis: number,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const next: BarDrag = { rowId, mode, startX: e.clientX, origStartAxis, origEndAxis, delta: 0 };
    barDragRef.current = next;
    setBarDrag(next);
  };

  /**
   * 把「今天」居中到时间轴可视区
   * 可视宽度需扣掉左侧固定列，否则今天会被固定的字段列盖住。
   */
  const centerOnToday = useCallback(
    (behavior: ScrollBehavior) => {
      const el = scrollRef.current;
      if (!el || todayX === null) return;
      const viewport = Math.max(160, el.clientWidth - leftPaneWidth);
      const target = Math.max(0, todayX - viewport / 2);
      if (behavior === 'smooth') el.scrollTo({ left: target, behavior });
      else el.scrollLeft = target;
    },
    [todayX, leftPaneWidth],
  );

  // 首次进入自动定位到「今天」，避免长周期任务把视图拖到几个月之前
  const autoScrolledRef = useRef(false);
  useEffect(() => {
    if (autoScrolledRef.current || todayX === null) return;
    autoScrolledRef.current = true;
    centerOnToday('auto');
  }, [todayX, centerOnToday]);

  const scrollToToday = () => centerOnToday('smooth');

  const openPanel = (kind: 'config' | 'fields', e: React.MouseEvent<HTMLButtonElement>) => {
    const anchor = getAnchorRect(e.currentTarget);
    if (!anchor) return;
    if (panel?.kind === kind) {
      setPanel(null);
      return;
    }
    setPanel({ kind, anchor, trigger: e.currentTarget });
  };

  /** 切换左侧固定列显隐（至少保留一列，否则时间轴失去行标识） */
  const toggleLeftColumn = (colId: string) => {
    const next = leftColumnIds.includes(colId)
      ? leftColumnIds.filter((id) => id !== colId)
      : [...leftColumnIds, colId];
    if (next.length === 0) {
      showToast('至少保留一个左侧字段');
      return;
    }
    onUpdateConfig({ leftColumnIds: next });
  };

  const palette = getOptionColor(config.color || 'blue');
  const today = todayDayIndex();

  /** 单行条形颜色：自定义取固定色，自动模式取该行第一个标签的颜色 */
  const resolveBarColor = (row: BitableRow) => {
    if (colorMode === 'custom') return palette;
    for (const col of columns) {
      if (col.type === 'select') {
        const opt = col.options?.find((o) => o.id === row[col.id]);
        if (opt) return getOptionColor(opt.color);
      } else if (col.type === 'multiSelect') {
        const val = row[col.id];
        const first = Array.isArray(val) ? (val[0] as string | undefined) : undefined;
        const opt = col.options?.find((o) => o.id === first);
        if (opt) return getOptionColor(opt.color);
      }
    }
    return palette;
  };

  /** 拖拽幽灵用的行标题（找不到时兜底为未命名记录） */
  const resolveRowTitleById = (rowId: string) => {
    const row = rows.find((r) => r.id === rowId);
    return row ? resolveBarTitle(row) : '未命名记录';
  };

  const resolveBarTitle = (row: BitableRow) => {
    if (!titleCol) return '未命名任务';
    const raw = row[titleCol.id];
    // 走统一展示格式化：单选 / 多选取标签文案，避免条形上出现 opt_* 主键
    let text = formatCellValue(titleCol, raw);

    // 多选 / 单选的历史数据可能以「逗号分隔主键串」保存，formatCellValue 只认数组，这里补兜底
    if (!text && (titleCol.type === 'select' || titleCol.type === 'multiSelect') && typeof raw === 'string' && raw.trim()) {
      text = raw
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((id) => titleCol.options?.find((o) => o.id === id)?.label || id)
        .join(', ');
    }

    return text.replace(/\s+/g, ' ').trim() || '未命名任务';
  };

  // ── 无日期字段：引导式空态 ──
  if (dateColumns.length === 0) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--editor-bg, #ffffff)',
          padding: 24,
        }}
      >
        <div
          style={{
            maxWidth: 420,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 12,
            padding: '28px 32px',
            borderRadius: 14,
            border: '1px dashed var(--editor-border, #cbd5e1)',
            background: 'var(--editor-surface, #ffffff)',
            textAlign: 'center',
          }}
        >
          <CalendarRange size={30} color="var(--editor-accent, #3b82f6)" />
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--editor-text, #1e293b)' }}>
            甘特图需要一个日期字段
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--editor-text-muted, #64748b)' }}>
            表格中还没有可用的「日期 / 日期时间」字段。创建「开始日期」与「结束日期」后即可按时间轴排布任务。
          </div>
          {onCreateDateFields && (
            <button
              type="button"
              className="nb-bitable-btn-primary"
              onClick={onCreateDateFields}
              style={{ padding: '6px 14px', marginTop: 4 }}
            >
              <Plus size={13} />
              <span>创建日期字段</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--editor-bg, #ffffff)',
        overflow: 'hidden',
      }}
    >
      {/* 工具条：甘特图配置 / 字段（左侧固定列） · 刻度切换 / 今天 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 10,
          rowGap: 6,
          padding: '6px 12px',
          borderBottom: '1px solid var(--editor-border, #e2e8f0)',
          background: 'var(--editor-surface, #f8fafc)',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            ref={configBtnRef}
            type="button"
            className="nb-bitable-btn-secondary"
            onClick={(e) => openPanel('config', e)}
            style={{
              gap: 4,
              background: panel?.kind === 'config' ? 'var(--editor-bg, #f1f5f9)' : undefined,
            }}
          >
            <Settings2 size={13} />
            <span>甘特图配置</span>
          </button>
          <button
            ref={fieldsBtnRef}
            type="button"
            className="nb-bitable-btn-secondary"
            onClick={(e) => openPanel('fields', e)}
            style={{
              gap: 4,
              background: panel?.kind === 'fields' ? 'var(--editor-bg, #f1f5f9)' : undefined,
            }}
          >
            <Pin size={13} />
            <span>左侧字段{leftColumns.length > 1 ? ` ${leftColumns.length}` : ''}</span>
          </button>

          {/* 分组依据 + 多字段排序：与表格视图共用同一套视图配置 */}
          {onUpdateGroupByColumnId && (
            <>
              <div style={{ width: 1, height: 16, background: 'var(--editor-border, #e2e8f0)' }} />
              <SlidersHorizontal size={13} color="var(--editor-text-muted, #64748b)" />
              <FieldSelectButton
                columns={columns}
                value={groupByColumnId || null}
                placeholder="不分组"
                onChange={(colId) => onUpdateGroupByColumnId(colId || '')}
                width={130}
              />
              {groupByColumnId && (
                <Tooltip content="清除分组" side="bottom" sideOffset={4}>
                  <button
                    type="button"
                    className="nb-bitable-btn-ghost"
                    onClick={() => onUpdateGroupByColumnId('')}
                    aria-label="清除分组"
                    style={{ padding: '3px 5px' }}
                  >
                    <X size={12} />
                  </button>
                </Tooltip>
              )}
              {onUpdateSortRules && (
                <Tooltip content="设置多字段排序" side="bottom" sideOffset={4}>
                  <button
                    type="button"
                    className="nb-bitable-btn-secondary"
                    onClick={(e) => {
                      const rect = getAnchorRect(e.currentTarget);
                      if (!rect) return;
                      setSortPanelAnchor(rect);
                      setSortPanelTrigger(e.currentTarget);
                      setSortPanelOpen(true);
                    }}
                    style={{
                      gap: 4,
                      padding: '3px 8px',
                      background: sortRules.length > 0 ? 'rgba(59, 130, 246, 0.08)' : undefined,
                      color: sortRules.length > 0 ? 'var(--editor-accent, #3b82f6)' : undefined,
                      borderColor: sortRules.length > 0 ? 'var(--editor-accent, #3b82f6)' : undefined,
                    }}
                  >
                    <ArrowUpDown size={13} />
                    <span>排序{sortRules.length > 0 ? ` ${sortRules.length}` : ''}</span>
                  </button>
                </Tooltip>
              )}
            </>
          )}
        </div>

        {sortPanelOpen && sortPanelAnchor && sortPanelTrigger && onUpdateSortRules && (
          <FloatingPanel
            anchor={sortPanelAnchor}
            trigger={sortPanelTrigger}
            width={380}
            align="left"
            onClose={() => setSortPanelOpen(false)}
          >
            <SortRulesPanel
              columns={columns}
              sortRules={sortRules}
              onChange={onUpdateSortRules}
              onClose={() => setSortPanelOpen(false)}
            />
          </FloatingPanel>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* 刻度切换：周 / 月 / 季 / 年 */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: 2,
              gap: 2,
              borderRadius: 7,
              background: 'var(--editor-bg, #ffffff)',
              border: '1px solid var(--editor-border, #e2e8f0)',
            }}
          >
            {ZOOM_OPTIONS.map((option) => {
              const isActive = option.id === zoom;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => onUpdateConfig({ zoom: option.id })}
                  className={`nb-bitable-gantt-zoom${isActive ? ' is-active' : ''}`}
                  style={{
                    padding: '2px 12px',
                    fontSize: 12,
                    border: 'none',
                    borderRadius: 5,
                    cursor: 'pointer',
                  }}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="nb-bitable-btn-secondary"
            onClick={scrollToToday}
            disabled={todayX === null}
          >
            <CalendarRange size={13} />
            <span>今天</span>
          </button>
        </div>

        {/* 甘特图配置面板 */}
        {panel?.kind === 'config' && (
          <FloatingPanel
            anchor={panel.anchor}
            trigger={panel.trigger}
            width={300}
            gap={10}
            onClose={() => {
              setPanel(null);
              setColorMenu(null);
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--editor-text, #1e293b)' }}>
              甘特图配置
            </div>

            <ConfigRow label="开始日期">
              <FieldSelectButton
                columns={dateColumns}
                value={startCol?.id || null}
                onChange={(colId) => colId && onUpdateConfig({ startColumnId: colId })}
                width={150}
              />
            </ConfigRow>
            <ConfigRow label="结束日期">
              <FieldSelectButton
                columns={dateColumns}
                value={endCol?.id || null}
                placeholder="同开始日期"
                onChange={(colId) => onUpdateConfig({ endColumnId: colId || undefined })}
                width={150}
              />
            </ConfigRow>

            <div style={{ height: 1, background: 'var(--editor-border, #f1f5f9)' }} />

            <ConfigRow label="标题展示">
              <FieldSelectButton
                columns={columns}
                value={titleCol?.id || null}
                onChange={(colId) => colId && onUpdateConfig({ titleColumnId: colId })}
                width={150}
              />
            </ConfigRow>

            <ConfigRow label="颜色显示">
              <button
                ref={colorBtnRef}
                type="button"
                className="nb-bitable-btn-secondary"
                onClick={(e) => {
                  const anchor = getAnchorRect(e.currentTarget);
                  if (!anchor) return;
                  if (colorMenu) {
                    setColorMenu(null);
                    return;
                  }
                  setColorMenu({ anchor, trigger: e.currentTarget });
                }}
                style={{
                  width: 150,
                  justifyContent: 'space-between',
                  padding: '3px 8px',
                  fontWeight: 400,
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {colorMode === 'custom' && (
                    <span
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: 3,
                        background: palette.text,
                        flexShrink: 0,
                      }}
                    />
                  )}
                  {COLOR_MODE_OPTIONS.find((o) => o.id === colorMode)?.label}
                </span>
                <ChevronDown size={12} style={{ opacity: 0.6 }} />
              </button>
              {colorMenu && (
                <FloatingPanel
                  anchor={colorMenu.anchor}
                  trigger={colorMenu.trigger}
                  width={150}
                  gap={2}
                  onClose={() => setColorMenu(null)}
                >
                  {COLOR_MODE_OPTIONS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className="nb-bitable-menu-item"
                      onClick={() => {
                        onUpdateConfig({ colorMode: option.id });
                        setColorMenu(null);
                      }}
                    >
                      <span style={{ flex: 1 }}>{option.label}</span>
                      {colorMode === option.id && <Check size={13} color="var(--editor-accent, #3b82f6)" />}
                    </button>
                  ))}
                </FloatingPanel>
              )}
            </ConfigRow>

            {/* 自定义色板：仅在自定义模式下展示，避免与「跟随标签颜色」语义冲突 */}
            {colorMode === 'custom' && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 8px',
                  borderRadius: 7,
                  background: 'var(--editor-bg, #f8fafc)',
                }}
              >
                {BITABLE_PALETTE.map((item) => (
                  <Tooltip key={item.id} content={item.label} side="bottom" sideOffset={4}>
                    <div
                      className="nb-bitable-color-dot"
                      onClick={() => onUpdateConfig({ color: item.id as SelectOptionColor })}
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 5,
                        background: item.text,
                        cursor: 'pointer',
                        border:
                          (config.color || 'blue') === item.id
                            ? '2px solid var(--editor-text, #0f172a)'
                            : '1px solid rgba(15,23,42,0.12)',
                      }}
                    />
                  </Tooltip>
                ))}
              </div>
            )}

            <div style={{ height: 1, background: 'var(--editor-border, #f1f5f9)' }} />

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 12.5, color: 'var(--editor-text, #1e293b)' }}>仅计算工作日</span>
              <button
                type="button"
                role="switch"
                aria-checked={workdaysOnly}
                onClick={() => onUpdateConfig({ workdaysOnly: !workdaysOnly })}
                style={{
                  width: 34,
                  height: 20,
                  padding: 0,
                  border: 'none',
                  borderRadius: 10,
                  cursor: 'pointer',
                  position: 'relative',
                  background: workdaysOnly ? 'var(--editor-accent, #3b82f6)' : 'var(--editor-border, #cbd5e1)',
                  transition: 'background 0.18s ease',
                }}
              >
                <span
                  style={{
                    position: 'absolute',
                    top: 2,
                    left: workdaysOnly ? 16 : 2,
                    width: 16,
                    height: 16,
                    borderRadius: '50%',
                    background: '#ffffff',
                    boxShadow: '0 1px 2px rgba(15,23,42,0.25)',
                    transition: 'left 0.18s ease',
                  }}
                />
              </button>
            </div>
          </FloatingPanel>
        )}

        {/* 左侧字段面板：勾选即固定展示在时间轴左侧 */}
        {panel?.kind === 'fields' && (
          <FloatingPanel
            anchor={panel.anchor}
            trigger={panel.trigger}
            width={250}
            gap={2}
            onClose={() => setPanel(null)}
          >
            <div
              style={{
                fontSize: 12,
                color: 'var(--editor-text-muted, #94a3b8)',
                padding: '2px 6px 6px',
                lineHeight: 1.6,
              }}
            >
              勾选的字段会固定在时间轴左侧，横向滚动时始终可见。
            </div>
            {columns.map((col) => {
              const included = leftColumnIds.includes(col.id);
              const meta = getFieldTypeMeta(col.type);
              return (
                <button
                  key={col.id}
                  type="button"
                  className="nb-bitable-menu-item"
                  onClick={() => toggleLeftColumn(col.id)}
                  style={{ justifyContent: 'space-between' }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
                    {meta.icon}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {col.name}
                    </span>
                    {included && <Lock size={11} color="var(--editor-text-muted, #94a3b8)" />}
                  </span>
                  {included ? (
                    <Eye size={13} color="var(--editor-accent, #3b82f6)" />
                  ) : (
                    <EyeOff size={13} color="var(--editor-text-muted, #94a3b8)" />
                  )}
                </button>
              );
            })}
          </FloatingPanel>
        )}
      </div>

      {/* 甘特图主体：单一滚动容器，左侧列与表头通过 sticky 固定 */}
      <div
        ref={scrollRef}
        style={{ flex: 1, overflow: 'auto', position: 'relative' }}
        onClick={(e) => {
          // 点击滚动区空白处：收起选区与右键菜单
          if (e.target === e.currentTarget) {
            setSelection({ type: 'none' });
            setCellContextMenu(null);
            focusClipboardProxy();
          }
        }}
      >
        <table
          style={{
            borderCollapse: 'separate',
            borderSpacing: 0,
            width: 'max-content',
            minWidth: '100%',
          }}
        >
          <thead>
            <tr style={{ height: HEADER_HEIGHT }}>
              {/* 左上角序号列头：双向固定 */}
              <th
                className="nb-bitable-gantt-corner"
                style={{
                  width: NUM_COL_WIDTH,
                  minWidth: NUM_COL_WIDTH,
                  maxWidth: NUM_COL_WIDTH,
                  position: 'sticky',
                  left: 0,
                  top: 0,
                  zIndex: 8,
                  background: 'var(--editor-surface, #f8fafc)',
                  borderBottom: '1px solid var(--editor-border, #e2e8f0)',
                  borderRight: '1px solid var(--editor-border, #e2e8f0)',
                  fontSize: 12,
                  fontWeight: 500,
                  color: 'var(--editor-text-muted, #94a3b8)',
                  textAlign: 'center',
                  userSelect: 'none',
                  padding: 0,
                }}
              >
                #
              </th>

              {/* 左侧固定列表头 */}
              {leftColumns.map((col, idx) => {
                const width = col.width || 160;
                const meta = getFieldTypeMeta(col.type);
                const isLastLeft = idx === leftColumns.length - 1;
                return (
                  <th
                    key={col.id}
                    className="nb-bitable-gantt-th-left"
                    style={{
                      width,
                      minWidth: width,
                      maxWidth: width,
                      position: 'sticky',
                      left: leftOffsets[idx],
                      top: 0,
                      zIndex: 7,
                      borderBottom: '1px solid var(--editor-border, #e2e8f0)',
                      borderRight: isLastLeft
                        ? '1px solid var(--editor-border, #cbd5e1)'
                        : '1px solid var(--editor-border, #f1f5f9)',
                      padding: '0 10px',
                      textAlign: 'left',
                      fontSize: 12,
                      fontWeight: 600,
                      color: 'var(--editor-text, #1e293b)',
                      userSelect: 'none',
                      overflow: 'hidden',
                    }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {meta.icon}
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {col.name}
                      </span>
                      <Lock size={11} color="var(--editor-text-muted, #94a3b8)" style={{ flexShrink: 0 }} />
                    </span>
                  </th>
                );
              })}

              {/* 时间轴表头：随内容横向滚动，纵向吸附 */}
              <th
                style={{
                  width: timelineWidth,
                  minWidth: timelineWidth,
                  position: 'sticky',
                  top: 0,
                  zIndex: 6,
                  background: 'var(--editor-surface, #f8fafc)',
                  borderBottom: '1px solid var(--editor-border, #e2e8f0)',
                  borderRight: '1px solid var(--editor-border, #e2e8f0)',
                  padding: 0,
                }}
              >
                <div style={{ position: 'relative', width: timelineWidth, height: HEADER_HEIGHT }}>
                  {/* 周末底色 */}
                  {weekendRects.map((rect) => (
                    <div
                      key={`h-${rect.left}`}
                      style={{
                        position: 'absolute',
                        top: 0,
                        bottom: 0,
                        left: rect.left,
                        width: rect.width,
                        background: 'rgba(148, 163, 184, 0.09)',
                        pointerEvents: 'none',
                      }}
                    />
                  ))}

                  {/* 上层：年 / 月 / 季 */}
                  <div style={{ display: 'flex', height: HEADER_HEIGHT / 2, position: 'relative' }}>
                    {primaryBands.map((band) => (
                      <div
                        key={band.key}
                        style={{
                          width: band.span * dayWidth,
                          minWidth: band.span * dayWidth,
                          boxSizing: 'border-box',
                          borderRight: '1px solid var(--editor-border, #e2e8f0)',
                          borderBottom: '1px solid var(--editor-border, #e2e8f0)',
                          display: 'flex',
                          alignItems: 'center',
                          paddingLeft: 8,
                          fontSize: 11.5,
                          fontWeight: 600,
                          color: 'var(--editor-text-muted, #64748b)',
                          overflow: 'hidden',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {band.label}
                      </div>
                    ))}
                  </div>

                  {/* 下层：日 / 周 / 月 */}
                  <div style={{ display: 'flex', height: HEADER_HEIGHT / 2, position: 'relative' }}>
                    {secondaryBands.map((band) => (
                      <div
                        key={band.key}
                        style={{
                          width: band.span * dayWidth,
                          minWidth: band.span * dayWidth,
                          boxSizing: 'border-box',
                          borderRight: '1px solid var(--editor-border, #f1f5f9)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: zoom === 'month' ? 'center' : 'flex-start',
                          paddingLeft: zoom === 'month' ? 0 : 8,
                          fontSize: 11,
                          color: 'var(--editor-text-muted, #94a3b8)',
                          overflow: 'hidden',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {band.label}
                      </div>
                    ))}
                  </div>

                  {/* 今日线 */}
                  {todayX !== null && (
                    <div
                      style={{
                        position: 'absolute',
                        top: 0,
                        bottom: 0,
                        left: todayX,
                        width: 1,
                        background: 'var(--editor-accent, #3b82f6)',
                        pointerEvents: 'none',
                      }}
                    />
                  )}
                </div>
              </th>
            </tr>
          </thead>

          <tbody ref={rowBodyRef}>
            {items.map((item, itemIndex) => {
              // 分组标题行：整行铺满，标题吸左固定，横向滚动时始终可读
              if (item.type === 'group') {
                const isCollapsed = collapsedGroupKeys.has(item.key);
                const isFirstGroup =
                  itemIndex === 0 || !items.slice(0, itemIndex).some((i) => i.type === 'group');
                return (
                  <React.Fragment key={`group-${item.key}`}>
                    {!isFirstGroup && (
                      <tr aria-hidden="true" style={{ height: 8 }}>
                        <td
                          colSpan={leftColumns.length + 2}
                          style={{ border: 'none', padding: 0, background: 'transparent' }}
                        />
                      </tr>
                    )}
                    <tr style={{ height: 34 }}>
                      <td
                        colSpan={leftColumns.length + 2}
                        className="nb-bitable-gantt-group-cell"
                        onClick={() => toggleGroupCollapse(item.key)}
                        style={{
                          borderTop: isFirstGroup ? '1px solid var(--editor-border, #e2e8f0)' : undefined,
                          borderBottom: '1px solid var(--editor-border, #e2e8f0)',
                          padding: 0,
                          cursor: 'pointer',
                        }}
                      >
                        <div
                          style={{
                            position: 'sticky',
                            left: 0,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '0 12px',
                            height: 34,
                            width: 'max-content',
                          }}
                        >
                          <button
                            type="button"
                            className="nb-bitable-btn-ghost"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleGroupCollapse(item.key);
                            }}
                            style={{ padding: 2, color: 'var(--editor-text-muted, #64748b)' }}
                          >
                            {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                          </button>
                          {item.color ? (
                            <OptionBadge option={{ id: item.key, label: item.label, color: item.color }} />
                          ) : (
                            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--editor-text, #1e293b)' }}>
                              {item.label}
                            </span>
                          )}
                          <span style={{ fontSize: 12, color: 'var(--editor-text-muted, #94a3b8)' }}>
                            总数 {item.count}
                          </span>
                        </div>
                      </td>
                    </tr>
                  </React.Fragment>
                );
              }

              const node = item.node;
              const row = node.row;
              const rowIdx = rowIdxMap.get(row.id) ?? -1;
              const isRowSelected =
                normalizedSelection !== null &&
                selection.type === 'row' &&
                rowIdx >= normalizedSelection.minRowIdx &&
                rowIdx <= normalizedSelection.maxRowIdx;
              const rowTint = isRowSelected ? '#eef4fe' : undefined;
              const bar = barsByRow.get(row.id);
              const rowHovered = hoverRowId === row.id;
              const drag = barDrag?.rowId === row.id ? barDrag : null;

              // 行拖拽落点指示线：画在单元格上而非 tr 上（tr 的 box-shadow 渲染不可靠）
              const rowIndicator = rowIdx >= 0 ? getRowIndicator(rowIdx) : null;
              const rowDropShadow =
                rowIndicator === 'top'
                  ? 'inset 0 2px 0 #3b82f6'
                  : rowIndicator === 'bottom'
                    ? 'inset 0 -2px 0 #3b82f6'
                    : undefined;
              const isRowDragging = rowDrag !== null && rowDrag.fromIdx === rowIdx;

              // 拖拽预览：按位移换算轴向偏移，实时反馈改期结果
              let barLeft = bar ? bar.aStart * dayWidth : 0;
              let barWidth = bar ? (bar.aEnd - bar.aStart + 1) * dayWidth - 6 : 0;
              if (bar && drag) {
                if (drag.mode === 'move') {
                  barLeft += drag.delta * dayWidth;
                } else if (drag.mode === 'resize-start') {
                  const shift = Math.min(drag.delta, bar.aEnd - bar.aStart) * dayWidth;
                  barLeft += shift;
                  barWidth -= shift;
                } else {
                  barWidth += drag.delta * dayWidth;
                  barWidth = Math.max(dayWidth, barWidth);
                }
              }

              const barPalette = bar ? resolveBarColor(row) : palette;
              const durationLabel = bar ? `${bar.durationDays} 天` : '';
              // 条形至少保留一个「日格」的宽度，否则 1 天的任务在粗刻度下会退化成一像素
              const effectiveWidth = Math.max(barWidth, dayWidth - 4);
              const showTitleInside = effectiveWidth >= 104;
              const showDurationInside = effectiveWidth >= 34;

              return (
                <tr
                  key={row.id}
                  ref={(el) => {
                    if (el) rowRefs.current.set(row.id, el);
                    else rowRefs.current.delete(row.id);
                  }}
                  className="nb-bitable-gantt-row"
                  style={{
                    background: rowTint,
                    // 被拖起的行整体压暗，明确「哪一行正在被搬运」
                    opacity: isRowDragging ? 0.45 : 1,
                  }}
                  onMouseEnter={() => setHoverRowId(row.id)}
                  onMouseLeave={() => setHoverRowId((prev) => (prev === row.id ? null : prev))}
                >
                  {/* 序号列：拖拽换行序、单击选中整行并浮出行操作条、双击展开记录详情 */}
                  <td
                    className="nb-bitable-gantt-num-cell"
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      if (rowIdx >= 0) startRowDrag(e, rowIdx);
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      // 拖拽结束紧跟的 click 不应再改变选区
                      if (consumeRowDraggedFlag()) return;
                      if (e.shiftKey && selection.type === 'row') {
                        setSelection({ type: 'row', startRowId: selection.startRowId, endRowId: row.id });
                      } else {
                        setSelection({ type: 'row', startRowId: row.id, endRowId: row.id });
                      }
                      focusClipboardProxy();
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      if (onOpenRecord) onOpenRecord(row.id);
                    }}
                    onContextMenu={(e) => handleRowContextMenu(e, row.id)}
                    style={{
                      width: NUM_COL_WIDTH,
                      minWidth: NUM_COL_WIDTH,
                      maxWidth: NUM_COL_WIDTH,
                      position: 'sticky',
                      left: 0,
                      zIndex: 5,
                      borderBottom: '1px solid var(--editor-border, #f1f5f9)',
                      borderRight: '1px solid var(--editor-border, #e2e8f0)',
                      textAlign: 'center',
                      fontSize: 12,
                      color: 'var(--editor-text-muted, #94a3b8)',
                      padding: 0,
                      userSelect: 'none',
                      background: rowTint || undefined,
                      cursor: rowDrag ? 'grabbing' : rowDragEnabled ? 'grab' : 'pointer',
                      // 指示线必须画在 sticky 单元格自身，否则会被它的背景色盖掉
                      boxShadow: rowDropShadow,
                    }}
                  >
                    <div
                      style={{
                        position: 'relative',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '100%',
                        height: ROW_HEIGHT,
                      }}
                    >
                      <Tooltip
                        content={
                          sortRules.length > 0
                            ? '存在排序规则时行序由排序决定，无法手动拖动'
                            : !onMoveRow
                              ? '单击选中整行 · 双击展开详情'
                              : groupByColumnId
                                ? '拖拽可在分组内换行 · 单击选中整行 · 双击展开详情'
                                : '拖拽行头可换序 · 单击选中整行 · 双击展开详情'
                        }
                        disabled={Boolean(rowDrag)}
                        side="right"
                        sideOffset={4}
                      >
                        <span style={{ cursor: 'inherit', display: 'inline-block', width: '100%' }}>
                          {node.rowNumber}
                        </span>
                      </Tooltip>

                      {/* 行快捷操作条：与表格视图保持同一套动作与图标 */}
                      <div
                        data-no-drag
                        style={{
                          display: isRowSelected ? 'flex' : 'none',
                          position: 'absolute',
                          left: '100%',
                          top: '50%',
                          transform: 'translateY(-50%)',
                          zIndex: 99,
                          background: 'var(--editor-surface, #ffffff)',
                          border: '1px solid var(--editor-border, #cbd5e1)',
                          borderRadius: 7,
                          boxShadow: '0 6px 18px rgba(15,23,42,0.14)',
                          padding: '4px 6px',
                          gap: 3,
                          alignItems: 'center',
                          marginLeft: 4,
                        }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {onOpenRecord && (
                          <Tooltip content="展开记录详情" side="top" sideOffset={4}>
                            <button
                              type="button"
                              aria-label="展开记录详情"
                              className="nb-bitable-row-action-btn"
                              onClick={() => onOpenRecord(row.id)}
                              style={{ color: 'var(--editor-accent, #3b82f6)' }}
                            >
                              <Maximize2 size={14} />
                            </button>
                          </Tooltip>
                        )}
                        {onOutdentRow && (
                          <Tooltip
                            content={row.parentId ? '升级为上一级' : '该行已是第一级'}
                            side="top"
                            sideOffset={4}
                            disabled={!row.parentId}
                          >
                            <button
                              type="button"
                              aria-label="升级为上一级"
                              disabled={!row.parentId}
                              className="nb-bitable-row-action-btn"
                              onClick={() => onOutdentRow(row.id)}
                              style={{ color: 'var(--editor-text, #334155)' }}
                            >
                              <IndentDecrease size={14} />
                            </button>
                          </Tooltip>
                        )}
                        {onIndentRow && (
                          <Tooltip content="降级为子任务" side="top" sideOffset={4}>
                            <button
                              type="button"
                              aria-label="降级为子任务"
                              className="nb-bitable-row-action-btn"
                              onClick={() => onIndentRow(row.id)}
                              style={{ color: 'var(--editor-text, #334155)' }}
                            >
                              <IndentIncrease size={14} />
                            </button>
                          </Tooltip>
                        )}
                        {onAddSubRow && (
                          <Tooltip content="添加子任务" side="top" sideOffset={4}>
                            <button
                              type="button"
                              aria-label="添加子任务"
                              className="nb-bitable-row-action-btn"
                              onClick={() => onAddSubRow(row.id)}
                              style={{ color: 'var(--editor-accent, #3b82f6)' }}
                            >
                              <CornerDownRight size={14} />
                            </button>
                          </Tooltip>
                        )}
                        {onInsertRowAbove && (
                          <Tooltip content="在上方插入行" side="top" sideOffset={4}>
                            <button
                              type="button"
                              aria-label="在上方插入行"
                              className="nb-bitable-row-action-btn"
                              onClick={() => onInsertRowAbove(row.id)}
                              style={{ color: 'var(--editor-text, #334155)' }}
                            >
                              <ArrowUp size={14} />
                            </button>
                          </Tooltip>
                        )}
                        {onInsertRowBelow && (
                          <Tooltip content="在下方插入行" side="top" sideOffset={4}>
                            <button
                              type="button"
                              aria-label="在下方插入行"
                              className="nb-bitable-row-action-btn"
                              onClick={() => onInsertRowBelow(row.id)}
                              style={{ color: 'var(--editor-text, #334155)' }}
                            >
                              <ArrowDown size={14} />
                            </button>
                          </Tooltip>
                        )}
                        <Tooltip content="删除该行" side="top" sideOffset={4}>
                          <button
                            type="button"
                            aria-label="删除该行"
                            className="nb-bitable-row-action-btn"
                            onClick={() => onDeleteRow(row.id)}
                            style={{ color: '#ef4444' }}
                          >
                            <Trash2 size={14} />
                          </button>
                        </Tooltip>
                      </div>
                    </div>
                  </td>

                  {/* 左侧固定字段列：可编辑、可框选、可右键、可拖拽填充 */}
                  {leftColumns.map((col, colIdx) => {
                    const width = col.width || 160;
                    const isLastLeft = colIdx === leftColumns.length - 1;
                    const isCellSelected =
                      normalizedSelection !== null &&
                      rowIdx >= normalizedSelection.minRowIdx &&
                      rowIdx <= normalizedSelection.maxRowIdx &&
                      colIdx >= normalizedSelection.minColIdx &&
                      colIdx <= normalizedSelection.maxColIdx;
                    const isTopEdge = isCellSelected && rowIdx === normalizedSelection.minRowIdx;
                    const isBottomEdge = isCellSelected && rowIdx === normalizedSelection.maxRowIdx;
                    const isLeftEdge = isCellSelected && colIdx === normalizedSelection.minColIdx;
                    const isRightEdge = isCellSelected && colIdx === normalizedSelection.maxColIdx;
                    const isBottomRightCorner = isCellSelected && isBottomEdge && isRightEdge;
                    const isInFillPreview =
                      fillPreview !== null &&
                      rowIdx >= fillPreview.fromRow &&
                      rowIdx <= fillPreview.toRow &&
                      colIdx >= fillPreview.fromCol &&
                      colIdx <= fillPreview.toCol;
                    const isFillTop = isInFillPreview && rowIdx === fillPreview.fromRow;
                    const isFillBottom = isInFillPreview && rowIdx === fillPreview.toRow;
                    const isFillLeft = isInFillPreview && colIdx === fillPreview.fromCol;
                    const isFillRight = isInFillPreview && colIdx === fillPreview.toCol;

                    const shadows: string[] = [];
                    if (rowDropShadow) shadows.push(rowDropShadow);
                    if (isCellSelected) {
                      if (isTopEdge) shadows.push('inset 0 2px 0 0 var(--editor-accent, #3b82f6)');
                      if (isBottomEdge) shadows.push('inset 0 -2px 0 0 var(--editor-accent, #3b82f6)');
                      if (isLeftEdge) shadows.push('inset 2px 0 0 0 var(--editor-accent, #3b82f6)');
                      if (isRightEdge) shadows.push('inset -2px 0 0 0 var(--editor-accent, #3b82f6)');
                    }
                    if (isInFillPreview) {
                      if (isFillTop) shadows.push('inset 0 2px 0 0 #60a5fa');
                      if (isFillBottom) shadows.push('inset 0 -2px 0 0 #60a5fa');
                      if (isFillLeft) shadows.push('inset 2px 0 0 0 #60a5fa');
                      if (isFillRight) shadows.push('inset -2px 0 0 0 #60a5fa');
                    }

                    const cellBg = isInFillPreview
                      ? '#dbe9fd'
                      : isCellSelected
                        ? '#e7effd'
                        : rowTint || undefined;

                    return (
                      <td
                        key={col.id}
                        className="nb-bitable-gantt-left-cell"
                        data-gantt-row-idx={rowIdx}
                        data-gantt-col-idx={colIdx}
                        onMouseDown={(e) => handleCellMouseDown(e, row.id, col.id)}
                        onMouseEnter={() => handleCellMouseEnter(row.id, col.id)}
                        onContextMenu={(e) => handleCellContextMenu(e, row.id, col.id)}
                        style={{
                          width,
                          minWidth: width,
                          maxWidth: width,
                          position: 'sticky',
                          left: leftOffsets[colIdx],
                          // 承载填充柄的单元格临时抬升层级，避免把手被下一列盖住
                          zIndex: isBottomRightCorner ? 2 : 1,
                          height: ROW_HEIGHT,
                          borderBottom: '1px solid var(--editor-border, #f1f5f9)',
                          borderRight: isLastLeft
                            ? '1px solid var(--editor-border, #cbd5e1)'
                            : '1px solid var(--editor-border, #f1f5f9)',
                          padding: 0,
                          overflow: 'visible',
                          verticalAlign: 'middle',
                          background: cellBg,
                          boxShadow: shadows.length > 0 ? shadows.join(', ') : undefined,
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            width: '100%',
                            height: '100%',
                            overflow: 'hidden',
                          }}
                        >
                          {/* 第一列渲染子任务层级缩进与折叠箭头 */}
                          {colIdx === 0 && (
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                paddingLeft: node.depth * 18 + 2,
                                marginRight: 2,
                                flexShrink: 0,
                              }}
                            >
                              {node.hasChildren ? (
                                <button
                                  type="button"
                                  className="nb-bitable-btn-ghost"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleCollapse(row.id);
                                  }}
                                  style={{ padding: 1, color: 'var(--editor-text-muted, #64748b)' }}
                                >
                                  {node.isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                                </button>
                              ) : node.depth > 0 ? (
                                <CornerDownRight
                                  size={11}
                                  color="var(--editor-text-muted, #94a3b8)"
                                  style={{ opacity: 0.7 }}
                                />
                              ) : null}
                            </div>
                          )}
                          <div style={{ flex: 1, height: '100%', minWidth: 0 }}>
                            <BitableCellEditor
                              column={col}
                              value={row[col.id]}
                              onChange={(newVal) => onUpdateRow(row.id, col.id, newVal)}
                              onManageColumnOption={onManageColumnOption}
                            />
                          </div>
                        </div>

                        {/* 选区右下角填充柄：拖拽自动填充 · 双击向下快速填充 */}
                        {isBottomRightCorner && normalizedSelection && (
                          <Tooltip content="拖拽自动填充 · 双击向下快速填充" side="bottom" sideOffset={4}>
                            <div
                              data-fill-handle
                              onMouseDown={(e) => startFillDrag(e, normalizedSelection)}
                              onDoubleClick={(e) => handleDoubleClickFill(e, normalizedSelection)}
                              className="nb-bitable-fill-handle"
                              style={{
                                position: 'absolute',
                                right: -4,
                                bottom: -4,
                                width: 7,
                                height: 7,
                                background: 'var(--editor-accent, #3b82f6)',
                                border: '1px solid #ffffff',
                                borderRadius: 1,
                                cursor: 'crosshair',
                                zIndex: 12,
                                boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                              }}
                            />
                          </Tooltip>
                        )}
                      </td>
                    );
                  })}

                  {/* 时间轴单元格：单击收起行悬浮菜单与选区，双击展开记录详情 */}
                  <td
                    onClick={() => {
                      if (!barDragRef.current) setSelection({ type: 'none' });
                      setCellContextMenu(null);
                    }}
                    onDoubleClick={() => {
                      if (onOpenRecord) onOpenRecord(row.id);
                    }}
                    style={{
                      padding: 0,
                      height: ROW_HEIGHT,
                      borderBottom: '1px solid var(--editor-border, #f1f5f9)',
                      position: 'relative',
                      boxShadow: rowDropShadow,
                    }}
                  >
                    <div
                      style={{
                        position: 'relative',
                        width: timelineWidth,
                        height: ROW_HEIGHT,
                        ...gridBackground,
                      }}
                    >
                      {/* 周末底色 */}
                      {weekendRects.map((rect) => (
                        <div
                          key={`b-${rect.left}`}
                          style={{
                            position: 'absolute',
                            top: 0,
                            bottom: 0,
                            left: rect.left,
                            width: rect.width,
                            background: 'rgba(148, 163, 184, 0.07)',
                            pointerEvents: 'none',
                          }}
                        />
                      ))}

                      {/* 今日线 */}
                      {todayX !== null && (
                        <div
                          style={{
                            position: 'absolute',
                            top: 0,
                            bottom: 0,
                            left: todayX,
                            width: 1,
                            background: 'var(--editor-accent, #3b82f6)',
                            opacity: 0.75,
                            pointerEvents: 'none',
                          }}
                        />
                      )}

                      {/* 条形 */}
                      {bar && (
                        <>
                          {/* 条形可能横跨上千像素，提示必须跟随指针，否则会飘到条形中心去 */}
                          <Tooltip
                            followCursor
                            content={`${resolveBarTitle(row)} · ${dayIndexToDate(bar.startDay)}${
                              bar.endDay !== bar.startDay ? ` → ${dayIndexToDate(bar.endDay)}` : ''
                            } · ${bar.durationDays} 天`}
                            disabled={Boolean(drag)}
                          >
                            <div
                              className="nb-bitable-gantt-bar"
                              onMouseDown={(e) =>
                                startBarDrag(e, row.id, 'move', bar.aStart, bar.aEnd)
                              }
                              onDoubleClick={(e) => {
                                e.stopPropagation();
                                if (onOpenRecord) onOpenRecord(row.id);
                              }}
                              style={{
                                position: 'absolute',
                                top: (ROW_HEIGHT - BAR_HEIGHT) / 2,
                                left: barLeft + 3,
                                width: effectiveWidth,
                                height: BAR_HEIGHT,
                                borderRadius: 6,
                                background: barPalette.text,
                                boxShadow: `0 1px 3px ${barPalette.text}44`,
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                padding: showTitleInside ? '0 8px' : '0 4px',
                                boxSizing: 'border-box',
                                overflow: 'hidden',
                                cursor: drag ? 'grabbing' : 'grab',
                                userSelect: 'none',
                              }}
                            >
                              {showTitleInside && (
                                <span
                                  style={{
                                    flex: 1,
                                    fontSize: 11.5,
                                    fontWeight: 600,
                                    color: '#ffffff',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  {resolveBarTitle(row)}
                                </span>
                              )}
                              {showDurationInside && (
                                <span
                                  style={{
                                    fontSize: 10.5,
                                    fontWeight: 600,
                                    color: 'rgba(255,255,255,0.92)',
                                    flexShrink: 0,
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  {durationLabel}
                                </span>
                              )}

                              {/* 两端拉伸把手 */}
                              <div
                                className="nb-bitable-gantt-bar-handle"
                                onMouseDown={(e) => startBarDrag(e, row.id, 'resize-start', bar.aStart, bar.aEnd)}
                                style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 7, cursor: 'col-resize' }}
                              />
                              <div
                                className="nb-bitable-gantt-bar-handle"
                                onMouseDown={(e) => startBarDrag(e, row.id, 'resize-end', bar.aStart, bar.aEnd)}
                                style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 7, cursor: 'col-resize' }}
                              />
                            </div>
                          </Tooltip>

                          {/* 过窄条形：标题外置到条形右侧，避免文字被压成省略号 */}
                          {!showTitleInside && (
                            <span
                              style={{
                                position: 'absolute',
                                left: barLeft + effectiveWidth + 12,
                                top: 0,
                                height: ROW_HEIGHT,
                                display: 'flex',
                                alignItems: 'center',
                                fontSize: 11.5,
                                color: 'var(--editor-text, #1e293b)',
                                whiteSpace: 'nowrap',
                                pointerEvents: 'none',
                              }}
                            >
                              {resolveBarTitle(row)}
                            </span>
                          )}
                        </>
                      )}

                      {/* 空行悬浮：在今日位置提供一键排期入口 */}
                      {!bar && rowHovered && todayX !== null && startCol && (
                        <Tooltip content="点击以「今天」为该行排期" side="top" sideOffset={6}>
                          <button
                            type="button"
                            className="nb-bitable-gantt-add"
                            onClick={() => {
                              const dateStr = dayIndexToDate(today);
                              onUpdateRow(row.id, startCol.id, buildDateFieldValue(dateStr, startCol.type));
                              if (endCol && endCol.id !== startCol.id) {
                                onUpdateRow(row.id, endCol.id, buildDateFieldValue(dateStr, endCol.type));
                              }
                            }}
                            style={{
                              position: 'absolute',
                              left: todayX - 12,
                              top: (ROW_HEIGHT - 24) / 2,
                              width: 24,
                              height: 24,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              borderRadius: 6,
                              border: '1px dashed var(--editor-border, #cbd5e1)',
                              background: 'var(--editor-surface, #ffffff)',
                              color: 'var(--editor-text-muted, #64748b)',
                              cursor: 'pointer',
                            }}
                          >
                            <Plus size={13} />
                          </button>
                        </Tooltip>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>

          <tfoot>
            <tr>
              <td
                colSpan={leftColumns.length + 1}
                style={{
                  padding: '8px 12px',
                  borderTop: '1px solid var(--editor-border, #e2e8f0)',
                  background: 'var(--editor-surface, #ffffff)',
                }}
              >
                <div style={{ position: 'sticky', left: 12, display: 'inline-flex', width: 'fit-content' }}>
                  <button
                    type="button"
                    className="nb-bitable-btn-secondary"
                    onClick={onAddRow}
                    style={{
                      borderStyle: 'dashed',
                      padding: '5px 12px',
                      color: 'var(--editor-text-muted, #64748b)',
                      fontWeight: 500,
                    }}
                  >
                    <Plus size={13} />
                    <span>添加一行记录</span>
                  </button>
                </div>
              </td>
              <td
                style={{
                  borderTop: '1px solid var(--editor-border, #e2e8f0)',
                  background: 'var(--editor-surface, #ffffff)',
                }}
              />
            </tr>
          </tfoot>
        </table>
      </div>

      {/* 行拖拽时的跟随幽灵：提示落在本组/本表的第几行 */}
      {rowDrag && (
        <DragGhost x={rowDrag.x - rowGrabOffset.x} y={rowDrag.y - rowGrabOffset.y + 4}>
          {resolveRowTitleById(rowSlots[rowDrag.fromIdx]?.rowId ?? '')}
          {rowDrag.valid
            ? ` · 移动到${groupByColumnId ? '组内' : ''}第 ${rowDropPosition} 行`
            : ' · 此处不可放置'}
        </DragGhost>
      )}

      {/* 隐藏剪贴板代理：持有焦点以接收原生 copy / cut / paste 与 Del 清空 */}
      <textarea
        ref={clipboardProxyRef}
        aria-hidden="true"
        tabIndex={-1}
        onCopy={handleProxyCopy}
        onCut={handleProxyCut}
        onPaste={handleProxyPaste}
        onKeyDown={handleProxyKeyDown}
        onChange={(e) => {
          e.currentTarget.value = '';
        }}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: 1,
          height: 1,
          padding: 0,
          border: 'none',
          outline: 'none',
          resize: 'none',
          opacity: 0,
          pointerEvents: 'none',
          zIndex: -1,
        }}
      />

      {/* 单元格右键菜单 */}
      {cellContextMenu && (
        <div
          ref={contextMenuRef}
          data-no-drag
          style={{
            position: 'fixed',
            left: Math.min(cellContextMenu.x, window.innerWidth - 190),
            top: Math.min(cellContextMenu.y, window.innerHeight - 400),
            zIndex: 9999,
            background: 'var(--editor-surface, #ffffff)',
            border: '1px solid var(--editor-border, #cbd5e1)',
            borderRadius: 8,
            boxShadow: '0 10px 25px rgba(15,23,42,0.15)',
            padding: 4,
            minWidth: 168,
            fontSize: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="nb-bitable-menu-item"
            onClick={() => {
              const payload = buildClipboardPayload();
              if (payload !== null) {
                if (navigator.clipboard?.writeText) navigator.clipboard.writeText(payload).catch(() => {});
                showToast(normalizedSelection?.isSingleCell ? '已复制单元格数据' : '已复制选区数据');
              }
              setCellContextMenu(null);
            }}
          >
            <Copy size={13} color="var(--editor-text-muted, #64748b)" />
            <span style={{ flex: 1 }}>复制</span>
            <span style={{ fontSize: 10, opacity: 0.5 }}>Ctrl+C</span>
          </button>

          <button
            type="button"
            className="nb-bitable-menu-item"
            onClick={() => {
              const payload = buildClipboardPayload();
              if (payload !== null && navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(payload).catch(() => {});
              }
              clearSelectedRange();
              setCellContextMenu(null);
            }}
          >
            <Scissors size={13} color="var(--editor-text-muted, #64748b)" />
            <span style={{ flex: 1 }}>剪切</span>
            <span style={{ fontSize: 10, opacity: 0.5 }}>Ctrl+X</span>
          </button>

          <button
            type="button"
            className="nb-bitable-menu-item"
            onClick={async () => {
              setCellContextMenu(null);
              try {
                if (navigator.clipboard?.readText) {
                  const text = await navigator.clipboard.readText();
                  if (text) {
                    applyPaste(text);
                    return;
                  }
                }
              } catch {
                // 读取剪贴板被拒绝时退回快捷键方式
              }
              showToast('请使用快捷键 Ctrl+V 粘贴');
            }}
          >
            <Clipboard size={13} color="var(--editor-text-muted, #64748b)" />
            <span style={{ flex: 1 }}>粘贴</span>
            <span style={{ fontSize: 10, opacity: 0.5 }}>Ctrl+V</span>
          </button>

          <button
            type="button"
            className="nb-bitable-menu-item"
            onClick={() => {
              clearSelectedRange();
              setCellContextMenu(null);
            }}
          >
            <Eraser size={13} color="var(--editor-text-muted, #64748b)" />
            <span style={{ flex: 1 }}>清空选区</span>
            <span style={{ fontSize: 10, opacity: 0.5 }}>Del</span>
          </button>

          <div style={{ height: 1, background: 'var(--editor-border, #e2e8f0)', margin: '3px 0' }} />

          {onInsertRowAbove && (
            <button
              type="button"
              className="nb-bitable-menu-item"
              onClick={() => {
                onInsertRowAbove(cellContextMenu.targetRowId);
                setCellContextMenu(null);
                showToast('已在上方插入行');
              }}
            >
              <ArrowUp size={13} color="var(--editor-text-muted, #64748b)" />
              <span>在上方插入行</span>
            </button>
          )}

          {onInsertRowBelow && (
            <button
              type="button"
              className="nb-bitable-menu-item"
              onClick={() => {
                onInsertRowBelow(cellContextMenu.targetRowId);
                setCellContextMenu(null);
                showToast('已在下方插入行');
              }}
            >
              <ArrowDown size={13} color="var(--editor-text-muted, #64748b)" />
              <span>在下方插入行</span>
            </button>
          )}

          <button
            type="button"
            className="nb-bitable-menu-item"
            style={{ color: '#ef4444' }}
            onClick={() => {
              if (normalizedSelection && selection.type === 'row') {
                normalizedSelection.selectedRowIds.forEach((id) => onDeleteRow(id));
              } else {
                onDeleteRow(cellContextMenu.targetRowId);
              }
              setSelection({ type: 'none' });
              setCellContextMenu(null);
              showToast('已删除行');
            }}
          >
            <Trash2 size={13} color="#ef4444" />
            <span>删除行</span>
          </button>

          <div style={{ height: 1, background: 'var(--editor-border, #e2e8f0)', margin: '3px 0' }} />

          <button
            type="button"
            className="nb-bitable-menu-item"
            onClick={() => {
              onAddColumn('left', cellContextMenu.targetColId);
              setCellContextMenu(null);
              showToast('已在左侧插入列');
            }}
          >
            <MoveLeft size={13} color="var(--editor-text-muted, #64748b)" />
            <span>在左侧插入列</span>
          </button>

          <button
            type="button"
            className="nb-bitable-menu-item"
            onClick={() => {
              onAddColumn('right', cellContextMenu.targetColId);
              setCellContextMenu(null);
              showToast('已在右侧插入列');
            }}
          >
            <MoveRight size={13} color="var(--editor-text-muted, #64748b)" />
            <span>在右侧插入列</span>
          </button>

          {onClearColumn && (
            <button
              type="button"
              className="nb-bitable-menu-item"
              onClick={() => {
                onClearColumn(cellContextMenu.targetColId);
                setCellContextMenu(null);
                showToast('已清空整列数据');
              }}
            >
              <Eraser size={13} color="var(--editor-text-muted, #64748b)" />
              <span>清空整列数据</span>
            </button>
          )}

          <button
            type="button"
            className="nb-bitable-menu-item"
            style={{ color: '#ef4444' }}
            onClick={() => {
              onDeleteColumn(cellContextMenu.targetColId);
              setSelection({ type: 'none' });
              setCellContextMenu(null);
            }}
          >
            <Trash2 size={13} color="#ef4444" />
            <span>删除列</span>
          </button>

          {onOpenRecord && cellContextMenu.targetRowId && (
            <>
              <div style={{ height: 1, background: 'var(--editor-border, #e2e8f0)', margin: '3px 0' }} />
              <button
                type="button"
                className="nb-bitable-menu-item"
                onClick={() => {
                  onOpenRecord(cellContextMenu.targetRowId);
                  setCellContextMenu(null);
                }}
              >
                <Maximize2 size={13} color="var(--editor-accent, #3b82f6)" />
                <span>展开记录详情</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** 配置面板「标签 + 控件」单行布局 */
function ConfigRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
      <span style={{ fontSize: 12.5, color: 'var(--editor-text, #1e293b)', flexShrink: 0 }}>{label}</span>
      {children}
    </div>
  );
}

