// NoteBoard 图表全屏预览弹窗
// Mermaid / PlantUML / Infographic 共用：按住左键拖动平移、Ctrl(⌘)+滚轮以光标为中心缩放
// 通过 Portal 挂到 body：避免 ProseMirror 截获鼠标事件（拖动时误选节点），也不受编辑区祖先 transform 影响

import { useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';
import { ChartExportMenu } from '../export/ChartExportMenu';
import type { ChartImageSource } from '../export/chartExport';
import { formatShortcut } from '../../core/shortcuts';

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;
/** 按钮每次缩放步长（乘法，保证放大/缩小对称） */
const BUTTON_ZOOM_FACTOR = 1.2;
/** 滚轮每格缩放步长 */
const WHEEL_ZOOM_FACTOR = 1.1;

type Point = { x: number; y: number };

function clampZoom(z: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
}

interface DiagramFullscreenModalProps {
  title: string;
  exportSource: ChartImageSource | null;
  exportFileName: string;
  onClose: () => void;
  children: ReactNode;
}

export function DiagramFullscreenModal({
  title,
  exportSource,
  exportFileName,
  onClose,
  children,
}: DiagramFullscreenModalProps) {
  // 仅用于工具栏百分比与按钮禁用态；拖动期间值不变，React 会跳过重渲染
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // 拖动起点：记录按下时的指针位置与当时的平移量
  const dragStartRef = useRef<{ pointer: Point; pan: Point } | null>(null);
  // 视图真值放在 ref：平移缩放直接写 DOM transform，不经 React 渲染，避免高频指针事件引起整棵弹窗重渲染
  const viewRef = useRef<{ zoom: number; pan: Point }>({ zoom: 1, pan: { x: 0, y: 0 } });
  const rafRef = useRef<number | null>(null);
  const animateRef = useRef(false);

  // 卸载时取消尚未执行的帧
  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
  }, []);

  /**
   * 更新视图：同一帧内的多次更新合并为一次 DOM 写入。
   * animate 仅用于按钮缩放/复位的过渡；拖动与滚轮需即时跟手，不加过渡。
   */
  const setView = useCallback((next: { zoom: number; pan: Point }, animate = false) => {
    viewRef.current = next;
    animateRef.current = animate;
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const { zoom: z, pan: p } = viewRef.current;
      // 百分比显示随帧刷新一次即可，连续滚轮不逐次触发渲染
      setZoom(z);
      const el = contentRef.current;
      if (!el) return;
      el.style.transition = animateRef.current ? 'transform 0.12s ease-out' : 'none';
      el.style.transform = `translate(${p.x}px, ${p.y}px) scale(${z})`;
    });
  }, []);

  /**
   * 以视口内某点为锚点缩放：锚点下的图表内容在缩放前后保持不动。
   * anchor 为相对视口中心的坐标；内容以视口中心为原点居中，屏幕坐标 p = pan + zoom * q。
   */
  const zoomAt = useCallback((nextZoomRaw: number, anchor: Point, animate = false) => {
    const { zoom: prevZoom, pan: prevPan } = viewRef.current;
    const nextZoom = clampZoom(nextZoomRaw);
    if (nextZoom === prevZoom) return;
    const ratio = nextZoom / prevZoom;
    setView(
      {
        zoom: nextZoom,
        pan: {
          x: anchor.x - (anchor.x - prevPan.x) * ratio,
          y: anchor.y - (anchor.y - prevPan.y) * ratio,
        },
      },
      animate,
    );
  }, [setView]);

  const resetView = useCallback(() => {
    setView({ zoom: 1, pan: { x: 0, y: 0 } }, true);
  }, [setView]);

  // 滚轮：React 的 onWheel 是 passive 监听，无法 preventDefault 拦截 WebView 自身的 Ctrl+滚轮页面缩放，需原生绑定
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      // 不带 Ctrl 的滚轮不移动图表；统一拦截，防止滚动穿透到底层编辑区
      e.preventDefault();
      if (!e.ctrlKey && !e.metaKey) return;
      const rect = el.getBoundingClientRect();
      const anchor = {
        x: e.clientX - rect.left - rect.width / 2,
        y: e.clientY - rect.top - rect.height / 2,
      };
      const factor = e.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR;
      zoomAt(viewRef.current.zoom * factor, anchor);
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [zoomAt]);

  // Esc 关闭预览
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // 捕获指针：拖出视口或窗口外松开也能正确结束拖动
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStartRef.current = { pointer: { x: e.clientX, y: e.clientY }, pan: viewRef.current.pan };
    setDragging(true);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    if (!start) return;
    setView({
      zoom: viewRef.current.zoom,
      pan: {
        x: start.pan.x + e.clientX - start.pointer.x,
        y: start.pan.y + e.clientY - start.pointer.y,
      },
    });
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStartRef.current) return;
    dragStartRef.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        // 需高于多维表格单元格编辑弹层（100002），低于全局输入弹窗（100010）
        zIndex: 100006,
        // 不用 backdrop-filter：全屏毛玻璃在内容每帧变化时都要重新模糊，拖动缩放会明显掉帧
        background: 'rgba(0, 0, 0, 0.8)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 20px',
          background: 'var(--editor-surface, #ffffff)',
          borderBottom: '1px solid var(--editor-border, #e2e8f0)',
          userSelect: 'none',
        }}
      >
        <span style={{ fontWeight: 600, color: 'var(--editor-text, #1e293b)' }}>{title}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Tooltip content={formatShortcut('缩小（Ctrl+滚轮）')} side="bottom" sideOffset={4}>
              <button
                type="button"
                className="nb-editor-icon-btn"
                onClick={() => zoomAt(viewRef.current.zoom / BUTTON_ZOOM_FACTOR, { x: 0, y: 0 }, true)}
                disabled={zoom <= MIN_ZOOM}
                aria-label="缩小"
                style={{ padding: '4px 6px' }}
              >
                <ZoomOut size={15} />
              </button>
            </Tooltip>
            <span
              style={{
                fontSize: 12,
                minWidth: 44,
                textAlign: 'center',
                color: 'var(--editor-text, #1e293b)',
              }}
            >
              {Math.round(zoom * 100)}%
            </span>
            <Tooltip content={formatShortcut('放大（Ctrl+滚轮）')} side="bottom" sideOffset={4}>
              <button
                type="button"
                className="nb-editor-icon-btn"
                onClick={() => zoomAt(viewRef.current.zoom * BUTTON_ZOOM_FACTOR, { x: 0, y: 0 }, true)}
                disabled={zoom >= MAX_ZOOM}
                aria-label="放大"
                style={{ padding: '4px 6px' }}
              >
                <ZoomIn size={15} />
              </button>
            </Tooltip>
            <Tooltip content="复位视图" side="bottom" sideOffset={4}>
              <button
                type="button"
                className="nb-editor-icon-btn"
                onClick={resetView}
                aria-label="复位视图"
                style={{ padding: '4px 6px' }}
              >
                <RotateCcw size={15} />
              </button>
            </Tooltip>
          </div>
          <ChartExportMenu action="copy" variant="outline" source={exportSource} fileName={exportFileName} />
          <ChartExportMenu action="download" variant="primary" source={exportSource} fileName={exportFileName} />
          <Tooltip content="关闭预览（Esc）" side="bottom" sideOffset={4}>
            <button
              type="button"
              className="nb-diagram-action-btn"
              onClick={onClose}
              aria-label="关闭预览"
              style={{ padding: 4 }}
            >
              <X size={20} />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* 画布视口：裁剪溢出，内容通过 transform 平移缩放 */}
      <div
        ref={viewportRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={resetView}
        onDragStart={(e) => e.preventDefault()}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 40,
          cursor: dragging ? 'grabbing' : 'grab',
          userSelect: 'none',
          touchAction: 'none',
        }}
      >
        {/* transform / transition 由 setView 直接写入，这里不声明，避免重渲染时被 React 覆盖 */}
        <div
          ref={contentRef}
          style={{
            transformOrigin: 'center center',
            // 仅拖动期间提升为合成层：平移只做合成不重绘；缩放时不保留，以便按新比例重新光栅化保持清晰
            willChange: dragging ? 'transform' : 'auto',
          }}
        >
          {children}
        </div>
      </div>

      {/* 操作提示 */}
      <div
        style={{
          position: 'absolute',
          left: '50%',
          bottom: 16,
          transform: 'translateX(-50%)',
          padding: '4px 12px',
          borderRadius: 999,
          background: 'rgba(0, 0, 0, 0.5)',
          color: 'rgba(255, 255, 255, 0.85)',
          fontSize: 12,
          pointerEvents: 'none',
          userSelect: 'none',
        }}
      >
        {formatShortcut('拖动平移 · Ctrl + 滚轮缩放 · 双击复位')}
      </div>
    </div>,
    document.body,
  );
}
