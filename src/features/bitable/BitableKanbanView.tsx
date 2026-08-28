// NoteBoard 多维表格看板视图 (Kanban View)
// 按单选分组字段（如状态、优先级）自动分列泳道，支持卡片流转与泳道内快速新增

import React from 'react';
import type {
  BitableColumn,
  BitableRow,
  SelectOption,
} from './bitableTypes';
import { OptionBadge } from './BitableOptions';
import { BITABLE_PALETTE } from './bitableConverter';
import { BitableMarkdown } from './BitableMarkdown';
import { FloatingPanel, getAnchorRect, type AnchorRect } from './BitableFloating';
import { previewLongText, resolveLongTextConfig } from './bitableUtils';
import { FieldSelectButton } from './BitableFieldMeta';
import type { ColumnOptionAction, SelectOptionColor } from './bitableTypes';
import {
  Plus,
  Calendar,
  Star,
  SlidersHorizontal,
  Trash2,
  MoreHorizontal,
  Pencil,
  X,
} from 'lucide-react';
import { useState } from 'react';

/** 分组菜单项的统一样式 */
const MENU_ITEM_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 8px',
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  fontSize: 12,
  lineHeight: 1.2,
  borderRadius: 4,
  color: 'var(--editor-text, #1e293b)',
  textAlign: 'left',
  width: '100%',
};

// 让 lucide svg 与文字 baseline 一致、且不挤压
const MENU_ICON_STYLE: React.CSSProperties = {
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
};

/**
 * 取卡片主标题
 * 多行文本按列配置折算：仅首行模式只取首行并剥离 Markdown 标记，避免把整段内容塞进标题。
 */
function resolveCardTitle(titleCol: BitableColumn | undefined, row: BitableRow): string {
  if (!titleCol) return '未命名任务';
  const val = row[titleCol.id];
  if (val === undefined || val === null || String(val).trim() === '') return '未命名任务';
  if (titleCol.type === 'longText') {
    return previewLongText(String(val), resolveLongTextConfig(titleCol)) || '未命名任务';
  }
  return String(val);
}

