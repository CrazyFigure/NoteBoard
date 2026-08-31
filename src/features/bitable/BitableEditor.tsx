// NoteBoard 多维表格主编辑器 (Bitable Editor)
// 深度还原多维表格多视图管理（多看板/多表格）+ 拖拽换列 + 树形子任务 + 各字段专有排序 + 撤销重做

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type {
  BitableDocument,
  BitableColumn,
  BitableRow,
  BitableViewConfig,
  BitableViewType,
  ColumnOptionAction,
  SortRule,
} from './bitableTypes';
import {
  parseBitableDocument,
  serializeBitableDocument,
  exportBitableToCsv,
} from './bitableConverter';
import { BitableGridView } from './BitableGridView';
import { BitableKanbanView } from './BitableKanbanView';
import { BitableRecordPanel } from './BitableRecordPanel';
import { DragGhost, FloatingPanel, getAnchorRect, type AnchorRect } from './BitableFloating';
import { usePointerReorder } from './usePointerReorder';
import {
  coerceCellValue,
  compareRowsBySortRules,
  createId,
  createRow,
  moveOptionByIndex,
  moveTreeRow,
  pickNextColor,
  previewLongText,
  resolveLongTextConfig,
  slotToFinalPosition,
} from './bitableUtils';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
import { showToast } from '../../stores/toastStore';
import { exportBlobWithDialog } from '../export/chartExport';
import {
  initializeDocumentHistory,
  registerDocumentHistoryAdapter,
  recordDocumentChange,
  undoDocumentHistory,
  redoDocumentHistory,
  markDocumentHistoryModeBoundary,
} from '../history/documentHistory';
import {
  Table as TableIcon,
  Kanban,
  Search,
  Plus,
  X,
  FileSpreadsheet,
  Edit2,
  Copy,
  Trash2,
  ChevronDown,
} from 'lucide-react';

interface BitableEditorProps {
  docKey: string;
}

