// NoteBoard 多维表格单元格渲染与交互编辑器
// 深度还原多维表格各类字段的视觉与交互体验
// 单选/多选单元格统一通过「双击」唤出 Portal 选项面板，单击仅选中单元格
// 多行文本单元格双击唤出编辑弹层，只读展示按列配置的显示模式（只显示第一行 / 全显示）

import React, { useState, useRef, useEffect } from 'react';
import {
  isDateTimeFieldType,
  type BitableColumn,
  type ColumnOptionAction,
  type LongTextConfig,
  type SelectOptionColor,
} from './bitableTypes';
import { OptionBadge, SelectOptionsPanel } from './BitableOptions';
import { getAnchorRect, type AnchorRect } from './BitableFloating';
import { areCellValuesEqual, createId, previewLongText, resolveLongTextConfig } from './bitableUtils';
import { BitableMarkdown } from './BitableMarkdown';
import { BitableRichTextEditor, type RichTextMode } from './BitableRichTextEditor';
import { BitableLongTextPopover } from './BitableLongTextPopover';
import { DateTimeFieldEditor } from './BitableDateTimePicker';
import { Star, Check, ExternalLink } from 'lucide-react';

/** 表单形态（记录详情侧边栏）下输入控件的统一样式 */
const FORM_INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  border: '1px solid var(--editor-border, #cbd5e1)',
  borderRadius: 6,
  padding: '6px 8px',
  fontSize: 13,
  fontFamily: 'inherit',
  lineHeight: 1.5,
  outline: 'none',
  background: 'var(--editor-bg, #ffffff)',
  color: 'var(--editor-text, #1e293b)',
};

/** 数字输入框的类名：隐藏原生上下微调箭头（样式见 globals.css 的 .nb-bitable-num-input） */
const NUMBER_INPUT_CLASS = 'nb-bitable-num-input';

/**
 * 拦截数字输入框的上下键步进
 * 表格里数字基本是手动录入的，原生步进既容易误改数值，又与键盘选区导航语义冲突。
 * 返回 true 表示事件已被消费，调用方应直接 return。
 */
function blockNumberStepKeys(e: React.KeyboardEvent<HTMLInputElement>): boolean {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return false;
  e.preventDefault();
  return true;
}

/**
 * 数字输入框聚焦时滚轮会直接加减数值，与表格滚动冲突
 * React 的 wheel 监听注册为被动监听、无法 preventDefault，故改为让输入框失焦，
 * 失焦后滚轮回归正常的页面滚动行为。
 */
function blurNumberOnWheel(e: React.WheelEvent<HTMLInputElement>): void {
  e.currentTarget.blur();
}

interface CellEditorProps {
  column: BitableColumn;
  value: unknown;
  onChange: (newValue: unknown) => void;
  /** 列选项增删改排序：由上层在单次提交内同步列与所有关联行 */
  onManageColumnOption?: (colId: string, action: ColumnOptionAction) => void;
  /**
   * 呈现形态：
   * - cell：表格单元格，紧凑、需双击进入编辑
   * - form：记录详情侧边栏，舒展、始终可直接编辑（多行文本、即时日期选择等）
   */
  variant?: 'cell' | 'form';
}

/** 空值占位的统一表现 */
const EMPTY_HINT = <span style={{ opacity: 0.5 }}>-</span>;

/**
 * 多行文本的只读展示
 * 显示模式由列配置决定：
 * - firstLine：压成一行并省略超出部分，行高保持紧凑
 * - full：完整展示（Markdown 列渲染富文本，普通列保留换行），行高由内容撑开
 */
function LongTextReadOnly({
  value,
  config,
  onOpenEditor,
}: {
  value: unknown;
  config: LongTextConfig;
  onOpenEditor: () => void;
}) {
  const raw = value === null || value === undefined ? '' : String(value);

  if (!raw.trim()) {
    return (
      <div
        onDoubleClick={onOpenEditor}
        style={{
          width: '100%',
          padding: '4px 8px',
          fontSize: 13,
          color: 'var(--editor-text-muted, #94a3b8)',
          cursor: 'pointer',
        }}
      >
        {EMPTY_HINT}
      </div>
    );
  }

  // 全显示：内容区自然撑高，外层表格行的高度会随之增长
  if (config.displayMode === 'full') {
    return (
      <div
        onDoubleClick={onOpenEditor}
        style={{
          width: '100%',
          padding: '5px 8px',
          fontSize: 13,
          lineHeight: 1.6,
          color: 'var(--editor-text, #1e293b)',
          cursor: 'pointer',
          // 内容整体可点击展开编辑，但 Markdown 里的代码块滚动不应被误触发
          overflow: 'hidden',
        }}
      >
        {config.markdown ? (
          <BitableMarkdown source={raw} density="compact" />
        ) : (
          <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{raw}</div>
        )}
      </div>
    );
  }

  // 只显示第一行：压平为单行并省略，保持表格紧凑
  return (
    <div
      onDoubleClick={onOpenEditor}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        padding: '4px 8px',
        fontSize: 13,
        color: 'var(--editor-text, #1e293b)',
        cursor: 'pointer',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      {previewLongText(raw, config)}
    </div>
  );
}

