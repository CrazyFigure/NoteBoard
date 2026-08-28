// NoteBoard 飞书风格多维表格网格视图 (Grid View)
// 支持表头指针拖拽换列、各字段格式专有排序、树形子任务展开收起、选区高亮与剪切/复制/粘贴/删除
// 剪贴板通过隐藏代理输入框接收原生 copy/cut/paste 事件，规避 navigator.clipboard 的读权限弹窗

import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import type {
  BitableColumn,
  BitableRow,
  BitableFieldType,
  ColumnOptionAction,
  SortRule,
} from './bitableTypes';
import { BitableCellEditor } from './BitableCellEditor';
import { SelectOptionsPanel } from './BitableOptions';
import { DragGhost, FloatingPanel, getAnchorRect, type AnchorRect } from './BitableFloating';
import { usePointerReorder } from './usePointerReorder';
import { getFieldTypeMeta } from './BitableFieldMeta';
import {
  createId,
  formatCellValue,
  parseClipboardMatrix,
  slotToFinalPosition,
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
  X,
} from 'lucide-react';

export type SelectionState =
  | { type: 'none' }
  | { type: 'cell'; rowId: string; colId: string }
  | { type: 'row'; rowId: string }
  | { type: 'col'; colId: string };

interface GridViewProps {
  columns: BitableColumn[];
  rows: BitableRow[];
  currentSortRule?: SortRule | null;
  /** 区域粘贴：以 (rowId, colId) 为左上角写入二维文本矩阵，行数不足时由上层自动补建 */
  onPasteCells?: (rowId: string, colId: string, matrix: string[][]) => void;
  /** 列选项增删改排序：由上层在单次提交内同步列定义与所有关联行数据 */
  onManageColumnOption?: (colId: string, action: ColumnOptionAction) => void;
  onSortColumn?: (colId: string, direction: 'asc' | 'desc' | null) => void;
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
}

/** 获取字段类型的显示图标与中文名称 */
/** 获取各字段类型专有的排序文案 */
function getSortLabels(type: BitableFieldType) {
  switch (type) {
    case 'number':
    case 'progress':
    case 'rating':
      return { asc: '从小到大升序 (1 → 9)', desc: '从大到小降序 (9 → 1)' };
    case 'date':
      return { asc: '从早到晚升序', desc: '从晚到早降序' };
    case 'checkbox':
      return { asc: '未勾选优先', desc: '已勾选优先' };
    case 'select':
    case 'multiSelect':
      return { asc: '按标签顺序升序', desc: '按标签顺序降序' };
    case 'text':
    case 'link':
    default:
      return { asc: '按 A → Z 升序', desc: '按 Z → A 降序' };
  }
}

const ALL_FIELD_TYPES: BitableFieldType[] = [
  'text',
  'number',
  'select',
  'multiSelect',
  'date',
  'checkbox',
  'rating',
  'progress',
  'link',
];

interface FlatTreeRow {
  row: BitableRow;
  depth: number;
  hasChildren: boolean;
  isCollapsed: boolean;
  rowNumber: number;
}

