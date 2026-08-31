// NoteBoard 多维表格网格视图 (Grid View)
// 支持表头指针拖拽换列、各字段格式专有排序、树形子任务展开收起、选区高亮与剪切/复制/粘贴/删除
// 剪贴板通过隐藏代理输入框接收原生 copy/cut/paste 事件，规避 navigator.clipboard 的读权限弹窗

import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import {
  DATE_FORMAT_OPTIONS,
  TIME_FORMAT_OPTIONS,
  isDateTimeFieldType,
  type BitableColumn,
  type BitableRow,
  type BitableFieldType,
  type ColumnOptionAction,
  type LongTextDisplayMode,
  type SelectOptionColor,
  type SortRule,
} from './bitableTypes';
import { BitableCellEditor } from './BitableCellEditor';
import { SelectOptionsPanel, OptionBadge } from './BitableOptions';
import { DragGhost, FloatingPanel, getAnchorRect, type AnchorRect } from './BitableFloating';
import { usePointerReorder } from './usePointerReorder';
import { getFieldTypeMeta, FieldSelectButton } from './BitableFieldMeta';
import { Tooltip } from '../../components/Tooltip';
import {
  calculateAutoFillValues,
  collectDescendantRowIds,
  createId,
  createRow,
  formatCellValue,
  getSortDirectionLabels,
  groupFlatTreeRows,
  isSlotNoop,
  parseClipboardMatrix,
  previewLongText,
  resolveDateTimeConfig,
  resolveLongTextConfig,
  slotToFinalPosition,
  slotToSpliceIndex,
  tileMatrix,
} from './bitableUtils';
import { showToast } from '../../stores/toastStore';
import {
  IndentIncrease,
  IndentDecrease,
  Maximize2,
  Tag,
  Tags,
  MoreHorizontal,
  Plus,
  Trash2,
  ArrowLeft,
  ArrowRight,
  Edit2,
  ChevronRight,
  ChevronDown,
  CornerDownRight,
  ArrowUp,
  ArrowDown,
  Eraser,
  MoveLeft,
  MoveRight,
  ArrowUpNarrowWide,
  ArrowDownWideNarrow,
  ArrowUpDown,
  CalendarClock,
  SlidersHorizontal,
  X,
  Check,
  Scissors,
  Clipboard,
  Copy,
} from 'lucide-react';

export interface CellRange {
  startRowId: string;
  startColId: string;
  endRowId: string;
  endColId: string;
}

export type SelectionState =
  | { type: 'none' }
  | { type: 'range'; range: CellRange }
  | { type: 'row'; startRowId: string; endRowId?: string }
  | { type: 'col'; startColId: string; endColId?: string };

interface GridViewProps {
  columns: BitableColumn[];
  rows: BitableRow[];
  /** 多字段联合排序规则 */
  sortRules?: SortRule[];
  /** 表格视图分组依据列 ID：与看板视图共用视图配置中的 groupByColumnId */
  groupByColumnId?: string;
  /** 分组依据变化回调 */
  onUpdateGroupByColumnId?: (colId: string) => void;
  /** 多字段排序规则变化回调 */
  onUpdateSortRules?: (sortRules: SortRule[]) => void;
  /** 区域粘贴：以 (rowId, colId) 为左上角写入二维文本矩阵，行数不足时由上层自动补建 */
  onPasteCells?: (rowId: string, colId: string, matrix: string[][]) => void;
  /** 批量更新单元格数据（单次事务合并撤销记录） */
  onBatchUpdateCells?: (
    updates: Array<{ rowId: string; colId: string; value: unknown }>,
    newRowsToAppend?: BitableRow[],
  ) => void;
  /** 列选项增删改排序：由上层在单次提交内同步列定义与所有关联行数据 */
  onManageColumnOption?: (colId: string, action: ColumnOptionAction) => void;
  onUpdateRow: (rowId: string, columnId: string, val: unknown) => void;
  onAddRow: () => void;
  onAddSubRow?: (parentRowId: string) => void;
  /** 子行升级为上一级 */
  onOutdentRow?: (rowId: string) => void;
  /** 行降级为上一同级行的子级 */
  onIndentRow?: (rowId: string) => void;
  /** 打开右侧记录详情侧边栏 */
  onOpenRecord?: (rowId: string) => void;
  onInsertRowAbove?: (rowId: string) => void;
  onInsertRowBelow?: (rowId: string) => void;
  onDeleteRow: (rowId: string) => void;
  onUpdateColumn: (colId: string, partial: Partial<BitableColumn>) => void;
  onAddColumn: (direction: 'left' | 'right', referenceColId?: string) => void;
  onDeleteColumn: (colId: string) => void;
  onClearColumn?: (colId: string) => void;
  onMoveColumn?: (colId: string, direction: 'left' | 'right') => void;
  onReorderColumns?: (fromIndex: number, toIndex: number) => void;
  /**
   * 拖拽行头换序：把 draggedRowId 对应的行（连同子树）插到 beforeRowId 之前
   * beforeRowId 为 null 表示追加到末尾；parentId 为被拖行的新父级。
   */
  onMoveRow?: (draggedRowId: string, beforeRowId: string | null, parentId?: string) => void;
}

/**
 * 一级字段类型清单
 * 日期与时间三个类型不再平铺在这里，而是收进「日期与时间」分组项下的二级菜单，
 * 避免类型列表越来越长、翻找困难。
 */
const ALL_FIELD_TYPES: BitableFieldType[] = [
  'text',
  'longText',
  'number',
  'select',
  'multiSelect',
  'checkbox',
  'rating',
  'progress',
  'link',
];

/** 「日期与时间」分组下的二级类型 */
const DATETIME_FIELD_TYPES: BitableFieldType[] = ['date', 'time', 'dateTime'];

/**
 * 切换字段类型时随列一起落库的补充字段
 * 集中成一处，保证「标签默认值 / 多行文本配置 / 日期时间格式」三条补全规则只写一遍，
 * 也避免新增类型时漏掉某一处导致「内存默认值与落盘数据不一致」。
 */
function buildFieldTypePatch(
  col: BitableColumn,
  nextType: BitableFieldType,
): Partial<BitableColumn> {
  return {
    type: nextType,
    options:
      (nextType === 'select' || nextType === 'multiSelect') && !col.options?.length
        ? [
            { id: 'opt_1', label: '选项 1', color: 'blue' },
            { id: 'opt_2', label: '选项 2', color: 'green' },
          ]
        : col.options,
    // 切为多行文本时补齐一份显式配置，避免只存在于内存中的默认值与落盘数据不一致
    longText: nextType === 'longText' ? resolveLongTextConfig(col) : col.longText,
    // 切为日期时间类时同理补齐格式配置，后续改格式才会基于已落盘的默认值
    dateTime: isDateTimeFieldType(nextType) ? resolveDateTimeConfig(col) : col.dateTime,
  };
}

/** 多行文本显示模式的菜单项 */
const DISPLAY_MODE_OPTIONS: Array<{ id: LongTextDisplayMode; label: string; hint: string }> = [
  { id: 'firstLine', label: '仅首行', hint: '只显示第一行，行高保持紧凑' },
  { id: 'full', label: '全显示', hint: '显示全部内容，行高随内容变高' },
];

interface FlatTreeRow {
  row: BitableRow;
  depth: number;
  hasChildren: boolean;
  isCollapsed: boolean;
  rowNumber: number;
}

/**
 * 可拖拽的行槽位：拖拽换序基于「可见数据行」序列计算
 * groupStart / groupEnd 为该行所属分组在序列中的区间 [groupStart, groupEnd)，
 * 用于把落点夹在本组内——跨组拖动等价于改写分组字段的值，不属于「换顺序」。
 */
interface RowSlot {
  rowId: string;
  parentId?: string;
  groupStart: number;
  groupEnd: number;
}

/** 表格视图渲染项：分组标题行或普通数据行 */
type GridItem =
  | { type: 'group'; key: string; label: string; count: number; color?: SelectOptionColor }
  | { type: 'row'; treeNode: FlatTreeRow };

interface SortRulesPanelProps {
  columns: BitableColumn[];
  sortRules: SortRule[];
  onChange: (rules: SortRule[]) => void;
  onClose: () => void;
}

