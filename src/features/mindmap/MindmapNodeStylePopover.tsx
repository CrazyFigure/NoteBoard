// NoteBoard 思维导图单个节点样式浮层
// 单独设置节点的标题对齐与图片显示方式；选中与设置默认值相同的选项时不单独保存，继续跟随设置。
// 另可设置节点背景色与文字颜色（预设色 + 自定义取色），只作用于选中的节点本身。
// 浮层始终收在窗口内：展开取色盘等内容变高时自动上移，窗口放不下时内部滚动。
// 详见 docs/09-开发路线图.md

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlignCenter, AlignLeft, Ban, Image as ImageIcon, Settings2, StretchHorizontal } from 'lucide-react';
import { stopReactPropagation } from '../bitable/bitableUtils';
import { Tooltip } from '../../components/Tooltip';
import { CustomColorSection } from '../../components/colorPicker/CustomColorPicker';
import type { MindmapImageFit, MindmapTextAlign } from './mindmapTypes';
import { NODE_FILL_PRESETS, NODE_TEXT_PRESETS, textSwatchBackground, type NodeColorPreset } from './mindmapNodeColors';

/** 浮层宽度（与样式表一致）与距窗口边缘的最小间距 */
const POPOVER_WIDTH = 240;
const VIEWPORT_MARGIN = 8;

const FILL_PRESET_VALUES = NODE_FILL_PRESETS.map((preset) => preset.value);
const TEXT_PRESET_VALUES = NODE_TEXT_PRESETS.map((preset) => preset.value);

interface MindmapNodeStylePopoverProps {
  position: { x: number; y: number };
  textAlign?: MindmapTextAlign;
  imageFit?: MindmapImageFit;
  hasImage: boolean;
  defaultTextAlign: MindmapTextAlign;
  defaultImageFit: MindmapImageFit;
  /** 节点背景色 / 文字颜色（未设置为 undefined） */
  fillColor?: string;
  textColor?: string;
  /** 同时设置的节点数（多选时 > 1） */
  targetCount: number;
  onTextAlignChange: (value: MindmapTextAlign | undefined) => void;
  onImageFitChange: (value: MindmapImageFit | undefined) => void;
  /** 传 undefined 表示恢复默认颜色 */
  onFillColorChange: (value: string | undefined) => void;
  onTextColorChange: (value: string | undefined) => void;
  onClose: () => void;
}

/**
 * 二选一分段按钮：高亮实际生效的值（节点值优先，否则为设置默认值）；
 * 选中与默认值相同的选项时回传 undefined，节点恢复跟随设置
 */
function Segment<T extends string>({
  options,
  value,
  defaultValue,
  onChange,
}: {
  options: Array<{ value: T; label: string; icon?: React.ReactNode }>;
  value: T | undefined;
  defaultValue: T;
  onChange: (value: T | undefined) => void;
}) {
  const effective = value ?? defaultValue;
  return (
    <div className="nb-mindmap-segment" role="radiogroup">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={effective === opt.value}
          className="nb-mindmap-edge-option"
          data-active={effective === opt.value}
          onClick={() => onChange(opt.value === defaultValue ? undefined : opt.value)}
        >
          {opt.icon}
          <span>{opt.label}</span>
        </button>
      ))}
    </div>
  );
}

