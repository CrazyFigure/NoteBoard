// NoteBoard 思维导图节点图片放大预览
// Portal 到 body 的全屏浮层：滚轮 / Ctrl+滚轮以光标为中心缩放图片，拖动平移，双击在适应窗口与 100% 间切换，
// Esc 或点击空白处关闭。滚轮用原生非 passive 监听拦截，避免缩放背后的导图或触发 WebView 页面缩放。
// 节点挂多张图片时支持左右切换（按钮 / ← → 键）与删除当前图片。
// 详见 docs/09-开发路线图.md

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Maximize2, Trash2, X, ZoomIn, ZoomOut } from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';
import { stopReactPropagation } from '../bitable/bitableUtils';

interface MindmapImagePreviewProps {
  src: string;
  onClose: () => void;
  /** 多图浏览：当前序号（从 0 开始）与总数；总数大于 1 且提供 onNavigate 时显示左右切换 */
  index?: number;
  count?: number;
  onNavigate?: (index: number) => void;
  /** 删除当前图片；未提供时不显示删除按钮 */
  onDelete?: () => void;
}

interface PreviewView {
  scale: number;
  x: number;
  y: number;
}

/** 单次滚轮 / 按钮缩放倍率 */
const ZOOM_STEP = 1.2;
const MIN_SCALE = 0.05;
const MAX_SCALE = 16;
/** 拖动超过该距离不再视为点击 */
const CLICK_TOLERANCE = 4;

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** 计算让图片完整显示在视口内的缩放（不放大小图） */
function computeFitScale(width: number, height: number): number {
  if (width <= 0 || height <= 0) return 1;
  const availW = window.innerWidth * 0.9;
  const availH = (window.innerHeight - 72) * 0.92;
  return Math.min(1, availW / width, availH / height);
}

