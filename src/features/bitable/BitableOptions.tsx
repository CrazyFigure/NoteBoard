// NoteBoard 多维表格标签徽章与选项管理面板
// 单元格选择面板与表头字段配置面板共用同一套「增 / 改名 / 改色 / 删除 / 排序」逻辑
// 面板统一走 Portal 浮层，避免被单元格与表头的 overflow 裁剪

import React, { useState } from 'react';
import type { SelectOption, SelectOptionColor } from './bitableTypes';
import { getOptionColor, BITABLE_PALETTE } from './bitableConverter';
import { FloatingPanel, type AnchorRect } from './BitableFloating';
import { Check, Edit2, Trash2, ChevronUp, ChevronDown, X } from 'lucide-react';

/** 飞书风格彩色标签胶囊 */
export function OptionBadge({
  option,
  onRemove,
}: {
  option: SelectOption;
  onRemove?: () => void;
}) {
  const color = getOptionColor(option.color);

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        borderRadius: 12,
        background: color.bg,
        border: `1px solid ${color.border}`,
        color: color.text,
        fontSize: 12,
        fontWeight: 500,
        lineHeight: 1.3,
        userSelect: 'none',
        maxWidth: '100%',
        flexShrink: 0,
      }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {option.label}
      </span>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          style={{
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            padding: 0,
            display: 'flex',
            color: color.text,
            opacity: 0.7,
          }}
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

/** 颜色挑选球行 */
function ColorPickerRow({
  value,
  onChange,
}: {
  value: SelectOptionColor;
  onChange: (color: SelectOptionColor) => void;
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '2px 0' }}>
      {BITABLE_PALETTE.map((pal) => (
        <div
          key={pal.id}
          title={pal.label}
          onClick={() => onChange(pal.id as SelectOptionColor)}
          style={{
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: pal.text,
            cursor: 'pointer',
            boxSizing: 'border-box',
            border: value === pal.id ? '2px solid var(--editor-text, #0f172a)' : '1px solid rgba(15,23,42,0.12)',
          }}
        />
      ))}
    </div>
  );
}

interface SelectOptionsPanelProps {
  anchor: AnchorRect;
  trigger?: HTMLElement | null;
  /** 面板标题，表头配置模式下用于提示当前字段 */
  title?: string;
  options: SelectOption[];
  /** 当前选中项（单元格模式传入，用于展示勾选态） */
  selectedIds?: string[];
  /** 是否允许点击选项切换选中值；表头配置模式为 false */
  selectable?: boolean;
  isMulti?: boolean;
  /** 是否展示增删改与排序操作 */
  manageable?: boolean;
  onToggleSelect?: (optionId: string) => void;
  onAddOption?: (label: string, color: SelectOptionColor) => void;
  onUpdateOption?: (optionId: string, label: string, color: SelectOptionColor) => void;
  onDeleteOption?: (optionId: string) => void;
  onMoveOption?: (optionId: string, direction: 'up' | 'down') => void;
  onClose: () => void;
}

