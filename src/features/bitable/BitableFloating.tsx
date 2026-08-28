// NoteBoard 多维表格通用浮动面板容器
// 通过 Portal 渲染到 body 并使用 fixed 定位：
// 1) 规避表格滚动容器与表头 overflow 对浮层的裁剪（此前视图下拉菜单被 Tab 栏 overflow-x:auto 裁掉）
// 2) 规避 sticky 表头/单元格形成的层叠上下文导致的 z-index 失效
// 3) 统一处理外部点击关闭、Esc 关闭、滚动与窗口尺寸变化时关闭

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface AnchorRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

/** 读取元素在视口中的位置作为浮层锚点 */
export function getAnchorRect(el: Element | null | undefined): AnchorRect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
}

/**
 * 拖拽跟随幽灵
 * 通过 Portal 渲染到 body 并跟随指针，位置按「抓取点偏移」贴合被拖元素，
 * 避免出现「幽灵显示在指针右侧、实际拖的是另一列」的错位感。
 */
export function DragGhost({
  x,
  y,
  width,
  children,
}: {
  x: number;
  y: number;
  width?: number;
  children: React.ReactNode;
}) {
  return createPortal(
    <div
      style={{
        position: 'fixed',
        top: y,
        left: x,
        width,
        zIndex: 100001,
        padding: '4px 10px',
        borderRadius: 6,
        background: 'var(--editor-accent, #3b82f6)',
        color: '#ffffff',
        fontSize: 12,
        fontWeight: 500,
        lineHeight: 1.4,
        pointerEvents: 'none',
        opacity: 0.96,
        boxShadow: '0 6px 18px rgba(0,0,0,0.22)',
        maxWidth: 240,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        boxSizing: 'border-box',
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

interface FloatingPanelProps {
  anchor: AnchorRect;
  width?: number;
  /** 内部条目间距：菜单类浮层用较小间距，面板类用较大间距 */
  gap?: number;
  /** left：浮层左边缘对齐锚点左边缘；right：浮层右边缘对齐锚点右边缘 */
  align?: 'left' | 'right';
  /** 触发元素：点击其内部时不触发关闭，保证触发按钮自身的 toggle 逻辑生效 */
  trigger?: HTMLElement | null;
  onClose: () => void;
  children: React.ReactNode;
}

const VIEWPORT_PADDING = 8;
const MIN_VISIBLE_HEIGHT = 160;

export function FloatingPanel({
  anchor,
  width = 240,
  gap = 6,
  align = 'left',
  trigger,
  onClose,
  children,
}: FloatingPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  // 依据锚点与实测高度计算定位：优先向下展开，下方空间不足则向上翻转
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const height = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const rawLeft = align === 'right' ? anchor.right - width : anchor.left;
    const left = Math.max(VIEWPORT_PADDING, Math.min(rawLeft, vw - width - VIEWPORT_PADDING));

    let top = anchor.bottom + 4;
    let maxHeight = vh - top - VIEWPORT_PADDING;

    if (maxHeight < Math.min(height, MIN_VISIBLE_HEIGHT)) {
      const flippedTop = anchor.top - 4 - height;
      if (flippedTop > VIEWPORT_PADDING) {
        top = flippedTop;
        maxHeight = height;
      } else {
        top = Math.max(VIEWPORT_PADDING, vh - height - VIEWPORT_PADDING);
        maxHeight = vh - top - VIEWPORT_PADDING;
      }
    }

    setLayout({ top, left, maxHeight: Math.max(120, maxHeight) });
  }, [anchor.top, anchor.bottom, anchor.left, anchor.right, width, align]);

  // 外部点击、Esc、外部滚动与窗口尺寸变化时关闭浮层
  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (trigger && trigger.contains(target)) return;
      onClose();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const handleScroll = (e: Event) => {
      // 浮层内部的滚动不关闭，其余任何祖先滚动都会让 fixed 定位失效，直接关闭
      if (panelRef.current && e.target instanceof Node && panelRef.current.contains(e.target)) return;
      onClose();
    };

    document.addEventListener('mousedown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleScroll);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleScroll);
    };
  }, [onClose, trigger]);

  return createPortal(
    <div
      ref={panelRef}
      // 阻断事件向 React 父树冒泡：Portal 内的点击会冒泡到渲染它的单元格/表头，造成误选区或菜单闪关
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        top: layout?.top ?? anchor.bottom + 4,
        left: layout?.left ?? anchor.left,
        width,
        maxHeight: layout?.maxHeight,
        visibility: layout ? 'visible' : 'hidden',
        overflowY: 'auto',
        boxSizing: 'border-box',
        background: 'var(--editor-surface, #ffffff)',
        border: '1px solid var(--editor-border, #e2e8f0)',
        borderRadius: 8,
        boxShadow: '0 8px 28px rgba(0,0,0,0.16)',
        padding: 6,
        zIndex: 100000,
        display: 'flex',
        flexDirection: 'column',
        gap,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