export function MindmapImagePreview({ src, onClose, index = 0, count = 1, onNavigate, onDelete }: MindmapImagePreviewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [view, setView] = useState<PreviewView>({ scale: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const canNavigate = count > 1 && Boolean(onNavigate);
  // 键盘监听只注册一次，通过 ref 读取最新的切换函数
  const navigateRef = useRef<(step: number) => void>(() => undefined);
  navigateRef.current = (step: number) => {
    // 首尾循环切换
    if (canNavigate) onNavigate!((index + step + count) % count);
  };

  // 切换图片后按新图片尺寸重新适应窗口（首次挂载跳过，避免清掉已先触发 onLoad 的尺寸）
  const shownRef = useRef({ src, index });
  useLayoutEffect(() => {
    if (shownRef.current.src === src && shownRef.current.index === index) return;
    shownRef.current = { src, index };
    setNatural(null);
  }, [src, index]);

  const fitScale = natural ? computeFitScale(natural.width, natural.height) : 1;

  /** 以视口坐标 (clientX, clientY) 为锚点缩放，保持锚点下的图片像素不动 */
  const zoomAt = useCallback((nextScale: number, clientX: number, clientY: number) => {
    const current = viewRef.current;
    const scale = clampScale(nextScale);
    const ax = clientX - window.innerWidth / 2;
    const ay = clientY - window.innerHeight / 2;
    const ratio = scale / current.scale;
    setView({
      scale,
      x: ax - (ax - current.x) * ratio,
      y: ay - (ay - current.y) * ratio,
    });
  }, []);

  /** 回到适应窗口并居中 */
  const resetToFit = useCallback(() => {
    if (!natural) return;
    setView({ scale: computeFitScale(natural.width, natural.height), x: 0, y: 0 });
  }, [natural]);

  // 图片加载完成后按适应窗口初始化
  useEffect(() => {
    if (natural) setView({ scale: computeFitScale(natural.width, natural.height), x: 0, y: 0 });
  }, [natural]);

  // 滚轮：React 的 onWheel 是 passive 监听，无法 preventDefault，必须原生绑定
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      zoomAt(viewRef.current.scale * factor, e.clientX, e.clientY);
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [zoomAt]);

  // 键盘：捕获阶段接管，Esc 关闭；其余按键不再传给背后的导图（避免 Enter / Tab 误建节点）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        navigateRef.current(e.key === 'ArrowLeft' ? -1 : 1);
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  // 窗口尺寸变化时若仍处于适应状态则重新适应
  useEffect(() => {
    const handleResize = () => {
      if (!natural) return;
      setView((v) => (v.x === 0 && v.y === 0 ? { ...v, scale: computeFitScale(natural.width, natural.height) } : v));
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [natural]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    stopReactPropagation(e);
    if (e.button !== 0 || (e.target as HTMLElement).closest('[data-preview-toolbar]')) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: viewRef.current.x,
      originY: viewRef.current.y,
      moved: false,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    stopReactPropagation(e);
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) > CLICK_TOLERANCE) {
      drag.moved = true;
      setIsDragging(true);
    }
    if (drag.moved) {
      setView((v) => ({ ...v, x: drag.originX + dx, y: drag.originY + dy }));
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    stopReactPropagation(e);
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setIsDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    // 未拖动且点在图片之外：视为点击空白处关闭
    const onImage = (e.target as HTMLElement).closest('[data-preview-image]');
    if (!drag.moved && !onImage) onClose();
  };

  const handleDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    stopReactPropagation(e);
    if (!(e.target as HTMLElement).closest('[data-preview-image]')) return;
    // 双击在「适应窗口」与「100%」之间切换
    const isAtFit = Math.abs(viewRef.current.scale - fitScale) < 0.001;
    if (isAtFit && fitScale < 1) {
      zoomAt(1, e.clientX, e.clientY);
    } else {
      resetToFit();
    }
  };

  const zoomByStep = (factor: number) => {
    zoomAt(viewRef.current.scale * factor, window.innerWidth / 2, window.innerHeight / 2);
  };

  const percent = Math.round(view.scale * 100);

  return createPortal(
    <div
      ref={rootRef}
      className="nb-image-preview"
      role="dialog"
      aria-label="图片预览"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onMouseDown={stopReactPropagation}
      onClick={stopReactPropagation}
      onDoubleClick={handleDoubleClick}
      onContextMenu={stopReactPropagation}
      onWheel={stopReactPropagation}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100006,
        background: 'rgba(0, 0, 0, 0.78)',
        overflow: 'hidden',
        cursor: isDragging ? 'grabbing' : 'zoom-out',
        touchAction: 'none',
        animation: 'nbFadeIn 0.15s ease-out',
      }}
    >
      <img
        // 切换到同一地址的图片时也重新挂载，保证 onLoad 触发并重新适应窗口
        key={index}
        data-preview-image
        src={src}
        alt="大图预览"
        draggable={false}
        onLoad={(e) => {
          const img = e.currentTarget;
          setNatural({ width: img.naturalWidth || 1, height: img.naturalHeight || 1 });
        }}
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: natural?.width,
          height: natural?.height,
          maxWidth: 'none',
          transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          transformOrigin: 'center center',
          transition: isDragging ? 'none' : 'transform 0.08s ease-out',
          borderRadius: 4,
          boxShadow: '0 12px 32px rgba(0, 0, 0, 0.4)',
          cursor: isDragging ? 'grabbing' : 'grab',
          userSelect: 'none',
          visibility: natural ? 'visible' : 'hidden',
        }}
      />

      {/* 多图左右切换 */}
      {canNavigate && (
        <>
          <Tooltip content="上一张 (←)" side="right" sideOffset={6}>
            <button
              type="button"
              data-preview-toolbar
              className="nb-image-preview-nav is-prev"
              aria-label="上一张"
              onClick={() => navigateRef.current(-1)}
            >
              <ChevronLeft size={22} />
            </button>
          </Tooltip>
          <Tooltip content="下一张 (→)" side="left" sideOffset={6}>
            <button
              type="button"
              data-preview-toolbar
              className="nb-image-preview-nav is-next"
              aria-label="下一张"
              onClick={() => navigateRef.current(1)}
            >
              <ChevronRight size={22} />
            </button>
          </Tooltip>
        </>
      )}

      {/* 底部缩放工具栏 */}
      <div data-preview-toolbar className="nb-image-preview-toolbar">
        {count > 1 && (
          <>
            <span className="nb-image-preview-counter" aria-live="polite">
              {index + 1} / {count}
            </span>
            <span className="nb-image-preview-divider" />
          </>
        )}
        <Tooltip content="缩小" side="top" sideOffset={6}>
          <button type="button" className="nb-image-preview-btn" aria-label="缩小" onClick={() => zoomByStep(1 / ZOOM_STEP)}>
            <ZoomOut size={15} />
          </button>
        </Tooltip>
        <Tooltip content="恢复 100%" side="top" sideOffset={6}>
          <button
            type="button"
            className="nb-image-preview-btn nb-image-preview-percent"
            aria-label="恢复 100%"
            onClick={() => setView({ scale: 1, x: 0, y: 0 })}
          >
            {percent}%
          </button>
        </Tooltip>
        <Tooltip content="放大" side="top" sideOffset={6}>
          <button type="button" className="nb-image-preview-btn" aria-label="放大" onClick={() => zoomByStep(ZOOM_STEP)}>
            <ZoomIn size={15} />
          </button>
        </Tooltip>
        <Tooltip content="适应窗口" side="top" sideOffset={6}>
          <button type="button" className="nb-image-preview-btn" aria-label="适应窗口" onClick={resetToFit}>
            <Maximize2 size={14} />
          </button>
        </Tooltip>
        <span className="nb-image-preview-divider" />
        {onDelete && (
          <Tooltip content="删除这张图片" side="top" sideOffset={6}>
            <button type="button" className="nb-image-preview-btn is-danger" aria-label="删除这张图片" onClick={onDelete}>
              <Trash2 size={14} />
            </button>
          </Tooltip>
        )}
        <Tooltip content="关闭 (Esc)" side="top" sideOffset={6}>
          <button type="button" className="nb-image-preview-btn" aria-label="关闭" onClick={onClose}>
            <X size={15} />
          </button>
        </Tooltip>
      </div>
    </div>,
    document.body,
  );
}
