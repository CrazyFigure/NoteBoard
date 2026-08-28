// NoteBoard 飞书风格多维表格网格视图 (Grid View)
// 支持表头拖拽与左右移动换列、各字段格式专有排序、树形子任务展开收起、选区高亮与剪切/复制/粘贴/删除

import React, { useState, useRef, useEffect, useMemo } from 'react';
import type {
  BitableColumn,
  BitableRow,
  BitableFieldType,
  SelectOption,
  SortRule,
} from './bitableTypes';
import { BitableCellEditor } from './BitableCellEditor';
import { showToast } from '../../stores/toastStore';
import {
  Type,
  Hash,
  Tag,
  Tags,
  Calendar,
  CheckSquare,
  Star,
  BarChart2,
  Link,
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
  onSortColumn?: (colId: string, direction: 'asc' | 'desc' | null) => void;
  onUpdateRow: (rowId: string, columnId: string, val: unknown) => void;
  onAddRow: () => void;
  onAddSubRow?: (parentRowId: string) => void;
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
export function getFieldTypeMeta(type: BitableFieldType) {
  switch (type) {
    case 'text':
      return { icon: <Type size={13} color="#3b82f6" />, label: '文本' };
    case 'number':
      return { icon: <Hash size={13} color="#10b981" />, label: '数字' };
    case 'select':
      return { icon: <Tag size={13} color="#8b5cf6" />, label: '单选' };
    case 'multiSelect':
      return { icon: <Tags size={13} color="#ec4899" />, label: '多选' };
    case 'date':
      return { icon: <Calendar size={13} color="#f59e0b" />, label: '日期' };
    case 'checkbox':
      return { icon: <CheckSquare size={13} color="#06b6d4" />, label: '勾选' };
    case 'rating':
      return { icon: <Star size={13} color="#eab308" />, label: '评分' };
    case 'progress':
      return { icon: <BarChart2 size={13} color="#3b82f6" />, label: '进度' };
    case 'link':
      return { icon: <Link size={13} color="#6366f1" />, label: '超链接' };
  }
}

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
  onSortColumn,
  onUpdateRow,
  onAddRow,
  onAddSubRow,
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
  // 当前打开列头菜单的列 ID
  const [activeMenuColId, setActiveMenuColId] = useState<string | null>(null);
  const [editingColNameId, setEditingColNameId] = useState<string | null>(null);
  const [colNameInput, setColNameInput] = useState('');

  // 折叠的行 ID 集合
  const [collapsedRowIds, setCollapsedRowIds] = useState<Set<string>>(new Set());

  // 选区系统状态 (选中单元格/整行/整列)
  const [selection, setSelection] = useState<SelectionState>({ type: 'none' });

  // 列拖拽排序状态
  const [draggingColIdx, setDraggingColIdx] = useState<number | null>(null);
  const [dragOverColIdx, setDragOverColIdx] = useState<number | null>(null);

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

  // 2. 键盘快捷键监听 (复制、剪切、粘贴、删除、取消选区)
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      // 避免在文本输入框内触发表格级快捷键
      const activeTag = document.activeElement?.tagName.toLowerCase();
      if (activeTag === 'input' || activeTag === 'textarea') {
        return;
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

      // Ctrl+C 复制选区数据
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        if (selection.type === 'cell') {
          const row = rows.find((r) => r.id === selection.rowId);
          const val = row ? row[selection.colId] : '';
          navigator.clipboard.writeText(String(val ?? ''));
          showToast('已复制单元格数据');
        } else if (selection.type === 'row') {
          const row = rows.find((r) => r.id === selection.rowId);
          if (row) {
            const line = columns.map((c) => String(row[c.id] ?? '')).join('\t');
            navigator.clipboard.writeText(line);
            showToast('已复制整行数据');
          }
        } else if (selection.type === 'col') {
          const lines = rows.map((r) => String(r[selection.colId] ?? '')).join('\n');
          navigator.clipboard.writeText(lines);
          showToast('已复制整列数据');
        }
        return;
      }

      // Ctrl+X 剪切选区数据
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') {
        if (selection.type === 'cell') {
          const row = rows.find((r) => r.id === selection.rowId);
          const val = row ? row[selection.colId] : '';
          navigator.clipboard.writeText(String(val ?? ''));
          onUpdateRow(selection.rowId, selection.colId, null);
          showToast('已剪切单元格数据');
        } else if (selection.type === 'row') {
          const row = rows.find((r) => r.id === selection.rowId);
          if (row) {
            const line = columns.map((c) => String(row[c.id] ?? '')).join('\t');
            navigator.clipboard.writeText(line);
            onDeleteRow(selection.rowId);
            setSelection({ type: 'none' });
            showToast('已剪切整行数据');
          }
        } else if (selection.type === 'col') {
          const lines = rows.map((r) => String(r[selection.colId] ?? '')).join('\n');
          navigator.clipboard.writeText(lines);
          if (onClearColumn) {
            onClearColumn(selection.colId);
          }
          showToast('已剪切整列数据');
        }
        return;
      }

      // Ctrl+V 粘贴剪贴板数据
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
        try {
          const text = await navigator.clipboard.readText();
          if (!text) return;

          if (selection.type === 'cell') {
            const col = columns.find((c) => c.id === selection.colId);
            if (!col) return;

            let finalVal: unknown = text.trim();
            if (col.type === 'number' || col.type === 'progress' || col.type === 'rating') {
              const num = Number(finalVal);
              finalVal = isNaN(num) ? 0 : num;
            } else if (col.type === 'checkbox') {
              finalVal = text.trim().toLowerCase() === 'true' || text.trim() === '1' || text.trim() === '是';
            } else if (col.type === 'select') {
              // 匹配标签，不存在则自动新增标签选项
              const matched = col.options?.find((o) => o.label.toLowerCase() === String(finalVal).toLowerCase());
              if (matched) {
                finalVal = matched.id;
              } else if (String(finalVal).trim()) {
                const newOpt: SelectOption = {
                  id: `opt_${Date.now()}`,
                  label: String(finalVal).trim(),
                  color: 'blue',
                };
                const updated = [...(col.options || []), newOpt];
                onUpdateColumn(col.id, { options: updated });
                finalVal = newOpt.id;
              }
            } else if (col.type === 'multiSelect') {
              const tokens = String(finalVal).split(/[,;，；\s]+/).filter(Boolean);
              const optIds: string[] = [];
              const newOptions = [...(col.options || [])];
              let hasNew = false;
              for (const tok of tokens) {
                const m = newOptions.find((o) => o.label.toLowerCase() === tok.toLowerCase());
                if (m) {
                  optIds.push(m.id);
                } else {
                  const newOpt: SelectOption = {
                    id: `opt_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
                    label: tok,
                    color: 'blue',
                  };
                  newOptions.push(newOpt);
                  optIds.push(newOpt.id);
                  hasNew = true;
                }
              }
              if (hasNew) {
                onUpdateColumn(col.id, { options: newOptions });
              }
              finalVal = optIds;
            }

            onUpdateRow(selection.rowId, selection.colId, finalVal);
            showToast('已粘贴数据');
          } else if (selection.type === 'row') {
            // 整行粘贴：按 Tab 分隔符依次填入各列
            const values = text.split('\t');
            columns.forEach((col, idx) => {
              if (idx < values.length) {
                onUpdateRow(selection.rowId, col.id, values[idx]);
              }
            });
            showToast('已粘贴整行数据');
          }
        } catch (err) {
          console.error('粘贴数据失败:', err);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selection, rows, columns, onUpdateRow, onDeleteRow, onClearColumn, onUpdateColumn]);

  // 3. 拖拽调整列宽
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

  // 4. 表头拖拽换列排序
  const handleDragStart = (e: React.DragEvent, index: number) => {
    if (editingColNameId) {
      e.preventDefault();
      return;
    }
    setDraggingColIdx(index);
    e.dataTransfer.setData('text/plain', String(index));
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (draggingColIdx !== null && draggingColIdx !== index) {
      setDragOverColIdx(index);
    }
  };

  const handleDrop = (e: React.DragEvent, toIndex: number) => {
    e.preventDefault();
    if (draggingColIdx !== null && draggingColIdx !== toIndex && onReorderColumns) {
      onReorderColumns(draggingColIdx, toIndex);
    }
    setDraggingColIdx(null);
    setDragOverColIdx(null);
  };

  const handleDragEnd = () => {
    setDraggingColIdx(null);
    setDragOverColIdx(null);
  };

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'auto',
        background: 'var(--editor-bg, #ffffff)',
      }}
      onClick={(e) => {
        // 点击空白处取消菜单与选区
        setActiveMenuColId(null);
        if (e.target === e.currentTarget) {
          setSelection({ type: 'none' });
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
              const sortLabels = getSortLabels(col.type);
              const isMenuOpen = activeMenuColId === col.id;
              const isColSelected = selection.type === 'col' && selection.colId === col.id;
              const isDragOverThis = dragOverColIdx === colIdx;
              const isSortedByThis = currentSortRule?.columnId === col.id;

              return (
                <th
                  key={col.id}
                  draggable={!editingColNameId}
                  onDragStart={(e) => handleDragStart(e, colIdx)}
                  onDragOver={(e) => handleDragOver(e, colIdx)}
                  onDrop={(e) => handleDrop(e, colIdx)}
                  onDragEnd={handleDragEnd}
                  onClick={() => setSelection({ type: 'col', colId: col.id })}
                  style={{
                    width: col.width || 160,
                    minWidth: 90,
                    position: 'sticky',
                    top: 0,
                    zIndex: 5,
                    background: isColSelected ? 'rgba(59, 130, 246, 0.12)' : 'var(--editor-surface, #f8fafc)',
                    borderBottom: '1px solid var(--editor-border, #e2e8f0)',
                    borderRight: '1px solid var(--editor-border, #e2e8f0)',
                    borderLeft: isDragOverThis ? '3px solid #3b82f6' : 'none',
                    padding: '4px 8px',
                    textAlign: 'left',
                    fontWeight: 600,
                    fontSize: 12,
                    color: 'var(--editor-text, #1e293b)',
                    userSelect: 'none',
                    cursor: 'grab',
                    transition: 'background 0.15s ease',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'relative' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, overflow: 'hidden' }}>
                      {meta.icon}
                      {editingColNameId === col.id ? (
                        <input
                          type="text"
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
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveMenuColId(isMenuOpen ? null : col.id);
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

                    {/* 飞书风列配置浮动菜单 */}
                    {isMenuOpen && (
                      <div
                        onClick={(e) => e.stopPropagation()}
                        style={{
                          position: 'absolute',
                          top: '100%',
                          right: 0,
                          marginTop: 6,
                          width: 220,
                          background: 'var(--editor-surface, #ffffff)',
                          border: '1px solid var(--editor-border, #e2e8f0)',
                          borderRadius: 8,
                          boxShadow: '0 8px 24px rgba(0, 0, 0, 0.12)',
                          padding: '4px',
                          zIndex: 9999,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 1,
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setColNameInput(col.name);
                            setEditingColNameId(col.id);
                            setActiveMenuColId(null);
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
                                  setActiveMenuColId(null);
                                }}
                                style={{
                                  flex: 1,
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  gap: 4,
                                  padding: '5px 6px',
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
                                  setActiveMenuColId(null);
                                }}
                                style={{
                                  flex: 1,
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  gap: 4,
                                  padding: '5px 6px',
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
                                setActiveMenuColId(null);
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
                                setActiveMenuColId(null);
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
                                  setActiveMenuColId(null);
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
                                  setActiveMenuColId(null);
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
                            setActiveMenuColId(null);
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
                            setActiveMenuColId(null);
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
                              setActiveMenuColId(null);
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
                            setActiveMenuColId(null);
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
                          <Trash2 size={12} />
                          <span>删除此列</span>
                        </button>
                      </div>
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
                        top: 2,
                        zIndex: 99,
                        background: 'var(--editor-surface, #ffffff)',
                        border: '1px solid var(--editor-border, #e2e8f0)',
                        borderRadius: 6,
                        boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                        padding: '2px 4px',
                        gap: 2,
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {onAddSubRow && (
                        <button
                          type="button"
                          title="添加子任务"
                          onClick={() => onAddSubRow(row.id)}
                          style={{
                            border: 'none',
                            background: 'transparent',
                            cursor: 'pointer',
                            padding: 3,
                            color: 'var(--editor-accent, #3b82f6)',
                            display: 'flex',
                          }}
                        >
                          <CornerDownRight size={12} />
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
                            padding: 3,
                            color: 'var(--editor-text, #334155)',
                            display: 'flex',
                          }}
                        >
                          <ArrowUp size={12} />
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
                            padding: 3,
                            color: 'var(--editor-text, #334155)',
                            display: 'flex',
                          }}
                        >
                          <ArrowDown size={12} />
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
                          padding: 3,
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
                            onUpdateColumnOptions={(newOpts: SelectOption[]) =>
                              onUpdateColumn(col.id, { options: newOpts })
                            }
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
    </div>
  );
}
