// NoteBoard 多维表格主编辑器 (Bitable Editor)
// 深度还原飞书多维表格多视图管理（多看板/多表格）+ 拖拽换列 + 树形子任务 + 各字段专有排序 + 撤销重做

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type {
  BitableDocument,
  BitableColumn,
  BitableRow,
  BitableViewConfig,
  BitableViewType,
  FilterRule,
  SortRule,
} from './bitableTypes';
import {
  parseBitableDocument,
  serializeBitableDocument,
  exportBitableToCsv,
} from './bitableConverter';
import { BitableGridView } from './BitableGridView';
import { BitableKanbanView } from './BitableKanbanView';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
import { showToast } from '../../stores/toastStore';
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

  // 视图管理状态
  const [editingViewId, setEditingViewId] = useState<string | null>(null);
  const [viewNameInput, setViewNameInput] = useState('');
  const [activeViewMenuId, setActiveViewMenuId] = useState<string | null>(null);
  const [showAddViewMenu, setShowAddViewMenu] = useState(false);

  // 外层包裹容器 ref，防止点击按钮时误触发 handleClickOutside
  const addViewContainerRef = useRef<HTMLDivElement>(null);
  const viewTabsContainerRef = useRef<HTMLDivElement>(null);

  // 1. 初始化并注册统一文档历史适配器
  useEffect(() => {
    const initialContent = doc?.content ?? '';
    initializeDocumentHistory(docKey, initialContent, 'bitable');

    const unregister = registerDocumentHistoryAdapter(docKey, {
      applyEntry: (entry) => {
        const parsed = parseBitableDocument(entry.content);
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
      setData(parsed);
    }
  }, [docKey]);

  // 点击外部关闭新建视图与视图下拉菜单
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (addViewContainerRef.current && !addViewContainerRef.current.contains(e.target as Node)) {
        setShowAddViewMenu(false);
      }
      if (viewTabsContainerRef.current && !viewTabsContainerRef.current.contains(e.target as Node)) {
        setActiveViewMenuId(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // 3. 提交数据变更并记录到文档历史
  const commitChange = useCallback(
    (nextDoc: BitableDocument) => {
      setData(nextDoc);
      const serialized = serializeBitableDocument(nextDoc);
      setContent(docKey, serialized);
      setDirty(docKey, true);
      setTabDirty(docKey, true);
      recordDocumentChange(docKey, serialized, {
        mode: 'bitable',
        startsNewGroup: true,
      });
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
    commitChange({ ...data, activeViewId: viewId });
    markDocumentHistoryModeBoundary(docKey);
  };

  const handleCreateView = (type: BitableViewType) => {
    setShowAddViewMenu(false);
    const newView: BitableViewConfig = {
      id: `view_${Date.now()}`,
      name: type === 'grid' ? `表格视图 ${data.views.length + 1}` : `看板视图 ${data.views.length + 1}`,
      type,
      groupByColumnId: type === 'kanban' ? data.columns.find((c) => c.type === 'select')?.id : undefined,
    };
    const nextViews = [...data.views, newView];
    commitChange({ ...data, views: nextViews, activeViewId: newView.id });
    showToast(`已创建 ${newView.name}`);
  };

  const handleRenameView = (viewId: string) => {
    if (!viewNameInput.trim()) {
      setEditingViewId(null);
      return;
    }
    const nextViews = data.views.map((v) => (v.id === viewId ? { ...v, name: viewNameInput.trim() } : v));
    commitChange({ ...data, views: nextViews });
    setEditingViewId(null);
  };

  const handleDuplicateView = (view: BitableViewConfig) => {
    setActiveViewMenuId(null);
    const dupView: BitableViewConfig = {
      ...view,
      id: `view_${Date.now()}`,
      name: `${view.name} (副本)`,
    };
    const nextViews = [...data.views, dupView];
    commitChange({ ...data, views: nextViews, activeViewId: dupView.id });
    showToast('已复制视图');
  };

  const handleDeleteView = (viewId: string) => {
    setActiveViewMenuId(null);
    if (data.views.length <= 1) {
      showToast('至少保留一个视图');
      return;
    }
    const nextViews = data.views.filter((v) => v.id !== viewId);
    const nextActiveId = data.activeViewId === viewId ? nextViews[0].id : data.activeViewId;
    commitChange({ ...data, views: nextViews, activeViewId: nextActiveId });
    showToast('已删除视图');
  };

  const handleUpdateGroupByColumnId = (newColId: string) => {
    const nextViews = data.views.map((v) => (v.id === activeView.id ? { ...v, groupByColumnId: newColId } : v));
    commitChange({ ...data, views: nextViews });
  };

  // ── 各字段类型专有排序 ──

  const handleSortColumn = useCallback(
    (colId: string, direction: 'asc' | 'desc' | null) => {
      const sortRules: SortRule[] = direction ? [{ columnId: colId, direction }] : [];
      const nextViews = data.views.map((v) => (v.id === activeView.id ? { ...v, sortRules } : v));
      commitChange({ ...data, views: nextViews });
    },
    [data, activeView.id, commitChange],
  );

  // ── 行记录与子行管理 ──

  const handleUpdateRow = useCallback(
    (rowId: string, colId: string, val: unknown) => {
      const nextRows = data.rows.map((r) => {
        if (r.id === rowId) {
          return { ...r, [colId]: val, _updatedAt: Date.now() };
        }
        return r;
      });
      commitChange({ ...data, rows: nextRows });
    },
    [data, commitChange],
  );

  const handleAddRow = useCallback(() => {
    const newRow: BitableRow = {
      id: `row_${Date.now()}`,
      _createdAt: Date.now(),
      _updatedAt: Date.now(),
    };
    data.columns.forEach((col) => {
      if (col.type === 'progress') newRow[col.id] = 0;
      if (col.type === 'rating') newRow[col.id] = 0;
      if (col.type === 'checkbox') newRow[col.id] = false;
    });
    commitChange({ ...data, rows: [...data.rows, newRow] });
  }, [data, commitChange]);

  const handleAddSubRow = useCallback(
    (parentRowId: string) => {
      const newSubRow: BitableRow = {
        id: `row_${Date.now()}`,
        parentId: parentRowId,
        _createdAt: Date.now(),
        _updatedAt: Date.now(),
      };
      // 插入在父行紧邻下方
      const parentIdx = data.rows.findIndex((r) => r.id === parentRowId);
      const nextRows = [...data.rows];
      if (parentIdx >= 0) {
        nextRows.splice(parentIdx + 1, 0, newSubRow);
      } else {
        nextRows.push(newSubRow);
      }
      commitChange({ ...data, rows: nextRows });
      showToast('已添加子任务');
    },
    [data, commitChange],
  );

  const handleInsertRowAbove = useCallback(
    (rowId: string) => {
      const targetRow = data.rows.find((r) => r.id === rowId);
      const newRow: BitableRow = {
        id: `row_${Date.now()}`,
        parentId: targetRow?.parentId,
        _createdAt: Date.now(),
        _updatedAt: Date.now(),
      };
      const idx = data.rows.findIndex((r) => r.id === rowId);
      const nextRows = [...data.rows];
      if (idx >= 0) {
        nextRows.splice(idx, 0, newRow);
      } else {
        nextRows.unshift(newRow);
      }
      commitChange({ ...data, rows: nextRows });
    },
    [data, commitChange],
  );

  const handleInsertRowBelow = useCallback(
    (rowId: string) => {
      const targetRow = data.rows.find((r) => r.id === rowId);
      const newRow: BitableRow = {
        id: `row_${Date.now()}`,
        parentId: targetRow?.parentId,
        _createdAt: Date.now(),
        _updatedAt: Date.now(),
      };
      const idx = data.rows.findIndex((r) => r.id === rowId);
      const nextRows = [...data.rows];
      if (idx >= 0) {
        nextRows.splice(idx + 1, 0, newRow);
      } else {
        nextRows.push(newRow);
      }
      commitChange({ ...data, rows: nextRows });
    },
    [data, commitChange],
  );

  const handleAddRowWithStatus = useCallback(
    (statusColId: string, optionId: string | null) => {
      const newRow: BitableRow = {
        id: `row_${Date.now()}`,
        [statusColId]: optionId,
        _createdAt: Date.now(),
        _updatedAt: Date.now(),
      };
      commitChange({ ...data, rows: [...data.rows, newRow] });
    },
    [data, commitChange],
  );

  const handleDeleteRow = useCallback(
    (rowId: string) => {
      // 级联删除该行以及其所有子行
      const idsToDelete = new Set<string>([rowId]);
      let changed = true;
      while (changed) {
        changed = false;
        data.rows.forEach((r) => {
          if (r.parentId && idsToDelete.has(r.parentId) && !idsToDelete.has(r.id)) {
            idsToDelete.add(r.id);
            changed = true;
          }
        });
      }
      const nextRows = data.rows.filter((r) => !idsToDelete.has(r.id));
      commitChange({ ...data, rows: nextRows });
    },
    [data, commitChange],
  );

  // ── 列与字段管理 ──

  const handleUpdateColumn = useCallback(
    (colId: string, partial: Partial<BitableColumn>) => {
      const nextCols = data.columns.map((c) => {
        if (c.id === colId) {
          return { ...c, ...partial };
        }
        return c;
      });
      commitChange({ ...data, columns: nextCols });
    },
    [data, commitChange],
  );

  const handleAddColumn = useCallback(
    (direction: 'left' | 'right', referenceColId?: string) => {
      const newCol: BitableColumn = {
        id: `col_${Date.now()}`,
        key: `field_${Date.now()}`,
        name: '新字段',
        type: 'text',
        width: 160,
      };

      let nextCols = [...data.columns];
      if (referenceColId) {
        const idx = nextCols.findIndex((c) => c.id === referenceColId);
        if (idx >= 0) {
          const insertIdx = direction === 'left' ? idx : idx + 1;
          nextCols.splice(insertIdx, 0, newCol);
        } else {
          nextCols.push(newCol);
        }
      } else {
        nextCols.push(newCol);
      }

      commitChange({ ...data, columns: nextCols });
    },
    [data, commitChange],
  );

  const handleDeleteColumn = useCallback(
    (colId: string) => {
      if (data.columns.length <= 1) {
        showToast('至少保留一列');
        return;
      }
      const nextCols = data.columns.filter((c) => c.id !== colId);
      commitChange({ ...data, columns: nextCols });
    },
    [data, commitChange],
  );

  const handleClearColumn = useCallback(
    (colId: string) => {
      const nextRows = data.rows.map((r) => ({ ...r, [colId]: null }));
      commitChange({ ...data, rows: nextRows });
    },
    [data, commitChange],
  );

  const handleMoveColumn = useCallback(
    (colId: string, direction: 'left' | 'right') => {
      const idx = data.columns.findIndex((c) => c.id === colId);
      if (idx < 0) return;
      const targetIdx = direction === 'left' ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= data.columns.length) return;

      const nextCols = [...data.columns];
      const [moved] = nextCols.splice(idx, 1);
      nextCols.splice(targetIdx, 0, moved);
      commitChange({ ...data, columns: nextCols });
      showToast(`已${direction === 'left' ? '向左' : '向右'}移动列`);
    },
    [data, commitChange],
  );

  const handleReorderColumns = useCallback(
    (fromIdx: number, toIdx: number) => {
      if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0) return;
      const nextCols = [...data.columns];
      const [moved] = nextCols.splice(fromIdx, 1);
      nextCols.splice(toIdx, 0, moved);
      commitChange({ ...data, columns: nextCols });
    },
    [data, commitChange],
  );

  // 导出 CSV
  const handleExportCsv = () => {
    try {
      const csv = exportBitableToCsv(data);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${data.title || '多维表格'}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('成功导出为 CSV 表格数据');
    } catch (e) {
      console.error('导出 CSV 失败:', e);
      showToast('导出 CSV 失败');
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

    // 2. 字段类型专有排序
    const sortRule = activeView.sortRules?.[0];
    if (sortRule) {
      const targetCol = data.columns.find((c) => c.id === sortRule.columnId);
      const colType = targetCol?.type || 'text';
      const colId = sortRule.columnId;
      const isAsc = sortRule.direction === 'asc';

      result.sort((a, b) => {
        const valA = a[colId];
        const valB = b[colId];

        // 空值后置
        if (valA === undefined || valA === null || valA === '') {
          return valB === undefined || valB === null || valB === '' ? 0 : 1;
        }
        if (valB === undefined || valB === null || valB === '') return -1;

        let cmp = 0;
        if (colType === 'number' || colType === 'progress' || colType === 'rating') {
          cmp = Number(valA) - Number(valB);
        } else if (colType === 'date') {
          cmp = String(valA).localeCompare(String(valB));
        } else if (colType === 'checkbox') {
          cmp = (Boolean(valA) === Boolean(valB) ? 0 : Boolean(valA) ? 1 : -1);
        } else if (colType === 'select') {
          const idxA = (targetCol?.options || []).findIndex((o) => o.id === valA);
          const idxB = (targetCol?.options || []).findIndex((o) => o.id === valB);
          cmp = idxA - idxB;
        } else {
          // 文本、链接等使用中文拼音/自然排序
          cmp = String(valA).localeCompare(String(valB), 'zh-CN', { numeric: true });
        }

        return isAsc ? cmp : -cmp;
      });
    }

    return result;
  }, [data.rows, data.columns, searchQuery, activeView.sortRules]);

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
      {/* 顶部飞书风格多视图 Tab 栏 + 搜索 + 导出 + 添加行 */}
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
        <div ref={viewTabsContainerRef} style={{ display: 'flex', alignItems: 'center', gap: 4, overflowX: 'auto', flex: 1 }}>
          {data.views.map((v) => {
            const isActive = v.id === activeView.id;
            const isEditingThis = editingViewId === v.id;
            const isMenuOpen = activeViewMenuId === v.id;

            return (
              <div
                key={v.id}
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
                  cursor: 'pointer',
                  fontWeight: isActive ? 600 : 400,
                  fontSize: 12,
                  transition: 'all 0.15s ease',
                  flexShrink: 0,
                }}
                onClick={() => handleSelectView(v.id)}
              >
                {v.type === 'grid' ? <TableIcon size={13} /> : <Kanban size={13} />}

                {isEditingThis ? (
                  <input
                    type="text"
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
                  onClick={(e) => {
                    e.stopPropagation();
                    setActiveViewMenuId(isMenuOpen ? null : v.id);
                  }}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    padding: 0,
                    color: 'inherit',
                    opacity: 0.6,
                    display: 'flex',
                    alignItems: 'center',
                  }}
                >
                  <ChevronDown size={11} />
                </button>

                {/* 视图配置浮动菜单 */}
                {isMenuOpen && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      position: 'absolute',
                      top: '100%',
                      left: 0,
                      marginTop: 4,
                      width: 140,
                      background: 'var(--editor-surface, #ffffff)',
                      border: '1px solid var(--editor-border, #e2e8f0)',
                      borderRadius: 6,
                      boxShadow: '0 6px 20px rgba(0,0,0,0.1)',
                      padding: 4,
                      zIndex: 9999,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 2,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setViewNameInput(v.name);
                        setEditingViewId(v.id);
                        setActiveViewMenuId(null);
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '4px 8px',
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        fontSize: 12,
                        borderRadius: 4,
                        color: 'var(--editor-text, #1e293b)',
                      }}
                    >
                      <Edit2 size={12} />
                      <span>重命名</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDuplicateView(v)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '4px 8px',
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        fontSize: 12,
                        borderRadius: 4,
                        color: 'var(--editor-text, #1e293b)',
                      }}
                    >
                      <Copy size={12} />
                      <span>复制视图</span>
                    </button>
                    {data.views.length > 1 && (
                      <button
                        type="button"
                        onClick={() => handleDeleteView(v.id)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '4px 8px',
                          border: 'none',
                          background: 'transparent',
                          cursor: 'pointer',
                          fontSize: 12,
                          borderRadius: 4,
                          color: '#ef4444',
                        }}
                      >
                        <Trash2 size={12} />
                        <span>删除视图</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* 新建视图 `+` 按钮与下拉菜单（包裹容器绑定 addViewContainerRef） */}
          <div ref={addViewContainerRef} style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => setShowAddViewMenu((prev) => !prev)}
              title="新建视图"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 26,
                height: 26,
                borderRadius: 4,
                border: '1px solid var(--editor-border, #cbd5e1)',
                background: 'var(--editor-bg, #ffffff)',
                color: 'var(--editor-text-muted, #64748b)',
                cursor: 'pointer',
              }}
            >
              <Plus size={13} />
            </button>

            {showAddViewMenu && (
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  marginTop: 4,
                  width: 150,
                  background: 'var(--editor-surface, #ffffff)',
                  border: '1px solid var(--editor-border, #e2e8f0)',
                  borderRadius: 6,
                  boxShadow: '0 6px 20px rgba(0,0,0,0.1)',
                  padding: 4,
                  zIndex: 9999,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                }}
              >
                <button
                  type="button"
                  onClick={() => handleCreateView('grid')}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '5px 8px',
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    fontSize: 12,
                    borderRadius: 4,
                    color: 'var(--editor-text, #1e293b)',
                  }}
                >
                  <TableIcon size={13} color="#3b82f6" />
                  <span>新建表格视图</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleCreateView('kanban')}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '5px 8px',
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    fontSize: 12,
                    borderRadius: 4,
                    color: 'var(--editor-text, #1e293b)',
                  }}
                >
                  <Kanban size={13} color="#8b5cf6" />
                  <span>新建看板视图</span>
                </button>
              </div>
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
                onClick={() => setSearchQuery('')}
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 0 }}
              >
                <X size={12} />
              </button>
            )}
          </div>

          {/* 导出按钮 */}
          <button
            type="button"
            onClick={handleExportCsv}
            title="导出为 CSV 表格"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '4px 8px',
              borderRadius: 5,
              border: '1px solid var(--editor-border, #e2e8f0)',
              background: 'var(--editor-bg, #ffffff)',
              color: 'var(--editor-text, #1e293b)',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            <FileSpreadsheet size={13} />
            <span>导出 CSV</span>
          </button>

          {/* 新增记录按钮 */}
          <button
            type="button"
            onClick={handleAddRow}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '4px 10px',
              borderRadius: 5,
              border: 'none',
              background: 'var(--editor-accent, #3b82f6)',
              color: '#ffffff',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            <Plus size={13} />
            <span>新建记录</span>
          </button>
        </div>
      </div>

      {/* 主视图分发渲染 */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {activeView.type === 'grid' ? (
          <BitableGridView
            columns={data.columns}
            rows={filteredAndSortedRows}
            currentSortRule={activeView.sortRules?.[0] || null}
            onSortColumn={handleSortColumn}
            onUpdateRow={handleUpdateRow}
            onAddRow={handleAddRow}
            onAddSubRow={handleAddSubRow}
            onInsertRowAbove={handleInsertRowAbove}
            onInsertRowBelow={handleInsertRowBelow}
            onDeleteRow={handleDeleteRow}
            onUpdateColumn={handleUpdateColumn}
            onAddColumn={handleAddColumn}
            onDeleteColumn={handleDeleteColumn}
            onClearColumn={handleClearColumn}
            onMoveColumn={handleMoveColumn}
            onReorderColumns={handleReorderColumns}
          />
        ) : (
          <BitableKanbanView
            columns={data.columns}
            rows={filteredAndSortedRows}
            groupByColumnId={activeView.groupByColumnId}
            onUpdateGroupByColumnId={handleUpdateGroupByColumnId}
            onUpdateRow={handleUpdateRow}
            onAddRowWithStatus={handleAddRowWithStatus}
            onDeleteRow={handleDeleteRow}
          />
        )}
      </div>
    </div>
  );
}