export function BitableEditor({ docKey }: BitableEditorProps) {
  const doc = useDocumentStore((s) => s.documents.get(docKey));
  const setContent = useDocumentStore((s) => s.setContent);
  const setDirty = useDocumentStore((s) => s.setDirty);
  const setTabDirty = useWindowStore((s) => s.setTabDirty);

  // 多维表格内部完整文档状态
  const [data, setData] = useState<BitableDocument>(() => {
    return parseBitableDocument(doc?.content ?? '');
  });

  const [searchQuery, setSearchQuery] = useState('');

  // 视图管理状态：下拉菜单统一走 Portal 浮层，需记录锚点与触发元素
  const [editingViewId, setEditingViewId] = useState<string | null>(null);
  const [viewNameInput, setViewNameInput] = useState('');
  const [viewMenu, setViewMenu] = useState<{
    viewId: string;
    anchor: AnchorRect;
    trigger: HTMLElement;
  } | null>(null);
  const [addViewMenu, setAddViewMenu] = useState<{
    anchor: AnchorRect;
    trigger: HTMLElement;
  } | null>(null);

  // 右侧记录详情侧边栏：以「收集单」形式编辑单条记录
  const [recordPanelRowId, setRecordPanelRowId] = useState<string | null>(null);

  /**
   * 文档数据的最新快照
   * 同一次交互内可能连续提交多次（例如「新增标签选项」既要改列定义又要改单元格值），
   * 若每次都基于渲染闭包中的 data，后一次提交会覆盖前一次的结果。
   * 这里用 ref 同步保存最新值，保证同批次提交严格串行叠加。
   */
  const dataRef = useRef<BitableDocument>(data);
  dataRef.current = data;

  // 1. 初始化并注册统一文档历史适配器
  useEffect(() => {
    const initialContent = doc?.content ?? '';
    initializeDocumentHistory(docKey, initialContent, 'bitable');

    const unregister = registerDocumentHistoryAdapter(docKey, {
      applyEntry: (entry) => {
        const parsed = parseBitableDocument(entry.content);
        dataRef.current = parsed;
        setData(parsed);
        setContent(docKey, entry.content);
        setDirty(docKey, true);
        setTabDirty(docKey, true);
      },
    });

    return unregister;
  }, [docKey]);

  // 2. 当外部文档内容变动时同步
  useEffect(() => {
    if (doc?.content != null) {
      const parsed = parseBitableDocument(doc.content);
      dataRef.current = parsed;
      setData(parsed);
    }
  }, [docKey]);

  // 待写入历史的快照：同一次交互内的多次提交合并为一条撤销记录
  const pendingHistoryRef = useRef<{ timer: number | null; content: string | null }>({
    timer: null,
    content: null,
  });

  // 组件卸载前冲刷未落库的历史记录
  useEffect(() => {
    const pending = pendingHistoryRef.current;
    return () => {
      if (pending.timer !== null) {
        window.clearTimeout(pending.timer);
        pending.timer = null;
      }
      if (pending.content !== null) {
        recordDocumentChange(docKey, pending.content, { mode: 'bitable', startsNewGroup: true });
        pending.content = null;
      }
    };
  }, [docKey]);

  // 3. 提交数据变更并记录到文档历史
  // 支持函数式更新：无论同批次内调用多少次，每次都能基于最新文档继续叠加
  const commitChange = useCallback(
    (updater: BitableDocument | ((prev: BitableDocument) => BitableDocument)) => {
      const prev = dataRef.current;
      const nextDoc = typeof updater === 'function' ? updater(prev) : updater;
      if (!nextDoc || nextDoc === prev) return;

      dataRef.current = nextDoc;
      setData(nextDoc);

      const serialized = serializeBitableDocument(nextDoc);
      setContent(docKey, serialized);
      setDirty(docKey, true);
      setTabDirty(docKey, true);

      // 延迟到本轮事件结束再记录历史：把一次交互产生的多步提交合并为单条撤销记录
      const pending = pendingHistoryRef.current;
      pending.content = serialized;
      if (pending.timer === null) {
        pending.timer = window.setTimeout(() => {
          pending.timer = null;
          const content = pending.content;
          pending.content = null;
          if (content !== null) {
            recordDocumentChange(docKey, content, { mode: 'bitable', startsNewGroup: true });
          }
        }, 0);
      }
    },
    [docKey, setContent, setDirty, setTabDirty],
  );

  // 获取当前激活的视图配置
  const activeView: BitableViewConfig = useMemo(() => {
    return data.views.find((v) => v.id === data.activeViewId) || data.views[0] || {
      id: 'default_grid',
      name: '表格视图',
      type: 'grid',
    };
  }, [data.views, data.activeViewId]);

  // ── 视图管理（切换/新建/重命名/复制/删除） ──

  const handleSelectView = (viewId: string) => {
    commitChange((prev) => ({ ...prev, activeViewId: viewId }));
    markDocumentHistoryModeBoundary(docKey);
  };

  const handleCreateView = (type: BitableViewType) => {
    setAddViewMenu(null);
    let createdName = type === 'grid' ? '表格视图' : '看板视图';
    const newViewId = createId('view');
    commitChange((prev) => {
      createdName = type === 'grid' ? `表格视图 ${prev.views.length + 1}` : `看板视图 ${prev.views.length + 1}`;
      // 看板视图必须绑定分组列，缺省取第一个单选列，保证新建后立刻能看到泳道
      const groupByColumnId = type === 'kanban' ? prev.columns.find((c) => c.type === 'select')?.id : undefined;
      return {
        ...prev,
        views: [...prev.views, { id: newViewId, name: createdName, type, groupByColumnId }],
        activeViewId: newViewId,
      };
    });
    showToast(`已创建 ${createdName}`);
  };

  const handleRenameView = (viewId: string) => {
    if (!viewNameInput.trim()) {
      setEditingViewId(null);
      return;
    }
    commitChange((prev) => ({
      ...prev,
      views: prev.views.map((v) => (v.id === viewId ? { ...v, name: viewNameInput.trim() } : v)),
    }));
    setEditingViewId(null);
  };

  const handleDuplicateView = (view: BitableViewConfig) => {
    setViewMenu(null);
    const dupView: BitableViewConfig = {
      ...view,
      id: createId('view'),
      name: `${view.name} (副本)`,
    };
    commitChange((prev) => ({
      ...prev,
      views: [...prev.views, dupView],
      activeViewId: dupView.id,
    }));
    showToast('已复制视图');
  };

  const handleDeleteView = (viewId: string) => {
    setViewMenu(null);
    if (data.views.length <= 1) {
      showToast('至少保留一个视图');
      return;
    }
    commitChange((prev) => {
      const nextViews = prev.views.filter((v) => v.id !== viewId);
      const nextActiveId = prev.activeViewId === viewId ? nextViews[0].id : prev.activeViewId;
      return { ...prev, views: nextViews, activeViewId: nextActiveId };
    });
    showToast('已删除视图');
  };

  const handleUpdateGroupByColumnId = (newColId: string) => {
    commitChange((prev) => ({
      ...prev,
      views: prev.views.map((v) => (v.id === activeView.id ? { ...v, groupByColumnId: newColId } : v)),
    }));
  };

  // ── 多字段联合排序 ──

  const handleUpdateSortRules = useCallback(
    (sortRules: SortRule[]) => {
      commitChange((prev) => ({
        ...prev,
        views: prev.views.map((v) => (v.id === activeView.id ? { ...v, sortRules } : v)),
      }));
    },
    [activeView.id, commitChange],
  );

  // ── 行记录与子行管理 ──

  const handleUpdateRow = useCallback(
    (rowId: string, colId: string, val: unknown) => {
      commitChange((prev) => ({
        ...prev,
        rows: prev.rows.map((r) => (r.id === rowId ? { ...r, [colId]: val, _updatedAt: Date.now() } : r)),
      }));
    },
    [commitChange],
  );

  const handleAddRow = useCallback(() => {
    commitChange((prev) => ({ ...prev, rows: [...prev.rows, createRow(prev.columns)] }));
  }, [commitChange]);

  const handleAddSubRow = useCallback(
    (parentRowId: string) => {
      commitChange((prev) => {
        const newSubRow: BitableRow = { ...createRow(prev.columns), parentId: parentRowId };
        const parentIdx = prev.rows.findIndex((r) => r.id === parentRowId);
        const nextRows = [...prev.rows];
        // 插入在父行紧邻下方
        if (parentIdx >= 0) nextRows.splice(parentIdx + 1, 0, newSubRow);
        else nextRows.push(newSubRow);
        return { ...prev, rows: nextRows };
      });
      showToast('已添加子任务');
    },
    [commitChange],
  );

  const handleInsertRowAbove = useCallback(
    (rowId: string) => {
      commitChange((prev) => {
        const targetRow = prev.rows.find((r) => r.id === rowId);
        const newRow: BitableRow = { ...createRow(prev.columns), parentId: targetRow?.parentId };
        const idx = prev.rows.findIndex((r) => r.id === rowId);
        const nextRows = [...prev.rows];
        if (idx >= 0) nextRows.splice(idx, 0, newRow);
        else nextRows.unshift(newRow);
        return { ...prev, rows: nextRows };
      });
    },
    [commitChange],
  );

  const handleInsertRowBelow = useCallback(
    (rowId: string) => {
      commitChange((prev) => {
        const targetRow = prev.rows.find((r) => r.id === rowId);
        const newRow: BitableRow = { ...createRow(prev.columns), parentId: targetRow?.parentId };
        const idx = prev.rows.findIndex((r) => r.id === rowId);
        const nextRows = [...prev.rows];
        if (idx >= 0) nextRows.splice(idx + 1, 0, newRow);
        else nextRows.push(newRow);
        return { ...prev, rows: nextRows };
      });
    },
    [commitChange],
  );

  /**
   * 拖拽行头换序：父级改写与顺序重排必须在同一次提交内完成
   * 顺序由 moveTreeRow 基于完整树序计算，被拖行的整棵子树会一起搬走。
   */
  const handleMoveRow = useCallback(
    (draggedRowId: string, beforeRowId: string | null, parentId?: string) => {
      commitChange((prev) => {
        const nextRows = moveTreeRow(prev.rows, draggedRowId, beforeRowId, parentId);
        // 落点非法（如拖进自己的子树）时工具函数原样返回，不产生撤销记录
        if (nextRows === prev.rows) return prev;
        return { ...prev, rows: nextRows };
      });
    },
    [commitChange],
  );

  const handleAddRowWithStatus = useCallback(
    (statusColId: string, optionId: string | null) => {
      commitChange((prev) => ({
        ...prev,
        rows: [...prev.rows, createRow(prev.columns, { [statusColId]: optionId })],
      }));
      showToast('已在该分组下新增卡片');
    },
    [commitChange],
  );

  /** 看板新增分组：为分组列追加一个标签选项，即新增一条泳道 */
  const handleAddGroupOption = useCallback(() => {
    const groupColId = activeView.groupByColumnId || data.columns.find((c) => c.type === 'select')?.id;
    const groupCol = data.columns.find((c) => c.id === groupColId);
    if (!groupCol || groupCol.type !== 'select') {
      showToast('请先将分组依据切换为单选字段');
      return;
    }
    const options = groupCol.options || [];
    const newOption = {
      id: createId('opt'),
      label: `新分组 ${options.length + 1}`,
      color: pickNextColor(options),
    };
    commitChange((prev) => ({
      ...prev,
      columns: prev.columns.map((c) =>
        c.id === groupCol.id ? { ...c, options: [...(c.options || []), newOption] } : c,
      ),
    }));
    showToast(`已新增分组「${newOption.label}」`);
  }, [activeView.groupByColumnId, data.columns, commitChange]);

  const handleDeleteRow = useCallback(
    (rowId: string) => {
      commitChange((prev) => {
        // 级联删除该行以及其所有子行
        const idsToDelete = new Set<string>([rowId]);
        let changed = true;
        while (changed) {
          changed = false;
          prev.rows.forEach((r) => {
            if (r.parentId && idsToDelete.has(r.parentId) && !idsToDelete.has(r.id)) {
              idsToDelete.add(r.id);
              changed = true;
            }
          });
        }
        return { ...prev, rows: prev.rows.filter((r) => !idsToDelete.has(r.id)) };
      });
    },
    [commitChange],
  );

  /**
   * 区域粘贴：以 (rowId, colId) 为左上角写入二维文本矩阵
   * 行数越界时自动补建新行；单选/多选遇到不存在的标签会按文本自动创建选项。
   * 整个过程在单次提交内完成，保证「列定义 + 行数据」同时落库。
   */
  const handlePasteCells = useCallback(
    (rowId: string, colId: string, matrix: string[][]) => {
      commitChange((prev) => {
        const colIdx = prev.columns.findIndex((c) => c.id === colId);
        const rowIdx = prev.rows.findIndex((r) => r.id === rowId);
        if (colIdx < 0 || rowIdx < 0) return prev;

        const nextColumns = [...prev.columns];
        const nextRows = [...prev.rows];

        matrix.forEach((line, rowOffset) => {
          const targetRowIdx = rowIdx + rowOffset;
          // 目标行不存在时自动补建，保持与锚点行一致的层级
          while (nextRows.length <= targetRowIdx) {
            nextRows.push({ ...createRow(prev.columns), parentId: nextRows[rowIdx]?.parentId });
          }

          line.forEach((raw, colOffset) => {
            const targetColIdx = colIdx + colOffset;
            if (targetColIdx >= nextColumns.length) return;
            const column = nextColumns[targetColIdx];
            const { value, column: updatedColumn } = coerceCellValue(column, raw);
            if (updatedColumn) nextColumns[targetColIdx] = updatedColumn;
            nextRows[targetRowIdx] = {
              ...nextRows[targetRowIdx],
              [column.id]: value,
              _updatedAt: Date.now(),
            };
          });
        });

        return { ...prev, columns: nextColumns, rows: nextRows };
      });
    },
    [commitChange],
  );

  /**
   * 批量更新单元格数据（选区清空 / 拖拽填充 / 批量修改）
   * 单次提交避免产生多条撤销记录，并支持自动创建不存在的行
   */
  const handleBatchUpdateCells = useCallback(
    (
      updates: Array<{ rowId: string; colId: string; value: unknown }>,
      newRowsToAppend?: BitableRow[],
    ) => {
      commitChange((prev) => {
        let nextRows = [...prev.rows];
        let nextColumns = [...prev.columns];

        if (newRowsToAppend && newRowsToAppend.length > 0) {
          nextRows = [...nextRows, ...newRowsToAppend];
        }

        const rowMap = new Map<string, BitableRow>();
        nextRows.forEach((r) => rowMap.set(r.id, { ...r }));

        updates.forEach(({ rowId, colId, value }) => {
          const row = rowMap.get(rowId);
          if (!row) return;

          const col = nextColumns.find((c) => c.id === colId);
          if (!col) return;

          if (typeof value === 'string') {
            const { value: coerced, column: updatedCol } = coerceCellValue(col, value);
            if (updatedCol) {
              nextColumns = nextColumns.map((c) => (c.id === colId ? updatedCol : c));
            }
            row[colId] = coerced;
          } else {
            row[colId] = value;
          }
          row._updatedAt = Date.now();
        });

        const finalRows = nextRows.map((r) => rowMap.get(r.id) || r);
        return { ...prev, columns: nextColumns, rows: finalRows };
      });
    },
    [commitChange],
  );

  // ── 列与字段管理 ──

  const handleUpdateColumn = useCallback(
    (colId: string, partial: Partial<BitableColumn>) => {
      commitChange((prev) => ({
        ...prev,
        columns: prev.columns.map((c) => (c.id === colId ? { ...c, ...partial } : c)),
      }));
    },
    [commitChange],
  );

  /**
   * 列标签选项的增删改排序
   * 删除选项时必须同步清理所有引用了该选项的单元格，否则会留下悬空的脏数据。
   */
  const handleManageColumnOption = useCallback(
    (colId: string, action: ColumnOptionAction) => {
      commitChange((prev) => {
        const targetCol = prev.columns.find((c) => c.id === colId);
        if (!targetCol) return prev;
        const options = targetCol.options || [];
        let nextOptions = options;
        let removedId: string | null = null;

        if (action.type === 'add') {
          if (options.some((o) => o.id === action.option.id)) return prev;
          nextOptions = [...options, action.option];
        } else if (action.type === 'update') {
          nextOptions = options.map((o) =>
            o.id === action.optionId ? { ...o, label: action.label, color: action.color } : o,
          );
        } else if (action.type === 'delete') {
          nextOptions = options.filter((o) => o.id !== action.optionId);
          removedId = action.optionId;
        } else if (action.type === 'reorder') {
          // 拖拽换序：optionId 为被拖选项，toIndex 为「移除后」的插入索引
          const from = options.findIndex((o) => o.id === action.optionId);
          if (from < 0) return prev;
          nextOptions = moveOptionByIndex(options, from, action.toIndex);
        } else {
          const from = options.findIndex((o) => o.id === action.optionId);
          const to = action.direction === 'up' ? from - 1 : from + 1;
          if (from < 0 || to < 0 || to >= options.length) return prev;
          nextOptions = [...options];
          const [moved] = nextOptions.splice(from, 1);
          nextOptions.splice(to, 0, moved);
        }

        const nextColumns = prev.columns.map((c) =>
          c.id === colId ? { ...c, options: nextOptions } : c,
        );

        if (!removedId) return { ...prev, columns: nextColumns };

        // 清理所有引用了已删除选项的单元格
        const isMulti = targetCol.type === 'multiSelect';
        const nextRows = prev.rows.map((r) => {
          const val = r[colId];
          if (isMulti) {
            if (!Array.isArray(val) || !val.includes(removedId as string)) return r;
            return { ...r, [colId]: val.filter((id: string) => id !== removedId), _updatedAt: Date.now() };
          }
          if (val === removedId) return { ...r, [colId]: null, _updatedAt: Date.now() };
          return r;
        });

        return { ...prev, columns: nextColumns, rows: nextRows };
      });
    },
    [commitChange],
  );

  const handleAddColumn = useCallback(
    (direction: 'left' | 'right', referenceColId?: string) => {
      commitChange((prev) => {
        const newCol: BitableColumn = {
          id: createId('col'),
          key: createId('field'),
          name: '新字段',
          type: 'text',
          width: 160,
        };
        const nextCols = [...prev.columns];
        if (referenceColId) {
          const idx = nextCols.findIndex((c) => c.id === referenceColId);
          const insertIdx = direction === 'left' ? idx : idx + 1;
          if (idx >= 0) nextCols.splice(insertIdx, 0, newCol);
          else nextCols.push(newCol);
        } else {
          nextCols.push(newCol);
        }
        return { ...prev, columns: nextCols };
      });
    },
    [commitChange],
  );

  const handleDeleteColumn = useCallback(
    (colId: string) => {
      if (data.columns.length <= 1) {
        showToast('至少保留一列');
        return;
      }
      commitChange((prev) => ({ ...prev, columns: prev.columns.filter((c) => c.id !== colId) }));
    },
    [data.columns.length, commitChange],
  );

  const handleClearColumn = useCallback(
    (colId: string) => {
      commitChange((prev) => ({
        ...prev,
        rows: prev.rows.map((r) => ({ ...r, [colId]: null })),
      }));
    },
    [commitChange],
  );

  const handleMoveColumn = useCallback(
    (colId: string, direction: 'left' | 'right') => {
      commitChange((prev) => {
        const idx = prev.columns.findIndex((c) => c.id === colId);
        if (idx < 0) return prev;
        const targetIdx = direction === 'left' ? idx - 1 : idx + 1;
        if (targetIdx < 0 || targetIdx >= prev.columns.length) return prev;
        const nextCols = [...prev.columns];
        const [moved] = nextCols.splice(idx, 1);
        nextCols.splice(targetIdx, 0, moved);
        return { ...prev, columns: nextCols };
      });
      showToast(`已${direction === 'left' ? '向左' : '向右'}移动列`);
    },
    [commitChange],
  );

  const handleReorderColumns = useCallback(
    (fromIdx: number, toIdx: number) => {
      if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0) return;
      commitChange((prev) => {
        const nextCols = [...prev.columns];
        if (fromIdx >= nextCols.length) return prev;
        const [moved] = nextCols.splice(fromIdx, 1);
        nextCols.splice(Math.min(toIdx, nextCols.length), 0, moved);
        return { ...prev, columns: nextCols };
      });
      showToast(`已将「${data.columns[fromIdx]?.name ?? ''}」移动到第 ${toIdx + 1} 列`);
    },
    [commitChange, data.columns],
  );

  /** 视图 Tab 拖拽换序：仅调整显示顺序，激活态按 ID 保持不变 */
  const handleReorderViews = useCallback(
    (fromIdx: number, toIdx: number) => {
      commitChange((prev) => {
        if (fromIdx < 0 || fromIdx >= prev.views.length) return prev;
        const nextViews = [...prev.views];
        const [moved] = nextViews.splice(fromIdx, 1);
        nextViews.splice(Math.min(toIdx, nextViews.length), 0, moved);
        return { ...prev, views: nextViews };
      });
    },
    [commitChange],
  );

  // 视图 Tab DOM 节点表：用于测量位置，支撑拖拽排序
  const viewTabRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // 视图 Tab 拖拽排序：与表头换列共用同一套「插入槽位」语义，落点即所得
  const {
    drag: viewDrag,
    startDrag: startViewDrag,
    getIndicator: getViewIndicator,
    grabOffset: viewGrabOffset,
    consumeDraggedFlag,
  } = usePointerReorder<BitableViewConfig>({
    items: data.views,
    getElement: (v) => viewTabRefs.current.get(v.id),
    onReorder: handleReorderViews,
    disabled: editingViewId !== null,
  });

  /**
   * 子行升级为上一级：挂到祖父节点下；已是最外层时保持不变
   * 层级判定与写入都在同一次提交内完成，避免基于过期快照误判
   */
  const handleOutdentRow = useCallback(
    (rowId: string) => {
      let failed = false;
      commitChange((prev) => {
        const idx = prev.rows.findIndex((r) => r.id === rowId);
        if (idx < 0) {
          failed = true;
          return prev;
        }
        const row = prev.rows[idx];
        if (!row.parentId) {
          failed = true;
          return prev;
        }

        const parentIdx = prev.rows.findIndex((r) => r.id === row.parentId);
        // 祖父节点：不存在时该行升级为最外层
        const grandParentId = parentIdx >= 0 ? prev.rows[parentIdx].parentId : undefined;

        const nextRows = [...prev.rows];
        const [moved] = nextRows.splice(idx, 1);
        // 紧跟在原父行之后，保证升级后的层级直观（与其原父行同级且相邻）
        const parentAfterRemove = nextRows.findIndex((r) => r.id === row.parentId);
        const insertIdx = parentAfterRemove >= 0 ? parentAfterRemove + 1 : nextRows.length;

        const nextRow: BitableRow = { ...moved, _updatedAt: Date.now() };
        if (grandParentId) nextRow.parentId = grandParentId;
        else delete nextRow.parentId;

        nextRows.splice(insertIdx, 0, nextRow);
        return { ...prev, rows: nextRows };
      });
      showToast(failed ? '该行已经是第一级' : '已升级为上一级');
    },
    [commitChange],
  );

  /**
   * 行降级为子任务：挂到同层中紧邻上方的行之下
   * 同级判定与写入都在同一次提交内完成，避免基于过期快照误判层级
   */
  const handleIndentRow = useCallback(
    (rowId: string) => {
      let failed = false;
      commitChange((prev) => {
        const idx = prev.rows.findIndex((r) => r.id === rowId);
        if (idx <= 0) {
          failed = true;
          return prev;
        }
        const row = prev.rows[idx];
        let newParentId: string | undefined;
        for (let i = idx - 1; i >= 0; i -= 1) {
          const candidate = prev.rows[i];
          // 仅能降级到同层的上一个兄弟节点之下
          if ((candidate.parentId || undefined) === (row.parentId || undefined)) {
            newParentId = candidate.id;
            break;
          }
        }
        if (!newParentId) {
          failed = true;
          return prev;
        }
        return {
          ...prev,
          rows: prev.rows.map((r) =>
            r.id === rowId ? { ...r, parentId: newParentId, _updatedAt: Date.now() } : r,
          ),
        };
      });
      showToast(failed ? '上方没有同级行，无法降级' : '已降级为子任务');
    },
    [commitChange],
  );

  // 导出 CSV 表格数据（弹出系统另存为对话框）
  const handleExportCsv = async () => {
    try {
      const csv = exportBitableToCsv(data);
      // 添加 UTF-8 BOM，确保 Excel 等软件打开中文不乱码
      const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
      const baseName = data.title?.trim() || '多维表格';
      const defaultFilename = `${baseName}.csv`;
      const filters = [
        { name: 'CSV 表格文件 (*.csv)', extensions: ['csv'] },
        { name: '全部文件 (*.*)', extensions: ['*'] },
      ];
      // 唤起原生对话框保存文件
      const saved = await exportBlobWithDialog(blob, defaultFilename, filters);
      if (saved) {
        showToast('成功导出为 CSV 表格数据', 'success');
      }
    } catch (e) {
      console.error('导出 CSV 失败:', e);
      showToast('导出 CSV 失败', 'error');
    }
  };

  // 数据搜索与基于字段类型专有排序计算
  const filteredAndSortedRows = useMemo(() => {
    let result = [...data.rows];

    // 1. 全局搜索
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      result = result.filter((row) => {
        return data.columns.some((col) => {
          const val = row[col.id];
          if (val === undefined || val === null) return false;
          if (col.type === 'select') {
            const opt = col.options?.find((o) => o.id === val);
            return opt ? opt.label.toLowerCase().includes(q) : false;
          }
          return String(val).toLowerCase().includes(q);
        });
      });
    }

    // 2. 多字段联合排序：按 sortRules 数组顺序依次比较
    const sortRules = activeView.sortRules || [];
    if (sortRules.length > 0) {
      result.sort((a, b) => compareRowsBySortRules(a, b, data.columns, sortRules));
    }

    return result;
  }, [data.rows, data.columns, searchQuery, activeView.sortRules]);

  // 记录详情侧边栏当前展示的行与其上级标题
  const recordPanelRow = useMemo(
    () => (recordPanelRowId ? data.rows.find((r) => r.id === recordPanelRowId) || null : null),
    [recordPanelRowId, data.rows],
  );
  const recordPanelParentTitle = useMemo(() => {
    if (!recordPanelRow || !recordPanelRow.parentId) return undefined;
    const parent = data.rows.find((r) => r.id === recordPanelRow.parentId);
    if (!parent) return undefined;
    // 标题列优先单行文本，其次多行文本（多行只取首行）
    const textCol = data.columns.find((c) => c.type === 'text');
    if (textCol) {
      const val = parent[textCol.id];
      return val === undefined || val === null ? undefined : String(val);
    }
    const longTextCol = data.columns.find((c) => c.type === 'longText');
    if (!longTextCol) return undefined;
    const val = parent[longTextCol.id];
    if (val === undefined || val === null) return undefined;
    return previewLongText(String(val), resolveLongTextConfig(longTextCol)) || undefined;
  }, [recordPanelRow, data.rows, data.columns]);

  // 全局撤销/重做快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        if (e.shiftKey) {
          e.preventDefault();
          redoDocumentHistory(docKey);
        } else {
          e.preventDefault();
          undoDocumentHistory(docKey);
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redoDocumentHistory(docKey);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [docKey]);

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
      {/* 顶部多视图 Tab 栏 + 搜索 + 导出 + 添加行 */}
      <div
        style={{
          height: 42,
          minHeight: 42,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 12px',
          borderBottom: '1px solid var(--editor-border, #e2e8f0)',
          background: 'var(--editor-surface, #f8fafc)',
          userSelect: 'none',
          fontSize: 12,
        }}
      >
        {/* 左侧：多视图 Tab 标签列表 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, overflowX: 'auto', flex: 1 }}>
          {data.views.map((v, viewIdx) => {
            const isActive = v.id === activeView.id;
            const isEditingThis = editingViewId === v.id;
            const isMenuOpen = viewMenu?.viewId === v.id;
            const viewIndicator = getViewIndicator(viewIdx);

            return (
              <div
                key={v.id}
                ref={(el) => {
                  if (el) viewTabRefs.current.set(v.id, el);
                  else viewTabRefs.current.delete(v.id);
                }}
                onMouseDown={(e) => startViewDrag(e, viewIdx)}
                title="拖拽可调整视图顺序 · 双击名称重命名"
                className={`nb-bitable-tab${isActive ? ' is-active' : ''}`}
                style={{
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 10px',
                  borderRadius: 6,
                  border: isActive ? '1px solid var(--editor-border, #cbd5e1)' : '1px solid transparent',
                  background: isActive ? 'var(--editor-bg, #ffffff)' : 'transparent',
                  color: isActive ? 'var(--editor-accent, #3b82f6)' : 'var(--editor-text-muted, #64748b)',
                  cursor: viewDrag ? 'grabbing' : 'grab',
                  fontWeight: isActive ? 600 : 400,
                  fontSize: 12,
                  flexShrink: 0,
                  // 被拖起的 Tab 半透明，落点处绘制插入指示线
                  opacity: viewDrag?.fromIdx === viewIdx ? 0.45 : 1,
                  boxShadow:
                    viewIndicator === 'left'
                      ? 'inset 3px 0 0 #3b82f6'
                      : viewIndicator === 'right'
                        ? 'inset -3px 0 0 #3b82f6'
                        : undefined,
                }}
                onClick={() => {
                  // 拖拽结束会紧跟一次 click，需避免误切换视图
                  if (consumeDraggedFlag()) return;
                  handleSelectView(v.id);
                }}
              >
                {v.type === 'grid' ? <TableIcon size={13} /> : <Kanban size={13} />}

                {isEditingThis ? (
                  <input
                    type="text"
                    data-no-drag
                    value={viewNameInput}
                    autoFocus
                    onChange={(e) => setViewNameInput(e.target.value)}
                    onBlur={() => handleRenameView(v.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRenameView(v.id);
                      if (e.key === 'Escape') setEditingViewId(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      width: 90,
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
                      setViewNameInput(v.name);
                      setEditingViewId(v.id);
                    }}
                  >
                    {v.name}
                  </span>
                )}

                {/* 视图下拉更多菜单按钮 */}
                <button
                  type="button"
                  data-no-drag
                  className="nb-bitable-btn-ghost"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isMenuOpen) {
                      setViewMenu(null);
                      return;
                    }
                    const anchor = getAnchorRect(e.currentTarget);
                    if (anchor) {
                      setViewMenu({ viewId: v.id, anchor, trigger: e.currentTarget as HTMLElement });
                    }
                  }}
                  style={{
                    padding: 2,
                    color: 'inherit',
                    opacity: 0.75,
                  }}
                >
                  <ChevronDown size={11} />
                </button>

                {/* 视图配置浮动菜单（Portal 渲染，避免被 Tab 栏的 overflow 裁剪） */}
                {isMenuOpen && viewMenu && (
                  <FloatingPanel
                    anchor={viewMenu.anchor}
                    trigger={viewMenu.trigger}
                    width={140}
                    onClose={() => setViewMenu(null)}
                  >
                    <button
                      type="button"
                      className="nb-bitable-menu-item"
                      onClick={() => {
                        setViewNameInput(v.name);
                        setEditingViewId(v.id);
                        setViewMenu(null);
                      }}
                    >
                      <Edit2 size={12} />
                      <span>重命名</span>
                    </button>
                    <button
                      type="button"
                      className="nb-bitable-menu-item"
                      onClick={() => handleDuplicateView(v)}
                    >
                      <Copy size={12} />
                      <span>复制视图</span>
                    </button>
                    {data.views.length > 1 && (
                      <button
                        type="button"
                        className="nb-bitable-btn-danger"
                        style={{ width: '100%', justifyContent: 'flex-start' }}
                        onClick={() => handleDeleteView(v.id)}
                      >
                        <Trash2 size={12} />
                        <span>删除视图</span>
                      </button>
                    )}
                  </FloatingPanel>
                )}
              </div>
            );
          })}

          {/* 新建视图 `+` 按钮与下拉菜单（Portal 渲染，避免被 Tab 栏的 overflow 裁剪） */}
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="nb-bitable-btn-secondary"
              onClick={(e) => {
                if (addViewMenu) {
                  setAddViewMenu(null);
                  return;
                }
                const anchor = getAnchorRect(e.currentTarget);
                if (anchor) {
                  setAddViewMenu({ anchor, trigger: e.currentTarget as HTMLElement });
                }
              }}
              title="新建视图"
              style={{
                width: 26,
                height: 26,
                padding: 0,
                background: addViewMenu ? 'var(--editor-bg, #f1f5f9)' : undefined,
                color: 'var(--editor-text-muted, #64748b)',
              }}
            >
              <Plus size={13} />
            </button>

            {addViewMenu && (
              <FloatingPanel
                anchor={addViewMenu.anchor}
                trigger={addViewMenu.trigger}
                width={150}
                onClose={() => setAddViewMenu(null)}
              >
                <button
                  type="button"
                  className="nb-bitable-menu-item"
                  onClick={() => handleCreateView('grid')}
                >
                  <TableIcon size={13} color="#3b82f6" />
                  <span>新建表格视图</span>
                </button>
                <button
                  type="button"
                  className="nb-bitable-menu-item"
                  onClick={() => handleCreateView('kanban')}
                >
                  <Kanban size={13} color="#8b5cf6" />
                  <span>新建看板视图</span>
                </button>
              </FloatingPanel>
            )}
          </div>
        </div>

        {/* 右侧：全局搜索 + 导出 + 添加行 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* 实时搜索框 */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '3px 8px',
              borderRadius: 5,
              background: 'var(--editor-bg, #ffffff)',
              border: '1px solid var(--editor-border, #cbd5e1)',
              width: 150,
            }}
          >
            <Search size={12} style={{ opacity: 0.5 }} />
            <input
              type="text"
              placeholder="搜索表格记录..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                border: 'none',
                background: 'transparent',
                fontSize: 11,
                width: '100%',
                outline: 'none',
                color: 'var(--editor-text, #1e293b)',
              }}
            />
            {searchQuery && (
              <button
                type="button"
                className="nb-bitable-btn-ghost"
                onClick={() => setSearchQuery('')}
                style={{ padding: 1 }}
              >
                <X size={12} />
              </button>
            )}
          </div>

          {/* 导出按钮 */}
          <button
            type="button"
            className="nb-bitable-btn-secondary"
            onClick={handleExportCsv}
            title="导出为 CSV 表格"
          >
            <FileSpreadsheet size={13} />
            <span>导出 CSV</span>
          </button>

          {/* 新增记录按钮 */}
          <button
            type="button"
            className="nb-bitable-btn-primary"
            onClick={handleAddRow}
          >
            <Plus size={13} />
            <span>新建记录</span>
          </button>
        </div>
      </div>

      {/* 视图 Tab 拖拽时的跟随幽灵 */}
      {viewDrag && (
        <DragGhost x={viewDrag.x - viewGrabOffset.x} y={viewDrag.y - viewGrabOffset.y + 4}>
          {data.views[viewDrag.fromIdx]?.name ?? ''}
          {` · 第 ${slotToFinalPosition(viewDrag.insertAt, viewDrag.fromIdx)} 位`}
        </DragGhost>
      )}

      {/* 主视图分发渲染（relative 定位用于承载右侧记录详情侧边栏） */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {activeView.type === 'grid' ? (
          <BitableGridView
            columns={data.columns}
            rows={filteredAndSortedRows}
            sortRules={activeView.sortRules || []}
            groupByColumnId={activeView.groupByColumnId}
            onUpdateGroupByColumnId={handleUpdateGroupByColumnId}
            onUpdateSortRules={handleUpdateSortRules}
            onPasteCells={handlePasteCells}
            onBatchUpdateCells={handleBatchUpdateCells}
            onManageColumnOption={handleManageColumnOption}
            onUpdateRow={handleUpdateRow}
            onAddRow={handleAddRow}
            onAddSubRow={handleAddSubRow}
            onOutdentRow={handleOutdentRow}
            onIndentRow={handleIndentRow}
            onOpenRecord={setRecordPanelRowId}
            onInsertRowAbove={handleInsertRowAbove}
            onInsertRowBelow={handleInsertRowBelow}
            onDeleteRow={handleDeleteRow}
            onUpdateColumn={handleUpdateColumn}
            onAddColumn={handleAddColumn}
            onDeleteColumn={handleDeleteColumn}
            onClearColumn={handleClearColumn}
            onMoveColumn={handleMoveColumn}
            onReorderColumns={handleReorderColumns}
            onMoveRow={handleMoveRow}
          />
        ) : (
          <BitableKanbanView
            columns={data.columns}
            rows={filteredAndSortedRows}
            groupByColumnId={activeView.groupByColumnId}
            onUpdateGroupByColumnId={handleUpdateGroupByColumnId}
            onAddRowWithStatus={handleAddRowWithStatus}
            onAddGroupOption={handleAddGroupOption}
            onManageColumnOption={handleManageColumnOption}
            onOpenRecord={setRecordPanelRowId}
            onDeleteRow={handleDeleteRow}
          />
        )}

        {/* 记录详情侧边栏：点击看板卡片或表格行展开 */}
        {recordPanelRow && (
          <BitableRecordPanel
            row={recordPanelRow}
            columns={data.columns}
            parentTitle={recordPanelParentTitle}
            onUpdateRow={handleUpdateRow}
            onManageColumnOption={handleManageColumnOption}
            onDeleteRow={handleDeleteRow}
            onClose={() => setRecordPanelRowId(null)}
          />
        )}
      </div>
    </div>
  );
}