export function BitableCellEditor({
  column,
  value,
  onChange,
  onManageColumnOption,
  variant = 'cell',
}: CellEditorProps) {
  const [editing, setEditing] = useState(false);
  const [inputValue, setInputValue] = useState<string>('');
  // 选项面板锚点：面板通过 Portal 渲染，彻底规避单元格 overflow 裁剪问题
  const [panelAnchor, setPanelAnchor] = useState<AnchorRect | null>(null);
  // 多行文本编辑弹层的开关与编辑形态（可视化 / Markdown 源码）
  const [longTextEditorOpen, setLongTextEditorOpen] = useState(false);
  const [richMode, setRichMode] = useState<RichTextMode>('rich');

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

  // 表单模式下控件常驻可编辑，需随外部值变化同步内部输入态
  useEffect(() => {
    if (variant !== 'form') return;
    if (column.type === 'text' || column.type === 'longText' || column.type === 'number' || column.type === 'link') {
      setInputValue(value === null || value === undefined ? '' : String(value));
    }
  }, [variant, column.id, column.type, value]);

  // ── 1. 单行文本字段 (Text) ──
  // 单行文本在任何形态下都不承载换行：回车即提交，需要多行内容请改用「多行文本」字段
  if (column.type === 'text') {
    // 表单形态：常驻可编辑的单行输入框
    if (variant === 'form') {
      return (
        <input
          type="text"
          value={inputValue}
          placeholder="请输入内容"
          onChange={(e) => setInputValue(e.target.value)}
          onBlur={() => {
            if (!areCellValuesEqual(value, inputValue)) {
              onChange(inputValue);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (!areCellValuesEqual(value, inputValue)) {
                onChange(inputValue);
              }
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              setInputValue(value === null || value === undefined ? '' : String(value));
              e.currentTarget.blur();
            }
          }}
          style={FORM_INPUT_STYLE}
        />
      );
    }

    if (editing) {
      return (
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onBlur={() => {
            if (!areCellValuesEqual(value, inputValue)) {
              onChange(inputValue);
            }
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (!areCellValuesEqual(value, inputValue)) {
                onChange(inputValue);
              }
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
        {String(value ?? '') || EMPTY_HINT}
      </div>
    );
  }

  // ── 1.5 多行文本字段 (LongText) ──
  // 单元格形态：双击唤出编辑弹层；表单形态：内嵌编辑器，高度与渲染方式随列配置变化
  if (column.type === 'longText') {
    const config = resolveLongTextConfig(column);

    if (variant === 'form') {
      // Markdown 列在侧边栏直接用富文本编辑器，编辑体验与单元格弹层一致
      if (config.markdown) {
        return (
          <div
            style={{
              border: '1px solid var(--editor-border, #cbd5e1)',
              borderRadius: 6,
              background: 'var(--editor-bg, #ffffff)',
              overflow: 'hidden',
            }}
          >
            <BitableRichTextEditor
              value={inputValue}
              onChange={setInputValue}
              // 失焦即落库：inputValue 已由 onChange 同步到最新，此时提交不会丢字
              onBlurCommit={() => onChange(inputValue)}
              mode={richMode}
              onModeChange={setRichMode}
              // 全显示模式给足高度，只在首行模式下保持紧凑
              minHeight={config.displayMode === 'full' ? 200 : 120}
            />
          </div>
        );
      }

      return (
        <textarea
          value={inputValue}
          placeholder="请输入内容，回车换行"
          rows={config.displayMode === 'full' ? 8 : 3}
          onChange={(e) => setInputValue(e.target.value)}
          onBlur={() => onChange(inputValue)}
          onKeyDown={(e) => {
            // 单行模式下回车直接提交，避免误以为换行已生效
            if (e.key === 'Enter' && config.displayMode === 'firstLine' && !e.shiftKey) {
              e.preventDefault();
              onChange(inputValue);
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              setInputValue(value === null || value === undefined ? '' : String(value));
              e.currentTarget.blur();
            }
          }}
          style={{ ...FORM_INPUT_STYLE, resize: 'vertical', lineHeight: 1.6 }}
        />
      );
    }

    return (
      <>
        <LongTextReadOnly
          value={value}
          config={config}
          onOpenEditor={() => setLongTextEditorOpen(true)}
        />
        {longTextEditorOpen && (
          <BitableLongTextPopover
            column={column}
            value={value}
            config={config}
            onCommit={(next) => onChange(next)}
            onClose={() => setLongTextEditorOpen(false)}
          />
        )}
      </>
    );
  }

  // ── 2. 数字字段 (Number) ──
  if (column.type === 'number') {
    if (variant === 'form') {
      return (
        <input
          type="number"
          className={NUMBER_INPUT_CLASS}
          value={inputValue}
          placeholder="请输入数字"
          onChange={(e) => setInputValue(e.target.value)}
          onWheel={blurNumberOnWheel}
          onBlur={() => {
            const num = inputValue.trim() === '' ? null : Number(inputValue);
            if (!areCellValuesEqual(value, num)) {
              onChange(num);
            }
          }}
          onKeyDown={(e) => {
            if (blockNumberStepKeys(e)) return;
            if (e.key === 'Enter') {
              const num = inputValue.trim() === '' ? null : Number(inputValue);
              if (!areCellValuesEqual(value, num)) {
                onChange(num);
              }
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              setInputValue(value === null || value === undefined ? '' : String(value));
              e.currentTarget.blur();
            }
          }}
          style={FORM_INPUT_STYLE}
        />
      );
    }

    if (editing) {
      return (
        <input
          ref={inputRef}
          type="number"
          className={NUMBER_INPUT_CLASS}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onWheel={blurNumberOnWheel}
          onBlur={() => {
            const num = inputValue.trim() === '' ? null : Number(inputValue);
            if (!areCellValuesEqual(value, num)) {
              onChange(num);
            }
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (blockNumberStepKeys(e)) return;
            if (e.key === 'Enter') {
              const num = inputValue.trim() === '' ? null : Number(inputValue);
              if (!areCellValuesEqual(value, num)) {
                onChange(num);
              }
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

    const isForm = variant === 'form';

    return (
      <div
        ref={cellRef}
        // 表单形态单击即可选择，单元格形态沿用双击以免与选区点击冲突
        onClick={isForm ? openSelectPanel : undefined}
        onDoubleClick={openSelectPanel}
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 4,
          padding: isForm ? '6px 8px' : '2px 6px',
          minHeight: isForm ? 34 : undefined,
          border: isForm ? '1px solid var(--editor-border, #cbd5e1)' : undefined,
          borderRadius: isForm ? 6 : undefined,
          background: isForm ? 'var(--editor-bg, #ffffff)' : undefined,
          cursor: 'pointer',
          overflow: 'hidden',
        }}
      >
        {selectedOption ? (
          <OptionBadge option={selectedOption} />
        ) : (
          <span style={{ fontSize: 12, color: 'var(--editor-text-muted, #94a3b8)', opacity: 0.6 }}>
            {isForm ? '点击选择标签' : '-'}
          </span>
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

    const isForm = variant === 'form';

    return (
      <div
        ref={cellRef}
        // 表单形态单击即可选择，单元格形态沿用双击以免与选区点击冲突
        onClick={isForm ? openSelectPanel : undefined}
        onDoubleClick={openSelectPanel}
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: isForm ? '6px 8px' : '2px 6px',
          minHeight: isForm ? 34 : undefined,
          border: isForm ? '1px solid var(--editor-border, #cbd5e1)' : undefined,
          borderRadius: isForm ? 6 : undefined,
          background: isForm ? 'var(--editor-bg, #ffffff)' : undefined,
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
            flexWrap: isForm ? 'wrap' : 'nowrap',
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
            <span style={{ fontSize: 12, color: 'var(--editor-text-muted, #94a3b8)', opacity: 0.6 }}>
              {isForm ? '点击选择标签' : '-'}
            </span>
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

  // ── 5. 日期 / 时间 / 日期时间 ──
  // 三者共用一套自研选择器：展示文本按列上的格式配置渲染，编辑时按类型给出日历、时间表盘或两者组合。
  if (isDateTimeFieldType(column.type)) {
    return (
      <DateTimeFieldEditor
        column={column}
        value={value}
        onChange={onChange}
        variant={variant}
      />
    );
  }

  // ── 6. 复选框 (Checkbox) ──
  if (column.type === 'checkbox') {
    const isChecked = Boolean(value);
    // 表单形态用开关样式并附带文字，比裸方块更易理解
    if (variant === 'form') {
      return (
        <div
          onClick={() => onChange(!isChecked)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          <div
            style={{
              position: 'relative',
              width: 38,
              height: 22,
              borderRadius: 11,
              background: isChecked ? 'var(--editor-accent, #3b82f6)' : 'var(--editor-border, #cbd5e1)',
              transition: 'background 0.18s ease',
              flexShrink: 0,
            }}
          >
            <div
              style={{
                position: 'absolute',
                top: 3,
                left: isChecked ? 19 : 3,
                width: 16,
                height: 16,
                borderRadius: '50%',
                background: '#ffffff',
                transition: 'left 0.18s ease',
                boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
              }}
            />
          </div>
          <span style={{ fontSize: 13, color: 'var(--editor-text, #1e293b)' }}>
            {isChecked ? '已完成' : '未完成'}
          </span>
        </div>
      );
    }

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
            className="nb-bitable-star"
            fill={star <= currentRating ? '#f59e0b' : 'none'}
            color={star <= currentRating ? '#f59e0b' : '#cbd5e1'}
            onClick={() => onChange(star === currentRating ? 0 : star)}
          />
        ))}
      </div>
    );
  }

  // ── 8. 进度条 (Progress 0~100) ──
  if (column.type === 'progress') {
    const progressVal = typeof value === 'number' ? Math.min(100, Math.max(0, value)) : 0;

    // 表单形态用滑块 + 数值输入，拖动即可设定
    if (variant === 'form') {
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            type="range"
            min={0}
            max={100}
            value={progressVal}
            onChange={(e) => onChange(Number(e.target.value))}
            style={{ flex: 1, accentColor: 'var(--editor-accent, #3b82f6)' }}
          />
          <input
            type="number"
            min={0}
            max={100}
            className={NUMBER_INPUT_CLASS}
            value={progressVal}
            onChange={(e) => onChange(Math.min(100, Math.max(0, Number(e.target.value) || 0)))}
            onWheel={blurNumberOnWheel}
            onKeyDown={blockNumberStepKeys}
            style={{ ...FORM_INPUT_STYLE, width: 64, textAlign: 'right' }}
          />
          <span style={{ fontSize: 12, color: 'var(--editor-text-muted, #94a3b8)' }}>%</span>
        </div>
      );
    }

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
          className={NUMBER_INPUT_CLASS}
          value={progressVal}
          onChange={(e) => onChange(Number(e.target.value))}
          onWheel={blurNumberOnWheel}
          onKeyDown={blockNumberStepKeys}
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
    if (variant === 'form') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <input
            type="url"
            value={inputValue}
            placeholder="https://example.com"
            onChange={(e) => setInputValue(e.target.value)}
            onBlur={() => {
              if (!areCellValuesEqual(value, inputValue)) {
                onChange(inputValue);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (!areCellValuesEqual(value, inputValue)) {
                  onChange(inputValue);
                }
                e.currentTarget.blur();
              }
            }}
            style={FORM_INPUT_STYLE}
          />
          {Boolean(inputValue) && (
            <a
              href={inputValue}
              target="_blank"
              rel="noopener noreferrer"
              className="nb-bitable-btn"
              style={{ fontSize: 11, color: 'var(--editor-accent, #3b82f6)', display: 'inline-flex', width: 'fit-content' }}
            >
              在新窗口打开链接
            </a>
          )}
        </div>
      );
    }

    if (editing) {
      return (
        <input
          ref={inputRef}
          type="url"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onBlur={() => {
            if (!areCellValuesEqual(value, inputValue)) {
              onChange(inputValue);
            }
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (!areCellValuesEqual(value, inputValue)) {
                onChange(inputValue);
              }
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
            className="nb-bitable-btn-ghost"
            style={{ padding: 2, color: 'var(--editor-accent, #3b82f6)' }}
          >
            <ExternalLink size={12} />
          </a>
        )}
      </div>
    );
  }

  return <div>-</div>;
}