export function BitableGridView({
  columns,
  rows,
  currentSortRule,
  onPasteCells,
  onManageColumnOption,
  onSortColumn,
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
}: GridViewProps) {
  // 当前打开列头菜单的列 ID（菜单改由 Portal 浮层渲染，需同时记录锚点与触发元素）
  const [columnMenu, setColumnMenu] = useState<{
    colId: string;
    anchor: AnchorRect;
    trigger: HTMLElement;
  } | null>(null);
  const [editingColNameId, setEditingColNameId] = useState<string | null>(null);
  const [colNameInput, setColNameInput] = useState('');

  // 折叠的行 ID 集合
  const [collapsedRowIds, setCollapsedRowIds] = useState<Set<string>>(new Set());

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

  // 2. 剪贴板读写：统一通过隐藏代理输入框接收原生 copy / cut / paste 事件
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
        // 拖拽换列期间禁用文本选中，避免拖出蓝色选区
        userSelect: colDrag ? 'none' : undefined,
      }}
      onClick={(e) => {
        // 点击空白处取消菜单并把焦点交还剪贴板代理
        setColumnMenu(null);
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
              const sortLabels = getSortLabels(col.type);
              const isMenuOpen = columnMenu?.colId === col.id;
              const isColSelected = selection.type === 'col' && selection.colId === col.id;
              const isSortedByThis = currentSortRule?.columnId === col.id;
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

                      {/* 排序状态指示图标 */}
                      {isSortedByThis && (
                        <span
                          title={currentSortRule.direction === 'asc' ? '升序排列' : '降序排列'}
                          style={{ display: 'flex', alignItems: 'center', color: 'var(--editor-accent, #3b82f6)' }}
                        >
                          {currentSortRule.direction === 'asc' ? <ArrowUpNarrowWide size={13} /> : <ArrowDownWideNarrow size={13} />}
                        </span>
                      )}
                    </div>

                    {/* 列操作菜单唤起按钮 */}
                    <button
                      type="button"
                      data-no-drag
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isMenuOpen) {
                          setColumnMenu(null);
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
                        border: 'none',
                        background: isMenuOpen ? 'var(--editor-bg, #f1f5f9)' : 'transparent',
                        cursor: 'pointer',
                        padding: '2px',
                        borderRadius: 4,
                        color: 'var(--editor-text-muted, #64748b)',
                        display: 'flex',
                        alignItems: 'center',
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

                    {/* 飞书风列配置浮动菜单（Portal 渲染，避免被滚动容器裁剪） */}
                    {isMenuOpen && columnMenu && (
                      <FloatingPanel
                        anchor={columnMenu.anchor}
                        trigger={columnMenu.trigger}
                        width={220}
                        gap={1}
                        align="right"
                        onClose={() => setColumnMenu(null)}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setColNameInput(col.name);
                            setEditingColNameId(col.id);
                            setColumnMenu(null);
                          }}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '6px 8px',
                            border: 'none',
                            background: 'transparent',
                            cursor: 'pointer',
                            fontSize: 12,
                            borderRadius: 4,
                            color: 'var(--editor-text, #1e293b)',
                            textAlign: 'left',
                          }}
                        >
                          <Edit2 size={13} />
                          <span>重命名列</span>
                        </button>

                        {/* 单选 / 多选中列表头：直接进入选项管理 */}
                        {isOptionField && (
                          <button
                            type="button"
                            onClick={() => {
                              const anchor = getAnchorRect(headerCellRefs.current.get(col.id));
                              const th = headerCellRefs.current.get(col.id);
                              if (anchor && th) {
                                setOptionsEditor({ colId: col.id, anchor, trigger: th });
                              }
                              setColumnMenu(null);
                            }}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                              padding: '6px 8px',
                              border: 'none',
                              background: 'transparent',
                              cursor: 'pointer',
                              fontSize: 12,
                              borderRadius: 4,
                              color: 'var(--editor-text, #1e293b)',
                              textAlign: 'left',
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
                                onClick={() => {
                                  onMoveColumn(col.id, 'left');
                                  setColumnMenu(null);
                                }}
                                style={{
                                  flex: 1,
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  gap: 4,
                                  padding: '5px 6px',
                                  minWidth: 26,
                                  border: 'none',
                                  background: 'transparent',
                                  cursor: colIdx === 0 ? 'not-allowed' : 'pointer',
                                  opacity: colIdx === 0 ? 0.4 : 1,
                                  fontSize: 11,
                                  borderRadius: 4,
                                  color: 'var(--editor-text, #1e293b)',
                                }}
                              >
                                <MoveLeft size={12} />
                                <span>向左移动</span>
                              </button>

                              <button
                                type="button"
                                disabled={colIdx === columns.length - 1}
                                onClick={() => {
                                  onMoveColumn(col.id, 'right');
                                  setColumnMenu(null);
                                }}
                                style={{
                                  flex: 1,
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  gap: 4,
                                  padding: '5px 6px',
                            minWidth: 26,
                                  border: 'none',
                                  background: 'transparent',
                                  cursor: colIdx === columns.length - 1 ? 'not-allowed' : 'pointer',
                                  opacity: colIdx === columns.length - 1 ? 0.4 : 1,
                                  fontSize: 11,
                                  borderRadius: 4,
                                  color: 'var(--editor-text, #1e293b)',
                                }}
                              >
                                <MoveRight size={12} />
                                <span>向右移动</span>
                              </button>
                            </div>
                            <div style={{ height: 1, background: 'var(--editor-border, #f1f5f9)', margin: '3px 0' }} />
                          </>
                        )}

                        {/* 字段专有智能排序菜单项 */}
                        {onSortColumn && (
                          <>
                            <div style={{ padding: '2px 8px', fontSize: 10, color: 'var(--editor-text-muted, #94a3b8)' }}>
                              当前列排序
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                onSortColumn(col.id, 'asc');
                                setColumnMenu(null);
                              }}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                padding: '5px 8px',
                                border: 'none',
                                background: isSortedByThis && currentSortRule.direction === 'asc' ? 'var(--editor-bg, #f1f5f9)' : 'transparent',
                                cursor: 'pointer',
                                fontSize: 11,
                                borderRadius: 4,
                                color: isSortedByThis && currentSortRule.direction === 'asc' ? 'var(--editor-accent, #3b82f6)' : 'var(--editor-text, #1e293b)',
                              }}
                            >
                              <ArrowUpNarrowWide size={13} />
                              <span>{sortLabels.asc}</span>
                            </button>

                            <button
                              type="button"
                              onClick={() => {
                                onSortColumn(col.id, 'desc');
                                setColumnMenu(null);
                              }}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                padding: '5px 8px',
                                border: 'none',
                                background: isSortedByThis && currentSortRule.direction === 'desc' ? 'var(--editor-bg, #f1f5f9)' : 'transparent',
                                cursor: 'pointer',
                                fontSize: 11,
                                borderRadius: 4,
                                color: isSortedByThis && currentSortRule.direction === 'desc' ? 'var(--editor-accent, #3b82f6)' : 'var(--editor-text, #1e293b)',
                              }}
                            >
                              <ArrowDownWideNarrow size={13} />
                              <span>{sortLabels.desc}</span>
                            </button>

                            {isSortedByThis && (
                              <button
                                type="button"
                                onClick={() => {
                                  onSortColumn(col.id, null);
                                  setColumnMenu(null);
                                }}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 6,
                                  padding: '5px 8px',
                                  border: 'none',
                                  background: 'transparent',
                                  cursor: 'pointer',
                                  fontSize: 11,
                                  borderRadius: 4,
                                  color: 'var(--editor-text-muted, #64748b)',
                                }}
                              >
                                <X size={13} />
                                <span>清除此列排序</span>
                              </button>
                            )}

                            <div style={{ height: 1, background: 'var(--editor-border, #f1f5f9)', margin: '3px 0' }} />
                          </>
                        )}

                        {/* 修改字段类型子列表 */}
                        <div style={{ padding: '2px 8px', fontSize: 10, color: 'var(--editor-text-muted, #94a3b8)' }}>
                          更改字段类型
                        </div>
                        <div style={{ maxHeight: 130, overflowY: 'auto' }}>
                          {ALL_FIELD_TYPES.map((t) => {
                            const tMeta = getFieldTypeMeta(t);
                            const isCurrent = col.type === t;
                            return (
                              <button
                                key={t}
                                type="button"
                                onClick={() => {
                                  onUpdateColumn(col.id, {
                                    type: t,
                                    options: (t === 'select' || t === 'multiSelect') && !col.options?.length
                                      ? [
                                          { id: 'opt_1', label: '选项 1', color: 'blue' },
                                          { id: 'opt_2', label: '选项 2', color: 'green' },
                                        ]
                                      : col.options,
                                  });
                                  setColumnMenu(null);
                                }}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  width: '100%',
                                  padding: '4px 8px',
                                  border: 'none',
                                  background: isCurrent ? 'var(--editor-bg, #f1f5f9)' : 'transparent',
                                  cursor: 'pointer',
                                  fontSize: 11,
                                  borderRadius: 4,
                                  color: 'var(--editor-text, #1e293b)',
                                }}
                              >
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  {tMeta.icon}
                                  <span>{tMeta.label}</span>
                                </div>
                              </button>
                            );
                          })}
                        </div>

                        <div style={{ height: 1, background: 'var(--editor-border, #f1f5f9)', margin: '3px 0' }} />

                        <button
                          type="button"
                          onClick={() => {
                            onAddColumn('left', col.id);
                            setColumnMenu(null);
                          }}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '5px 8px',
                            border: 'none',
                            background: 'transparent',
                            cursor: 'pointer',
                            fontSize: 11,
                            borderRadius: 4,
                            color: 'var(--editor-text, #1e293b)',
                          }}
                        >
                          <ArrowLeft size={12} />
                          <span>在左侧插入列</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            onAddColumn('right', col.id);
                            setColumnMenu(null);
                          }}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '5px 8px',
                            border: 'none',
                            background: 'transparent',
                            cursor: 'pointer',
                            fontSize: 11,
                            borderRadius: 4,
                            color: 'var(--editor-text, #1e293b)',
                          }}
                        >
                          <ArrowRight size={12} />
                          <span>在右侧插入列</span>
                        </button>

                        {onClearColumn && (
                          <button
                            type="button"
                            onClick={() => {
                              onClearColumn(col.id);
                              setColumnMenu(null);
                              showToast('已清空该列所有数据');
                            }}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                              padding: '5px 8px',
                              border: 'none',
                              background: 'transparent',
                              cursor: 'pointer',
                              fontSize: 11,
                              borderRadius: 4,
                              color: 'var(--editor-text-muted, #64748b)',
                            }}
                          >
                            <Eraser size={12} />
                            <span>清空此列数据</span>
                          </button>
                        )}

                        <div style={{ height: 1, background: 'var(--editor-border, #f1f5f9)', margin: '3px 0' }} />

                        <button
                          type="button"
                          onClick={() => {
                            onDeleteColumn(col.id);
                            setColumnMenu(null);
                          }}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '5px 8px',
                            border: 'none',
                            background: 'transparent',
                            cursor: 'pointer',
                            fontSize: 11,
                            borderRadius: 4,
                            color: '#ef4444',
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
                onClick={() => onAddColumn('right')}
                title="添加新列"
                style={{
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  padding: '4px',
                  borderRadius: 4,
                  color: 'var(--editor-text-muted, #64748b)',
                  display: 'inline-flex',
                  alignItems: 'center',
                }}
              >
                <Plus size={14} />
              </button>
            </th>
          </tr>
        </thead>

        {/* 表格记录行内容 (树形子任务与选区渲染) */}
        <tbody>
          {flatTreeRows.map((treeNode) => {
            const { row, depth, hasChildren, isCollapsed, rowNumber } = treeNode;
            const isRowSelected = selection.type === 'row' && selection.rowId === row.id;

            return (
              <tr
                key={row.id}
                style={{
                  height: 38,
                  background: isRowSelected ? 'rgba(59, 130, 246, 0.08)' : 'var(--editor-surface, #ffffff)',
                  transition: 'background var(--transition-fast)',
                }}
              >
                {/* 序号列单元格 (点击选中整行，悬停/选中弹出快捷操作) */}
                <td
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelection({ type: 'row', rowId: row.id });
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    if (onOpenRecord) onOpenRecord(row.id);
                  }}
                  title={onOpenRecord ? '单击选中整行 · 双击展开记录详情' : '单击选中整行'}
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
                    cursor: 'pointer',
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
                    <div
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
                        padding: '4px 5px',
                        gap: 3,
                        alignItems: 'center',
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {onOpenRecord && (
                        <button
                          type="button"
                          title="展开记录详情"
                          onClick={() => onOpenRecord(row.id)}
                          style={{
                            border: 'none',
                            background: 'transparent',
                            cursor: 'pointer',
                            padding: '5px 6px',
                            minWidth: 26,
                            color: 'var(--editor-accent, #3b82f6)',
                            display: 'flex',
                          }}
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
                          onClick={() => onOutdentRow(row.id)}
                          style={{
                            border: 'none',
                            background: 'transparent',
                            cursor: row.parentId ? 'pointer' : 'not-allowed',
                            opacity: row.parentId ? 1 : 0.3,
                            padding: '5px 6px',
                            minWidth: 26,
                            color: 'var(--editor-text, #334155)',
                            display: 'flex',
                          }}
                        >
                          <IndentDecrease size={14} />
                        </button>
                      )}
                      {onIndentRow && (
                        <button
                          type="button"
                          title="降级为子任务 (Tab)"
                          onClick={() => onIndentRow(row.id)}
                          style={{
                            border: 'none',
                            background: 'transparent',
                            cursor: 'pointer',
                            padding: '5px 6px',
                            minWidth: 26,
                            color: 'var(--editor-text, #334155)',
                            display: 'flex',
                          }}
                        >
                          <IndentIncrease size={14} />
                        </button>
                      )}
                      {onAddSubRow && (
                        <button
                          type="button"
                          title="添加子任务"
                          onClick={() => onAddSubRow(row.id)}
                          style={{
                            border: 'none',
                            background: 'transparent',
                            cursor: 'pointer',
                            padding: '5px 6px',
                            minWidth: 26,
                            color: 'var(--editor-accent, #3b82f6)',
                            display: 'flex',
                          }}
                        >
                          <CornerDownRight size={14} />
                        </button>
                      )}
                      {onInsertRowAbove && (
                        <button
                          type="button"
                          title="在上方插入行"
                          onClick={() => onInsertRowAbove(row.id)}
                          style={{
                            border: 'none',
                            background: 'transparent',
                            cursor: 'pointer',
                            padding: '5px 6px',
                            minWidth: 26,
                            color: 'var(--editor-text, #334155)',
                            display: 'flex',
                          }}
                        >
                          <ArrowUp size={14} />
                        </button>
                      )}
                      {onInsertRowBelow && (
                        <button
                          type="button"
                          title="在下方插入行"
                          onClick={() => onInsertRowBelow(row.id)}
                          style={{
                            border: 'none',
                            background: 'transparent',
                            cursor: 'pointer',
                            padding: '5px 6px',
                            color: 'var(--editor-text, #334155)',
                            display: 'flex',
                          }}
                        >
                          <ArrowDown size={14} />
                        </button>
                      )}
                      <button
                        type="button"
                        title="删除该行"
                        onClick={() => onDeleteRow(row.id)}
                        style={{
                          border: 'none',
                          background: 'transparent',
                          cursor: 'pointer',
                          padding: '5px 6px',
                          color: '#ef4444',
                          display: 'flex',
                        }}
                      >
                        <Trash2 size={12} />
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

                  return (
                    <td
                      key={col.id}
                      onClick={() => setSelection({ type: 'cell', rowId: row.id, colId: col.id })}
                      style={{
                        borderBottom: '1px solid var(--editor-border, #f1f5f9)',
                        borderRight: '1px solid var(--editor-border, #f1f5f9)',
                        padding: 0,
                        height: 38,
                        verticalAlign: 'middle',
                        position: 'relative',
                        overflow: 'visible',
                        background: isCellSelected
                          ? 'rgba(59, 130, 246, 0.08)'
                          : isColSelected
                          ? 'rgba(59, 130, 246, 0.05)'
                          : 'inherit',
                        outline: isCellSelected ? '2px solid var(--editor-accent, #3b82f6)' : 'none',
                        outlineOffset: -2,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', width: '100%', height: '100%', position: 'relative', overflow: 'visible' }}>
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
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleCollapse(row.id);
                                }}
                                style={{
                                  border: 'none',
                                  background: 'transparent',
                                  cursor: 'pointer',
                                  padding: 0,
                                  display: 'flex',
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

                        <div style={{ flex: 1, height: '100%', position: 'relative', overflow: 'visible' }}>
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
                <td style={{ borderBottom: '1px solid var(--editor-border, #f1f5f9)' }} />
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
                onClick={onAddRow}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '5px 12px',
                  borderRadius: 5,
                  border: '1px dashed var(--editor-border, #cbd5e1)',
                  background: 'transparent',
                  color: 'var(--editor-text-muted, #64748b)',
                  fontSize: 12,
                  cursor: 'pointer',
                  fontWeight: 500,
                  transition: 'all 0.15s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--editor-accent, #3b82f6)';
                  e.currentTarget.style.color = 'var(--editor-accent, #3b82f6)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--editor-border, #cbd5e1)';
                  e.currentTarget.style.color = 'var(--editor-text-muted, #64748b)';
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
          width={colDragWidth}
        >
          {columns[colDrag.fromIdx]?.name ?? ''}
          {` · 移动到第 ${slotToFinalPosition(colDrag.insertAt, colDrag.fromIdx)} 列`}
        </DragGhost>
      )}
    </div>
  );
}
