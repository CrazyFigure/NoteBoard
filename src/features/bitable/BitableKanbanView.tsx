// NoteBoard 飞书风格多维表格看板视图 (Kanban View)
// 按单选分组字段（如状态、优先级）自动分列泳道，支持卡片流转与泳道内快速新增

import React from 'react';
import type {
  BitableColumn,
  BitableRow,
  SelectOption,
} from './bitableTypes';
import { OptionBadge } from './BitableOptions';
import { Plus, Calendar, Star, SlidersHorizontal, Trash2 } from 'lucide-react';

interface KanbanViewProps {
  columns: BitableColumn[];
  rows: BitableRow[];
  groupByColumnId?: string;
  onUpdateGroupByColumnId?: (colId: string) => void;
  onUpdateRow: (rowId: string, columnId: string, val: unknown) => void;
  onAddRowWithStatus: (columnId: string, optionId: string | null) => void;
  /** 新增分组泳道：为分组列追加一个标签选项 */
  onAddGroupOption?: () => void;
  onDeleteRow: (rowId: string) => void;
}

export function BitableKanbanView({
  columns,
  rows,
  groupByColumnId,
  onUpdateGroupByColumnId,
  onUpdateRow,
  onAddRowWithStatus,
  onAddGroupOption,
  onDeleteRow,
}: KanbanViewProps) {
  // 查找作为分组依据的列（若未指定或不存在，优先选择第一个 select 列，否则选择第一个列）
  const groupColumn =
    (groupByColumnId ? columns.find((c) => c.id === groupByColumnId) : null) ||
    columns.find((c) => c.type === 'select') ||
    columns[0];

  const isSelectGroup = groupColumn?.type === 'select';
  const options: SelectOption[] = isSelectGroup ? groupColumn?.options || [] : [];
  const titleCol = columns.find((c) => c.type === 'text') || columns[0];

  // 按分组列对行进行归类
  const laneMap = new Map<string | null, BitableRow[]>();

  if (isSelectGroup) {
    // 1. 单选标签分组
    options.forEach((opt) => laneMap.set(opt.id, []));
    laneMap.set(null, []); // 未分类
    rows.forEach((row) => {
      const rawVal = groupColumn ? (row[groupColumn.id] as string | undefined) : null;
      const key = rawVal && options.some((o) => o.id === rawVal) ? rawVal : null;
      const list = laneMap.get(key) || [];
      list.push(row);
      laneMap.set(key, list);
    });
  } else {
    // 2. 普通字段（如文本、数字等）按离散唯一值动态分组
    const dynamicValues = new Set<string>();
    rows.forEach((row) => {
      const rawVal = groupColumn ? row[groupColumn.id] : null;
      if (rawVal !== undefined && rawVal !== null && String(rawVal).trim() !== '') {
        dynamicValues.add(String(rawVal));
      }
    });
    dynamicValues.forEach((val) => laneMap.set(val, []));
    laneMap.set(null, []); // 未分类
    rows.forEach((row) => {
      const rawVal = groupColumn ? row[groupColumn.id] : null;
      const key = rawVal !== undefined && rawVal !== null && String(rawVal).trim() !== '' ? String(rawVal) : null;
      const list = laneMap.get(key) || [];
      list.push(row);
      laneMap.set(key, list);
    });
  }

  // 泳道列表定义
  const lanes = isSelectGroup
    ? options.map((opt) => ({
        id: opt.id,
        label: opt.label,
        badge: <OptionBadge option={opt} />,
        rows: laneMap.get(opt.id) || [],
      }))
    : Array.from(laneMap.keys())
        .filter((k): k is string => k !== null)
        .map((val) => ({
          id: val,
          label: val,
          badge: (
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--editor-text, #1e293b)',
                padding: '2px 8px',
                borderRadius: 12,
                background: 'var(--editor-bg, #f1f5f9)',
              }}
            >
              {val}
            </span>
          ),
          rows: laneMap.get(val) || [],
        }));

  // 未分类泳道数据
  const unclassifiedRows = laneMap.get(null) || [];

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--editor-bg, #f8fafc)',
        overflow: 'hidden',
      }}
    >
      {/* 顶部看板控制条：分组维度选择器 */}
      <div
        style={{
          padding: '8px 16px',
          borderBottom: '1px solid var(--editor-border, #e2e8f0)',
          background: 'var(--editor-surface, #ffffff)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          fontSize: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--editor-text-muted, #64748b)' }}>
          <SlidersHorizontal size={13} />
          <span>分组依据:</span>
        </div>
        <select
          value={groupColumn?.id || ''}
          onChange={(e) => {
            if (onUpdateGroupByColumnId) {
              onUpdateGroupByColumnId(e.target.value);
            }
          }}
          style={{
            padding: '3px 8px',
            borderRadius: 4,
            border: '1px solid var(--editor-border, #cbd5e1)',
            background: 'var(--editor-bg, #ffffff)',
            color: 'var(--editor-text, #1e293b)',
            fontSize: 12,
            outline: 'none',
            cursor: 'pointer',
          }}
        >
          {columns.map((col) => (
            <option key={col.id} value={col.id}>
              {col.name} ({col.type})
            </option>
          ))}
        </select>
      </div>

      {/* 看板泳道列表 */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          gap: 16,
          padding: '16px 20px',
          overflowX: 'auto',
          alignItems: 'flex-start',
        }}
      >
        {/* 已定义分组泳道 */}
        {lanes.map((lane) => (
          <div
            key={lane.id}
            style={{
              width: 280,
              minWidth: 280,
              maxHeight: '100%',
              borderRadius: 10,
              background: 'var(--editor-surface, #ffffff)',
              border: '1px solid var(--editor-border, #e2e8f0)',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 1px 4px rgba(0, 0, 0, 0.02)',
              overflow: 'hidden',
            }}
          >
            {/* 泳道头部 */}
            <div
              style={{
                padding: '10px 14px',
                borderBottom: '1px solid var(--editor-border, #f1f5f9)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: 'var(--editor-surface, #ffffff)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {lane.badge}
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--editor-text-muted, #94a3b8)' }}>
                  {lane.rows.length}
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (groupColumn) onAddRowWithStatus(groupColumn.id, lane.id);
                }}
                title="在当前分组下添加卡片"
                style={{
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  padding: 3,
                  borderRadius: 4,
                  color: 'var(--editor-text-muted, #64748b)',
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                <Plus size={14} />
              </button>
            </div>

            {/* 卡片容器列表 */}
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '10px',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              {lane.rows.map((row) => (
                <div
                  key={row.id}
                  style={{
                    padding: '12px 14px',
                    borderRadius: 8,
                    background: 'var(--editor-surface, #ffffff)',
                    border: '1px solid var(--editor-border, #e2e8f0)',
                    boxShadow: '0 2px 6px rgba(0, 0, 0, 0.03)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                    position: 'relative',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = 'var(--editor-border-focus, #cbd5e1)';
                    e.currentTarget.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.06)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = 'var(--editor-border, #e2e8f0)';
                    e.currentTarget.style.boxShadow = '0 2px 6px rgba(0, 0, 0, 0.03)';
                  }}
                >
                  {/* 卡片头部与删除按钮 */}
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 6 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--editor-text, #1e293b)', lineHeight: 1.4, flex: 1 }}>
                      {titleCol ? String(row[titleCol.id] || '未命名任务') : '未命名任务'}
                    </div>
                    <button
                      type="button"
                      title="删除卡片"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteRow(row.id);
                      }}
                      style={{
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        padding: 2,
                        color: 'var(--editor-text-muted, #94a3b8)',
                        opacity: 0.6,
                        display: 'flex',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = '#ef4444';
                        e.currentTarget.style.opacity = '1';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = 'var(--editor-text-muted, #94a3b8)';
                        e.currentTarget.style.opacity = '0.6';
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>

                  {/* 关键属性标签与元数据摘要 */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                    {columns
                      .filter((c) => c.id !== groupColumn.id && c.id !== titleCol?.id)
                      .map((c) => {
                        const val = row[c.id];
                        if (val === undefined || val === null || val === '') return null;

                        if (c.type === 'select') {
                          const optionItem = c.options?.find((o) => o.id === val);
                          return optionItem ? <OptionBadge key={c.id} option={optionItem} /> : null;
                        }

                        if (c.type === 'date') {
                          return (
                            <div
                              key={c.id}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 3,
                                fontSize: 11,
                                color: 'var(--editor-text-muted, #64748b)',
                              }}
                            >
                              <Calendar size={11} />
                              <span>{String(val)}</span>
                            </div>
                          );
                        }

                        if (c.type === 'progress') {
                          const p = Number(val);
                          return (
                            <div
                              key={c.id}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 4,
                                fontSize: 11,
                                fontWeight: 600,
                                color: p === 100 ? '#16a34a' : '#3b82f6',
                              }}
                            >
                              <span>{p}%</span>
                            </div>
                          );
                        }

                        if (c.type === 'rating') {
                          return (
                            <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                              <Star size={11} fill="#f59e0b" color="#f59e0b" />
                              <span style={{ fontSize: 11, color: '#f59e0b', fontWeight: 600 }}>{String(val)}</span>
                            </div>
                          );
                        }

                        return (
                          <span
                            key={c.id}
                            style={{
                              fontSize: 11,
                              padding: '1px 6px',
                              borderRadius: 4,
                              background: 'var(--editor-bg, #f1f5f9)',
                              color: 'var(--editor-text-muted, #64748b)',
                            }}
                          >
                            {String(val)}
                          </span>
                        );
                      })}
                  </div>

                  {/* 卡片快速状态流转指示 */}
                  {lanes.length > 1 && (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        borderTop: '1px dashed var(--editor-border, #f1f5f9)',
                        paddingTop: 6,
                        marginTop: 2,
                        fontSize: 11,
                        color: 'var(--editor-text-muted, #94a3b8)',
                      }}
                    >
                      <span>移动到:</span>
                      <div style={{ display: 'flex', gap: 4 }}>
                        {lanes
                          .filter((l) => l.id !== lane.id)
                          .slice(0, 2)
                          .map((targetLane) => (
                            <button
                              key={targetLane.id}
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onUpdateRow(row.id, groupColumn.id, targetLane.id);
                              }}
                              style={{
                                padding: '1px 6px',
                                borderRadius: 4,
                                border: '1px solid var(--editor-border, #cbd5e1)',
                                background: 'transparent',
                                fontSize: 10,
                                cursor: 'pointer',
                                color: 'var(--editor-text, #334155)',
                              }}
                            >
                              {targetLane.label}
                            </button>
                          ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {lane.rows.length === 0 && (
                <div
                  style={{
                    padding: '24px 10px',
                    textAlign: 'center',
                    fontSize: 12,
                    color: 'var(--editor-text-muted, #94a3b8)',
                    border: '1px dashed var(--editor-border, #e2e8f0)',
                    borderRadius: 6,
                  }}
                >
                  暂无卡片
                </div>
              )}
            </div>
          </div>
        ))}

        {/* 新增分组泳道：仅在以单选中列为分组依据时可用 */}
        {isSelectGroup && onAddGroupOption && (
          <div
            style={{
              width: 200,
              minWidth: 200,
              borderRadius: 10,
              border: '1px dashed var(--editor-border, #cbd5e1)',
              background: 'transparent',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              minHeight: 56,
            }}
          >
            <button
              type="button"
              onClick={onAddGroupOption}
              title="新增一个分组"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 14px',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 500,
                color: 'var(--editor-text-muted, #64748b)',
                borderRadius: 6,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = 'var(--editor-accent, #3b82f6)';
                e.currentTarget.style.background = 'var(--editor-bg, #f8fafc)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = 'var(--editor-text-muted, #64748b)';
                e.currentTarget.style.background = 'transparent';
              }}
            >
              <Plus size={14} />
              <span>新增分组</span>
            </button>
          </div>
        )}

        {/* 未分类泳道 */}
        {unclassifiedRows.length > 0 && (
          <div
            style={{
              width: 280,
              minWidth: 280,
              maxHeight: '100%',
              borderRadius: 10,
              background: 'var(--editor-surface, #ffffff)',
              border: '1px dashed var(--editor-border, #cbd5e1)',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 1px 4px rgba(0, 0, 0, 0.02)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                padding: '10px 14px',
                borderBottom: '1px solid var(--editor-border, #f1f5f9)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--editor-text-muted, #64748b)' }}>未分类</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--editor-text-muted, #94a3b8)' }}>
                  {unclassifiedRows.length}
                </span>
              </div>
            </div>

            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '10px',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              {unclassifiedRows.map((row) => (
                <div
                  key={row.id}
                  style={{
                    padding: '12px 14px',
                    borderRadius: 8,
                    background: 'var(--editor-surface, #ffffff)',
                    border: '1px solid var(--editor-border, #e2e8f0)',
                    boxShadow: '0 2px 6px rgba(0, 0, 0, 0.03)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--editor-text, #1e293b)' }}>
                    {titleCol ? String(row[titleCol.id] || '未命名任务') : '未命名任务'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
