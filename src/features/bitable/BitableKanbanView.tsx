// NoteBoard 多维表格看板视图 (Kanban View)
// 按单选分组字段（如状态、优先级）自动分列泳道，支持卡片流转与泳道内快速新增

import React from 'react';
import {
  isDateTimeFieldType,
  type BitableColumn,
  type BitableRow,
  type SelectOption,
} from './bitableTypes';
import { OptionBadge } from './BitableOptions';
import { BITABLE_PALETTE } from './bitableConverter';
import { BitableMarkdown } from './BitableMarkdown';
import { DragGhost, FloatingPanel, getAnchorRect, type AnchorRect } from './BitableFloating';
import { Tooltip } from '../../components/Tooltip';
import {
  formatDateTimeValue,
  previewLongText,
  resolveDateTimeConfig,
  resolveLongTextConfig,
  slotToFinalPosition,
} from './bitableUtils';
import { usePointerReorder } from './usePointerReorder';
import { FieldSelectButton } from './BitableFieldMeta';
import type { ColumnOptionAction, SelectOptionColor } from './bitableTypes';
import {
  Plus,
  Calendar,
  Clock,
  Star,
  SlidersHorizontal,
  Trash2,
  MoreHorizontal,
  Pencil,
  X,
} from 'lucide-react';
import { useRef, useState } from 'react';

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

  // 泳道 DOM 节点表：用于测量泳道位置，支撑「拖拽泳道换分组顺序」的落点计算
  const laneRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  /**
   * 拖拽泳道换序 = 调整分组列标签选项的顺序
   * 仅在以单选中列为分组依据时可用：按普通字段分组时分组由行数据动态派生，没有可持久化的顺序。
   */
  const laneDragEnabled = isSelectGroup && Boolean(onManageColumnOption);

  const {
    drag: laneDrag,
    startDrag: startLaneDrag,
    getIndicator: getLaneIndicator,
    grabOffset: laneGrabOffset,
  } = usePointerReorder<(typeof lanes)[number]>({
    items: lanes,
    getElement: (lane) => laneRefs.current.get(lane.id),
    axis: 'x',
    disabled: !laneDragEnabled,
    onReorder: (fromIdx, toIdx) => {
      if (!groupColumn || !onManageColumnOption) return;
      onManageColumnOption(groupColumn.id, {
        type: 'reorder',
        optionId: lanes[fromIdx].id,
        toIndex: toIdx,
      });
    },
  });

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
        {lanes.map((lane, laneIdx) => {
          // 落点指示线：槽位落在本泳道左侧画左边线，落到末位时画最后一列右边线
          const laneIndicator = getLaneIndicator(laneIdx);

          return (
          <div
            key={lane.id}
            ref={(el) => {
              if (el) laneRefs.current.set(lane.id, el);
              else laneRefs.current.delete(lane.id);
            }}
            style={{
              width: 280,
              minWidth: 280,
              maxHeight: '100%',
              borderRadius: 10,
              background: 'var(--editor-surface, #ffffff)',
              border: '1px solid var(--editor-border, #e2e8f0)',
              display: 'flex',
              flexDirection: 'column',
              // 落点指示条依赖绝对定位，故泳道设为定位上下文；卡片阴影仍由 overflow:hidden 裁剪到圆角内
              position: 'relative',
              overflow: 'hidden',
              // 被拖起的泳道整体压暗，明确「哪一组正在被搬运」
              opacity: laneDrag?.fromIdx === laneIdx ? 0.45 : 1,
            }}
          >
            {/* 落点指示条：贯穿泳道全高，明确「这组会落到这里」 */}
            {laneIndicator && (
              <div
                aria-hidden
                style={{
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  left: laneIndicator === 'left' ? 0 : 'auto',
                  right: laneIndicator === 'right' ? 0 : 'auto',
                  width: 4,
                  background: '#3b82f6',
                  // 外侧与泳道圆角对齐，内侧直角，视觉上是泳道边缘被涂蓝
                  borderTopLeftRadius: laneIndicator === 'left' ? 10 : 0,
                  borderBottomLeftRadius: laneIndicator === 'left' ? 10 : 0,
                  borderTopRightRadius: laneIndicator === 'right' ? 10 : 0,
                  borderBottomRightRadius: laneIndicator === 'right' ? 10 : 0,
                  boxShadow: '0 0 10px rgba(59, 130, 246, 0.45)',
                  zIndex: 5,
                  pointerEvents: 'none',
                }}
              />
            )}

            {/* 泳道头部：整块作为拖拽把手，按下横向拖动即可换分组顺序 */}
            <div
              onMouseDown={(e) => startLaneDrag(e, laneIdx)}
              style={{
                padding: '10px 14px',
                borderBottom: '1px solid var(--editor-border, #f1f5f9)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: 'var(--editor-surface, #ffffff)',
                cursor: laneDrag ? 'grabbing' : laneDragEnabled ? 'grab' : 'default',
                userSelect: laneDrag ? 'none' : undefined,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {lane.badge}
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--editor-text-muted, #94a3b8)' }}>
                  {lane.rows.length}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <Tooltip content="在当前分组下添加卡片" side="top" sideOffset={4}>
                  <button
                    type="button"
                    data-no-drag
                    className="nb-bitable-btn-ghost"
                    onClick={() => {
                      if (groupColumn) onAddRowWithStatus(groupColumn.id, lane.id);
                    }}
                    aria-label="在当前分组下添加卡片"
                    style={{
                      padding: 3,
                      borderRadius: 4,
                    }}
                  >
                    <Plus size={14} />
                  </button>
                </Tooltip>

                {isSelectGroup && onManageColumnOption && (
                  <Tooltip content="编辑或删除该分组" side="top" sideOffset={4}>
                    <button
                      type="button"
                      data-no-drag
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
                      aria-label="编辑或删除该分组"
                      style={{
                        background: groupMenu && groupMenu.optionId === lane.id ? 'var(--editor-bg, #f1f5f9)' : undefined,
                        padding: 3,
                      }}
                    >
                      <MoreHorizontal size={14} />
                    </button>
                  </Tooltip>
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
                  <Tooltip content="取消编辑" side="top" sideOffset={4}>
                    <button
                      type="button"
                      aria-label="取消编辑"
                      className="nb-bitable-btn-ghost"
                      onClick={() => setEditingGroup(null)}
                      style={{ padding: 2 }}
                    >
                      <X size={13} />
                    </button>
                  </Tooltip>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  {BITABLE_PALETTE.map((pal) => (
                    <Tooltip key={pal.id} content={pal.label} side="bottom" sideOffset={4}>
                      <div
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
                    </Tooltip>
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
                    <Tooltip content="删除卡片" side="top" sideOffset={4}>
                      <button
                        type="button"
                        aria-label="删除卡片"
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
                    </Tooltip>
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
                            <Tooltip key={c.id} content={text} side="bottom" sideOffset={4}>
                              <span
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
                            </Tooltip>
                          );
                        }

                        if (c.type === 'select') {
                          const optionItem = c.options?.find((o) => o.id === val);
                          return optionItem ? <OptionBadge key={c.id} option={optionItem} /> : null;
                        }

                        // 日期 / 时间 / 日期时间：图标按类型区分，文本按列格式渲染
                        if (isDateTimeFieldType(c.type)) {
                          return (
                            <div
                              key={c.id}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 3,
                                fontSize: 11,
                                color: 'var(--editor-text-muted, #64748b)',
                                maxWidth: '100%',
                                overflow: 'hidden',
                              }}
                            >
                              {c.type === 'time' ? <Clock size={11} /> : <Calendar size={11} />}
                              <span
                                style={{
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {formatDateTimeValue(val, c.type, resolveDateTimeConfig(c))}
                              </span>
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
          );
        })}

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
            <Tooltip content="新增一个分组" side="top" sideOffset={4}>
              <button
                type="button"
                className="nb-bitable-btn-secondary"
                onClick={onAddGroupOption}
                aria-label="新增一个分组"
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
            </Tooltip>
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

      {/* 泳道拖拽时的跟随幽灵：实时提示该分组将落在第几位 */}
      {laneDrag && (
        <DragGhost x={laneDrag.x - laneGrabOffset.x} y={laneDrag.y - laneGrabOffset.y + 4}>
          {lanes[laneDrag.fromIdx]?.label ?? ''}
          {` · 移动到第 ${slotToFinalPosition(laneDrag.insertAt, laneDrag.fromIdx)} 个分组`}
        </DragGhost>
      )}
    </div>
  );
}