interface KanbanViewProps {
  columns: BitableColumn[];
  rows: BitableRow[];
  groupByColumnId?: string;
  onUpdateGroupByColumnId?: (colId: string) => void;
  onUpdateRow: (rowId: string, columnId: string, val: unknown) => void;
  onAddRowWithStatus: (columnId: string, optionId: string | null) => void;
  /** 新增分组泳道：为分组列追加一个标签选项 */
  onAddGroupOption?: () => void;
  /** 分组标签的改名 / 改色 / 删除，由上层在单次提交内同步列与所有关联卡片 */
  onManageColumnOption?: (colId: string, action: ColumnOptionAction) => void;
  /** 点击卡片打开记录详情侧边栏 */
  onOpenRecord?: (rowId: string) => void;
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
  onManageColumnOption,
  onOpenRecord,
  onDeleteRow,
}: KanbanViewProps) {
  // 分组操作菜单（改名 / 改色 / 删除）与触发元素锚点
  const [groupMenu, setGroupMenu] = useState<{
    optionId: string;
    anchor: AnchorRect;
    trigger: HTMLElement;
  } | null>(null);
  // 分组编辑态：直接输入新名称并选色
  const [editingGroup, setEditingGroup] = useState<{ optionId: string; label: string; color: SelectOptionColor } | null>(
    null,
  );
  // 删除分组需二次确认，避免误删整组卡片
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  // 查找作为分组依据的列（若未指定或不存在，优先选择第一个 select 列，否则选择第一个列）
  const groupColumn =
    (groupByColumnId ? columns.find((c) => c.id === groupByColumnId) : null) ||
    columns.find((c) => c.type === 'select') ||
    columns[0];

  const isSelectGroup = groupColumn?.type === 'select';
  const options: SelectOption[] = isSelectGroup ? groupColumn?.options || [] : [];
  // 卡片主标题：优先单行文本，其次多行文本，都没有时退回第一列
  const titleCol =
    columns.find((c) => c.type === 'text') ||
    columns.find((c) => c.type === 'longText') ||
    columns[0];

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
          <span>分组依据</span>
        </div>
        <FieldSelectButton
          columns={columns}
          value={groupColumn?.id || null}
          placeholder="选择分组字段"
          onChange={(colId) => onUpdateGroupByColumnId && onUpdateGroupByColumnId(colId || '')}
          width={180}
        />
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <button
                  type="button"
                  className="nb-bitable-btn-ghost"
                  onClick={() => {
                    if (groupColumn) onAddRowWithStatus(groupColumn.id, lane.id);
                  }}
                  title="在当前分组下添加卡片"
                  style={{
                    padding: 3,
                    borderRadius: 4,
                  }}
                >
                  <Plus size={14} />
                </button>

                {isSelectGroup && onManageColumnOption && (
                  <button
                    type="button"
                    className="nb-bitable-btn-ghost"
                    onClick={(e) => {
                      const anchor = getAnchorRect(e.currentTarget);
                      if (!anchor) return;
                      setPendingDeleteId(null);
                      setGroupMenu((prev) =>
                        prev && prev.optionId === lane.id
                          ? null
                          : { optionId: lane.id, anchor, trigger: e.currentTarget as HTMLElement },
                      );
                    }}
                    title="编辑或删除该分组"
                    style={{
                      background: groupMenu && groupMenu.optionId === lane.id ? 'var(--editor-bg, #f1f5f9)' : undefined,
                      padding: 3,
                    }}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                )}
              </div>
            </div>

            {editingGroup && editingGroup.optionId === lane.id && groupColumn && (
              <div
                style={{
                  padding: '8px 10px',
                  borderBottom: '1px solid var(--editor-border, #f1f5f9)',
                  background: 'var(--editor-bg, #f8fafc)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input
                    type="text"
                    value={editingGroup.label}
                    autoFocus
                    placeholder="分组名称"
                    onChange={(e) =>
                      setEditingGroup((prev) => (prev ? { ...prev, label: e.target.value } : prev))
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && editingGroup.label.trim() && groupColumn) {
                        if (onManageColumnOption) {
                          onManageColumnOption(groupColumn.id, {
                            type: 'update',
                            optionId: editingGroup.optionId,
                            label: editingGroup.label.trim(),
                            color: editingGroup.color,
                          });
                        }
                        setEditingGroup(null);
                      } else if (e.key === 'Escape') {
                        setEditingGroup(null);
                      }
                    }}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      padding: '4px 6px',
                      fontSize: 12,
                      border: '1px solid var(--editor-accent, #3b82f6)',
                      borderRadius: 4,
                      outline: 'none',
                    }}
                  />
                  <button
                    type="button"
                    title="取消编辑"
                    className="nb-bitable-btn-ghost"
                    onClick={() => setEditingGroup(null)}
                    style={{ padding: 2 }}
                  >
                    <X size={13} />
                  </button>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  {BITABLE_PALETTE.map((pal) => (
                    <div
                      key={pal.id}
                      title={pal.label}
                      className="nb-bitable-color-dot"
                      onClick={() =>
                        setEditingGroup((prev) =>
                          prev ? { ...prev, color: pal.id as SelectOptionColor } : prev,
                        )
                      }
                      style={{
                        width: 14,
                        height: 14,
                        borderRadius: '50%',
                        background: pal.text,
                        cursor: 'pointer',
                        boxSizing: 'border-box',
                        border:
                          editingGroup.color === pal.id
                            ? '2px solid var(--editor-text, #0f172a)'
                            : '1px solid rgba(15,23,42,0.12)',
                      }}
                    />
                  ))}
                </div>

                <button
                  type="button"
                  className="nb-bitable-btn-primary"
                  onClick={() => {
                    if (!editingGroup.label.trim() || !groupColumn) return;
                    if (onManageColumnOption) {
                      onManageColumnOption(groupColumn.id, {
                        type: 'update',
                        optionId: editingGroup.optionId,
                        label: editingGroup.label.trim(),
                        color: editingGroup.color,
                      });
                    }
                    setEditingGroup(null);
                  }}
                  style={{
                    alignSelf: 'flex-end',
                    padding: '3px 8px',
                    fontSize: 11,
                  }}
                >
                  保存分组
                </button>
              </div>
            )}

            {isSelectGroup && onManageColumnOption && groupMenu && groupMenu.optionId === lane.id && (
              <FloatingPanel
                anchor={groupMenu.anchor}
                trigger={groupMenu.trigger}
                width={210}
                gap={2}
                align="right"
                onClose={() => {
                  setGroupMenu(null);
                  setPendingDeleteId(null);
                }}
              >
                <button
                  type="button"
                  className="nb-bitable-menu-item"
                  onClick={() => {
                    const opt = options.find((o) => o.id === lane.id);
                    setEditingGroup({
                      optionId: lane.id,
                      label: opt ? opt.label : lane.label,
                      color: opt ? opt.color : 'blue',
                    });
                    setGroupMenu(null);
                  }}
                >
                  <span style={MENU_ICON_STYLE}><Pencil size={13} /></span>
                  <span>编辑分组名称与颜色</span>
                </button>

                {pendingDeleteId === lane.id ? (
                  <button
                    type="button"
                    className="nb-bitable-btn-danger"
                    onClick={() => {
                      if (groupColumn && onManageColumnOption) {
                        onManageColumnOption(groupColumn.id, { type: 'delete', optionId: lane.id });
                      }
                      setPendingDeleteId(null);
                      setGroupMenu(null);
                    }}
                    style={{ background: '#fee2e2' }}
                  >
                    <span style={MENU_ICON_STYLE}><Trash2 size={13} /></span>
                    <span>确认删除（{lane.rows.length} 张卡片将变为未分组）</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="nb-bitable-btn-danger"
                    onClick={() => setPendingDeleteId(lane.id)}
                  >
                    <span style={MENU_ICON_STYLE}><Trash2 size={13} /></span>
                    <span>删除该分组</span>
                  </button>
                )}
              </FloatingPanel>
            )}

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
                  className="nb-bitable-kanban-card"
                  onClick={() => onOpenRecord && onOpenRecord(row.id)}
                  title={onOpenRecord ? '点击展开记录详情' : undefined}
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
                    position: 'relative',
                  }}
                >
                  {/* 卡片头部与删除按钮 */}
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 6 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--editor-text, #1e293b)', lineHeight: 1.4, flex: 1 }}>
                      {resolveCardTitle(titleCol, row)}
                    </div>
                    <button
                      type="button"
                      title="删除卡片"
                      className="nb-bitable-btn-ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteRow(row.id);
                      }}
                      style={{
                        padding: 2,
                        opacity: 0.6,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = '#ef4444';
                        e.currentTarget.style.opacity = '1';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = 'var(--editor-text-muted, #64748b)';
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

                        // 多行文本：按列配置渲染，全显示时不套胶囊样式，否则整段内容会被挤成一行
                        if (c.type === 'longText') {
                          const ltConfig = resolveLongTextConfig(c);
                          const text = String(val);
                          if (ltConfig.displayMode === 'full') {
                            return (
                              <div
                                key={c.id}
                                style={{
                                  width: '100%',
                                  padding: '6px 8px',
                                  borderRadius: 6,
                                  background: 'var(--editor-bg, #f8fafc)',
                                  color: 'var(--editor-text, #1e293b)',
                                  fontSize: 12,
                                  lineHeight: 1.6,
                                  overflow: 'hidden',
                                }}
                              >
                                {ltConfig.markdown ? (
                                  <BitableMarkdown source={text} density="compact" />
                                ) : (
                                  <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</div>
                                )}
                              </div>
                            );
                          }
                          return (
                            <span
                              key={c.id}
                              title={text}
                              style={{
                                fontSize: 11,
                                padding: '1px 6px',
                                borderRadius: 4,
                                background: 'var(--editor-bg, #f1f5f9)',
                                color: 'var(--editor-text-muted, #64748b)',
                                maxWidth: '100%',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {previewLongText(text, ltConfig)}
                            </span>
                          );
                        }

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
              className="nb-bitable-btn-secondary"
              onClick={onAddGroupOption}
              title="新增一个分组"
              style={{
                borderStyle: 'dashed',
                padding: '6px 12px',
                color: 'var(--editor-text-muted, #64748b)',
                fontWeight: 500,
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
                  className="nb-bitable-kanban-card"
                  onClick={() => onOpenRecord && onOpenRecord(row.id)}
                  title={onOpenRecord ? '点击展开记录详情' : undefined}
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
                    {resolveCardTitle(titleCol, row)}
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