export function SelectOptionsPanel({
  anchor,
  trigger,
  title,
  options,
  selectedIds = [],
  selectable = false,
  isMulti = false,
  manageable = true,
  onToggleSelect,
  onAddOption,
  onUpdateOption,
  onDeleteOption,
  onMoveOption,
  onClose,
}: SelectOptionsPanelProps) {
  const [newLabel, setNewLabel] = useState('');
  const [newColor, setNewColor] = useState<SelectOptionColor>('blue');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editColor, setEditColor] = useState<SelectOptionColor>('blue');

  const handleAdd = () => {
    const label = newLabel.trim();
    if (!label || !onAddOption) return;
    onAddOption(label, newColor);
    setNewLabel('');
  };

  const startEdit = (e: React.MouseEvent, opt: SelectOption) => {
    e.stopPropagation();
    setEditingId(opt.id);
    setEditLabel(opt.label);
    setEditColor(opt.color);
  };

  const saveEdit = (optionId: string) => {
    const label = editLabel.trim();
    if (label && onUpdateOption) {
      onUpdateOption(optionId, label, editColor);
    }
    setEditingId(null);
  };

  return (
    <FloatingPanel anchor={anchor} width={248} trigger={trigger} onClose={onClose}>
      {title && (
        <div
          style={{
            padding: '2px 6px 4px',
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--editor-text-muted, #94a3b8)',
          }}
        >
          {title}
        </div>
      )}

      {/* 选项列表 */}
      <div style={{ maxHeight: 200, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {options.map((opt, idx) => {
          const isSelected = selectedIds.includes(opt.id);
          const isEditingThis = editingId === opt.id;

          if (isEditingThis) {
            return (
              <div
                key={opt.id}
                style={{
                  padding: '6px 8px',
                  borderRadius: 6,
                  background: 'var(--editor-bg, #f8fafc)',
                  border: '1px solid var(--editor-border, #cbd5e1)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                <div style={{ display: 'flex', gap: 4 }}>
                  <input
                    type="text"
                    value={editLabel}
                    autoFocus
                    onChange={(e) => setEditLabel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveEdit(opt.id);
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      padding: '3px 6px',
                      fontSize: 12,
                      border: '1px solid var(--editor-accent, #3b82f6)',
                      borderRadius: 4,
                      outline: 'none',
                      background: 'var(--editor-surface, #ffffff)',
                      color: 'var(--editor-text, #1e293b)',
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => saveEdit(opt.id)}
                    style={{
                      padding: '3px 8px',
                      borderRadius: 4,
                      background: 'var(--editor-accent, #3b82f6)',
                      color: '#ffffff',
                      border: 'none',
                      fontSize: 11,
                      cursor: 'pointer',
                      fontWeight: 500,
                    }}
                  >
                    保存
                  </button>
                </div>
                <ColorPickerRow value={editColor} onChange={setEditColor} />
              </div>
            );
          }

          return (
            <div
              key={opt.id}
              onClick={() => {
                if (selectable && onToggleSelect) onToggleSelect(opt.id);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 4,
                padding: '4px 6px',
                borderRadius: 4,
                cursor: selectable ? 'pointer' : 'default',
                background: isSelected ? 'var(--editor-bg, #f1f5f9)' : 'transparent',
                transition: 'background 0.12s ease',
              }}
              onMouseEnter={(e) => {
                if (!isSelected) e.currentTarget.style.background = 'var(--editor-bg, #f8fafc)';
              }}
              onMouseLeave={(e) => {
                if (!isSelected) e.currentTarget.style.background = 'transparent';
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, overflow: 'hidden' }}>
                <OptionBadge option={opt} />
                {isSelected && <Check size={13} color="#3b82f6" />}
              </div>

              {manageable && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 1 }} onClick={(e) => e.stopPropagation()}>
                  {onMoveOption && (
                    <>
                      <button
                        type="button"
                        title="上移"
                        disabled={idx === 0}
                        onClick={(e) => {
                          e.stopPropagation();
                          onMoveOption(opt.id, 'up');
                        }}
                        style={{
                          border: 'none',
                          background: 'transparent',
                          cursor: idx === 0 ? 'not-allowed' : 'pointer',
                          opacity: idx === 0 ? 0.25 : 1,
                          padding: 2,
                          borderRadius: 3,
                          color: 'var(--editor-text-muted, #94a3b8)',
                          display: 'flex',
                        }}
                      >
                        <ChevronUp size={11} />
                      </button>
                      <button
                        type="button"
                        title="下移"
                        disabled={idx === options.length - 1}
                        onClick={(e) => {
                          e.stopPropagation();
                          onMoveOption(opt.id, 'down');
                        }}
                        style={{
                          border: 'none',
                          background: 'transparent',
                          cursor: idx === options.length - 1 ? 'not-allowed' : 'pointer',
                          opacity: idx === options.length - 1 ? 0.25 : 1,
                          padding: 2,
                          borderRadius: 3,
                          color: 'var(--editor-text-muted, #94a3b8)',
                          display: 'flex',
                        }}
                      >
                        <ChevronDown size={11} />
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    title="修改选项名称与颜色"
                    onClick={(e) => startEdit(e, opt)}
                    style={{
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                      padding: 2,
                      borderRadius: 3,
                      color: 'var(--editor-text-muted, #94a3b8)',
                      display: 'flex',
                    }}
                  >
                    <Edit2 size={11} />
                  </button>
                  <button
                    type="button"
                    title="删除选项"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteOption?.(opt.id);
                    }}
                    style={{
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                      padding: 2,
                      borderRadius: 3,
                      color: '#ef4444',
                      display: 'flex',
                    }}
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {options.length === 0 && (
          <div style={{ padding: '10px 8px', fontSize: 11, color: 'var(--editor-text-muted, #94a3b8)', textAlign: 'center' }}>
            {isMulti ? '暂无多选标签，请在下方创建' : '暂无选项，请在下方创建'}
          </div>
        )}
      </div>

      {/* 新建选项表单 */}
      {manageable && onAddOption && (
        <div
          style={{
            borderTop: '1px solid var(--editor-border, #f1f5f9)',
            paddingTop: 6,
            marginTop: 2,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ display: 'flex', gap: 4 }}>
            <input
              type="text"
              placeholder="新建标签选项..."
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAdd();
              }}
              style={{
                flex: 1,
                minWidth: 0,
                padding: '3px 6px',
                fontSize: 11,
                border: '1px solid var(--editor-border, #cbd5e1)',
                borderRadius: 4,
                outline: 'none',
                background: 'var(--editor-surface, #ffffff)',
                color: 'var(--editor-text, #1e293b)',
              }}
            />
            <button
              type="button"
              onClick={handleAdd}
              style={{
                padding: '3px 8px',
                borderRadius: 4,
                background: 'var(--editor-accent, #3b82f6)',
                color: '#ffffff',
                border: 'none',
                fontSize: 11,
                cursor: 'pointer',
                fontWeight: 500,
              }}
            >
              添加
            </button>
          </div>
          <ColorPickerRow value={newColor} onChange={setNewColor} />
        </div>
      )}
    </FloatingPanel>
  );
}
