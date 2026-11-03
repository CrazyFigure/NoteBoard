// NoteBoard 通用图片放大预览浮层
// Markdown 文档图片与思维导图节点图片共用，Portal 到 body 的全屏浮层，顶部胶囊工具栏、底部图片说明。
// 交互（桌面 Windows / macOS / Linux 与安卓触屏通用）：
// - 滚轮滚动平移，Shift+滚轮横向滚动（触控板双指滑动同样平移）
// - Ctrl / ⌘ + 滚轮以光标为中心缩放；Chromium / WebView2 / WebKitGTK 的触控板捏合也以 Ctrl+滚轮形式到达
// - macOS WKWebView 的触控板捏合走 WebKit 私有 gesture 事件；触屏双指捏合走指针事件
// - 按住拖动平移，双击在适应窗口与 100% 间切换，Esc 或点击空白处关闭
// - 多图时支持左右切换（按钮 / ← → 键）
// 视图状态放在 ref，transform 经 rAF 合并后直写 DOM，避免高频指针 / 滚轮事件重渲染整个浮层（同 DiagramFullscreenModal）。

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FolderOpen,
  Maximize2,
  RotateCw,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';
import { stopReactPropagation } from '../bitable/bitableUtils';
import { USES_COMMAND_KEY } from '../../core/platform';
import '../../styles/imagePreview.css';

export interface ImagePreviewOverlayProps {
  src: string;
  /** 图片说明（Markdown 的替代文本），显示在底部 */
  alt?: string;
  onClose: () => void;
  /** 多图浏览：当前序号（从 0 开始）与总数；总数大于 1 且提供 onNavigate 时显示左右切换 */
  index?: number;
  count?: number;
  onNavigate?: (index: number) => void;
  /** 删除当前图片；未提供时不显示删除按钮 */
  onDelete?: () => void;
  /** 在独立图片标签页中打开；未提供时不显示 */
  onOpenInTab?: () => void;
  /** 在系统文件夹中显示原图；未提供时不显示 */
  onRevealInDir?: () => void;
}

interface PreviewView {
  scale: number;
  x: number;
  y: number;
  /** 顺时针旋转角度，只增不减（取模会让 270° → 0° 反向转一圈） */
  rotate: number;
}

interface Point {
  x: number;
  y: number;
}

/** WebKit 私有的触控板捏合事件（macOS WKWebView） */
interface WebKitGestureEvent extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
}

/** 按钮 / 键盘单次缩放倍率 */
const BUTTON_ZOOM_STEP = 1.2;
/** Ctrl+滚轮每像素增量对应的对数缩放量 */
const WHEEL_ZOOM_SENSITIVITY = 0.01;
/** 单次滚轮事件的最大对数缩放量（约 1.22 倍）：鼠标一格（约 100px）与触控板连续小增量手感一致 */
const WHEEL_ZOOM_MAX_STEP = 0.2;
const MIN_SCALE = 0.05;
const MAX_SCALE = 16;
/** 拖动超过该距离不再视为点击 */
const CLICK_TOLERANCE = 4;
/** 顶部工具栏与底部说明各自预留的高度 */
const CHROME_RESERVE = 68;
/** 按钮缩放 / 复位 / 旋转的过渡；拖动与滚轮需即时跟手，不加过渡 */
const VIEW_TRANSITION = 'transform 0.12s ease-out';
/** 缩放按钮提示中的滚轮快捷键文案 */
const WHEEL_ZOOM_HINT = USES_COMMAND_KEY ? '⌘+滚轮' : 'Ctrl+滚轮';

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** 旋转 90° / 270° 时宽高互换 */
function isQuarterTurn(rotate: number): boolean {
  return ((rotate % 180) + 180) % 180 === 90;
}

/** 计算让图片完整显示在视口内的缩放（不放大小图） */
function computeFitScale(width: number, height: number, rotate: number): number {
  if (width <= 0 || height <= 0) return 1;
  const quarter = isQuarterTurn(rotate);
  const w = quarter ? height : width;
  const h = quarter ? width : height;
  const availW = Math.max(1, window.innerWidth - 48);
  const availH = Math.max(1, window.innerHeight - CHROME_RESERVE * 2);
  return Math.min(1, availW / w, availH / h);
}