function SortRulesPanel({ columns, sortRules, onChange, onClose }: SortRulesPanelProps) {
  const [localRules, setLocalRules] = useState<SortRule[]>(sortRules);

  const updateRule = (index: number, patch: Partial<SortRule>) => {
    setLocalRules((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  const removeRule = (index: number) => {
    setLocalRules((prev) => prev.filter((_, i) => i !== index));
  };

  const addRule = () => {
    const unusedCol = columns.find((c) => !localRules.some((r) => r.columnId === c.id));
    if (!unusedCol) {
      showToast('所有字段都已加入排序');
      return;
    }
    setLocalRules((prev) => [...prev, { columnId: unusedCol.id, direction: 'asc' }]);
  };

  const apply = () => {
    onChange(localRules);
    onClose();
  };

  const clearAll = () => {
    onChange([]);
    onClose();
  };

  return (
    <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10, width: 380 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--editor-text, #1e293b)' }}>排序</span>
        {sortRules.length > 0 && (
          <button type="button" onClick={clearAll} className="nb-bitable-btn-ghost" style={{ fontSize: 11, padding: '2px 6px' }}>
            清除全部
          </button>
        )}
      </div>

      {localRules.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--editor-text-muted, #94a3b8)', padding: '6px 0' }}>未设置排序字段</div>
      )}

      {localRules.map((rule, index) => {
        const col = columns.find((c) => c.id === rule.columnId);
        if (!col) return null;
        const labels = getSortDirectionLabels(col.type);
        const usedColIds = localRules.map((r) => r.columnId);
        return (
          <div key={`${rule.columnId}-${index}`} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, color: 'var(--editor-text-muted, #94a3b8)', width: 18, flexShrink: 0 }}>{index + 1}</span>
            <FieldSelectButton
              columns={columns}
              value={rule.columnId}
              onChange={(colId) => colId && updateRule(index, { columnId: colId })}
              disabledColIds={usedColIds.filter((id) => id !== rule.columnId)}
              width={140}
            />
            <button
              type="button"
              className="nb-bitable-btn-secondary"
              onClick={() => updateRule(index, { direction: rule.direction === 'asc' ? 'desc' : 'asc' })}
              style={{
                flex: 1,
                padding: '3px 6px',
                fontSize: 11,
              }}
            >
              {rule.direction === 'asc' ? labels.asc : labels.desc}
            </button>
            <Tooltip content="移除该排序字段" side="top" sideOffset={4}>
              <button
                type="button"
                className="nb-bitable-btn-ghost"
                onClick={() => removeRule(index)}
                aria-label="移除该排序字段"
                style={{ padding: 4 }}
              >
                <X size={13} />
              </button>
            </Tooltip>
          </div>
        );
      })}

      {localRules.length < columns.length && (
        <button
          type="button"
          className="nb-bitable-btn-secondary"
          onClick={addRule}
          style={{
            borderStyle: 'dashed',
            padding: '5px 10px',
            color: 'var(--editor-text-muted, #64748b)',
          }}
        >
          <Plus size={13} />
          <span>添加排序字段</span>
        </button>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
        <button type="button" onClick={onClose} className="nb-bitable-btn-secondary" style={{ padding: '4px 10px' }}>
          取消
        </button>
        <button type="button" onClick={apply} className="nb-bitable-btn-primary" style={{ padding: '4px 12px' }}>
          应用
        </button>
      </div>
    </div>
  );
}

export function BitableGridView({
  columns,
  rows,
  sortRules = [],
  groupByColumnId,
  onUpdateGroupByColumnId,
  onUpdateSortRules,
  onPasteCells,
  onBatchUpdateCells,
  onManageColumnOption,
  onUpdateRow,
  onAddRow,
  onAddSubRow,
  onOutdentRow,
  onIndentRow,
  onOpenRecord,
  onInsertRowAbove,
  onInsertRowBelow,
  onDeleteRow,
  onUpdateColumn,
  onAddColumn,
  onDeleteColumn,
  onClearColumn,
  onMoveColumn,
  onReorderColumns,
  onMoveRow,
}: GridViewProps) {
  // 当前打开列头菜单的列 ID（菜单改由 Portal 浮层渲染，需同时记录锚点与触发元素）
  const [columnMenu, setColumnMenu] = useState<{
    colId: string;
    anchor: AnchorRect;
    trigger: HTMLElement;
  } | null>(null);
  const [editingColNameId, setEditingColNameId] = useState<string | null>(null);
  const [colNameInput, setColNameInput] = useState('');

  // 「日期与时间」二级菜单：记录锚点（一级菜单项的位置）与触发元素
  // 该菜单是列头菜单派生的更上层浮层，FloatingPanel 的浮层栈会保证点它不会关掉列头菜单。
  const [datetimeSubmenu, setDatetimeSubmenu] = useState<{
    anchor: AnchorRect;
    trigger: HTMLElement;
  } | null>(null);
  const datetimeItemRef = useRef<HTMLButtonElement>(null);

  // 折叠的行 ID 集合
  const [collapsedRowIds, setCollapsedRowIds] = useState<Set<string>>(new Set());

  // 折叠的分组键集合：分组行本身可见，其下数据行被隐藏
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<Set<string>>(new Set());

  // 多字段排序面板状态
  const [sortPanelOpen, setSortPanelOpen] = useState(false);
  const [sortPanelAnchor, setSortPanelAnchor] = useState<AnchorRect | null>(null);
  const [sortPanelTrigger, setSortPanelTrigger] = useState<HTMLElement | null>(null);
  const sortButtonRef = useRef<HTMLButtonElement>(null);

  // 选区系统状态 (选中单元格区域/整行/整列)
  const [selection, setSelection] = useState<SelectionState>({ type: 'none' });

  // 鼠标按住拖拽框选状态
  const isSelectingCellsRef = useRef(false);
  const dragStartCellRef = useRef<{ rowId: string; colId: string } | null>(null);

  // 单元格悬浮右键菜单状态
  const [cellContextMenu, setCellContextMenu] = useState<{
    x: number;
    y: number;
    targetRowId: string;
    targetColId: string;
  } | null>(null);

  // 填充柄拖拽预测选区预览状态
  const [fillPreview, setFillPreview] = useState<{
    direction: 'forward' | 'backward';
    axis: 'row' | 'col';
    fromRow: number;
    toRow: number;
    fromCol: number;
    toCol: number;
  } | null>(null);

  const tbodyRef = useRef<HTMLTableSectionElement>(null);

  // 表头 DOM 节点表：用于测量列位置，支撑拖拽落点计算与浮层锚点
  const headerCellRefs = useRef<Map<string, HTMLTableCellElement>>(new Map());

  // 单选/多选中列表头的选项管理面板
  const [optionsEditor, setOptionsEditor] = useState<{
    colId: string;
    anchor: AnchorRect;
    trigger: HTMLElement;
  } | null>(null);

  // 隐藏剪贴板代理输入框：保持焦点以接收原生 copy/cut/paste 事件
  const clipboardProxyRef = useRef<HTMLTextAreaElement>(null);
  // 表格滚动容器：代理输入框持有焦点时用于手工转发滚动键
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // 拖拽调整列宽状态
  const resizingColRef = useRef<{ colId: string; startX: number; startW: number } | null>(null);

  /**
   * 关闭列头菜单，并连带收起由它派生的「日期与时间」二级菜单
   * 统一出口避免两处状态不同步：漏关子菜单会留下一个悬空的孤儿浮层。
   */
  const closeColumnMenu = useCallback(() => {
    setColumnMenu(null);
    setDatetimeSubmenu(null);
  }, []);

  /**
   * 打开「日期与时间」二级菜单
   * 锚点取一级菜单项的实测位置，使子菜单紧贴该项右侧延伸；右侧空间不足时
   * FloatingPanel 会自动翻到左侧，二者都不会被视口边缘裁掉。
   */
  const openDatetimeSubmenu = useCallback(() => {
    const el = datetimeItemRef.current;
    if (!el) return;
    const rect = getAnchorRect(el);
    if (rect) setDatetimeSubmenu({ anchor: rect, trigger: el });
  }, []);

  // 1. 构建树形扁平展示行列表 (计算层级深度 depth 与折叠状态)
  const flatTreeRows = useMemo(() => {
    const parentToChildren = new Map<string | undefined, BitableRow[]>();

    rows.forEach((row) => {
      const pid = row.parentId;
      const list = parentToChildren.get(pid) || [];
      list.push(row);
      parentToChildren.set(pid, list);
    });

    const result: FlatTreeRow[] = [];
    let counter = 0;

    function traverse(parentId: string | undefined, depth: number) {
      const children = parentToChildren.get(parentId) || [];
      for (const r of children) {
        counter++;
        const hasKids = (parentToChildren.get(r.id) || []).length > 0;
        const isCollapsed = collapsedRowIds.has(r.id);

        result.push({
          row: r,
          depth,
          hasChildren: hasKids,
          isCollapsed,
          rowNumber: counter,
        });

        // 未折叠时递归遍历子节点
        if (hasKids && !isCollapsed) {
          traverse(r.id, depth + 1);
        }
      }
    }

    traverse(undefined, 0);
    return result;
  }, [rows, collapsedRowIds]);

  // 切换折叠/展开
  const toggleCollapse = (rowId: string) => {
    setCollapsedRowIds((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) {
        next.delete(rowId);
      } else {
        next.add(rowId);
      }
      return next;
    });
  };

  // 2. 按分组字段把扁平树行组织为「分组标题 + 数据行」列表
  const groupColumn = useMemo(
    () => columns.find((c) => c.id === groupByColumnId),
    [columns, groupByColumnId],
  );

  const gridItems = useMemo(() => {
    if (!groupByColumnId || !groupColumn) {
      return flatTreeRows.map<GridItem>((node) => ({ type: 'row', treeNode: node }));
    }

    const groups = groupFlatTreeRows(flatTreeRows, groupColumn);
    const items: GridItem[] = [];
    let visibleCounter = 0;

    groups.forEach((group) => {
      items.push({
        type: 'group',
        key: group.meta.key,
        label: group.meta.label,
        count: group.rows.length,
        color: group.meta.color,
      });
      const collapsed = collapsedGroupKeys.has(group.meta.key);
      if (!collapsed) {
        group.rows.forEach((node) => {
          visibleCounter += 1;
          items.push({
            type: 'row',
            treeNode: { ...node, rowNumber: visibleCounter },
          });
        });
      }
    });

    return items;
  }, [flatTreeRows, groupByColumnId, groupColumn, collapsedGroupKeys]);

  /** 切换分组折叠/展开 */
  const toggleGroupCollapse = (key: string) => {
    setCollapsedGroupKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // 是否处于分组视图：决定落点提示文案与跨组夹取行为
  const isGrouped = Boolean(groupByColumnId && groupColumn);

  // 行 DOM 节点表：用于测量行位置，支撑「拖拽行头换序」的落点计算
  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());

  // 行 ID → 行数据：沿 parentId 链上溯即可判断落点是否落进自身子树
  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  /**
   * 可见数据行槽位序列（排除分组标题行）
   * 两趟构造：先按分组划出连续区间，再把区间回填到每一行上。
   */
  const rowSlots = useMemo<RowSlot[]>(() => {
    const raw: Array<{ rowId: string; parentId?: string; groupKey: string | null }> = [];
    let currentKey: string | null = null;
    gridItems.forEach((item) => {
      if (item.type === 'group') {
        currentKey = item.key;
        return;
      }
      raw.push({
        rowId: item.treeNode.row.id,
        parentId: item.treeNode.row.parentId,
        groupKey: currentKey,
      });
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
  }, [gridItems]);

  /** 行 ID → 槽位索引，供渲染层按行取用拖拽状态 */
  const rowSlotIndex = useMemo(
    () => new Map(rowSlots.map((slot, idx) => [slot.rowId, idx])),
    [rowSlots],
  );

  /**
   * 把拖拽槽位换算为落点描述；返回 null 表示该落点无效（不画指示线、不提交）
   *
   * 两个关键点：
   * 1) 落库时被拖行是「连整棵子树一起搬走」的，因此落点参照行必须跳过它自己的后代，
   *    否则「把父行拖到紧邻自己子树的后面」会被算成一次有效移动，实际顺序却毫无变化；
   * 2) 新父级不能是被拖行自身或它的后代，否则父行会被塞进自己的子树形成环。
   *
   * @param toIdx 「移除被拖行之后」的插入索引
   */
  const resolveRowDropTarget = useCallback(
    (fromIdx: number, toIdx: number) => {
      const dragged = rowSlots[fromIdx];
      if (!dragged) return null;
      const descendants = collectDescendantRowIds(rows, dragged.rowId);
      const rest = rowSlots.filter((_, i) => i !== fromIdx);

      // 跳过自身子树：这些行会跟着一起走，不能作为落点参照
      let cursor = toIdx;
      while (cursor < rest.length && descendants.has(rest[cursor].rowId)) cursor += 1;
      const before = rest[cursor] ?? null;

      const restWithoutSubtree = rest.filter((slot) => !descendants.has(slot.rowId));
      const insertIdx = before
        ? restWithoutSubtree.findIndex((slot) => slot.rowId === before.rowId)
        : restWithoutSubtree.length;

      // 插入位置与子树原起点重合 → 顺序不变，按无效落点处理，避免产生空撤销记录
      if (insertIdx === fromIdx) return null;

      // 追加到末尾时沿用末行的父级，保证落点与视觉位置一致
      const parentId = before
        ? before.parentId
        : restWithoutSubtree[restWithoutSubtree.length - 1]?.parentId;
      if (parentId && (parentId === dragged.rowId || descendants.has(parentId))) return null;

      return { beforeRowId: before ? before.rowId : null, parentId, insertIdx };
    },
    [rowSlots, rows],
  );

  // 行 ID -> 扁平行序号的快速映射
  const rowIdxMap = useMemo(() => {
    const map = new Map<string, number>();
    flatTreeRows.forEach((item, idx) => {
      map.set(item.row.id, idx);
    });
    return map;
  }, [flatTreeRows]);

  // 列 ID -> 列序号的快速映射
  const colIdxMap = useMemo(() => {
    const map = new Map<string, number>();
    columns.forEach((col, idx) => {
      map.set(col.id, idx);
    });
    return map;
  }, [columns]);

  // 规整化选区矩形范围 (minRowIdx, maxRowIdx, minColIdx, maxColIdx)
  const normalizedSelection = useMemo(() => {
    if (selection.type === 'range') {
      const sRowIdx = rowIdxMap.get(selection.range.startRowId) ?? -1;
      const sColIdx = colIdxMap.get(selection.range.startColId) ?? -1;
      const eRowIdx = rowIdxMap.get(selection.range.endRowId) ?? -1;
      const eColIdx = colIdxMap.get(selection.range.endColId) ?? -1;
      if (sRowIdx < 0 || sColIdx < 0 || eRowIdx < 0 || eColIdx < 0) return null;

      const minRowIdx = Math.min(sRowIdx, eRowIdx);
      const maxRowIdx = Math.max(sRowIdx, eRowIdx);
      const minColIdx = Math.min(sColIdx, eColIdx);
      const maxColIdx = Math.max(sColIdx, eColIdx);

      const selectedRowIds: string[] = [];
      for (let r = minRowIdx; r <= maxRowIdx; r += 1) {
        if (flatTreeRows[r]) selectedRowIds.push(flatTreeRows[r].row.id);
      }
      const selectedColIds: string[] = [];
      for (let c = minColIdx; c <= maxColIdx; c += 1) {
        if (columns[c]) selectedColIds.push(columns[c].id);
      }

      return {
        minRowIdx,
        maxRowIdx,
        minColIdx,
        maxColIdx,
        anchorRowIdx: sRowIdx,
        anchorColIdx: sColIdx,
        selectedRowIds,
        selectedColIds,
        isSingleCell: minRowIdx === maxRowIdx && minColIdx === maxColIdx,
      };
    }

    if (selection.type === 'row') {
      const sRowIdx = rowIdxMap.get(selection.startRowId) ?? -1;
      const eRowIdx = selection.endRowId ? (rowIdxMap.get(selection.endRowId) ?? sRowIdx) : sRowIdx;
      if (sRowIdx < 0) return null;

      const minRowIdx = Math.min(sRowIdx, eRowIdx);
      const maxRowIdx = Math.max(sRowIdx, eRowIdx);
      const minColIdx = 0;
      const maxColIdx = columns.length - 1;

      const selectedRowIds: string[] = [];
      for (let r = minRowIdx; r <= maxRowIdx; r += 1) {
        if (flatTreeRows[r]) selectedRowIds.push(flatTreeRows[r].row.id);
      }

      return {
        minRowIdx,
        maxRowIdx,
        minColIdx,
        maxColIdx,
        anchorRowIdx: sRowIdx,
        anchorColIdx: 0,
        selectedRowIds,
        selectedColIds: columns.map((c) => c.id),
        isSingleCell: false,
      };
    }

    if (selection.type === 'col') {
      const sColIdx = colIdxMap.get(selection.startColId) ?? -1;
      const eColIdx = selection.endColId ? (colIdxMap.get(selection.endColId) ?? sColIdx) : sColIdx;
      if (sColIdx < 0) return null;

      const minRowIdx = 0;
      const maxRowIdx = flatTreeRows.length - 1;
      const minColIdx = Math.min(sColIdx, eColIdx);
      const maxColIdx = Math.max(sColIdx, eColIdx);

      const selectedColIds: string[] = [];
      for (let c = minColIdx; c <= maxColIdx; c += 1) {
        if (columns[c]) selectedColIds.push(columns[c].id);
      }

      return {
        minRowIdx,
        maxRowIdx,
        minColIdx,
        maxColIdx,
        anchorRowIdx: 0,
        anchorColIdx: sColIdx,
        selectedRowIds: flatTreeRows.map((n) => n.row.id),
        selectedColIds,
        isSingleCell: false,
      };
    }

    return null;
  }, [selection, rowIdxMap, colIdxMap, flatTreeRows, columns]);

  // 单元格鼠标按下：开始框选或 Shift 扩展选区
  const handleCellMouseDown = (e: React.MouseEvent, rowId: string, colId: string) => {
    if (e.button !== 0) return; // 仅左键处理框选
    const target = e.target as HTMLElement;
    if (target.closest('[data-fill-handle], [data-no-drag], input, textarea, button')) {
      return;
    }

    if (e.shiftKey && selection.type === 'range') {
      e.preventDefault();
      setSelection({
        type: 'range',
        range: {
          startRowId: selection.range.startRowId,
          startColId: selection.range.startColId,
          endRowId: rowId,
          endColId: colId,
        },
      });
      return;
    }

    isSelectingCellsRef.current = true;
    dragStartCellRef.current = { rowId, colId };
    setSelection({
      type: 'range',
      range: {
        startRowId: rowId,
        startColId: colId,
        endRowId: rowId,
        endColId: colId,
      },
    });
  };

  // 单元格鼠标悬停：拖拽框选中实时扩展焦点
  const handleCellMouseEnter = (rowId: string, colId: string) => {
    if (!isSelectingCellsRef.current || !dragStartCellRef.current) return;
    setSelection({
      type: 'range',
      range: {
        startRowId: dragStartCellRef.current.rowId,
        startColId: dragStartCellRef.current.colId,
        endRowId: rowId,
        endColId: colId,
      },
    });
  };

  // 单元格右键上下文菜单
  const handleCellContextMenu = (e: React.MouseEvent, rowId: string, colId: string) => {
    e.preventDefault();
    e.stopPropagation();

    const rIdx = rowIdxMap.get(rowId) ?? -1;
    const cIdx = colIdxMap.get(colId) ?? -1;
    const isInsideSelection =
      normalizedSelection &&
      rIdx >= normalizedSelection.minRowIdx &&
      rIdx <= normalizedSelection.maxRowIdx &&
      cIdx >= normalizedSelection.minColIdx &&
      cIdx <= normalizedSelection.maxColIdx;

    if (!isInsideSelection) {
      setSelection({
        type: 'range',
        range: {
          startRowId: rowId,
          startColId: colId,
          endRowId: rowId,
          endColId: colId,
        },
      });
    }

    setCellContextMenu({
      x: e.clientX,
      y: e.clientY,
      targetRowId: rowId,
      targetColId: colId,
    });
  };

  // 全局鼠标松开：结束矩形框选
  useEffect(() => {
    const handleGlobalMouseUp = () => {
      isSelectingCellsRef.current = false;
      dragStartCellRef.current = null;
    };
    window.addEventListener('mouseup', handleGlobalMouseUp);
    return () => window.removeEventListener('mouseup', handleGlobalMouseUp);
  }, []);

  // 右键菜单外部点击与 Escape 关闭
  useEffect(() => {
    if (!cellContextMenu) return;
    const handleClickOutside = () => setCellContextMenu(null);
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCellContextMenu(null);
    };
    window.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [cellContextMenu]);

  // 3. 剪贴板读写：统一通过隐藏代理输入框接收原生 copy / cut / paste 事件
  // 直接调用 navigator.clipboard.readText() 会触发浏览器的「是否允许粘贴」权限弹窗，
  // 且在 WebView 受限环境下经常静默失败；改为监听原生剪贴板事件后无需任何授权。

  /** 将当前选区序列化为可粘贴的 TSV 纯文本 */
  const buildClipboardPayload = useCallback((): string | null => {
    if (!normalizedSelection) return null;

    if (selection.type === 'range') {
      const lines: string[] = [];
      for (let r = normalizedSelection.minRowIdx; r <= normalizedSelection.maxRowIdx; r += 1) {
        const rowNode = flatTreeRows[r];
        if (!rowNode) continue;
        const rowCells: string[] = [];
        for (let c = normalizedSelection.minColIdx; c <= normalizedSelection.maxColIdx; c += 1) {
          const col = columns[c];
          if (!col) continue;
          rowCells.push(formatCellValue(col, rowNode.row[col.id]));
        }
        lines.push(rowCells.join('\t'));
      }
      return lines.join('\n');
    }

    if (selection.type === 'row') {
      const lines: string[] = [];
      for (let r = normalizedSelection.minRowIdx; r <= normalizedSelection.maxRowIdx; r += 1) {
        const rowNode = flatTreeRows[r];
        if (!rowNode) continue;
        lines.push(columns.map((c) => formatCellValue(c, rowNode.row[c.id])).join('\t'));
      }
      return lines.join('\n');
    }

    if (selection.type === 'col') {
      const lines: string[] = [];
      for (let r = 0; r < flatTreeRows.length; r += 1) {
        const rowNode = flatTreeRows[r];
        const rowCells: string[] = [];
        for (let c = normalizedSelection.minColIdx; c <= normalizedSelection.maxColIdx; c += 1) {
          const col = columns[c];
          rowCells.push(formatCellValue(col, rowNode.row[col.id]));
        }
        lines.push(rowCells.join('\t'));
      }
      return lines.join('\n');
    }

    return null;
  }, [normalizedSelection, selection.type, flatTreeRows, columns]);

  /** 剪切：内容写入剪贴板后清空选区数据 */
  const clearSelectedRange = useCallback(() => {
    if (!normalizedSelection) return;

    if (selection.type === 'range') {
      const updates: Array<{ rowId: string; colId: string; value: unknown }> = [];
      for (let r = normalizedSelection.minRowIdx; r <= normalizedSelection.maxRowIdx; r += 1) {
        const rowNode = flatTreeRows[r];
        if (!rowNode) continue;
        for (let c = normalizedSelection.minColIdx; c <= normalizedSelection.maxColIdx; c += 1) {
          const col = columns[c];
          if (!col) continue;
          updates.push({ rowId: rowNode.row.id, colId: col.id, value: null });
        }
      }
      if (onBatchUpdateCells) {
        onBatchUpdateCells(updates);
      } else {
        updates.forEach((u) => onUpdateRow(u.rowId, u.colId, null));
      }
      showToast(normalizedSelection.isSingleCell ? '已清空单元格' : '已清空选区数据');
      return;
    }

    if (selection.type === 'row') {
      for (let r = normalizedSelection.minRowIdx; r <= normalizedSelection.maxRowIdx; r += 1) {
        const rowNode = flatTreeRows[r];
        if (rowNode) onDeleteRow(rowNode.row.id);
      }
      setSelection({ type: 'none' });
      showToast('已删除选中行');
      return;
    }

    if (selection.type === 'col' && onClearColumn) {
      for (let c = normalizedSelection.minColIdx; c <= normalizedSelection.maxColIdx; c += 1) {
        const col = columns[c];
        if (col) onClearColumn(col.id);
      }
      showToast('已清空整列数据');
    }
  }, [
    normalizedSelection,
    selection.type,
    flatTreeRows,
    columns,
    onBatchUpdateCells,
    onUpdateRow,
    onDeleteRow,
    onClearColumn,
  ]);

  /** 粘贴：按选区类型把二维矩阵写入单元格 / 区域 / 整行 / 整列 */
  const applyPaste = useCallback(
    (text: string) => {
      const matrix = parseClipboardMatrix(text);
      if (!matrix.length || !normalizedSelection) {
        showToast('请先选中单元格后再粘贴');
        return;
      }

      const mRows = matrix.length;
      const mCols = matrix[0]?.length || 1;

      const selRows = normalizedSelection.maxRowIdx - normalizedSelection.minRowIdx + 1;
      const selCols = normalizedSelection.maxColIdx - normalizedSelection.minColIdx + 1;

      // 目标范围：如果是多选区域且大于粘贴矩阵，按 Excel 规则平铺/复制；如果是单格，按矩阵尺寸向右向下展开
      const targetRows = normalizedSelection.isSingleCell ? mRows : selRows;
      const targetCols = normalizedSelection.isSingleCell ? mCols : selCols;

      const finalMatrix = tileMatrix(matrix, targetRows, targetCols);

      const startRowIdx = normalizedSelection.minRowIdx;
      const startColIdx = normalizedSelection.minColIdx;

      const updates: Array<{ rowId: string; colId: string; value: unknown }> = [];
      const newRowsToAppend: BitableRow[] = [];

      finalMatrix.forEach((line, rOffset) => {
        const rIdx = startRowIdx + rOffset;
        let targetRowId: string;
        if (rIdx < flatTreeRows.length) {
          targetRowId = flatTreeRows[rIdx].row.id;
        } else {
          // 行数不足时新建行
          const anchorParentId = flatTreeRows[startRowIdx]?.row.parentId;
          const newRow = { ...createRow(columns), parentId: anchorParentId };
          newRowsToAppend.push(newRow);
          targetRowId = newRow.id;
        }

        line.forEach((val, cOffset) => {
          const cIdx = startColIdx + cOffset;
          if (cIdx >= columns.length) return;
          const col = columns[cIdx];
          updates.push({ rowId: targetRowId, colId: col.id, value: val });
        });
      });

      if (onBatchUpdateCells) {
        onBatchUpdateCells(updates, newRowsToAppend);
        showToast(updates.length > 1 ? '已粘贴区域数据' : '已粘贴数据');
      } else if (onPasteCells) {
        onPasteCells(flatTreeRows[startRowIdx].row.id, columns[startColIdx].id, matrix);
        showToast('已粘贴数据');
      } else {
        updates.forEach((u) => onUpdateRow(u.rowId, u.colId, u.value));
        showToast('已粘贴数据');
      }
    },
    [normalizedSelection, flatTreeRows, columns, onBatchUpdateCells, onPasteCells, onUpdateRow],
  );

  /** 智能自动补齐执行入口 */
  const applyAutoFill = useCallback(
    (
      range: {
        minRowIdx: number;
        maxRowIdx: number;
        minColIdx: number;
        maxColIdx: number;
      },
      preview: {
        direction: 'forward' | 'backward';
        axis: 'row' | 'col';
        fromRow: number;
        toRow: number;
        fromCol: number;
        toCol: number;
      },
    ) => {
      const updates: Array<{ rowId: string; colId: string; value: unknown }> = [];
      const newRowsToAppend: BitableRow[] = [];

      if (preview.axis === 'row') {
        const targetRowCount = preview.toRow - preview.fromRow + 1;
        if (targetRowCount <= 0) return;

        const targetRowIds: string[] = [];
        for (let r = preview.fromRow; r <= preview.toRow; r += 1) {
          if (r < flatTreeRows.length) {
            targetRowIds.push(flatTreeRows[r].row.id);
          } else {
            const anchorParentId = flatTreeRows[range.maxRowIdx]?.row.parentId;
            const newRow = { ...createRow(columns), parentId: anchorParentId };
            newRowsToAppend.push(newRow);
            targetRowIds.push(newRow.id);
          }
        }

        for (let c = range.minColIdx; c <= range.maxColIdx; c += 1) {
          const col = columns[c];
          if (!col) continue;

          const sourceValues: unknown[] = [];
          for (let r = range.minRowIdx; r <= range.maxRowIdx; r += 1) {
            sourceValues.push(flatTreeRows[r]?.row[col.id]);
          }

          const filledValues = calculateAutoFillValues(
            col,
            sourceValues,
            targetRowCount,
            preview.direction,
          );

          filledValues.forEach((val, idx) => {
            const rowId = targetRowIds[idx];
            if (rowId) {
              updates.push({ rowId, colId: col.id, value: val });
            }
          });
        }

        const newMinRow = Math.min(range.minRowIdx, preview.fromRow);
        const newMaxRow = Math.max(range.maxRowIdx, preview.toRow);
        const newStartRowId = flatTreeRows[newMinRow]?.row.id || targetRowIds[0];
        const newEndRowId =
          newMaxRow < flatTreeRows.length
            ? flatTreeRows[newMaxRow].row.id
            : targetRowIds[targetRowIds.length - 1];

        if (onBatchUpdateCells) {
          onBatchUpdateCells(updates, newRowsToAppend);
        } else {
          updates.forEach((u) => onUpdateRow(u.rowId, u.colId, u.value));
        }

        if (newStartRowId && newEndRowId) {
          setSelection({
            type: 'range',
            range: {
              startRowId: newStartRowId,
              startColId: columns[range.minColIdx].id,
              endRowId: newEndEndId(newEndRowId),
              endColId: columns[range.maxColIdx].id,
            },
          });
        }
        showToast('已自动填充数据');
      } else {
        const targetColCount = preview.toCol - preview.fromCol + 1;
        if (targetColCount <= 0) return;

        for (let r = range.minRowIdx; r <= range.maxRowIdx; r += 1) {
          const rowNode = flatTreeRows[r];
          if (!rowNode) continue;

          const sourceValues: unknown[] = [];
          for (let c = range.minColIdx; c <= range.maxColIdx; c += 1) {
            const col = columns[c];
            if (col) sourceValues.push(rowNode.row[col.id]);
          }

          for (let c = preview.fromCol; c <= preview.toCol; c += 1) {
            const targetCol = columns[c];
            if (!targetCol) continue;

            const offset = preview.direction === 'forward' ? c - preview.fromCol : preview.toCol - c;
            const filled = calculateAutoFillValues(targetCol, sourceValues, targetColCount, preview.direction);
            const val = filled[offset];
            updates.push({ rowId: rowNode.row.id, colId: targetCol.id, value: val });
          }
        }

        if (onBatchUpdateCells) {
          onBatchUpdateCells(updates);
        } else {
          updates.forEach((u) => onUpdateRow(u.rowId, u.colId, u.value));
        }

        const newMinCol = Math.min(range.minColIdx, preview.fromCol);
        const newMaxCol = Math.max(range.maxColIdx, preview.toCol);
        setSelection({
          type: 'range',
          range: {
            startRowId: flatTreeRows[range.minRowIdx].row.id,
            startColId: columns[newMinCol].id,
            endRowId: flatTreeRows[range.maxRowIdx].row.id,
            endColId: columns[newMaxCol].id,
          },
        });
        showToast('已自动填充数据');
      }
    },
    [flatTreeRows, columns, onBatchUpdateCells, onUpdateRow],
  );

  function newEndEndId(id: string): string {
    return id;
  }

  // 拖拽填充柄启动
  const startFillDrag = (e: React.MouseEvent, range: NonNullable<typeof normalizedSelection>) => {
    e.preventDefault();
    e.stopPropagation();

    const startMaxRow = range.maxRowIdx;
    const startMinRow = range.minRowIdx;
    const startMaxCol = range.maxColIdx;
    const startMinCol = range.minColIdx;

    let currentPreview: {
      direction: 'forward' | 'backward';
      axis: 'row' | 'col';
      fromRow: number;
      toRow: number;
      fromCol: number;
      toCol: number;
    } | null = null;

    const onMouseMove = (ev: MouseEvent) => {
      const target = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const td = target?.closest('td[data-cell-row-idx]') as HTMLTableCellElement | null;
      let hoverRow = startMaxRow;
      let hoverCol = startMaxCol;

      if (td) {
        const rStr = td.getAttribute('data-cell-row-idx');
        const cStr = td.getAttribute('data-cell-col-idx');
        if (rStr !== null) hoverRow = parseInt(rStr, 10);
        if (cStr !== null) hoverCol = parseInt(cStr, 10);
      } else {
        const tbody = tbodyRef.current;
        if (tbody) {
          const tbodyRect = tbody.getBoundingClientRect();
          if (ev.clientY > tbodyRect.bottom) {
            const extraRows = Math.floor((ev.clientY - tbodyRect.bottom) / 38) + 1;
            hoverRow = flatTreeRows.length - 1 + extraRows;
          }
        }
      }

      const dDown = hoverRow - startMaxRow;
      const dUp = startMinRow - hoverRow;
      const dRight = hoverCol - startMaxCol;
      const dLeft = startMinCol - hoverCol;

      const maxDelta = Math.max(dDown, dUp, dRight, dLeft);

      if (maxDelta <= 0) {
        currentPreview = null;
        setFillPreview(null);
        return;
      }

      if (maxDelta === dDown) {
        currentPreview = {
          direction: 'forward',
          axis: 'row',
          fromRow: startMaxRow + 1,
          toRow: hoverRow,
          fromCol: startMinCol,
          toCol: startMaxCol,
        };
      } else if (maxDelta === dUp) {
        currentPreview = {
          direction: 'backward',
          axis: 'row',
          fromRow: hoverRow,
          toRow: startMinRow - 1,
          fromCol: startMinCol,
          toCol: startMaxCol,
        };
      } else if (maxDelta === dRight) {
        currentPreview = {
          direction: 'forward',
          axis: 'col',
          fromRow: startMinRow,
          toRow: startMaxRow,
          fromCol: startMaxCol + 1,
          toCol: Math.min(columns.length - 1, hoverCol),
        };
      } else {
        currentPreview = {
          direction: 'backward',
          axis: 'col',
          fromRow: startMinRow,
          toRow: startMaxRow,
          fromCol: Math.max(0, hoverCol),
          toCol: startMinCol - 1,
        };
      }

      setFillPreview(currentPreview);
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      setFillPreview(null);

      if (!currentPreview) return;
      applyAutoFill(range, currentPreview);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // 双击填充柄：快速向下补齐至相邻列非空末尾
  const handleDoubleClickFill = (
    e: React.MouseEvent,
    range: NonNullable<typeof normalizedSelection>,
  ) => {
    e.preventDefault();
    e.stopPropagation();

    if (range.maxRowIdx >= flatTreeRows.length - 1) {
      showToast('已到达表格末尾');
      return;
    }

    let targetLastRowIdx = -1;
    const checkColIdxs = [range.minColIdx - 1, range.maxColIdx + 1].filter(
      (c) => c >= 0 && c < columns.length,
    );

    for (const cIdx of checkColIdxs) {
      const col = columns[cIdx];
      let lastFilledRow = range.maxRowIdx;
      for (let r = range.maxRowIdx + 1; r < flatTreeRows.length; r += 1) {
        const v = flatTreeRows[r].row[col.id];
        if (v !== null && v !== undefined && v !== '') {
          lastFilledRow = r;
        } else {
          break;
        }
      }
      if (lastFilledRow > targetLastRowIdx) {
        targetLastRowIdx = lastFilledRow;
      }
    }

    if (targetLastRowIdx <= range.maxRowIdx) {
      targetLastRowIdx = flatTreeRows.length - 1;
    }

    if (targetLastRowIdx <= range.maxRowIdx) {
      showToast('下方无更多行可填充');
      return;
    }

    const preview = {
      direction: 'forward' as const,
      axis: 'row' as const,
      fromRow: range.maxRowIdx + 1,
      toRow: targetLastRowIdx,
      fromCol: range.minColIdx,
      toCol: range.maxColIdx,
    };

    applyAutoFill(range, preview);
  };

  /**
   * 保持焦点停留在隐藏代理输入框上，使表格始终能接收到原生剪贴板事件
   * 正在输入（单元格编辑框 / 列重命名框）时不抢占焦点
   */
  const focusClipboardProxy = useCallback(() => {
    window.setTimeout(() => {
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== clipboardProxyRef.current && active !== document.body) {
        const tag = active.tagName.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || active.isContentEditable) return;
      }
      const proxy = clipboardProxyRef.current;
      if (!proxy) return;
      proxy.value = '';
      proxy.focus({ preventScroll: true });
    }, 0);
  }, []);

  // 选区变化后把焦点交还代理输入框，保证 Ctrl+C / Ctrl+X / Ctrl+V 始终有落点
  useEffect(() => {
    focusClipboardProxy();
  }, [selection, focusClipboardProxy]);

  // 3. 键盘快捷键监听（方向键导航与 Shift 扩展、Ctrl+A 全选、删除、清空、取消选区；复制/剪切/粘贴交由原生剪贴板事件处理）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 避免在单元格编辑框与列重命名框内触发表格级快捷键
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== clipboardProxyRef.current) {
        const tag = active.tagName.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || active.isContentEditable) {
          return;
        }
      }

      // Escape 取消选区与右键菜单
      if (e.key === 'Escape') {
        setSelection({ type: 'none' });
        setCellContextMenu(null);
        return;
      }

      // Ctrl + A / Meta + A 全选表格
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        if (flatTreeRows.length > 0 && columns.length > 0) {
          e.preventDefault();
          setSelection({
            type: 'range',
            range: {
              startRowId: flatTreeRows[0].row.id,
              startColId: columns[0].id,
              endRowId: flatTreeRows[flatTreeRows.length - 1].row.id,
              endColId: columns[columns.length - 1].id,
            },
          });
        }
        return;
      }

      // 方向键移动焦点或按住 Shift 扩展选区
      if (
        (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
        normalizedSelection
      ) {
        e.preventDefault();
        const currentEndRowIdx =
          selection.type === 'range'
            ? (rowIdxMap.get(selection.range.endRowId) ?? normalizedSelection.maxRowIdx)
            : normalizedSelection.maxRowIdx;
        const currentEndColIdx =
          selection.type === 'range'
            ? (colIdxMap.get(selection.range.endColId) ?? normalizedSelection.maxColIdx)
            : normalizedSelection.maxColIdx;

        let dRow = 0;
        let dCol = 0;
        if (e.key === 'ArrowUp') dRow = -1;
        if (e.key === 'ArrowDown') dRow = 1;
        if (e.key === 'ArrowLeft') dCol = -1;
        if (e.key === 'ArrowRight') dCol = 1;

        const nextRowIdx = Math.max(0, Math.min(flatTreeRows.length - 1, currentEndRowIdx + dRow));
        const nextColIdx = Math.max(0, Math.min(columns.length - 1, currentEndColIdx + dCol));
        const nextRowId = flatTreeRows[nextRowIdx]?.row.id;
        const nextColId = columns[nextColIdx]?.id;

        if (nextRowId && nextColId) {
          if (e.shiftKey && selection.type === 'range') {
            setSelection({
              type: 'range',
              range: {
                startRowId: selection.range.startRowId,
                startColId: selection.range.startColId,
                endRowId: nextRowId,
                endColId: nextColId,
              },
            });
          } else {
            setSelection({
              type: 'range',
              range: {
                startRowId: nextRowId,
                startColId: nextColId,
                endRowId: nextRowId,
                endColId: nextColId,
              },
            });
          }
        }
        return;
      }

      // Delete / Backspace 删除或清空
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        clearSelectedRange();
        return;
      }

      // Tab / Shift+Tab 快速调整行层级：Shift+Tab 升级为上一级，Tab 降级为子任务
      if (e.key === 'Tab') {
        if (normalizedSelection && (selection.type === 'row' || selection.type === 'range')) {
          e.preventDefault();
          const targetRowId =
            selection.type === 'row'
              ? selection.startRowId
              : selection.range.startRowId;
          if (e.shiftKey) {
            if (onOutdentRow) onOutdentRow(targetRowId);
          } else if (onIndentRow) {
            onIndentRow(targetRowId);
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    normalizedSelection,
    selection,
    flatTreeRows,
    columns,
    rowIdxMap,
    colIdxMap,
    clearSelectedRange,
    onOutdentRow,
    onIndentRow,
  ]);
  // 4. 拖拽调整列宽
  const handleResizeStart = (e: React.MouseEvent, col: BitableColumn) => {
    e.preventDefault();
    e.stopPropagation();
    resizingColRef.current = {
      colId: col.id,
      startX: e.clientX,
      startW: col.width || 160,
    };

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!resizingColRef.current) return;
      const delta = moveEvent.clientX - resizingColRef.current.startX;
      const newWidth = Math.max(90, resizingColRef.current.startW + delta);
      onUpdateColumn(resizingColRef.current.colId, { width: newWidth });
    };

    const handleMouseUp = () => {
      resizingColRef.current = null;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  // 5. 表头指针拖拽换列排序
  // 落点采用「插入槽位」语义（见 usePointerReorder）：指示线画在哪一列边缘，列就落到那个位置，
  // 彻底消除「鼠标停在这里、列却落到隔壁一位」的错位。
  const { drag: colDrag, startDrag: startColDrag, getIndicator: getColIndicator, grabOffset } =
    usePointerReorder<BitableColumn>({
      items: columns,
      getElement: (col) => headerCellRefs.current.get(col.id),
      onReorder: (fromIdx, toIdx) => onReorderColumns?.(fromIdx, toIdx),
      disabled: editingColNameId !== null,
      // 未产生位移即视为点击：单选 / 多选中列表头直接打开选项管理面板
      onTap: (colIdx) => {
        const col = columns[colIdx];
        const th = col ? headerCellRefs.current.get(col.id) : null;
        if (!col || !th) return;
        if (col.type !== 'select' && col.type !== 'multiSelect') return;
        const anchor = getAnchorRect(th);
        if (!anchor) return;
        setOptionsEditor((prev) =>
          prev?.colId === col.id ? null : { colId: col.id, anchor, trigger: th },
        );
      },
    });

  // 6. 拖拽行头换序
  // 前置条件：视图未设置排序规则——一旦排序生效，行序由排序结果决定，手动顺序会被立刻覆盖。
  // 无分组时整表可换序；有分组时落点被夹在本组内，跨组拖拽不改变分组归属。
  const rowDragEnabled = Boolean(onMoveRow) && sortRules.length === 0;

  const {
    drag: rowDrag,
    startDrag: startRowDrag,
    grabOffset: rowGrabOffset,
    consumeDraggedFlag: consumeRowDraggedFlag,
  } = usePointerReorder<RowSlot>({
    items: rowSlots,
    getElement: (slot) => rowRefs.current.get(slot.rowId),
    axis: 'y',
    disabled: !rowDragEnabled,
    // 把落点夹在本组范围内，越界时贴到组边界
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

  /**
   * 行落点指示线：返回值已按「顶边 / 底边」命名，避免与列拖拽的左右语义混淆
   * 分组视图下不使用 Hook 的通用实现：落点被夹到本组末尾时，通用实现会把
   * insertAt 当成「下一组首行的上边线」，指示线因此跑到下一组去。
   */
  const getRowIndicator = useCallback(
    (idx: number): 'top' | 'bottom' | null => {
      if (!rowDrag || !rowDrag.valid) return null;
      const { fromIdx, insertAt } = rowDrag;
      if (isSlotNoop(insertAt, fromIdx)) return null;
      if (insertAt === idx) return 'top';
      const slot = rowSlots[fromIdx];
      if (!slot) return null;
      // 组内末尾与全表末尾都落在「最后一行之下」，需在本行画底边线
      if (insertAt === slot.groupEnd && idx === slot.groupEnd - 1) return 'bottom';
      if (insertAt === rowSlots.length && idx === rowSlots.length - 1) return 'bottom';
      return null;
    },
    [rowDrag, rowSlots],
  );

  /** 行拖拽幽灵展示的主标题列：优先单行文本，其次多行文本，都没有则退回第一列 */
  const rowTitleCol = useMemo(
    () => columns.find((c) => c.type === 'text') || columns.find((c) => c.type === 'longText') || columns[0],
    [columns],
  );

  const resolveRowTitle = useCallback(
    (rowId: string) => {
      const row = rowById.get(rowId);
      if (!row || !rowTitleCol) return '未命名记录';
      const val = row[rowTitleCol.id];
      if (val === undefined || val === null || String(val).trim() === '') return '未命名记录';
      if (rowTitleCol.type === 'longText') {
        return previewLongText(String(val), resolveLongTextConfig(rowTitleCol)) || '未命名记录';
      }
      return String(val);
    },
    [rowById, rowTitleCol],
  );

  /**
   * 行落点的最终序号（从 1 起）
   * 以「剔除自身子树后的可见序列」为基准计数，分组视图下再折算为组内序号，
   * 与用户「在这一组里挪到第几位」的心理预期一致。
   */
  const rowDropPosition = useMemo(() => {
    if (!rowDrag) return 0;
    const target = resolveRowDropTarget(rowDrag.fromIdx, slotToSpliceIndex(rowDrag.insertAt, rowDrag.fromIdx));
    if (!target) return 0;
    const offset = rowSlots[rowDrag.fromIdx]?.groupStart ?? 0;
    return target.insertIdx - offset + 1;
  }, [rowDrag, rowSlots, resolveRowDropTarget]);

  /**
   * 是否存在「全显示」模式的多行文本列
   * 存在时行高必须交给内容决定：若继续锁死 38px，超出的内容会被裁掉，
   * 「全显示」就名不副实。其余列仍按固定行高垂直居中。
   */
  const hasFullLongTextColumn = useMemo(
    () =>
      columns.some(
        (c) => c.type === 'longText' && resolveLongTextConfig(c).displayMode === 'full',
      ),
    [columns],
  );

  /** 拖拽幽灵宽度与被拖列一致，视觉上等同于「整列被拎起来」 */
  const colDragWidth = useMemo(() => {
    if (!colDrag) return undefined;
    const col = columns[colDrag.fromIdx];
    return col ? headerCellRefs.current.get(col.id)?.getBoundingClientRect().width : undefined;
  }, [colDrag, columns]);


  // 代理输入框持有焦点后浏览器不再自动滚动表格，这里手工转发滚动键
  const handleProxyKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const lineHeight = 40;
    const page = container.clientHeight * 0.9;
    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        container.scrollTop -= lineHeight;
        break;
      case 'ArrowDown':
        e.preventDefault();
        container.scrollTop += lineHeight;
        break;
      case 'ArrowLeft':
        e.preventDefault();
        container.scrollLeft -= lineHeight;
        break;
      case 'ArrowRight':
        e.preventDefault();
        container.scrollLeft += lineHeight;
        break;
      case 'PageUp':
        e.preventDefault();
        container.scrollTop -= page;
        break;
      case 'PageDown':
        e.preventDefault();
        container.scrollTop += page;
        break;
      case 'Home':
        e.preventDefault();
        container.scrollTop = 0;
        break;
      case 'End':
        e.preventDefault();
        container.scrollTop = container.scrollHeight;
        break;
      default:
        break;
    }
  };

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: 'var(--editor-bg, #ffffff)',
        // 拖拽换列 / 换行期间禁用文本选中，避免拖出蓝色选区
        userSelect: colDrag || rowDrag ? 'none' : undefined,
      }}
      onClick={(e) => {
        // 点击空白处取消菜单并把焦点交还剪贴板代理
        closeColumnMenu();
        if (e.target === e.currentTarget) {
          setSelection({ type: 'none' });
        }
        focusClipboardProxy();
      }}
    >
      {/* 隐藏剪贴板代理输入框：承载原生 copy / cut / paste 事件，避免剪贴板读权限弹窗 */}
      <textarea
        ref={clipboardProxyRef}
        aria-hidden
        tabIndex={-1}
        onCopy={(e) => {
          const payload = buildClipboardPayload();
          if (payload === null) return;
          e.clipboardData.setData('text/plain', payload);
          e.preventDefault();
          showToast(
            normalizedSelection?.isSingleCell
              ? '已复制单元格数据'
              : selection.type === 'row'
                ? '已复制整行数据'
                : selection.type === 'col'
                  ? '已复制整列数据'
                  : '已复制选区数据',
          );
        }}
        onCut={(e) => {
          const payload = buildClipboardPayload();
          if (payload === null) return;
          e.clipboardData.setData('text/plain', payload);
          e.preventDefault();
          clearSelectedRange();
        }}
        onPaste={(e) => {
          const text = e.clipboardData.getData('text/plain');
          e.preventDefault();
          applyPaste(text);
        }}
        onKeyDown={handleProxyKeyDown}
        onInput={(e) => {
          // 代理框只用于承载剪贴板事件，任何键入内容立即清空
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
      {/* 表格视图工具栏：分组依据 + 多字段排序入口 */}
      {onUpdateGroupByColumnId && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '6px 12px',
            borderBottom: '1px solid var(--editor-border, #e2e8f0)',
            background: 'var(--editor-surface, #f8fafc)',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <SlidersHorizontal size={13} color="var(--editor-text-muted, #64748b)" />
            <span style={{ fontSize: 12, color: 'var(--editor-text-muted, #64748b)' }}>分组依据</span>
            <FieldSelectButton
              columns={columns}
              value={groupByColumnId || null}
              placeholder="不分组"
              onChange={(colId) => onUpdateGroupByColumnId && onUpdateGroupByColumnId(colId || '')}
              width={150}
            />
            {groupByColumnId && (
              <button
                type="button"
                className="nb-bitable-btn-ghost"
                onClick={() => onUpdateGroupByColumnId && onUpdateGroupByColumnId('')}
                style={{
                  gap: 4,
                  padding: '2px 6px',
                  fontSize: 11,
                }}
              >
                <X size={11} />
                <span>清除分组</span>
              </button>
            )}
          </div>

          <div style={{ width: 1, height: 16, background: 'var(--editor-border, #e2e8f0)' }} />

          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              type="button"
              ref={(el) => { if (el) sortButtonRef.current = el; }}
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
            {sortRules.length > 0 && (
              <button
                type="button"
                className="nb-bitable-btn-ghost"
                onClick={() => onUpdateSortRules && onUpdateSortRules([])}
                style={{
                  gap: 4,
                  padding: '2px 6px',
                  fontSize: 11,
                }}
              >
                <X size={11} />
                <span>清除排序</span>
              </button>
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
        </div>
      )}

      {/* 表格主体滚动区：水平滚动仅发生在此区域内 */}
      <div
        ref={scrollContainerRef}
        style={{
          flex: 1,
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column',
        }}
        onClick={(e) => {
          // 点击滚动区空白处（非表格单元格）取消当前选区
          if (e.target === e.currentTarget) {
            setSelection({ type: 'none' });
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
        {/* 表头 */}
        <thead>
          <tr style={{ background: 'var(--editor-surface, #f8fafc)', height: 36 }}>
            {/* 序号列头 */}
            <th
              style={{
                width: 50,
                minWidth: 50,
                maxWidth: 50,
                position: 'sticky',
                left: 0,
                top: 0,
                zIndex: 10,
                background: 'var(--editor-surface, #f8fafc)',
                borderBottom: '1px solid var(--editor-border, #e2e8f0)',
                borderRight: '1px solid var(--editor-border, #e2e8f0)',
                fontSize: 12,
                color: 'var(--editor-text-muted, #94a3b8)',
                textAlign: 'center',
                fontWeight: 500,
                userSelect: 'none',
              }}
            >
              #
            </th>

            {/* 各业务数据列头 (支持拖拽排序、列宽拖拽、列头菜单、专有格式排序) */}
            {columns.map((col, colIdx) => {
              const meta = getFieldTypeMeta(col.type);
              const isMenuOpen = columnMenu?.colId === col.id;
              const isColSelected =
                normalizedSelection !== null &&
                selection.type === 'col' &&
                colIdx >= normalizedSelection.minColIdx &&
                colIdx <= normalizedSelection.maxColIdx;
              const sortRuleForCol = sortRules.find((r) => r.columnId === col.id);
              const sortPriority = sortRuleForCol ? sortRules.findIndex((r) => r.columnId === col.id) + 1 : null;
              const isOptionField = col.type === 'select' || col.type === 'multiSelect';

              // 落点指示线：槽位落在自身左侧时画左边缘线，落到末位时画最后一列右边缘线
              const indicatorSide = getColIndicator(colIdx);
              const dropIndicator =
                indicatorSide === 'left'
                  ? 'inset 3px 0 0 #3b82f6'
                  : indicatorSide === 'right'
                    ? 'inset -3px 0 0 #3b82f6'
                    : undefined;

              return (
                <th
                  key={col.id}
                  ref={(el) => {
                    if (el) headerCellRefs.current.set(col.id, el);
                    else headerCellRefs.current.delete(col.id);
                  }}
                  onMouseDown={(e) => startColDrag(e, colIdx)}
                  onClick={(e) => {
                    if (e.shiftKey && selection.type === 'col') {
                      setSelection({
                        type: 'col',
                        startColId: selection.startColId,
                        endColId: col.id,
                      });
                    } else {
                      setSelection({ type: 'col', startColId: col.id, endColId: col.id });
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!isColSelected) {
                      setSelection({ type: 'col', startColId: col.id, endColId: col.id });
                    }
                    setCellContextMenu({
                      x: e.clientX,
                      y: e.clientY,
                      targetRowId: flatTreeRows[0]?.row.id || '',
                      targetColId: col.id,
                    });
                  }}
                  style={{
                    width: col.width || 160,
                    minWidth: 90,
                    position: 'sticky',
                    top: 0,
                    zIndex: 5,
                    background:
                      colDrag?.fromIdx === colIdx
                        ? 'rgba(59, 130, 246, 0.16)'
                        : isColSelected
                          ? 'rgba(59, 130, 246, 0.12)'
                          : 'var(--editor-surface, #f8fafc)',
                    borderBottom: '1px solid var(--editor-border, #e2e8f0)',
                    borderRight: '1px solid var(--editor-border, #e2e8f0)',
                    boxShadow: dropIndicator,
                    padding: '4px 8px',
                    textAlign: 'left',
                    fontWeight: 600,
                    fontSize: 12,
                    color: 'var(--editor-text, #1e293b)',
                    userSelect: 'none',
                    cursor: colDrag ? 'grabbing' : 'grab',
                    transition: 'background 0.15s ease',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'relative' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, overflow: 'hidden' }}>
                      {meta.icon}
                      {editingColNameId === col.id ? (
                        <input
                          type="text"
                          data-no-drag
                          value={colNameInput}
                          autoFocus
                          onChange={(e) => setColNameInput(e.target.value)}
                          onBlur={() => {
                            if (colNameInput.trim()) {
                              onUpdateColumn(col.id, { name: colNameInput.trim() });
                            }
                            setEditingColNameId(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              if (colNameInput.trim()) {
                                onUpdateColumn(col.id, { name: colNameInput.trim() });
                              }
                              setEditingColNameId(null);
                            } else if (e.key === 'Escape') {
                              setEditingColNameId(null);
                            }
                          }}
                          onClick={(e) => e.stopPropagation()}
                          style={{
                            width: '100%',
                            fontSize: 12,
                            padding: '1px 4px',
                            border: '1px solid var(--editor-accent, #3b82f6)',
                            borderRadius: 3,
                            outline: 'none',
                          }}
                        />
                      ) : (
                        <Tooltip content={isOptionField ? '单击编辑选项 · 拖拽换列 · 双击名称重命名' : '拖拽表头可换列 · 双击名称重命名'} disabled={Boolean(colDrag)} side="bottom" sideOffset={4}>
                          <span
                            onDoubleClick={(e) => {
                              e.stopPropagation();
                              setColNameInput(col.name);
                              setEditingColNameId(col.id);
                            }}
                            style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}
                          >
                            {col.name}
                          </span>
                        </Tooltip>
                      )}

                      {/* 排序状态指示图标：多字段时显示优先级角标 */}
                      {sortRuleForCol && (
                        <Tooltip content={`第 ${sortPriority} 排序字段 · ${sortRuleForCol.direction === 'asc' ? '升序' : '降序'}`} side="top" sideOffset={4}>
                          <span
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 2,
                              color: 'var(--editor-accent, #3b82f6)',
                              fontSize: 10,
                            }}
                          >
                            {sortRuleForCol.direction === 'asc' ? <ArrowUpNarrowWide size={13} /> : <ArrowDownWideNarrow size={13} />}
                            {sortRules.length > 1 && sortPriority}
                          </span>
                        </Tooltip>
                      )}
                    </div>

                    {/* 列操作菜单唤起按钮 */}
                    <Tooltip content="字段配置与操作" side="bottom" sideOffset={4}>
                      <button
                        type="button"
                        data-no-drag
                        className="nb-bitable-btn-ghost"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isMenuOpen) {
                            closeColumnMenu();
                            return;
                          }
                          const anchor = getAnchorRect(headerCellRefs.current.get(col.id));
                          if (anchor) {
                            setColumnMenu({
                              colId: col.id,
                              anchor,
                              trigger: e.currentTarget as HTMLElement,
                            });
                          }
                        }}
                        style={{
                          padding: '2px',
                          background: isMenuOpen ? 'var(--editor-bg, #f1f5f9)' : undefined,
                        }}
                        aria-label="字段配置与操作"
                      >
                        <MoreHorizontal size={13} />
                      </button>
                    </Tooltip>

                    {/* 拖拽列宽调整把手 */}
                    <div
                      data-no-drag
                      onMouseDown={(e) => handleResizeStart(e, col)}
                      style={{
                        position: 'absolute',
                        right: -8,
                        top: -4,
                        bottom: -4,
                        width: 6,
                        cursor: 'col-resize',
                        zIndex: 10,
                      }}
                    />

                    {/* 列配置浮动菜单（Portal 渲染，避免被滚动容器裁剪；宽度设为 240px 保证中文日期/时间格式单行完整展示） */}
                    {isMenuOpen && columnMenu && (
                      <FloatingPanel
                        anchor={columnMenu.anchor}
                        trigger={columnMenu.trigger}
                        width={240}
                        gap={1}
                        align="right"
                        // 菜单整体滚动会让二级菜单与一级项错位，滚动即收起
                        onScroll={() => setDatetimeSubmenu(null)}
                        onClose={() => closeColumnMenu()}
                      >
                        <button
                          type="button"
                          className="nb-bitable-menu-item"
                          onClick={() => {
                            setColNameInput(col.name);
                            setEditingColNameId(col.id);
                            closeColumnMenu();
                          }}
                        >
                          <Edit2 size={13} />
                          <span>重命名列</span>
                        </button>

                        {/* 单选 / 多选中列表头：直接进入选项管理 */}
                        {isOptionField && (
                          <button
                            type="button"
                            className="nb-bitable-menu-item"
                            onClick={() => {
                              const anchor = getAnchorRect(headerCellRefs.current.get(col.id));
                              const th = headerCellRefs.current.get(col.id);
                              if (anchor && th) {
                                setOptionsEditor({ colId: col.id, anchor, trigger: th });
                              }
                              closeColumnMenu();
                            }}
                          >
                            {col.type === 'select' ? <Tag size={13} /> : <Tags size={13} />}
                            <span>编辑标签选项</span>
                          </button>
                        )}

                        <div style={{ height: 1, background: 'var(--editor-border, #f1f5f9)', margin: '3px 0' }} />

                        {/* 移动列位置 (向左移动 / 向右移动) */}
                        {onMoveColumn && (
                          <>
                            <div style={{ display: 'flex', gap: 4 }}>
                              <button
                                type="button"
                                disabled={colIdx === 0}
                                className="nb-bitable-btn-secondary"
                                onClick={() => {
                                  onMoveColumn(col.id, 'left');
                                  closeColumnMenu();
                                }}
                                style={{
                                  flex: 1,
                                  gap: 4,
                                  padding: '5px 6px',
                                  fontSize: 11,
                                  opacity: colIdx === 0 ? 0.4 : 1,
                                }}
                              >
                                <MoveLeft size={12} />
                                <span>向左移动</span>
                              </button>

                              <button
                                type="button"
                                disabled={colIdx === columns.length - 1}
                                className="nb-bitable-btn-secondary"
                                onClick={() => {
                                  onMoveColumn(col.id, 'right');
                                  closeColumnMenu();
                                }}
                                style={{
                                  flex: 1,
                                  gap: 4,
                                  padding: '5px 6px',
                                  fontSize: 11,
                                  opacity: colIdx === columns.length - 1 ? 0.4 : 1,
                                }}
                              >
                                <MoveRight size={12} />
                                <span>向右移动</span>
                              </button>
                            </div>
                            <div style={{ height: 1, background: 'var(--editor-border, #f1f5f9)', margin: '3px 0' }} />
                          </>
                        )}

                        {/* 多行文本专有的显示与格式配置（列级设置，对该列所有单元格生效） */}
                        {col.type === 'longText' && (() => {
                          const ltConfig = resolveLongTextConfig(col);
                          return (
                            <>
                              <div style={{ height: 1, background: 'var(--editor-border, #f1f5f9)', margin: '3px 0' }} />
                              <div style={{ padding: '2px 8px', fontSize: 10, color: 'var(--editor-text-muted, #94a3b8)' }}>
                                显示模式
                              </div>
                              <div style={{ display: 'flex', gap: 4 }}>
                                {DISPLAY_MODE_OPTIONS.map((opt) => {
                                  const active = ltConfig.displayMode === opt.id;
                                  return (
                                    <Tooltip key={opt.id} content={opt.hint} side="top" sideOffset={4}>
                                      <button
                                        type="button"
                                        className={active ? 'nb-bitable-btn-primary' : 'nb-bitable-btn-secondary'}
                                        onClick={() => {
                                          onUpdateColumn(col.id, {
                                            longText: { ...ltConfig, displayMode: opt.id },
                                          });
                                          closeColumnMenu();
                                        }}
                                        style={{
                                          flex: 1,
                                          padding: '4px 6px',
                                          fontSize: 11,
                                          fontWeight: active ? 600 : 400,
                                        }}
                                      >
                                        {opt.label}
                                      </button>
                                    </Tooltip>
                                  );
                                })}
                              </div>

                              <Tooltip content="开启后以富文本方式编辑与渲染，支持加粗、代码块等 Markdown 语法" side="bottom" sideOffset={4}>
                                <button
                                  type="button"
                                  className="nb-bitable-menu-item"
                                  onClick={() => {
                                    onUpdateColumn(col.id, {
                                      longText: { ...ltConfig, markdown: !ltConfig.markdown },
                                    });
                                    closeColumnMenu();
                                  }}
                                  style={{
                                    fontSize: 11,
                                    color: ltConfig.markdown ? 'var(--editor-accent, #3b82f6)' : undefined,
                                  }}
                                >
                                <span
                                  style={{
                                    width: 12,
                                    height: 12,
                                    borderRadius: 3,
                                    border: ltConfig.markdown
                                      ? 'none'
                                      : '1.5px solid var(--editor-border, #cbd5e1)',
                                    background: ltConfig.markdown ? 'var(--editor-accent, #3b82f6)' : 'transparent',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    color: '#ffffff',
                                    flexShrink: 0,
                                  }}
                                >
                                  {ltConfig.markdown && <Check size={10} strokeWidth={3.5} />}
                                </span>
                                <span>Markdown 富文本</span>
                              </button>
                            </Tooltip>
                          </>
                          );
                        })()}

                        {/* 日期时间字段专有的显示格式（列级设置，对该列所有单元格生效） */}
                        {isDateTimeFieldType(col.type) && (() => {
                          const dtConfig = resolveDateTimeConfig(col);
                          const showDateFormat = col.type === 'date' || col.type === 'dateTime';
                          const showTimeFormat = col.type === 'time' || col.type === 'dateTime';
                          return (
                            <>
                              <div style={{ height: 1, background: 'var(--editor-border, #f1f5f9)', margin: '3px 0' }} />
                              {showDateFormat && (
                                <>
                                  <div style={{ padding: '2px 8px', fontSize: 10, color: 'var(--editor-text-muted, #94a3b8)' }}>
                                    日期格式
                                  </div>
                                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                                    {DATE_FORMAT_OPTIONS.map((opt) => {
                                      const active = dtConfig.dateFormat === opt.id;
                                      return (
                                        <Tooltip key={opt.id} content={opt.label} side="top" sideOffset={4}>
                                          <button
                                            type="button"
                                            className={active ? 'nb-bitable-btn-primary' : 'nb-bitable-btn-secondary'}
                                            onClick={() => {
                                              onUpdateColumn(col.id, {
                                                dateTime: { ...dtConfig, dateFormat: opt.id },
                                              });
                                              closeColumnMenu();
                                            }}
                                            style={{
                                              padding: '4px 5px',
                                              fontSize: 11,
                                              fontWeight: active ? 600 : 400,
                                              whiteSpace: 'nowrap',
                                            }}
                                          >
                                            {opt.sample}
                                          </button>
                                        </Tooltip>
                                      );
                                    })}
                                  </div>
                                </>
                              )}

                              {showTimeFormat && (
                                <>
                                  <div style={{ padding: '2px 8px', fontSize: 10, color: 'var(--editor-text-muted, #94a3b8)' }}>
                                    时间格式
                                  </div>
                                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                                    {TIME_FORMAT_OPTIONS.map((opt) => {
                                      const active = dtConfig.timeFormat === opt.id;
                                      return (
                                        <Tooltip key={opt.id} content={opt.label} side="top" sideOffset={4}>
                                          <button
                                            type="button"
                                            className={active ? 'nb-bitable-btn-primary' : 'nb-bitable-btn-secondary'}
                                            onClick={() => {
                                              onUpdateColumn(col.id, {
                                                dateTime: { ...dtConfig, timeFormat: opt.id },
                                              });
                                              closeColumnMenu();
                                            }}
                                            style={{
                                              padding: '4px 5px',
                                              fontSize: 11,
                                              fontWeight: active ? 600 : 400,
                                              whiteSpace: 'nowrap',
                                            }}
                                          >
                                            {opt.sample}
                                          </button>
                                        </Tooltip>
                                      );
                                    })}
                                  </div>
                                </>
                              )}
                            </>
                          );
                        })()}

                        {/* 修改字段类型列表 */}
                        <div style={{ padding: '2px 8px', fontSize: 10, color: 'var(--editor-text-muted, #94a3b8)' }}>
                          更改字段类型
                        </div>
                        <div
                          // 列表滚动会让一级项与右侧二级菜单错位，滚动时直接收起二级菜单
                          onScroll={() => setDatetimeSubmenu(null)}
                          style={{ maxHeight: 160, overflowY: 'auto' }}
                        >
                          {ALL_FIELD_TYPES.map((t) => {
                            const tMeta = getFieldTypeMeta(t);
                            const isCurrent = col.type === t;
                            return (
                              <button
                                key={t}
                                type="button"
                                className="nb-bitable-menu-item"
                                // 鼠标移到别的类型项上时收起二级菜单，避免残留一个孤儿浮层
                                onMouseEnter={() => setDatetimeSubmenu(null)}
                                onClick={() => {
                                  onUpdateColumn(col.id, buildFieldTypePatch(col, t));
                                  closeColumnMenu();
                                }}
                                style={{
                                  background: isCurrent ? 'var(--editor-bg, #f1f5f9)' : undefined,
                                  fontSize: 11,
                                }}
                              >
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  {tMeta.icon}
                                  <span>{tMeta.label}</span>
                                </div>
                              </button>
                            );
                          })}

                          {/* 日期与时间：一级项，悬停或点击在其右侧延伸出二级菜单 */}
                          <button
                            ref={datetimeItemRef}
                            type="button"
                            className={[
                              'nb-bitable-menu-item',
                              'has-submenu',
                              datetimeSubmenu ? 'is-submenu-open' : '',
                            ].filter(Boolean).join(' ')}
                            // 桌面端级联菜单用 hover 打开最顺手；click 作为兜底，触屏不是主场景
                            onMouseEnter={openDatetimeSubmenu}
                            onClick={(e) => {
                              e.stopPropagation();
                              openDatetimeSubmenu();
                            }}
                            style={{
                              background:
                                isDateTimeFieldType(col.type) && !datetimeSubmenu
                                  ? 'var(--editor-bg, #f1f5f9)'
                                  : undefined,
                              fontSize: 11,
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <CalendarClock size={13} color="#f59e0b" />
                              <span>日期与时间</span>
                            </div>
                            <ChevronRight size={12} style={{ opacity: 0.55, flexShrink: 0 }} />
                          </button>
                        </div>

                        {/* 二级菜单：从一级项右侧延伸；贴边时由 FloatingPanel 自动翻向左侧 */}
                        {datetimeSubmenu && (
                          <FloatingPanel
                            anchor={datetimeSubmenu.anchor}
                            trigger={datetimeSubmenu.trigger}
                            placement="side"
                            width={150}
                            gap={2}
                            onClose={() => setDatetimeSubmenu(null)}
                          >
                            {DATETIME_FIELD_TYPES.map((t) => {
                              const tMeta = getFieldTypeMeta(t);
                              const isCurrent = col.type === t;
                              return (
                                <button
                                  key={t}
                                  type="button"
                                  className="nb-bitable-menu-item"
                                  onClick={() => {
                                    onUpdateColumn(col.id, buildFieldTypePatch(col, t));
                                    closeColumnMenu();
                                  }}
                                  style={{
                                    background: isCurrent ? 'var(--editor-bg, #f1f5f9)' : undefined,
                                    fontSize: 11,
                                  }}
                                >
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                    {tMeta.icon}
                                    <span>{tMeta.label}</span>
                                  </div>
                                </button>
                              );
                            })}
                          </FloatingPanel>
                        )}

                        <div style={{ height: 1, background: 'var(--editor-border, #f1f5f9)', margin: '3px 0' }} />

                        <button
                          type="button"
                          className="nb-bitable-menu-item"
                          onClick={() => {
                            onAddColumn('left', col.id);
                            closeColumnMenu();
                          }}
                          style={{ fontSize: 11 }}
                        >
                          <ArrowLeft size={12} />
                          <span>在左侧插入列</span>
                        </button>

                        <button
                          type="button"
                          className="nb-bitable-menu-item"
                          onClick={() => {
                            onAddColumn('right', col.id);
                            closeColumnMenu();
                          }}
                          style={{ fontSize: 11 }}
                        >
                          <ArrowRight size={12} />
                          <span>在右侧插入列</span>
                        </button>

                        {onClearColumn && (
                          <button
                            type="button"
                            className="nb-bitable-menu-item"
                            onClick={() => {
                              onClearColumn(col.id);
                              closeColumnMenu();
                              showToast('已清空该列所有数据');
                            }}
                            style={{ fontSize: 11, color: 'var(--editor-text-muted, #64748b)' }}
                          >
                            <Eraser size={12} />
                            <span>清空此列数据</span>
                          </button>
                        )}

                        <div style={{ height: 1, background: 'var(--editor-border, #f1f5f9)', margin: '3px 0' }} />

                        <button
                          type="button"
                          className="nb-bitable-btn-danger"
                          style={{ width: '100%', justifyContent: 'flex-start' }}
                          onClick={() => {
                            onDeleteColumn(col.id);
                            closeColumnMenu();
                          }}
                        >
                          <Trash2 size={14} />
                          <span>删除此列</span>
                        </button>
                      </FloatingPanel>
                    )}
                  </div>
                </th>
              );
            })}

            {/* 新增列按钮表头 */}
            <th
              style={{
                width: 44,
                minWidth: 44,
                position: 'sticky',
                top: 0,
                zIndex: 5,
                background: 'var(--editor-surface, #f8fafc)',
                borderBottom: '1px solid var(--editor-border, #e2e8f0)',
                padding: '4px',
                textAlign: 'center',
              }}
            >
              <Tooltip content="添加新列" side="bottom" sideOffset={4}>
                <button
                  type="button"
                  className="nb-bitable-btn-ghost"
                  onClick={() => onAddColumn('right')}
                  aria-label="添加新列"
                  style={{ padding: '4px' }}
                >
                  <Plus size={14} />
                </button>
              </Tooltip>
            </th>
          </tr>
        </thead>

        {/* 表格记录行内容 (树形子任务、分组标题与选区渲染) */}
        <tbody ref={tbodyRef}>
          {gridItems.map((item, itemIndex) => {
            // 分组标题行：显示分组名称与记录数，支持展开/折叠与组间间距
            if (item.type === 'group') {
              const isCollapsed = collapsedGroupKeys.has(item.key);
              const isFirstGroup = itemIndex === 0 || !gridItems.slice(0, itemIndex).some((i) => i.type === 'group');
              return (
                <React.Fragment key={`group-${item.key}`}>
                  {!isFirstGroup && (
                    <tr aria-hidden="true" style={{ height: 10 }}>
                      <td
                        colSpan={columns.length + 2}
                        style={{
                          border: 'none',
                          padding: 0,
                          background: 'transparent',
                        }}
                      />
                    </tr>
                  )}
                  <tr
                    style={{
                      height: 36,
                      background: 'var(--editor-surface, #f8fafc)',
                    }}
                  >
                    <td
                      colSpan={columns.length + 2}
                      onClick={() => toggleGroupCollapse(item.key)}
                      style={{
                        borderBottom: '1px solid var(--editor-border, #e2e8f0)',
                        borderTop: isFirstGroup ? '1px solid var(--editor-border, #e2e8f0)' : undefined,
                        padding: '0 12px',
                        cursor: 'pointer',
                        background: 'var(--editor-surface, #f8fafc)',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          height: '100%',
                        }}
                      >
                        <button
                          type="button"
                          className="nb-bitable-btn-ghost"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleGroupCollapse(item.key);
                          }}
                          style={{
                            padding: 2,
                            color: 'var(--editor-text-muted, #64748b)',
                          }}
                        >
                          {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                        </button>

                        {item.color ? (
                          <OptionBadge option={{ id: item.key, label: item.label, color: item.color }} />
                        ) : (
                          <span
                            style={{
                              fontSize: 12,
                              fontWeight: 600,
                              color: 'var(--editor-text, #1e293b)',
                            }}
                          >
                            {item.label}
                          </span>
                        )}

                        <span
                          style={{
                            fontSize: 12,
                            color: 'var(--editor-text-muted, #94a3b8)',
                          }}
                        >
                          总数 {item.count}
                        </span>
                      </div>
                    </td>
                  </tr>
                </React.Fragment>
              );
            }

            const { row, depth, hasChildren, isCollapsed, rowNumber } = item.treeNode;
            const rowSlotIdx = rowSlotIndex.get(row.id) ?? -1;
            const rIdx = rowSlotIdx >= 0 ? rowSlotIdx : (rowIdxMap.get(row.id) ?? -1);
            const isRowSelected =
              normalizedSelection !== null &&
              selection.type === 'row' &&
              rIdx >= normalizedSelection.minRowIdx &&
              rIdx <= normalizedSelection.maxRowIdx;
            const isRowDragging = rowDrag?.fromIdx === rowSlotIdx;

            // 落点指示线：槽位落在本行上方画顶边线，落到末行之后画底边线
            const rowIndicator = rowSlotIdx >= 0 ? getRowIndicator(rowSlotIdx) : null;
            // 把指示线画在每个单元格上而不是 tr 上：tr 的 box-shadow 在浏览器中渲染不可靠
            // （容易被 td 背景盖住、且部分浏览器直接忽略 tr 的 box-shadow）
            const rowDropShadow =
              rowIndicator === 'top'
                ? 'inset 0 2px 0 #3b82f6'
                : rowIndicator === 'bottom'
                  ? 'inset 0 -2px 0 #3b82f6'
                  : undefined;

            return (
              <tr
                key={row.id}
                ref={(el) => {
                  if (el) rowRefs.current.set(row.id, el);
                  else rowRefs.current.delete(row.id);
                }}
                style={{
                  // 存在全显示多行文本列时，height 退化为最小高度，实际行高由内容撑开
                  height: hasFullLongTextColumn ? undefined : 38,
                  minHeight: 38,
                  background: isRowSelected ? 'rgba(59, 130, 246, 0.08)' : 'var(--editor-surface, #ffffff)',
                  transition: 'background var(--transition-fast)',
                  // 被拖起的行整体压暗，明确「哪一行正在被搬运」
                  opacity: isRowDragging ? 0.45 : 1,
                }}
              >
                {/* 序号列单元格 (点击选中整行，拖拽换行，双击展开详情) */}
                <td
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    if (rowSlotIdx >= 0) startRowDrag(e, rowSlotIdx);
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    // 拖拽结束紧跟的 click 不应再改变选区
                    if (consumeRowDraggedFlag()) return;
                    if (e.shiftKey && selection.type === 'row') {
                      setSelection({
                        type: 'row',
                        startRowId: selection.startRowId,
                        endRowId: row.id,
                      });
                    } else {
                      setSelection({ type: 'row', startRowId: row.id, endRowId: row.id });
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!isRowSelected) {
                      setSelection({ type: 'row', startRowId: row.id, endRowId: row.id });
                    }
                    setCellContextMenu({
                      x: e.clientX,
                      y: e.clientY,
                      targetRowId: row.id,
                      targetColId: columns[0]?.id || '',
                    });
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    if (onOpenRecord) onOpenRecord(row.id);
                  }}
                  style={{
                    position: 'sticky',
                    left: 0,
                    zIndex: 2,
                    background: isRowSelected ? 'rgba(59, 130, 246, 0.14)' : 'var(--editor-surface, #f8fafc)',
                    borderBottom: '1px solid var(--editor-border, #f1f5f9)',
                    borderRight: '1px solid var(--editor-border, #e2e8f0)',
                    fontSize: 12,
                    color: 'var(--editor-text-muted, #94a3b8)',
                    textAlign: 'center',
                    padding: 0,
                    cursor: rowDrag ? 'grabbing' : rowDragEnabled ? 'grab' : 'pointer',
                    // sticky 单元格有自己的背景色，指示线必须直接画在它上面，否则会被自身背景盖掉
                    boxShadow: rowDropShadow,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: '100%',
                      height: '100%',
                      position: 'relative',
                    }}
                  >
                    <Tooltip
                      content={
                        !rowDragEnabled
                          ? '存在排序规则时行序由排序决定，无法手动拖动'
                          : isGrouped
                            ? '拖拽可在分组内换行 · 单击选中整行 · 双击展开详情'
                            : '拖拽行头可换序 · 单击选中整行 · 双击展开详情'
                      }
                      disabled={Boolean(rowDrag)}
                      side="right"
                      sideOffset={4}
                    >
                      <span style={{ cursor: 'inherit', display: 'inline-block', width: '100%', lineHeight: 'inherit' }}>{rowNumber}</span>
                    </Tooltip>

                    {/* 行快捷操作 (展开详情、升级、降级、添加子任务、向上插入、向下插入、删除) */}
                    {/* data-no-drag：这些按钮位于行头内部，但按下时不应触发拖拽换行 */}
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
                          shortcut={row.parentId ? 'Shift+Tab' : undefined}
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
                        <Tooltip content="降级为子任务" shortcut="Tab" side="top" sideOffset={4}>
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

                {/* 各单元格内容 (支持矩形跨单元格选区、填充柄与悬浮菜单) */}
                {columns.map((col, colIdx) => {
                  const cIdx = colIdx;
                  const isCellSelected =
                    normalizedSelection !== null &&
                    rIdx >= normalizedSelection.minRowIdx &&
                    rIdx <= normalizedSelection.maxRowIdx &&
                    cIdx >= normalizedSelection.minColIdx &&
                    cIdx <= normalizedSelection.maxColIdx;

                  const isAnchor =
                    normalizedSelection !== null &&
                    rIdx === normalizedSelection.anchorRowIdx &&
                    cIdx === normalizedSelection.anchorColIdx;

                  const isColSelected =
                    normalizedSelection !== null &&
                    selection.type === 'col' &&
                    cIdx >= normalizedSelection.minColIdx &&
                    cIdx <= normalizedSelection.maxColIdx;

                  const isTopEdge = isCellSelected && rIdx === normalizedSelection.minRowIdx;
                  const isBottomEdge = isCellSelected && rIdx === normalizedSelection.maxRowIdx;
                  const isLeftEdge = isCellSelected && cIdx === normalizedSelection.minColIdx;
                  const isRightEdge = isCellSelected && cIdx === normalizedSelection.maxColIdx;
                  const isBottomRightCorner = isCellSelected && isBottomEdge && isRightEdge;

                  // 填充预览区域判定
                  const isInFillPreview =
                    fillPreview !== null &&
                    rIdx >= fillPreview.fromRow &&
                    rIdx <= fillPreview.toRow &&
                    cIdx >= fillPreview.fromCol &&
                    cIdx <= fillPreview.toCol;
                  const isFillTop = isInFillPreview && rIdx === fillPreview.fromRow;
                  const isFillBottom = isInFillPreview && rIdx === fillPreview.toRow;
                  const isFillLeft = isInFillPreview && cIdx === fillPreview.fromCol;
                  const isFillRight = isInFillPreview && cIdx === fillPreview.toCol;

                  const isFirstCol = colIdx === 0;
                  const isExpandedLongText =
                    col.type === 'longText' && resolveLongTextConfig(col).displayMode === 'full';

                  // 边框阴影组合
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

                  let cellBg = 'inherit';
                  if (isInFillPreview) {
                    cellBg = 'rgba(59, 130, 246, 0.15)';
                  } else if (isCellSelected) {
                    cellBg =
                      isAnchor && !normalizedSelection.isSingleCell
                        ? 'rgba(59, 130, 246, 0.04)'
                        : 'rgba(59, 130, 246, 0.08)';
                  } else if (isColSelected) {
                    cellBg = 'rgba(59, 130, 246, 0.05)';
                  }

                  return (
                    <td
                      key={col.id}
                      data-cell-row-idx={rIdx}
                      data-cell-col-idx={cIdx}
                      onMouseDown={(e) => handleCellMouseDown(e, row.id, col.id)}
                      onMouseEnter={() => handleCellMouseEnter(row.id, col.id)}
                      onContextMenu={(e) => handleCellContextMenu(e, row.id, col.id)}
                      style={{
                        borderBottom: '1px solid var(--editor-border, #f1f5f9)',
                        borderRight: '1px solid var(--editor-border, #f1f5f9)',
                        padding: 0,
                        height: 38,
                        verticalAlign: isExpandedLongText ? 'top' : 'middle',
                        position: 'relative',
                        overflow: 'visible',
                        background: cellBg,
                        boxShadow: shadows.length > 0 ? shadows.join(', ') : undefined,
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: isExpandedLongText ? 'flex-start' : 'center',
                          width: '100%',
                          height: isExpandedLongText ? 'auto' : '100%',
                          position: 'relative',
                          overflow: 'visible',
                        }}
                      >
                        {/* 第一列渲染子行层级缩进与折叠展开箭头 */}
                        {isFirstCol && (
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              paddingLeft: depth * 18 + 4,
                              marginRight: 2,
                            }}
                          >
                            {hasChildren ? (
                              <button
                                type="button"
                                className="nb-bitable-btn-ghost"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleCollapse(row.id);
                                }}
                                style={{
                                  padding: 1,
                                  color: 'var(--editor-text-muted, #64748b)',
                                }}
                              >
                                {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                              </button>
                            ) : depth > 0 ? (
                              <CornerDownRight size={11} color="var(--editor-text-muted, #94a3b8)" style={{ opacity: 0.7 }} />
                            ) : null}
                          </div>
                        )}

                        <div
                          style={{
                            flex: 1,
                            height: isExpandedLongText ? 'auto' : '100%',
                            position: 'relative',
                            overflow: 'visible',
                          }}
                        >
                          <BitableCellEditor
                            column={col}
                            value={row[col.id]}
                            onChange={(newVal) => onUpdateRow(row.id, col.id, newVal)}
                            onManageColumnOption={onManageColumnOption}
                          />
                        </div>
                      </div>

                      {/* 选区右下角 Excel 风格填充柄 */}
                      {isBottomRightCorner && normalizedSelection && (
                        <Tooltip content="拖拽自动填充 · 双击向下快速填充" side="bottom" sideOffset={4}>
                          <div
                            data-fill-handle
                            onMouseDown={(e) => startFillDrag(e, normalizedSelection)}
                            onDoubleClick={(e) => handleDoubleClickFill(e, normalizedSelection)}
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
                              zIndex: 10,
                              boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                            }}
                            className="nb-bitable-fill-handle"
                          />
                        </Tooltip>
                      )}
                    </td>
                  );
                })}

                {/* 尾部空白 */}
                <td
                  style={{
                    borderBottom: '1px solid var(--editor-border, #f1f5f9)',
                    boxShadow: rowDropShadow,
                  }}
                />
              </tr>
            );
          })}
        </tbody>

      {/* 底部统计栏与快速添加行：放在表格末尾原位，水平方向粘在左侧避免随滚动移动 */}
      <tfoot>
        <tr>
          <td
            colSpan={columns.length + 2}
            style={{
              padding: '8px 12px',
              borderTop: '1px solid var(--editor-border, #e2e8f0)',
              background: 'var(--editor-surface, #ffffff)',
            }}
          >
            {/* 水平粘性容器：表格横向滚动时，「添加一行记录」按钮始终固定在视口左侧可见位置 */}
            <div
              style={{
                position: 'sticky',
                left: 12,
                display: 'inline-flex',
                alignItems: 'center',
                width: 'fit-content',
              }}
            >
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
        </tr>
      </tfoot>
    </table>
    </div>

      {/* 单选 / 多选中列表头的选项管理面板（Portal 渲染） */}
      {optionsEditor &&
        (() => {
          const targetCol = columns.find((c) => c.id === optionsEditor.colId);
          if (!targetCol) return null;
          return (
            <SelectOptionsPanel
              anchor={optionsEditor.anchor}
              trigger={optionsEditor.trigger}
              title={`编辑「${targetCol.name}」的标签选项`}
              options={targetCol.options || []}
              isMulti={targetCol.type === 'multiSelect'}
              manageable
              onAddOption={(label, color) =>
                onManageColumnOption?.(targetCol.id, {
                  type: 'add',
                  option: { id: createId('opt'), label, color },
                })
              }
              onUpdateOption={(optionId, label, color) =>
                onManageColumnOption?.(targetCol.id, { type: 'update', optionId, label, color })
              }
              onDeleteOption={(optionId) =>
                onManageColumnOption?.(targetCol.id, { type: 'delete', optionId })
              }
              onMoveOption={(optionId, direction) =>
                onManageColumnOption?.(targetCol.id, { type: 'move', optionId, direction })
              }
              onClose={() => setOptionsEditor(null)}
            />
          );
        })()}

      {/* 表头拖拽时的跟随幽灵：按抓取偏移贴合被拖列，并实时提示落点序号 */}
      {colDrag && (
        <DragGhost
          x={colDrag.x - grabOffset.x}
          y={colDrag.y - grabOffset.y + 4}
          minWidth={colDragWidth}
        >
          {columns[colDrag.fromIdx]?.name ?? ''}
          {` · 移动到第 ${slotToFinalPosition(colDrag.insertAt, colDrag.fromIdx)} 列`}
        </DragGhost>
      )}

      {/* 行头拖拽时的跟随幽灵：提示落在本组/本表的第几行 */}
      {rowDrag && (
        <DragGhost x={rowDrag.x - rowGrabOffset.x} y={rowDrag.y - rowGrabOffset.y + 4}>
          {resolveRowTitle(rowSlots[rowDrag.fromIdx]?.rowId ?? '')}
          {rowDrag.valid
            ? ` · 移动到${isGrouped ? '组内' : ''}第 ${rowDropPosition} 行`
            : ' · 此处不可放置'}
        </DragGhost>
      )}

      {/* 单元格与选区悬浮右键上下文菜单 */}
      {cellContextMenu && (
        <div
          data-no-drag
          style={{
            position: 'fixed',
            left: Math.min(cellContextMenu.x, window.innerWidth - 180),
            top: Math.min(cellContextMenu.y, window.innerHeight - 380),
            zIndex: 9999,
            background: 'var(--editor-surface, #ffffff)',
            border: '1px solid var(--editor-border, #cbd5e1)',
            borderRadius: 8,
            boxShadow: '0 10px 25px rgba(15,23,42,0.15)',
            padding: 4,
            minWidth: 160,
            fontSize: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="nb-bitable-menu-item"
            onClick={() => {
              const payload = buildClipboardPayload();
              if (payload !== null) {
                if (navigator.clipboard?.writeText) {
                  navigator.clipboard.writeText(payload).catch(() => {});
                }
                showToast(
                  normalizedSelection?.isSingleCell
                    ? '已复制单元格数据'
                    : '已复制选区数据',
                );
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
              if (payload !== null) {
                if (navigator.clipboard?.writeText) {
                  navigator.clipboard.writeText(payload).catch(() => {});
                }
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
                // fallback
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
