// NoteBoard 多维表格单元格渲染与交互编辑器
// 深度还原飞书多维表格各类字段的视觉与交互体验
// 单选/多选单元格统一通过「双击」唤出 Portal 选项面板，单击仅选中单元格

import React, { useState, useRef, useEffect } from 'react';
import type {
  BitableColumn,
  ColumnOptionAction,
  SelectOptionColor,
} from './bitableTypes';
import { OptionBadge, SelectOptionsPanel } from './BitableOptions';
import { getAnchorRect, type AnchorRect } from './BitableFloating';
import { createId } from './bitableUtils';
import { Star, Check, ExternalLink } from 'lucide-react';

interface CellEditorProps {
  column: BitableColumn;
  value: unknown;
  onChange: (newValue: unknown) => void;
  /** 列选项增删改排序：由上层在单次提交内同步列与所有关联行 */
  onManageColumnOption?: (colId: string, action: ColumnOptionAction) => void;
}

export function BitableCellEditor({
  column,
  value,
  onChange,
  onManageColumnOption,
}: CellEditorProps) {
  const [editing, setEditing] = useState(false);
  const [inputValue, setInputValue] = useState<string>('');
  // 选项面板锚点：面板通过 Portal 渲染，彻底规避单元格 overflow 裁剪问题
  const [panelAnchor, setPanelAnchor] = useState<AnchorRect | null>(null);

  const cellRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const showSelectPanel = panelAnchor !== null;

  // 双击单元格：以单元格自身为锚点打开选项面板
  const openSelectPanel = (e: React.MouseEvent) => {
    e.stopPropagation();
    const anchor = getAnchorRect(cellRef.current);
    if (anchor) setPanelAnchor(anchor);
  };

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
      setPanelAnchor(null);
    };

    // 新增选项：先由上层落库列定义，再把新选项设为当前单元格的值
    const handleAddNewOption = (label: string, color: SelectOptionColor) => {
      const newOpt = { id: createId('opt'), label, color };
      onManageColumnOption?.(column.id, { type: 'add', option: newOpt });
      onChange(newOpt.id);
    };

    const handleUpdateOption = (optId: string, label: string, color: SelectOptionColor) => {
      onManageColumnOption?.(column.id, { type: 'update', optionId: optId, label, color });
    };

    const handleDeleteOption = (optId: string) => {
      onManageColumnOption?.(column.id, { type: 'delete', optionId: optId });
      if (value === optId) onChange(null);
    };

    return (
      <div
        ref={cellRef}
        onDoubleClick={openSelectPanel}
        title="双击选择或新建标签"
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '2px 6px',
          cursor: 'pointer',
          overflow: 'hidden',
        }}
      >
        {selectedOption ? (
          <OptionBadge option={selectedOption} />
        ) : (
          <span style={{ fontSize: 12, color: 'var(--editor-text-muted, #94a3b8)', opacity: 0.5 }}>-</span>
        )}

        {showSelectPanel && (
          <SelectOptionsPanel
            anchor={panelAnchor}
            trigger={cellRef.current}
            options={column.options || []}
            selectedIds={selectedIds}
            selectable
            isMulti={false}
            onToggleSelect={handleToggleSelect}
            onAddOption={handleAddNewOption}
            onUpdateOption={handleUpdateOption}
            onDeleteOption={handleDeleteOption}
            onClose={() => setPanelAnchor(null)}
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
      const newOpt = { id: createId('opt'), label, color };
      onManageColumnOption?.(column.id, { type: 'add', option: newOpt });
      onChange([...selectedIds, newOpt.id]);
    };

    const handleUpdateOption = (optId: string, label: string, color: SelectOptionColor) => {
      onManageColumnOption?.(column.id, { type: 'update', optionId: optId, label, color });
    };

    const handleDeleteOption = (optId: string) => {
      onManageColumnOption?.(column.id, { type: 'delete', optionId: optId });
      if (selectedIds.includes(optId)) {
        onChange(selectedIds.filter((id) => id !== optId));
      }
    };

    return (
      <div
        ref={cellRef}
        onDoubleClick={openSelectPanel}
        title="双击选择或新建标签"
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
          // 注意：此处不能设置 overflow: hidden，否则 Portal 之外的内联面板会被裁剪；
          // 徽章超宽由内部容器裁剪，避免影响浮层展示
          overflow: 'visible',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            flexWrap: 'nowrap',
            overflow: 'hidden',
            maxWidth: '100%',
          }}
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
        </div>

        {showSelectPanel && (
          <SelectOptionsPanel
            anchor={panelAnchor}
            trigger={cellRef.current}
            options={column.options || []}
            selectedIds={selectedIds}
            selectable
            isMulti
            onToggleSelect={handleToggleSelect}
            onAddOption={handleAddNewOption}
            onUpdateOption={handleUpdateOption}
            onDeleteOption={handleDeleteOption}
            onClose={() => setPanelAnchor(null)}
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
