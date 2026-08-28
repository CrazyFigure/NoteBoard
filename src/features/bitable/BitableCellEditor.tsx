// NoteBoard 多维表格单元格渲染与交互编辑器
// 深度还原飞书多维表格各类字段的视觉与交互体验

import React, { useState, useRef, useEffect } from 'react';
import type { BitableColumn, SelectOption, SelectOptionColor } from './bitableTypes';
import { getOptionColor, BITABLE_PALETTE } from './bitableConverter';
import {
  Star,
  Check,
  Plus,
  ExternalLink,
  ChevronDown,
  X,
  Edit2,
  Trash2,
} from 'lucide-react';

interface CellEditorProps {
  column: BitableColumn;
  value: unknown;
  onChange: (newValue: unknown) => void;
  onUpdateColumnOptions?: (newOptions: SelectOption[]) => void;
}

/** 飞书风格彩色单选/多选标签胶囊组件 */
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

/** 飞书风格单选与多选标签配置管理浮动面板 */
function SelectOptionsPanel({
  options,
  selectedIds,
  isMulti,
  onToggleSelect,
  onAddNewOption,
  onUpdateOption,
  onDeleteOption,
  panelRef,
}: {
  options: SelectOption[];
  selectedIds: string[];
  isMulti: boolean;
  onToggleSelect: (id: string) => void;
  onAddNewOption: (label: string, color: SelectOptionColor) => void;
  onUpdateOption: (id: string, label: string, color: SelectOptionColor) => void;
  onDeleteOption: (id: string) => void;
  panelRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [newLabel, setNewLabel] = useState('');
  const [newColor, setNewColor] = useState<SelectOptionColor>('blue');
  const [editingOptId, setEditingOptId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editColor, setEditColor] = useState<SelectOptionColor>('blue');

  const handleAdd = () => {
    if (!newLabel.trim()) return;
    onAddNewOption(newLabel.trim(), newColor);
    setNewLabel('');
  };

  const handleStartEdit = (e: React.MouseEvent, opt: SelectOption) => {
    e.stopPropagation();
    setEditingOptId(opt.id);
    setEditLabel(opt.label);
    setEditColor(opt.color);
  };

  const handleSaveEdit = (optId: string) => {
    if (editLabel.trim()) {
      onUpdateOption(optId, editLabel.trim(), editColor);
    }
    setEditingOptId(null);
  };

  return (
    <div
      ref={panelRef}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        top: '100%',
        left: 0,
        zIndex: 99999,
        marginTop: 4,
        width: 240,
        background: 'var(--editor-surface, #ffffff)',
        border: '1px solid var(--editor-border, #e2e8f0)',
        borderRadius: 8,
        boxShadow: '0 8px 28px rgba(0,0,0,0.16)',
        padding: '6px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      {/* 选项列表 */}
      <div style={{ maxHeight: 180, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {options.map((opt) => {
          const isSelected = selectedIds.includes(opt.id);
          const isEditingThis = editingOptId === opt.id;

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
                      if (e.key === 'Enter') handleSaveEdit(opt.id);
                      if (e.key === 'Escape') setEditingOptId(null);
                    }}
                    style={{
                      flex: 1,
                      padding: '3px 6px',
                      fontSize: 12,
                      border: '1px solid var(--editor-accent, #3b82f6)',
                      borderRadius: 4,
                      outline: 'none',
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => handleSaveEdit(opt.id)}
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
                {/* 编辑时的颜色挑选 */}
                <div style={{ display: 'flex', gap: 4 }}>
                  {BITABLE_PALETTE.map((pal) => (
                    <div
                      key={pal.id}
                      onClick={() => setEditColor(pal.id as SelectOptionColor)}
                      style={{
                        width: 14,
                        height: 14,
                        borderRadius: '50%',
                        background: pal.text,
                        cursor: 'pointer',
                        border: editColor === pal.id ? '2px solid #000000' : 'none',
                      }}
                    />
                  ))}
                </div>
              </div>
            );
          }

          return (
            <div
              key={opt.id}
              onClick={() => onToggleSelect(opt.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '4px 8px',
                borderRadius: 4,
                cursor: 'pointer',
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, overflow: 'hidden' }}>
                <OptionBadge option={opt} />
                {isSelected && <Check size={13} color="#3b82f6" />}
              </div>

              {/* 选项操作按钮（编辑 / 删除） */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 2 }} onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  title="修改选项"
                  onClick={(e) => handleStartEdit(e, opt)}
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
                    onDeleteOption(opt.id);
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
            </div>
          );
        })}

        {options.length === 0 && (
          <div style={{ padding: '8px', fontSize: 11, color: 'var(--editor-text-muted, #94a3b8)', textAlign: 'center' }}>
            暂无选项，请在下方创建
          </div>
        )}
      </div>

      {/* 新建标签选项表单 */}
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
              padding: '3px 6px',
              fontSize: 11,
              border: '1px solid var(--editor-border, #cbd5e1)',
              borderRadius: 4,
              outline: 'none',
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

        {/* 颜色选择球 */}
        <div style={{ display: 'flex', gap: 4, padding: '2px 0' }}>
          {BITABLE_PALETTE.map((pal) => (
            <div
              key={pal.id}
              onClick={() => setNewColor(pal.id as SelectOptionColor)}
              style={{
                width: 14,
                height: 14,
                borderRadius: '50%',
                background: pal.text,
                cursor: 'pointer',
                border: newColor === pal.id ? '2px solid #000000' : 'none',
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export function BitableCellEditor({
  column,
  value,
  onChange,
  onUpdateColumnOptions,
}: CellEditorProps) {
  const [editing, setEditing] = useState(false);
  const [inputValue, setInputValue] = useState<string>('');
  const [showSelectPanel, setShowSelectPanel] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 点击外部关闭单选/多选下拉面板
  useEffect(() => {
    if (!showSelectPanel) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setShowSelectPanel(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showSelectPanel]);

  // 进入编辑状态时聚焦
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  // ── 1. 文本字段 (Text) ──
  if (column.type === 'text') {
    if (editing) {
      return (
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onBlur={() => {
            onChange(inputValue);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onChange(inputValue);
              setEditing(false);
            } else if (e.key === 'Escape') {
              setEditing(false);
            }
          }}
          style={{
            width: '100%',
            height: '100%',
            border: '2px solid var(--editor-accent, #3b82f6)',
            borderRadius: 4,
            padding: '4px 8px',
            fontSize: 13,
            outline: 'none',
            background: 'var(--editor-surface, #ffffff)',
            color: 'var(--editor-text, #1e293b)',
          }}
        />
      );
    }

    return (
      <div
        onDoubleClick={() => {
          setInputValue(String(value ?? ''));
          setEditing(true);
        }}
        title="双击进行编辑"
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          padding: '4px 8px',
          fontSize: 13,
          color: value ? 'var(--editor-text, #1e293b)' : 'var(--editor-text-muted, #94a3b8)',
          cursor: 'pointer',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {String(value ?? '') || <span style={{ opacity: 0.5 }}>-</span>}
      </div>
    );
  }

  // ── 2. 数字字段 (Number) ──
  if (column.type === 'number') {
    if (editing) {
      return (
        <input
          ref={inputRef}
          type="number"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onBlur={() => {
            const num = inputValue.trim() === '' ? null : Number(inputValue);
            onChange(num);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const num = inputValue.trim() === '' ? null : Number(inputValue);
              onChange(num);
              setEditing(false);
            } else if (e.key === 'Escape') {
              setEditing(false);
            }
          }}
          style={{
            width: '100%',
            height: '100%',
            border: '2px solid var(--editor-accent, #3b82f6)',
            borderRadius: 4,
            padding: '4px 8px',
            fontSize: 13,
            outline: 'none',
            background: 'var(--editor-surface, #ffffff)',
            color: 'var(--editor-text, #1e293b)',
          }}
        />
      );
    }

    return (
      <div
        onDoubleClick={() => {
          setInputValue(value !== null && value !== undefined ? String(value) : '');
          setEditing(true);
        }}
        title="双击进行数字编辑"
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          padding: '4px 8px',
          fontSize: 13,
          color: value !== null && value !== undefined ? 'var(--editor-text, #1e293b)' : 'var(--editor-text-muted, #94a3b8)',
          cursor: 'pointer',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value !== null && value !== undefined ? String(value) : <span style={{ opacity: 0.5 }}>-</span>}
      </div>
    );
  }

  // ── 3. 单选标签 (Select) ──
  if (column.type === 'select') {
    const selectedOption = column.options?.find((opt) => opt.id === value);
    const selectedIds = selectedOption ? [selectedOption.id] : [];

    const handleToggleSelect = (optId: string) => {
      onChange(optId === value ? null : optId);
      setShowSelectPanel(false);
    };

    const handleAddNewOption = (label: string, color: SelectOptionColor) => {
      const newOpt: SelectOption = {
        id: `opt_${Date.now()}`,
        label,
        color,
      };
      const updated = [...(column.options || []), newOpt];
      onUpdateColumnOptions?.(updated);
      onChange(newOpt.id);
      setShowSelectPanel(false);
    };

    const handleUpdateOption = (optId: string, label: string, color: SelectOptionColor) => {
      const updated = (column.options || []).map((o) => (o.id === optId ? { ...o, label, color } : o));
      onUpdateColumnOptions?.(updated);
    };

    const handleDeleteOption = (optId: string) => {
      const updated = (column.options || []).filter((o) => o.id !== optId);
      onUpdateColumnOptions?.(updated);
      if (value === optId) {
        onChange(null);
      }
    };

    return (
      <div
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          padding: '2px 6px',
          cursor: 'pointer',
        }}
        onClick={() => setShowSelectPanel(true)}
      >
        {selectedOption ? (
          <OptionBadge option={selectedOption} />
        ) : (
          <span style={{ fontSize: 12, color: 'var(--editor-text-muted, #94a3b8)', opacity: 0.5 }}>-</span>
        )}

        {showSelectPanel && (
          <SelectOptionsPanel
            options={column.options || []}
            selectedIds={selectedIds}
            isMulti={false}
            onToggleSelect={handleToggleSelect}
            onAddNewOption={handleAddNewOption}
            onUpdateOption={handleUpdateOption}
            onDeleteOption={handleDeleteOption}
            panelRef={panelRef}
          />
        )}
      </div>
    );
  }

  // ── 4. 多选标签 (MultiSelect) ──
  if (column.type === 'multiSelect') {
    const selectedIds = Array.isArray(value) ? (value as string[]) : [];
    const selectedOptions = (column.options || []).filter((opt) => selectedIds.includes(opt.id));

    const handleToggleSelect = (optId: string) => {
      const next = selectedIds.includes(optId)
        ? selectedIds.filter((id) => id !== optId)
        : [...selectedIds, optId];
      onChange(next);
    };

    const handleAddNewOption = (label: string, color: SelectOptionColor) => {
      const newOpt: SelectOption = {
        id: `opt_${Date.now()}`,
        label,
        color,
      };
      const updated = [...(column.options || []), newOpt];
      onUpdateColumnOptions?.(updated);
      onChange([...selectedIds, newOpt.id]);
    };

    const handleUpdateOption = (optId: string, label: string, color: SelectOptionColor) => {
      const updated = (column.options || []).map((o) => (o.id === optId ? { ...o, label, color } : o));
      onUpdateColumnOptions?.(updated);
    };

    const handleDeleteOption = (optId: string) => {
      const updated = (column.options || []).filter((o) => o.id !== optId);
      onUpdateColumnOptions?.(updated);
      if (selectedIds.includes(optId)) {
        onChange(selectedIds.filter((id) => id !== optId));
      }
    };

    return (
      <div
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '2px 6px',
          cursor: 'pointer',
          flexWrap: 'nowrap',
          overflow: 'hidden',
        }}
        onClick={() => setShowSelectPanel(true)}
      >
        {selectedOptions.length > 0 ? (
          selectedOptions.map((opt) => (
            <OptionBadge
              key={opt.id}
              option={opt}
              onRemove={() => handleToggleSelect(opt.id)}
            />
          ))
        ) : (
          <span style={{ fontSize: 12, color: 'var(--editor-text-muted, #94a3b8)', opacity: 0.5 }}>-</span>
        )}

        {showSelectPanel && (
          <SelectOptionsPanel
            options={column.options || []}
            selectedIds={selectedIds}
            isMulti={true}
            onToggleSelect={handleToggleSelect}
            onAddNewOption={handleAddNewOption}
            onUpdateOption={handleUpdateOption}
            onDeleteOption={handleDeleteOption}
            panelRef={panelRef}
          />
        )}
      </div>
    );
  }

  // ── 5. 日期 (Date) ──
  if (column.type === 'date') {
    return (
      <input
        type="date"
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value || null)}
        style={{
          width: '100%',
          height: '100%',
          border: 'none',
          background: 'transparent',
          padding: '2px 6px',
          fontSize: 12,
          color: 'var(--editor-text, #1e293b)',
          cursor: 'pointer',
          outline: 'none',
        }}
      />
    );
  }

  // ── 6. 复选框 (Checkbox) ──
  if (column.type === 'checkbox') {
    const isChecked = Boolean(value);
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
        }}
        onClick={() => onChange(!isChecked)}
      >
        <div
          style={{
            width: 16,
            height: 16,
            borderRadius: 4,
            border: isChecked ? 'none' : '1.5px solid var(--editor-border, #cbd5e1)',
            background: isChecked ? 'var(--editor-accent, #3b82f6)' : 'transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#ffffff',
            transition: 'all 0.15s ease',
          }}
        >
          {isChecked && <Check size={12} strokeWidth={3} />}
        </div>
      </div>
    );
  }

  // ── 7. 评分 (Rating 1~5 星) ──
  if (column.type === 'rating') {
    const currentRating = typeof value === 'number' ? value : 0;
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          padding: '2px 6px',
        }}
      >
        {[1, 2, 3, 4, 5].map((star) => (
          <Star
            key={star}
            size={14}
            fill={star <= currentRating ? '#f59e0b' : 'none'}
            color={star <= currentRating ? '#f59e0b' : '#cbd5e1'}
            style={{ cursor: 'pointer', transition: 'transform 0.1s ease' }}
            onClick={() => onChange(star === currentRating ? 0 : star)}
          />
        ))}
      </div>
    );
  }

  // ── 8. 进度条 (Progress 0~100) ──
  if (column.type === 'progress') {
    const progressVal = typeof value === 'number' ? Math.min(100, Math.max(0, value)) : 0;
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '2px 8px',
        }}
      >
        <div
          style={{
            flex: 1,
            height: 8,
            borderRadius: 4,
            background: 'var(--editor-bg, #f1f5f9)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${progressVal}%`,
              height: '100%',
              borderRadius: 4,
              background: progressVal === 100 ? '#10b981' : '#3b82f6',
              transition: 'width 0.2s ease',
            }}
          />
        </div>
        <input
          type="number"
          min={0}
          max={100}
          value={progressVal}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{
            width: 44,
            border: 'none',
            background: 'transparent',
            fontSize: 11,
            fontWeight: 600,
            textAlign: 'right',
            color: 'var(--editor-text, #1e293b)',
            outline: 'none',
          }}
        />
        <span style={{ fontSize: 10, color: 'var(--editor-text-muted, #94a3b8)', marginLeft: -4 }}>%</span>
      </div>
    );
  }

  // ── 9. 超链接 (Link) ──
  if (column.type === 'link') {
    if (editing) {
      return (
        <input
          ref={inputRef}
          type="url"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onBlur={() => {
            onChange(inputValue);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onChange(inputValue);
              setEditing(false);
            } else if (e.key === 'Escape') {
              setEditing(false);
            }
          }}
          style={{
            width: '100%',
            height: '100%',
            border: '2px solid var(--editor-accent, #3b82f6)',
            borderRadius: 4,
            padding: '4px 8px',
            fontSize: 13,
            outline: 'none',
            background: 'var(--editor-surface, #ffffff)',
          }}
        />
      );
    }

    return (
      <div
        onDoubleClick={() => {
          setInputValue(String(value ?? ''));
          setEditing(true);
        }}
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '4px 8px',
          fontSize: 13,
          cursor: 'pointer',
        }}
      >
        <span
          style={{
            color: value ? 'var(--editor-accent, #3b82f6)' : 'var(--editor-text-muted, #94a3b8)',
            textDecoration: value ? 'underline' : 'none',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {String(value ?? '') || '-'}
        </span>
        {Boolean(value) && (
          <a
            href={String(value)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            style={{ color: 'var(--editor-accent, #3b82f6)', display: 'flex', opacity: 0.8 }}
          >
            <ExternalLink size={12} />
          </a>
        )}
      </div>
    );
  }

  return <div>-</div>;
}
