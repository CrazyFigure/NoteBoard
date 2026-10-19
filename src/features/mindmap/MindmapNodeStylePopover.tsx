// NoteBoard 思维导图单个节点样式浮层
// 单独设置节点的标题对齐与图片显示方式；选中与设置默认值相同的选项时不单独保存，继续跟随设置。
// 详见 docs/09-开发路线图.md

import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AlignCenter, AlignLeft, Image as ImageIcon, Settings2, StretchHorizontal } from 'lucide-react';
import { stopReactPropagation } from '../bitable/bitableUtils';
import type { MindmapImageFit, MindmapTextAlign } from './mindmapTypes';

interface MindmapNodeStylePopoverProps {
  position: { x: number; y: number };
  textAlign?: MindmapTextAlign;
  imageFit?: MindmapImageFit;
  hasImage: boolean;
  defaultTextAlign: MindmapTextAlign;
  defaultImageFit: MindmapImageFit;
  onTextAlignChange: (value: MindmapTextAlign | undefined) => void;
  onImageFitChange: (value: MindmapImageFit | undefined) => void;
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

export function MindmapNodeStylePopover({
  position,
  textAlign,
  imageFit,
  hasImage,
  defaultTextAlign,
  defaultImageFit,
  onTextAlignChange,
  onImageFitChange,
  onClose,
}: MindmapNodeStylePopoverProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

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

  const left = Math.min(Math.max(position.x, 12), window.innerWidth - 252);

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
      style={{ left, top: position.y }}
    >
      <div className="nb-mindmap-popover-title">
        <Settings2 size={13} />
        <span>节点样式</span>
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
    </div>,
    document.body,
  );
}
