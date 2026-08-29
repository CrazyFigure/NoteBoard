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
import {
  createId,
  formatCellValue,
  getSortDirectionLabels,
  collectDescendantRowIds,
  groupFlatTreeRows,
  isSlotNoop,
  parseClipboardMatrix,
  previewLongText,
  resolveDateTimeConfig,
  resolveLongTextConfig,
  slotToFinalPosition,
  slotToSpliceIndex,
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
} from 'lucide-react';

export type SelectionState =
  | { type: 'none' }
  | { type: 'cell'; rowId: string; colId: string }
  | { type: 'row'; rowId: string }
  | { type: 'col'; colId: string };

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
            <button
              type="button"
              className="nb-bitable-btn-ghost"
              onClick={() => removeRule(index)}
              title="移除该排序字段"
              style={{ padding: 4 }}
            >
              <X size={13} />
            </button>
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

  // 选区系统状态 (选中单元格/整行/整列)
  const [selection, setSelection] = useState<SelectionState>({ type: 'none' });

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

  // 3. 剪贴板读写：统一通过隐藏代理输入框接收原生 copy / cut / paste 事件
  // 直接调用 navigator.clipboard.readText() 会触发浏览器的「是否允许粘贴」权限弹窗，
  // 且在 WebView 受限环境下经常静默失败；改为监听原生剪贴板事件后无需任何授权。

  /** 将当前选区序列化为可粘贴的纯文本 */
  const buildClipboardPayload = useCallback((): string | null => {
    if (selection.type === 'cell') {
      const row = rows.find((r) => r.id === selection.rowId);
      const col = columns.find((c) => c.id === selection.colId);
      if (!row || !col) return null;
      return formatCellValue(col, row[col.id]);
    }
    if (selection.type === 'row') {
      const row = rows.find((r) => r.id === selection.rowId);
      if (!row) return null;
      return columns.map((c) => formatCellValue(c, row[c.id])).join('\t');
    }
    if (selection.type === 'col') {
      const col = columns.find((c) => c.id === selection.colId);
      if (!col) return null;
      return rows.map((r) => formatCellValue(col, r[col.id])).join('\n');
    }
    return null;
  }, [selection, rows, columns]);

  /** 剪切：内容写入剪贴板后清空选区数据 */
  const clearSelectedRange = useCallback(() => {
    if (selection.type === 'cell') {
      onUpdateRow(selection.rowId, selection.colId, null);
      showToast('已剪切单元格数据');
      return;
    }
    if (selection.type === 'row') {
      onDeleteRow(selection.rowId);
      setSelection({ type: 'none' });
      showToast('已剪切整行数据');
      return;
    }
    if (selection.type === 'col' && onClearColumn) {
      onClearColumn(selection.colId);
      showToast('已剪切整列数据');
    }
  }, [selection, onUpdateRow, onDeleteRow, onClearColumn]);

  /** 粘贴：按选区类型把二维矩阵写入单元格 / 整行 / 整列 */
  const applyPaste = useCallback(
    (text: string) => {
      const matrix = parseClipboardMatrix(text);
      if (!matrix.length) return;

      if (selection.type === 'cell') {
        if (onPasteCells) {
          onPasteCells(selection.rowId, selection.colId, matrix);
          showToast(matrix.length > 1 || (matrix[0]?.length ?? 0) > 1 ? '已粘贴区域数据' : '已粘贴数据');
        } else {
          onUpdateRow(selection.rowId, selection.colId, matrix[0][0] ?? '');
          showToast('已粘贴数据');
        }
        return;
      }

      if (selection.type === 'row') {
        if (onPasteCells && columns.length) {
          onPasteCells(selection.rowId, columns[0].id, [matrix[0] ?? []]);
          showToast('已粘贴整行数据');
        }
        return;
      }

      if (selection.type === 'col') {
        if (!onPasteCells || !rows.length) {
          showToast('请先选中单元格后再粘贴');
          return;
        }
        onPasteCells(rows[0].id, selection.colId, matrix.map((line) => [line[0] ?? '']));
        showToast('已粘贴整列数据');
        return;
      }

      showToast('请先选中单元格后再粘贴');
    },
    [selection, columns, rows, onPasteCells, onUpdateRow],
  );

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

  // 3. 键盘快捷键监听（删除、清空、取消选区；复制/剪切/粘贴交由原生剪贴板事件处理）
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

      // Escape 取消选区
      if (e.key === 'Escape') {
        setSelection({ type: 'none' });
        return;
      }

      // Delete / Backspace 删除或清空
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selection.type === 'cell') {
          e.preventDefault();
          onUpdateRow(selection.rowId, selection.colId, null);
          showToast('已清空单元格');
        } else if (selection.type === 'row') {
          e.preventDefault();
          onDeleteRow(selection.rowId);
          setSelection({ type: 'none' });
          showToast('已删除选中行');
        } else if (selection.type === 'col') {
          e.preventDefault();
          if (onClearColumn) {
            onClearColumn(selection.colId);
            showToast('已清空整列数据');
          }
        }
        return;
      }

      // Tab / Shift+Tab 快速调整行层级：Shift+Tab 升级为上一级，Tab 降级为子任务
      if (e.key === 'Tab') {
        if (selection.type !== 'row' && selection.type !== 'cell') return;
        e.preventDefault();
        const targetRowId = selection.rowId;
        if (e.shiftKey) {
          if (onOutdentRow) onOutdentRow(targetRowId);
        } else if (onIndentRow) {
          onIndentRow(targetRowId);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selection, onUpdateRow, onDeleteRow, onClearColumn, onOutdentRow, onIndentRow]);
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
      ref={scrollContainerRef}
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'auto',
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
            selection.type === 'cell'
              ? '已复制单元格数据'
              : selection.type === 'row'
                ? '已复制整行数据'
                : '已复制整列数据',
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
              const isColSelected = selection.type === 'col' && selection.colId === col.id;
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
                  onClick={() => setSelection({ type: 'col', colId: col.id })}
                  title={isOptionField ? '单击编辑选项 · 拖拽换列 · 双击名称重命名' : '拖拽表头可换列 · 双击名称重命名'}
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
                      )}

                      {/* 排序状态指示图标：多字段时显示优先级角标 */}
                      {sortRuleForCol && (
                        <span
                          title={`第 ${sortPriority} 排序字段 · ${sortRuleForCol.direction === 'asc' ? '升序' : '降序'}`}
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
                      )}
                    </div>

                    {/* 列操作菜单唤起按钮 */}
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
                    >
                      <MoreHorizontal size={13} />
                    </button>

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
                                    <button
                                      key={opt.id}
                                      type="button"
                                      title={opt.hint}
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
                                  );
                                })}
                              </div>

                              <button
                                type="button"
                                title="开启后以富文本方式编辑与渲染，支持加粗、代码块等 Markdown 语法"
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
                                        <button
                                          key={opt.id}
                                          type="button"
                                          title={opt.label}
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
                                        <button
                                          key={opt.id}
                                          type="button"
                                          title={opt.label}
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
              <button
                type="button"
                className="nb-bitable-btn-ghost"
                onClick={() => onAddColumn('right')}
                title="添加新列"
                style={{ padding: '4px' }}
              >
                <Plus size={14} />
              </button>
            </th>
          </tr>
        </thead>

        {/* 表格记录行内容 (树形子任务、分组标题与选区渲染) */}
        <tbody>
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
            const isRowSelected = selection.type === 'row' && selection.rowId === row.id;
            const rowSlotIdx = rowSlotIndex.get(row.id) ?? -1;
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
                    setSelection({ type: 'row', rowId: row.id });
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    if (onOpenRecord) onOpenRecord(row.id);
                  }}
                  title={
                    !rowDragEnabled
                      ? '存在排序规则时行序由排序决定，无法手动拖动'
                      : isGrouped
                        ? '拖拽可在分组内换行 · 单击选中整行 · 双击展开详情'
                        : '拖拽行头可换序 · 单击选中整行 · 双击展开详情'
                  }
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
                    <span>{rowNumber}</span>

                    {/* 行快捷操作 (添加子任务、向上插入、向下插入、删除) */}
                    {/* data-no-drag：这些按钮位于行头内部，但按下时不应触发拖拽换行 */}
                    <div
                      data-no-drag
                      style={{
                        display: isRowSelected ? 'flex' : 'none',
                        position: 'absolute',
                        left: '100%',
                        top: 0,
                        zIndex: 99,
                        background: 'var(--editor-surface, #ffffff)',
                        border: '1px solid var(--editor-border, #cbd5e1)',
                        borderRadius: 6,
                        boxShadow: '0 6px 18px rgba(15,23,42,0.12)',
                        padding: '3px 4px',
                        gap: 2,
                        alignItems: 'center',
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {onOpenRecord && (
                        <button
                          type="button"
                          title="展开记录详情"
                          className="nb-bitable-row-action-btn"
                          onClick={() => onOpenRecord(row.id)}
                          style={{ color: 'var(--editor-accent, #3b82f6)' }}
                        >
                          <Maximize2 size={14} />
                        </button>
                      )}
                      {onOutdentRow && (
                        <button
                          type="button"
                          title={
                            row.parentId
                              ? '升级为上一级 (Shift+Tab)'
                              : '该行已是第一级'
                          }
                          disabled={!row.parentId}
                          className="nb-bitable-row-action-btn"
                          onClick={() => onOutdentRow(row.id)}
                          style={{ color: 'var(--editor-text, #334155)' }}
                        >
                          <IndentDecrease size={14} />
                        </button>
                      )}
                      {onIndentRow && (
                        <button
                          type="button"
                          title="降级为子任务 (Tab)"
                          className="nb-bitable-row-action-btn"
                          onClick={() => onIndentRow(row.id)}
                          style={{ color: 'var(--editor-text, #334155)' }}
                        >
                          <IndentIncrease size={14} />
                        </button>
                      )}
                      {onAddSubRow && (
                        <button
                          type="button"
                          title="添加子任务"
                          className="nb-bitable-row-action-btn"
                          onClick={() => onAddSubRow(row.id)}
                          style={{ color: 'var(--editor-accent, #3b82f6)' }}
                        >
                          <CornerDownRight size={14} />
                        </button>
                      )}
                      {onInsertRowAbove && (
                        <button
                          type="button"
                          title="在上方插入行"
                          className="nb-bitable-row-action-btn"
                          onClick={() => onInsertRowAbove(row.id)}
                          style={{ color: 'var(--editor-text, #334155)' }}
                        >
                          <ArrowUp size={14} />
                        </button>
                      )}
                      {onInsertRowBelow && (
                        <button
                          type="button"
                          title="在下方插入行"
                          className="nb-bitable-row-action-btn"
                          onClick={() => onInsertRowBelow(row.id)}
                          style={{ color: 'var(--editor-text, #334155)' }}
                        >
                          <ArrowDown size={14} />
                        </button>
                      )}
                      <button
                        type="button"
                        title="删除该行"
                        className="nb-bitable-row-action-btn"
                        onClick={() => onDeleteRow(row.id)}
                        style={{ color: '#ef4444' }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                </td>

                {/* 各单元格内容 (修复 overflow 避免裁剪下拉面板) */}
                {columns.map((col, colIdx) => {
                  const isCellSelected =
                    selection.type === 'cell' && selection.rowId === row.id && selection.colId === col.id;
                  const isColSelected = selection.type === 'col' && selection.colId === col.id;
                  const isFirstCol = colIdx === 0;
                  // 全显示的多行文本列需放开高度约束并顶部对齐，否则内容撑不开、也看不出起始位置
                  const isExpandedLongText =
                    col.type === 'longText' && resolveLongTextConfig(col).displayMode === 'full';

                  return (
                    <td
                      key={col.id}
                      onClick={() => setSelection({ type: 'cell', rowId: row.id, colId: col.id })}
                      style={{
                        borderBottom: '1px solid var(--editor-border, #f1f5f9)',
                        borderRight: '1px solid var(--editor-border, #f1f5f9)',
                        padding: 0,
                        height: 38,
                        verticalAlign: isExpandedLongText ? 'top' : 'middle',
                        position: 'relative',
                        overflow: 'visible',
                        background: isCellSelected
                          ? 'rgba(59, 130, 246, 0.08)'
                          : isColSelected
                          ? 'rgba(59, 130, 246, 0.05)'
                          : 'inherit',
                        outline: isCellSelected ? '2px solid var(--editor-accent, #3b82f6)' : 'none',
                        outlineOffset: -2,
                        // 落点指示线画在数据单元格上：tr 的 box-shadow 不可靠，必须逐格画
                        boxShadow: rowDropShadow,
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
                    </td>
                  );
                })}

                {/* 尾部空白 */}
                <td
                  style={{
                    borderBottom: '1px solid var(--editor-border, #f1f5f9)',
                    // 落点指示线必须延伸到行尾的留白格，否则右侧看不到落点
                    boxShadow: rowDropShadow,
                  }}
                />
              </tr>
            );
          })}
        </tbody>

        {/* 底部统计栏与快速添加行 */}
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
            </td>
          </tr>
        </tfoot>
      </table>

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
    </div>
  );
}