/** 颜色预设色板：首格为「默认」（清除颜色），其余为预设色块 */
function ColorPresetGrid({
  variant,
  presets,
  value,
  defaultLabel,
  onChange,
}: {
  variant: 'fill' | 'text';
  presets: NodeColorPreset[];
  value: string | undefined;
  defaultLabel: string;
  onChange: (value: string | undefined) => void;
}) {
  const active = value?.toLowerCase();
  return (
    <div className="nb-mindmap-color-grid" role="radiogroup" aria-label={variant === 'fill' ? '背景颜色' : '文字颜色'}>
      <Tooltip content={defaultLabel} side="top" sideOffset={4} delayDuration={100}>
        <button
          type="button"
          role="radio"
          aria-checked={!active}
          aria-label={defaultLabel}
          className="nb-mindmap-color-swatch is-default"
          data-active={!active}
          onClick={() => onChange(undefined)}
        >
          <Ban size={12} />
        </button>
      </Tooltip>
      {presets.map((preset) => (
        <Tooltip key={preset.value} content={preset.name} side="top" sideOffset={4} delayDuration={100}>
          <button
            type="button"
            role="radio"
            aria-checked={active === preset.value}
            aria-label={preset.name}
            className="nb-mindmap-color-swatch"
            data-variant={variant}
            data-active={active === preset.value}
            style={
              variant === 'fill'
                ? ({ '--nb-swatch-color': preset.value } as React.CSSProperties)
                : ({ '--nb-swatch-color': preset.value, background: textSwatchBackground(preset.value) } as React.CSSProperties)
            }
            onClick={() => onChange(preset.value)}
          >
            {variant === 'text' && 'A'}
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

export function MindmapNodeStylePopover({
  position,
  textAlign,
  imageFit,
  hasImage,
  defaultTextAlign,
  defaultImageFit,
  fillColor,
  textColor,
  targetCount,
  onTextAlignChange,
  onImageFitChange,
  onFillColorChange,
  onTextColorChange,
  onClose,
}: MindmapNodeStylePopoverProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // 实际显示位置与最大高度：按浮层实测尺寸收进窗口
  const [placement, setPlacement] = useState<{ left: number; top: number; maxHeight?: number }>(() => ({
    left: position.x,
    top: position.y,
  }));

  // 点击外部或按 Esc 关闭
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onCloseRef.current();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, []);

  // 内容高度变化（展开取色盘等）或窗口尺寸变化时重新收进窗口：
  // 底部放不下先整体上移，窗口比浮层还矮时限制最大高度并在内部滚动
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const place = () => {
      const viewWidth = window.innerWidth;
      const viewHeight = window.innerHeight;
      const width = Math.min(POPOVER_WIDTH, viewWidth - VIEWPORT_MARGIN * 2);
      const left = Math.min(Math.max(position.x, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, viewWidth - width - VIEWPORT_MARGIN));
      const available = Math.max(0, viewHeight - VIEWPORT_MARGIN * 2);
      // scrollHeight 为内容完整高度，不受当前最大高度限制
      const contentHeight = el.scrollHeight;
      const height = Math.min(contentHeight, available);
      const top = Math.max(VIEWPORT_MARGIN, Math.min(position.y, viewHeight - VIEWPORT_MARGIN - height));
      const maxHeight = contentHeight > available ? available : undefined;
      setPlacement((cur) =>
        cur.left === left && cur.top === top && cur.maxHeight === maxHeight ? cur : { left, top, maxHeight },
      );
    };
    place();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    // 观察内部各区块：浮层自身被限制高度时也能感知内容增减（如展开取色盘）
    for (const child of Array.from(el.children)) observer?.observe(child);
    observer?.observe(el);
    window.addEventListener('resize', place);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [position.x, position.y, hasImage]);

  return createPortal(
    <div
      ref={rootRef}
      className="nb-mindmap-node-style-popover"
      role="dialog"
      aria-label="节点样式"
      onMouseDown={stopReactPropagation}
      onPointerDown={stopReactPropagation}
      onClick={stopReactPropagation}
      onDoubleClick={stopReactPropagation}
      style={{
        left: placement.left,
        top: placement.top,
        width: `min(${POPOVER_WIDTH}px, calc(100vw - ${VIEWPORT_MARGIN * 2}px))`,
        maxHeight: placement.maxHeight,
        overflowY: placement.maxHeight !== undefined ? 'auto' : undefined,
      }}
    >
      <div className="nb-mindmap-popover-title">
        <Settings2 size={13} />
        <span>节点样式</span>
        {targetCount > 1 && <span className="nb-mindmap-popover-count">已选 {targetCount} 个</span>}
      </div>
      <div className="nb-mindmap-popover-label">文字对齐</div>
      <Segment<MindmapTextAlign>
        value={textAlign}
        defaultValue={defaultTextAlign}
        onChange={onTextAlignChange}
        options={[
          { value: 'left', label: '左对齐', icon: <AlignLeft size={12} /> },
          { value: 'center', label: '居中', icon: <AlignCenter size={12} /> },
        ]}
      />
      {hasImage && (
        <>
          <div className="nb-mindmap-popover-label">图片显示</div>
          <Segment<MindmapImageFit>
            value={imageFit}
            defaultValue={defaultImageFit}
            onChange={onImageFitChange}
            options={[
              { value: 'original', label: '原始比例', icon: <ImageIcon size={12} /> },
              { value: 'fill', label: '宽度填充', icon: <StretchHorizontal size={12} /> },
            ]}
          />
        </>
      )}
      <div className="nb-mindmap-popover-label">背景颜色</div>
      <ColorPresetGrid
        variant="fill"
        presets={NODE_FILL_PRESETS}
        value={fillColor}
        defaultLabel="默认背景"
        onChange={onFillColorChange}
      />
      {/* 自定义颜色：固定的颜色可直接选用，「+」展开取色盘 */}
      <div className="nb-mindmap-popover-custom">
        <CustomColorSection
          kind="highlight"
          variant="fill"
          activeColor={fillColor}
          presetColors={FILL_PRESET_VALUES}
          onSelect={(hex) => onFillColorChange(hex)}
        />
      </div>
      <div className="nb-mindmap-popover-label">文字颜色</div>
      <ColorPresetGrid
        variant="text"
        presets={NODE_TEXT_PRESETS}
        value={textColor}
        defaultLabel="默认文字颜色"
        onChange={onTextColorChange}
      />
      <div className="nb-mindmap-popover-custom">
        <CustomColorSection
          kind="text"
          variant="text"
          activeColor={textColor}
          presetColors={TEXT_PRESET_VALUES}
          onSelect={(hex) => onTextColorChange(hex)}
        />
      </div>
    </div>,
    document.body,
  );
}
