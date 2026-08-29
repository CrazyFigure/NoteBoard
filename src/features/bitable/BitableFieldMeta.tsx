// NoteBoard 多维表格字段类型元数据
// 表头、列菜单、记录详情侧边栏、分组/排序字段选择器共用同一套图标与文案

import React, { useState } from 'react';
import type { BitableColumn, BitableFieldType } from './bitableTypes';
import { FloatingPanel, getAnchorRect, type AnchorRect } from './BitableFloating';
import {
  Type,
  AlignLeft,
  Hash,
  Tag,
  Tags,
  Calendar,
  CalendarClock,
  Clock,
  CheckSquare,
  Star,
  BarChart2,
  Link,
  ChevronDown,
} from 'lucide-react';

export interface FieldTypeMeta {
  icon: React.ReactNode;
  label: string;
}

/** 获取字段类型的展示元数据（图标 + 中文名） */
export function getFieldTypeMeta(type: BitableFieldType): FieldTypeMeta {
  switch (type) {
    case 'text':
      return { icon: <Type size={13} color="#3b82f6" />, label: '单行文本' };
    case 'longText':
      return { icon: <AlignLeft size={13} color="#0ea5e9" />, label: '多行文本' };
    case 'number':
      return { icon: <Hash size={13} color="#10b981" />, label: '数字' };
    case 'select':
      return { icon: <Tag size={13} color="#8b5cf6" />, label: '单选' };
    case 'multiSelect':
      return { icon: <Tags size={13} color="#ec4899" />, label: '多选' };
    case 'date':
      return { icon: <Calendar size={13} color="#f59e0b" />, label: '日期' };
    case 'time':
      return { icon: <Clock size={13} color="#14b8a6" />, label: '时间' };
    case 'dateTime':
      return { icon: <CalendarClock size={13} color="#6366f1" />, label: '日期时间' };
    case 'checkbox':
      return { icon: <CheckSquare size={13} color="#06b6d4" />, label: '勾选' };
    case 'rating':
      return { icon: <Star size={13} color="#eab308" />, label: '评分' };
    case 'progress':
      return { icon: <BarChart2 size={13} color="#3b82f6" />, label: '进度' };
    case 'link':
      return { icon: <Link size={13} color="#6366f1" />, label: '超链接' };
    default:
      // 未知类型兜底：外部数据可能携带本版本不认识的字段类型，不能让渲染崩掉
      return { icon: <Type size={13} color="#94a3b8" />, label: '未知字段' };
  }
}

interface FieldSelectButtonProps {
  columns: BitableColumn[];
  value: string | null;
  placeholder?: string;
  onChange: (colId: string | null) => void;
  disabledColIds?: string[];
  width?: number;
}

/**
 * 通用字段选择触发器
 * 用于表格视图/看板视图的分组、排序等场景；列表项显示字段彩色类型图标与中文名称。
 */
export function FieldSelectButton({
  columns,
  value,
  placeholder = '请选择字段',
  onChange,
  disabledColIds = [],
  width = 160,
}: FieldSelectButtonProps) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);

  const selectedCol = columns.find((c) => c.id === value);
  const meta = selectedCol ? getFieldTypeMeta(selectedCol.type) : null;

  const handleOpen = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = getAnchorRect(e.currentTarget);
    if (!rect) return;
    setAnchor(rect);
    setTrigger(e.currentTarget);
    setOpen(true);
  };

  return (
    <>
      <button
        type="button"
        className="nb-bitable-btn-secondary"
        onClick={handleOpen}
        style={{
          gap: 6,
          padding: '3px 8px',
          fontSize: 12,
          minWidth: width,
          maxWidth: width,
        }}
      >
        {meta && selectedCol ? (
          <>
            {meta.icon}
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1,
                textAlign: 'left',
              }}
            >
              {selectedCol.name}
            </span>
          </>
        ) : (
          <span style={{ color: 'var(--editor-text-muted, #64748b)', flex: 1, textAlign: 'left' }}>
            {placeholder}
          </span>
        )}
        <ChevronDown size={12} style={{ marginLeft: 'auto', opacity: 0.6, flexShrink: 0 }} />
      </button>
      {open && anchor && trigger && (
        <FloatingPanel anchor={anchor} trigger={trigger} width={200} onClose={() => setOpen(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', padding: '4px' }}>
            <button
              type="button"
              className="nb-bitable-menu-item"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
              style={{
                background: value === null ? 'var(--editor-bg, #f1f5f9)' : undefined,
                color: 'var(--editor-text-muted, #64748b)',
              }}
            >
              <span>{placeholder}</span>
            </button>
            {columns
              .filter((c) => !disabledColIds.includes(c.id))
              .map((col) => {
                const colMeta = getFieldTypeMeta(col.type);
                const isSelected = col.id === value;
                return (
                  <button
                    key={col.id}
                    type="button"
                    className="nb-bitable-menu-item"
                    onClick={() => {
                      onChange(col.id);
                      setOpen(false);
                    }}
                    style={{
                      background: isSelected ? 'var(--editor-bg, #f1f5f9)' : undefined,
                    }}
                  >
                    {colMeta.icon}
                    <span>{col.name}</span>
                  </button>
                );
              })}
          </div>
        </FloatingPanel>
      )}
    </>
  );
}
