// NoteBoard Markdown 图片右键菜单
// 右键（触屏长按）图片时替代通用的文本右键菜单：只列出针对图片本身的操作，
// 由图片节点视图按图片来源（本地文件 / 网络图片 / 内嵌图片）、是否可编辑与平台组装菜单项。
// 交互：点击外部、滚动、窗口尺寸变化或 Esc 关闭；↑ / ↓ 在菜单项间移动焦点。

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlignCenter, AlignLeft, AlignRight, Image as ImageIcon, type LucideIcon } from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';
import { stopReactPropagation } from '../bitable/bitableUtils';
import '../../styles/imageContextMenu.css';

export type ImageAlign = 'left' | 'center' | 'right';

export interface ImageMenuItem {
  key: string;
  label: string;
  Icon: LucideIcon;
  onSelect: () => void;
  /** 破坏性操作（删除）以错误色显示 */
  danger?: boolean;
}

export type ImageMenuSection =
  | { kind: 'items'; key: string; items: ImageMenuItem[] }
  | {
      kind: 'layout';
      key: string;
      align: ImageAlign;
      width: string;
      onAlign: (align: ImageAlign) => void;
      onWidth: (width: string) => void;
    };

interface ImageContextMenuProps {
  /** 菜单左上角（右键位置，视口坐标） */
  x: number;
  y: number;
  /** 信息头：文件名与尺寸等补充信息 */
  title: string;
  meta?: string;
  sections: ImageMenuSection[];
  onClose: () => void;
}

const ALIGN_OPTIONS: Array<{ align: ImageAlign; label: string; Icon: LucideIcon }> = [
  { align: 'left', label: '居左', Icon: AlignLeft },
  { align: 'center', label: '居中', Icon: AlignCenter },
  { align: 'right', label: '居右', Icon: AlignRight },
];

const WIDTH_OPTIONS = ['25%', '50%', '75%', '100%'];

/** 视口边缘留白 */
const EDGE = 8;

export function ImageContextMenu({ x, y, title, meta, sections, onClose }: ImageContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // 绘制前按实际尺寸夹进视口：右侧放不下时向左翻转，底部放不下时上移
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const { offsetWidth: width, offsetHeight: height } = menu;
    const left = x + width + EDGE > window.innerWidth ? Math.max(EDGE, x - width) : x;
    const top = Math.max(EDGE, Math.min(y, window.innerHeight - height - EDGE));
    setPosition({ left, top });
  }, [x, y]);

  useEffect(() => {
    const isInside = (target: EventTarget | null) => target instanceof Node && Boolean(menuRef.current?.contains(target));
    // 捕获阶段判断，避免编辑器等阻止冒泡后菜单关不掉
    const handlePointerDown = (event: Event) => {
      if (!isInside(event.target)) onCloseRef.current();
    };
    const handleScroll = (event: Event) => {
      // 菜单自身在矮视口下可能滚动，不应因此关闭
      if (!isInside(event.target)) onCloseRef.current();
    };
    const handleResize = () => onCloseRef.current();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // 只关闭菜单本身：阻止外层弹层（如多维表格单元格编辑弹层）一并关闭
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      // 方向键在菜单项与行内控件之间循环移动焦点，不传给背后的编辑器
      event.preventDefault();
      event.stopPropagation();
      const focusable = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
      if (focusable.length === 0) return;
      const current = focusable.indexOf(document.activeElement as HTMLButtonElement);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = current < 0 ? (step > 0 ? 0 : focusable.length - 1) : (current + step + focusable.length) % focusable.length;
      focusable[next].focus();
    };
    document.addEventListener('mousedown', handlePointerDown, true);
    document.addEventListener('touchstart', handlePointerDown, true);
    document.addEventListener('scroll', handleScroll, true);
    document.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('resize', handleResize);
    window.addEventListener('blur', handleResize);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true);
      document.removeEventListener('touchstart', handlePointerDown, true);
      document.removeEventListener('scroll', handleScroll, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('blur', handleResize);
    };
  }, []);

  /** 先关闭菜单再执行：弹窗类操作需要拿回焦点 */
  const run = (action: () => void) => {
    onClose();
    action();
  };

  const visibleSections = sections.filter((section) => section.kind === 'layout' || section.items.length > 0);

  return createPortal(
    <div
      ref={menuRef}
      className="nb-context-menu nb-image-menu"
      role="menu"
      aria-label="图片操作"
      style={{ left: position.left, top: position.top }}
      // Portal 事件仍沿 React 树冒泡到图片节点与编辑器：只拦 React 树，原生冒泡照常（外部点击关闭逻辑依赖它）
      onMouseDown={(event) => {
        stopReactPropagation(event);
        // 保持编辑器焦点与选区，点击菜单不让正文失焦
        if (!(event.target as HTMLElement).closest('input, textarea')) event.preventDefault();
      }}
      onClick={stopReactPropagation}
      onDoubleClick={stopReactPropagation}
      onPointerDown={stopReactPropagation}
      onContextMenu={(event) => {
        event.preventDefault();
        stopReactPropagation(event);
      }}
    >
      <div className="nb-image-menu-header">
        <ImageIcon size={14} />
        <span className="nb-image-menu-header-name">{title}</span>
        {meta && <span className="nb-image-menu-header-meta">{meta}</span>}
      </div>

      {visibleSections.map((section) => (
        <React.Fragment key={section.key}>
          <div className="nb-image-menu-divider" role="separator" />
          {section.kind === 'items' ? (
            section.items.map((item) => (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                className={item.danger ? 'nb-image-menu-item is-danger' : 'nb-image-menu-item'}
                onClick={() => run(item.onSelect)}
              >
                <item.Icon size={15} />
                <span>{item.label}</span>
              </button>
            ))
          ) : (
            <>
              <div className="nb-image-menu-row">
                <span className="nb-image-menu-row-label">对齐</span>
                <div className="nb-image-menu-segment" role="group" aria-label="对齐">
                  {ALIGN_OPTIONS.map(({ align, label, Icon }) => (
                    <Tooltip key={align} content={label} side="top" sideOffset={6}>
                      <button
                        type="button"
                        aria-label={label}
                        aria-pressed={section.align === align}
                        // 布局调整可连续尝试，不关闭菜单
                        onClick={() => section.onAlign(align)}
                      >
                        <Icon size={14} />
                      </button>
                    </Tooltip>
                  ))}
                </div>
              </div>
              <div className="nb-image-menu-row">
                <span className="nb-image-menu-row-label">宽度</span>
                <div className="nb-image-menu-segment" role="group" aria-label="宽度">
                  {WIDTH_OPTIONS.map((width) => (
                    <button
                      key={width}
                      type="button"
                      aria-label={`宽度 ${width}`}
                      aria-pressed={section.width === width}
                      onClick={() => section.onWidth(width)}
                    >
                      {width}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </React.Fragment>
      ))}
    </div>,
    document.body,
  );
}