/** 统一滚轮增量单位为像素：Firefox / 部分 Linux 环境按行或按页上报 */
function wheelDeltaInPixels(e: WheelEvent): Point {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
  return { x: e.deltaX * unit, y: e.deltaY * unit };
}

export function ImagePreviewOverlay({
  src,
  alt,
  onClose,
  index = 0,
  count = 1,
  onNavigate,
  onDelete,
  onOpenInTab,
  onRevealInDir,
}: ImagePreviewOverlayProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const naturalRef = useRef(natural);
  naturalRef.current = natural;
  const [loadFailed, setLoadFailed] = useState(false);
  // 仅用于工具栏百分比显示，按帧刷新
  const [percent, setPercent] = useState(100);
  const [isDragging, setIsDragging] = useState(false);

  // 视图真值：平移缩放直接写 DOM transform，不经 React 渲染
  const viewRef = useRef<PreviewView>({ scale: 1, x: 0, y: 0, rotate: 0 });
  // 是否处于「适应窗口」状态：窗口尺寸变化、旋转时据此重新适应
  const fitModeRef = useRef(true);
  const rafRef = useRef<number | null>(null);
  const animateRef = useRef(false);

  // 指针手势：按下中的指针、单指拖动、双指捏合
  const pointersRef = useRef(new Map<number, Point>());
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const pinchRef = useRef<{ startDist: number; startScale: number; startMid: Point; origin: Point } | null>(null);
  // 本次按下到全部抬起之间是否拖动 / 捏合过：用于区分「点击空白处关闭」
  const gestureMovedRef = useRef(false);
  // macOS 触控板捏合开始时的缩放比例；捏合期间忽略同时到达的 Ctrl+滚轮，避免重复缩放
  const webkitGestureRef = useRef<{ startScale: number } | null>(null);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const canNavigate = count > 1 && Boolean(onNavigate);

  /** 把 viewRef 写入 DOM，并同步工具栏百分比 */
  const flushView = useCallback(() => {
    rafRef.current = null;
    const v = viewRef.current;
    setPercent(Math.round(v.scale * 100));
    const img = imgRef.current;
    if (!img) return;
    img.style.transition = animateRef.current ? VIEW_TRANSITION : 'none';
    img.style.transform = `translate(-50%, -50%) translate(${v.x}px, ${v.y}px) rotate(${v.rotate}deg) scale(${v.scale})`;
  }, []);

  /** 更新视图：同一帧内的多次更新合并为一次 DOM 写入；immediate 用于图片刚显示时避免闪一帧 */
  const setView = useCallback((next: PreviewView, options: { animate?: boolean; immediate?: boolean } = {}) => {
    viewRef.current = next;
    animateRef.current = Boolean(options.animate);
    if (options.immediate) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      flushView();
      return;
    }
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(flushView);
  }, [flushView]);

  // 卸载时取消尚未执行的帧
  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
  }, []);

  /** 浮层中心的视口坐标（缩放锚点换算用） */
  const getCenter = useCallback((): Point => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, []);

  /** 以视口坐标 (clientX, clientY) 为锚点缩放，保持锚点下的图片像素不动 */
  const zoomAt = useCallback((nextScale: number, clientX: number, clientY: number, animate = false) => {
    const current = viewRef.current;
    const scale = clampScale(nextScale);
    if (scale === current.scale) return;
    const center = getCenter();
    const ax = clientX - center.x;
    const ay = clientY - center.y;
    const ratio = scale / current.scale;
    fitModeRef.current = false;
    setView(
      {
        ...current,
        scale,
        x: ax - (ax - current.x) * ratio,
        y: ay - (ay - current.y) * ratio,
      },
      { animate },
    );
  }, [getCenter, setView]);

  /** 回到适应窗口并居中（保留当前旋转角度） */
  const resetToFit = useCallback((animate = false) => {
    const size = naturalRef.current;
    if (!size) return;
    const { rotate } = viewRef.current;
    fitModeRef.current = true;
    setView({ scale: computeFitScale(size.width, size.height, rotate), x: 0, y: 0, rotate }, { animate });
  }, [setView]);

  /** 按钮 / 键盘缩放：以浮层中心为锚点 */
  const zoomByStep = useCallback((factor: number) => {
    const center = getCenter();
    zoomAt(viewRef.current.scale * factor, center.x, center.y, true);
  }, [getCenter, zoomAt]);

  /** 顺时针旋转 90°：适应窗口状态下按旋转后的尺寸重新适应 */
  const rotateClockwise = () => {
    const current = viewRef.current;
    const rotate = current.rotate + 90;
    const size = naturalRef.current;
    if (fitModeRef.current && size) {
      setView({ scale: computeFitScale(size.width, size.height, rotate), x: 0, y: 0, rotate }, { animate: true });
    } else {
      setView({ ...current, rotate }, { animate: true });
    }
  };

  // 切换图片后清空尺寸与旋转，等新图片 onLoad 再适应窗口（首次挂载跳过，避免清掉已先触发 onLoad 的尺寸）
  const shownRef = useRef({ src, index });
  useLayoutEffect(() => {
    if (shownRef.current.src === src && shownRef.current.index === index) return;
    shownRef.current = { src, index };
    viewRef.current = { ...viewRef.current, rotate: 0 };
    setNatural(null);
    setLoadFailed(false);
  }, [src, index]);

  // 图片加载完成后按适应窗口初始化；布局阶段同步写入 transform，图片显示的第一帧就在正确位置
  useLayoutEffect(() => {
    if (!natural) return;
    fitModeRef.current = true;
    setView(
      { scale: computeFitScale(natural.width, natural.height, 0), x: 0, y: 0, rotate: 0 },
      { immediate: true },
    );
  }, [natural, setView]);

  // 窗口尺寸变化时若仍处于适应状态则重新适应
  useEffect(() => {
    const handleResize = () => {
      if (fitModeRef.current) resetToFit();
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [resetToFit]);

  // 打开时把焦点移到浮层：避免按键输入到背后的编辑器；关闭时还给原先的焦点元素
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    rootRef.current?.focus({ preventScroll: true });
    return () => {
      if (previous && previous.isConnected && typeof previous.focus === 'function') {
        previous.focus({ preventScroll: true });
      }
    };
  }, []);

  // 滚轮：React 的 onWheel 是 passive 监听，无法 preventDefault 拦截页面滚动 / WebView 页面缩放，必须原生绑定
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const delta = wheelDeltaInPixels(e);
      if (e.ctrlKey || e.metaKey) {
        // macOS 捏合期间已由 gesture 事件缩放
        if (webkitGestureRef.current) return;
        const logStep = Math.max(-WHEEL_ZOOM_MAX_STEP, Math.min(WHEEL_ZOOM_MAX_STEP, -delta.y * WHEEL_ZOOM_SENSITIVITY));
        if (logStep === 0) return;
        zoomAt(viewRef.current.scale * Math.exp(logStep), e.clientX, e.clientY);
        return;
      }
      // 普通滚轮平移；Shift+滚轮在 Windows / Linux 鼠标上只给 deltaY，转为横向
      let dx = delta.x;
      let dy = delta.y;
      if (e.shiftKey && dx === 0) {
        dx = dy;
        dy = 0;
      }
      if (dx === 0 && dy === 0) return;
      const current = viewRef.current;
      fitModeRef.current = false;
      setView({ ...current, x: current.x - dx, y: current.y - dy });
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [setView, zoomAt]);

  // macOS WKWebView 触控板捏合：WebKit 不派发 Ctrl+滚轮，而是私有 gesture 事件；同时阻止页面级缩放
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const handleGestureStart = (e: Event) => {
      e.preventDefault();
      // 触屏双指捏合已由指针事件处理（iOS WebKit 会同时派发 gesture 事件）
      if (pointersRef.current.size >= 2) return;
      webkitGestureRef.current = { startScale: viewRef.current.scale };
    };
    const handleGestureChange = (e: Event) => {
      e.preventDefault();
      const gesture = webkitGestureRef.current;
      if (!gesture || pointersRef.current.size >= 2) return;
      const ge = e as WebKitGestureEvent;
      zoomAt(gesture.startScale * ge.scale, ge.clientX, ge.clientY);
    };
    const handleGestureEnd = (e: Event) => {
      e.preventDefault();
      webkitGestureRef.current = null;
    };
    el.addEventListener('gesturestart', handleGestureStart);
    el.addEventListener('gesturechange', handleGestureChange);
    el.addEventListener('gestureend', handleGestureEnd);
    return () => {
      el.removeEventListener('gesturestart', handleGestureStart);
      el.removeEventListener('gesturechange', handleGestureChange);
      el.removeEventListener('gestureend', handleGestureEnd);
    };
  }, [zoomAt]);

  // 键盘监听只注册一次，通过 ref 读取最新的操作函数
  const keyActionsRef = useRef<{
    navigate: (step: number) => void;
    zoomByStep: (factor: number) => void;
    resetToFit: (animate?: boolean) => void;
  }>({ navigate: () => undefined, zoomByStep, resetToFit });
  keyActionsRef.current = {
    navigate: (step: number) => {
      // 首尾循环切换
      if (canNavigate) onNavigate!((index + step + count) % count);
    },
    zoomByStep,
    resetToFit,
  };

  // 键盘：捕获阶段接管，Esc 关闭（preventDefault 让外层弹层不随之关闭）；
  // 其余按键不再传给背后的编辑器 / 导图 / 表格（避免 Enter、Tab、Backspace 误操作）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      e.stopPropagation();
      const actions = keyActionsRef.current;
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        actions.navigate(e.key === 'ArrowLeft' ? -1 : 1);
      } else if (e.key === '+' || e.key === '=') {
        // 同时拦截 Ctrl+= 的 WebView 页面缩放
        e.preventDefault();
        actions.zoomByStep(BUTTON_ZOOM_STEP);
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        actions.zoomByStep(1 / BUTTON_ZOOM_STEP);
      } else if (e.key === '0') {
        e.preventDefault();
        actions.resetToFit(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  /** 由当前两个指针开始双指捏合 */
  const startPinch = () => {
    const [a, b] = Array.from(pointersRef.current.values());
    const v = viewRef.current;
    pinchRef.current = {
      startDist: Math.hypot(b.x - a.x, b.y - a.y) || 1,
      startScale: v.scale,
      startMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      origin: { x: v.x, y: v.y },
    };
    dragRef.current = null;
    gestureMovedRef.current = true;
    setIsDragging(true);
  };

  /** 由指定指针开始单指拖动 */
  const startDrag = (pointerId: number, point: Point) => {
    dragRef.current = {
      pointerId,
      startX: point.x,
      startY: point.y,
      originX: viewRef.current.x,
      originY: viewRef.current.y,
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    stopReactPropagation(e);
    if (e.button !== 0 || (e.target as HTMLElement).closest('[data-preview-toolbar]')) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    const point = { x: e.clientX, y: e.clientY };
    pointersRef.current.set(e.pointerId, point);
    if (pointersRef.current.size === 1) {
      gestureMovedRef.current = false;
      startDrag(e.pointerId, point);
    } else if (pointersRef.current.size === 2) {
      startPinch();
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    stopReactPropagation(e);
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    const pinch = pinchRef.current;
    if (pinch && pointersRef.current.size >= 2) {
      const [a, b] = Array.from(pointersRef.current.values());
      const scale = clampScale(pinch.startScale * (Math.hypot(b.x - a.x, b.y - a.y) / pinch.startDist));
      const center = getCenter();
      const mid = { x: (a.x + b.x) / 2 - center.x, y: (a.y + b.y) / 2 - center.y };
      const startMid = { x: pinch.startMid.x - center.x, y: pinch.startMid.y - center.y };
      // 捏合起点下的图片像素跟随两指中点移动，同时按两指间距缩放
      const ratio = scale / pinch.startScale;
      fitModeRef.current = false;
      setView({
        ...viewRef.current,
        scale,
        x: mid.x - (startMid.x - pinch.origin.x) * ratio,
        y: mid.y - (startMid.y - pinch.origin.y) * ratio,
      });
      return;
    }

    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!gestureMovedRef.current && Math.hypot(dx, dy) > CLICK_TOLERANCE) {
      gestureMovedRef.current = true;
      setIsDragging(true);
    }
    if (gestureMovedRef.current) {
      fitModeRef.current = false;
      setView({ ...viewRef.current, x: drag.originX + dx, y: drag.originY + dy });
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    stopReactPropagation(e);
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.delete(e.pointerId);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    const remaining = pointersRef.current.size;
    if (remaining >= 2) {
      // 三指以上抬起一指：以剩下的两指重新开始捏合
      startPinch();
      return;
    }
    if (remaining === 1) {
      // 捏合结束剩一指：从当前位置继续拖动，不会被当作点击
      pinchRef.current = null;
      const [[pointerId, point]] = Array.from(pointersRef.current.entries());
      startDrag(pointerId, point);
      return;
    }

    pinchRef.current = null;
    dragRef.current = null;
    setIsDragging(false);
    // 未拖动且点在图片之外：视为点击空白处关闭
    const onImage = (e.target as HTMLElement).closest('[data-preview-image]');
    if (e.type === 'pointerup' && !gestureMovedRef.current && !onImage) onClose();
  };

  const handleDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    stopReactPropagation(e);
    const size = naturalRef.current;
    if (!size || !(e.target as HTMLElement).closest('[data-preview-image]')) return;
    const fitScale = computeFitScale(size.width, size.height, viewRef.current.rotate);
    const isAtFit = fitModeRef.current || Math.abs(viewRef.current.scale - fitScale) < 0.001;
    if (isAtFit) {
      // 大图放到 100%，本就完整显示的小图放大一倍
      zoomAt(fitScale < 1 ? 1 : fitScale * 2, e.clientX, e.clientY, true);
    } else {
      resetToFit(true);
    }
  };

  const showFileActions = Boolean(onOpenInTab || onRevealInDir);

  return createPortal(
    <div
      ref={rootRef}
      className="nb-image-preview"
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      tabIndex={-1}
      // 多维表格据此放行键盘，不把按键当作表格快捷键
      data-bitable-keyboard-scope
      data-dragging={isDragging || undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onMouseDown={stopReactPropagation}
      onClick={stopReactPropagation}
      onDoubleClick={handleDoubleClick}
      onContextMenu={stopReactPropagation}
      onWheel={stopReactPropagation}
    >
      {loadFailed ? (
        <div className="nb-image-preview-error">图片加载失败</div>
      ) : (
        <img
          // 切换到同一地址的图片时也重新挂载，保证 onLoad 触发并重新适应窗口
          key={index}
          ref={imgRef}
          className="nb-image-preview-img"
          data-preview-image
          src={src}
          alt={alt || '大图预览'}
          // 禁用 Referer 携带，防止网络图片防盗链拦截
          referrerPolicy="no-referrer"
          draggable={false}
          onLoad={(e) => {
            const img = e.currentTarget;
            setNatural({ width: img.naturalWidth || 1, height: img.naturalHeight || 1 });
          }}
          onError={() => setLoadFailed(true)}
          // transform / transition 由 setView 直接写入，这里不声明，避免重渲染时被 React 覆盖
          style={{
            width: natural?.width,
            height: natural?.height,
            visibility: natural ? 'visible' : 'hidden',
            // 仅拖动期间提升为合成层：平移只做合成不重绘；缩放后按新比例重新光栅化保持清晰
            willChange: isDragging ? 'transform' : 'auto',
          }}
        />
      )}

      {/* 多图左右切换 */}
      {canNavigate && (
        <>
          <Tooltip content="上一张 (←)" side="right" sideOffset={6}>
            <button
              type="button"
              data-preview-toolbar
              className="nb-image-preview-nav is-prev"
              aria-label="上一张"
              onClick={() => keyActionsRef.current.navigate(-1)}
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
              onClick={() => keyActionsRef.current.navigate(1)}
            >
              <ChevronRight size={22} />
            </button>
          </Tooltip>
        </>
      )}

      {/* 顶部悬浮工具栏 */}
      <div data-preview-toolbar className="nb-image-preview-toolbar">
        {count > 1 && (
          <>
            <span className="nb-image-preview-counter" aria-live="polite">
              {index + 1} / {count}
            </span>
            <span className="nb-image-preview-divider" />
          </>
        )}
        <Tooltip content={`缩小 (${WHEEL_ZOOM_HINT})`} side="bottom" sideOffset={6}>
          <button type="button" className="nb-image-preview-btn" aria-label="缩小" onClick={() => zoomByStep(1 / BUTTON_ZOOM_STEP)}>
            <ZoomOut size={16} />
          </button>
        </Tooltip>
        <Tooltip content="恢复 100%" side="bottom" sideOffset={6}>
          <button
            type="button"
            className="nb-image-preview-btn nb-image-preview-percent"
            aria-label="恢复 100%"
            onClick={() => {
              fitModeRef.current = false;
              setView({ ...viewRef.current, scale: 1, x: 0, y: 0 }, { animate: true });
            }}
          >
            {percent}%
          </button>
        </Tooltip>
        <Tooltip content={`放大 (${WHEEL_ZOOM_HINT})`} side="bottom" sideOffset={6}>
          <button type="button" className="nb-image-preview-btn" aria-label="放大" onClick={() => zoomByStep(BUTTON_ZOOM_STEP)}>
            <ZoomIn size={16} />
          </button>
        </Tooltip>
        <Tooltip content="顺时针旋转 90°" side="bottom" sideOffset={6}>
          <button type="button" className="nb-image-preview-btn" aria-label="顺时针旋转 90°" onClick={rotateClockwise}>
            <RotateCw size={16} />
          </button>
        </Tooltip>
        <Tooltip content="适应窗口" side="bottom" sideOffset={6}>
          <button type="button" className="nb-image-preview-btn" aria-label="适应窗口" onClick={() => resetToFit(true)}>
            <Maximize2 size={16} />
          </button>
        </Tooltip>
        {showFileActions && <span className="nb-image-preview-divider" />}
        {onOpenInTab && (
          <Tooltip content="在独立标签页中打开" side="bottom" sideOffset={6}>
            <button type="button" className="nb-image-preview-btn" aria-label="在独立标签页中打开" onClick={onOpenInTab}>
              <ExternalLink size={16} />
            </button>
          </Tooltip>
        )}
        {onRevealInDir && (
          <Tooltip content="在文件夹中显示" side="bottom" sideOffset={6}>
            <button type="button" className="nb-image-preview-btn" aria-label="在文件夹中显示" onClick={onRevealInDir}>
              <FolderOpen size={16} />
            </button>
          </Tooltip>
        )}
        <span className="nb-image-preview-divider" />
        {onDelete && (
          <Tooltip content="删除这张图片" side="bottom" sideOffset={6}>
            <button type="button" className="nb-image-preview-btn is-danger" aria-label="删除这张图片" onClick={onDelete}>
              <Trash2 size={16} />
            </button>
          </Tooltip>
        )}
        <Tooltip content="关闭 (Esc)" side="bottom" sideOffset={6}>
          <button type="button" className="nb-image-preview-btn is-danger" aria-label="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </Tooltip>
      </div>

      {/* 底部图片说明 */}
      {alt && <div className="nb-image-preview-caption">{alt}</div>}
    </div>,
    document.body,
  );
}
