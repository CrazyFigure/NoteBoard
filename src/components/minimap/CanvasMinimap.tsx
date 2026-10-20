// NoteBoard 通用画布缩略图（导图 / 画板等大画布共用）
// 内容用 Canvas 一次性绘制，视口框为 DOM 叠层：平移只移动视口框，不重绘内容；
// 面板按内容真实宽高比显示，视野移出内容时缩略图随之缩放，视口框始终留在面板内。
// 只有当画面里看得到的内容不足面积 1/3、或宽高任一方向不足 1/2 时才出现（内容不大时缩略图没有意义）；
// 未出现或被收起时只算边界不绘制，大文件几乎零额外开销；收起状态按 storageKey 记在本地。

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { Map as MapIcon, X } from 'lucide-react';
import { Tooltip } from '../Tooltip';

/** 世界坐标矩形 */
export interface MinimapRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 一次绘制所需的场景：边界决定缩放，paint 在已变换到世界坐标的画布上作画 */
export interface MinimapScene {
  bounds: MinimapRect | null;
  /** scale 为世界坐标 → 缩略图像素的比例，可据此把线宽 / 最小尺寸换算成固定像素 */
  paint: (ctx: CanvasRenderingContext2D, scale: number, style: CSSStyleDeclaration) => void;
}

export interface CanvasMinimapHandle {
  /** 宿主以命令方式平移（不触发 React 渲染）后调用，只同步视口框位置 */
  syncViewport: () => void;
}

interface CanvasMinimapProps {
  /** 显隐状态的本地存储键，不同编辑器互不影响 */
  storageKey: string;
  /** 引用变化时调用（需要边界判断是否出现）；宿主用 useCallback 绑定内容依赖 */
  getScene: () => MinimapScene;
  /** 当前可视区域的世界坐标 */
  getViewport: () => MinimapRect;
  /** 把可视区域中心移动到指定世界坐标 */
  onNavigate: (centerX: number, centerY: number) => void;
  /** 距编辑区右下角的偏移，避开各编辑器自带的角落控件 */
  right?: number;
  bottom?: number;
  /** 缩略图画布滤镜（画板深色模式与 Excalidraw 画布保持同一反色） */
  canvasFilter?: string;
  /** 默认显隐（本地没有记录时使用） */
  defaultVisible?: boolean;
}

/**
 * 缩略图面板尺寸与内容留白：按内容真实宽高比等比放进上限框；
 * 短边不小于下限，细长内容不会缩成一条线（此时内容在短边方向居中）
 */
const MINIMAP_MAX_WIDTH = 200;
const MINIMAP_MAX_HEIGHT = 150;
const MINIMAP_MIN_SIDE = 48;
const MINIMAP_PADDING = 8;

/**
 * 出现条件（满足其一）：视野面积 ≤ 内容的 1/3，或宽 / 高任一方向 ≤ 内容的 1/2。
 * 消失要同时越过更宽松的阈值，中间留回差避免在临界缩放来回闪。
 */
const SHOW_AREA = 1 / 3;
const SHOW_SIDE = 1 / 2;
const HIDE_AREA = 0.42;
const HIDE_SIDE = 0.6;

/** 单次绘制超过该耗时视为重场景，后续改为合并刷新，避免编辑时逐键重绘 */
const HEAVY_PAINT_MS = 8;
const HEAVY_PAINT_DELAY = 240;

/** 读取本地显隐记录；隐私模式下 localStorage 可能抛错，回退默认值 */
function readVisible(storageKey: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(storageKey);
    return raw === null ? fallback : raw === '1';
  } catch {
    return fallback;
  }
}

interface MinimapSize {
  width: number;
  height: number;
}

/** 无内容时的默认面板尺寸（4:3 横向） */
const DEFAULT_SIZE: MinimapSize = { width: 160, height: 120 };

/** 按内容宽高比等比缩放到上限框内，短边夹到下限 */
export function computePanelSize(bounds: MinimapRect): MinimapSize {
  const innerMaxW = MINIMAP_MAX_WIDTH - MINIMAP_PADDING * 2;
  const innerMaxH = MINIMAP_MAX_HEIGHT - MINIMAP_PADDING * 2;
  const w = Math.max(1, bounds.width);
  const h = Math.max(1, bounds.height);
  const scale = Math.min(innerMaxW / w, innerMaxH / h);
  return {
    width: Math.round(Math.max(MINIMAP_MIN_SIDE, w * scale + MINIMAP_PADDING * 2)),
    height: Math.round(Math.max(MINIMAP_MIN_SIDE, h * scale + MINIMAP_PADDING * 2)),
  };
}

/** 两矩形的外接矩形 */
function unionRect(a: MinimapRect, b: MinimapRect): MinimapRect {
  const left = Math.min(a.left, b.left);
  const top = Math.min(a.top, b.top);
  return {
    left,
    top,
    width: Math.max(a.left + a.width, b.left + b.width) - left,
    height: Math.max(a.top + a.height, b.top + b.height) - top,
  };
}

function sameRect(a: MinimapRect | null, b: MinimapRect | null): boolean {
  return Boolean(a && b && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height);
}

/**
 * 画面里实际看得到的内容占比：取视野与内容范围的重叠部分，再算面积比与较短方向的边长比。
 * 视野漂到空白处（如以左上角为基准放大后）时重叠变小，缩略图会及时出现。
 */
function computeCoverage(viewport: MinimapRect, bounds: MinimapRect): { area: number; side: number } {
  const overlapW = Math.min(viewport.left + viewport.width, bounds.left + bounds.width) - Math.max(viewport.left, bounds.left);
  const overlapH = Math.min(viewport.top + viewport.height, bounds.top + bounds.height) - Math.max(viewport.top, bounds.top);
  const wr = Math.min(1, Math.max(0, overlapW) / Math.max(1, bounds.width));
  const hr = Math.min(1, Math.max(0, overlapH) / Math.max(1, bounds.height));
  return { area: wr * hr, side: Math.min(wr, hr) };
}

/** 世界坐标与缩略图像素之间的映射 */
interface MinimapTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** 按显示范围（内容边界 ∪ 视口）等比适配面板，居中 */
function computeTransform(bounds: MinimapRect, size: MinimapSize): MinimapTransform {
  const innerW = size.width - MINIMAP_PADDING * 2;
  const innerH = size.height - MINIMAP_PADDING * 2;
  const scale = Math.min(innerW / Math.max(1, bounds.width), innerH / Math.max(1, bounds.height));
  return {
    scale,
    offsetX: MINIMAP_PADDING + (innerW - bounds.width * scale) / 2 - bounds.left * scale,
    offsetY: MINIMAP_PADDING + (innerH - bounds.height * scale) / 2 - bounds.top * scale,
  };
}

export const CanvasMinimap = forwardRef<CanvasMinimapHandle, CanvasMinimapProps>(function CanvasMinimap(
  { storageKey, getScene, getViewport, onNavigate, right = 12, bottom = 10, canvasFilter, defaultVisible = true },
  ref,
) {
  // enabled：用户是否展开（记在本地）；needed：内容是否大到需要缩略图（随缩放与内容变化）
  const [enabled, setEnabled] = useState(() => readVisible(storageKey, defaultVisible));
  const [needed, setNeeded] = useState(false);
  const neededRef = useRef(false);
  const [size, setSize] = useState<MinimapSize>(DEFAULT_SIZE);
  const sizeRef = useRef<MinimapSize>(DEFAULT_SIZE);
  const panelRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportBoxRef = useRef<HTMLDivElement>(null);
  const transformRef = useRef<MinimapTransform | null>(null);
  const boundsRef = useRef<MinimapRect | null>(null);
  /** 当前变换所适配的显示范围（内容边界 ∪ 视口），视口移出内容时随之扩大 */
  const displayBoundsRef = useRef<MinimapRect | null>(null);
  /** 重场景下视口引起的重新适配延迟执行，避免平移时逐帧重画 */
  const refitTimerRef = useRef<number | null>(null);
  const sceneRef = useRef<MinimapScene | null>(null);
  /** 场景已更新但还没画到画布上（未出现期间积压，出现时补画） */
  const dirtyRef = useRef(true);
  /** 单次绘制超过阈值后，后续内容刷新改为合并延迟 */
  const heavyRef = useRef(false);
  // 拖动会话：按在视口框内保持抓取偏移，按在框外先把视口中心跳到该点
  const dragRef = useRef<{ pointerId: number; grabDX: number; grabDY: number } | null>(null);
  const getSceneRef = useRef(getScene);
  getSceneRef.current = getScene;
  const getViewportRef = useRef(getViewport);
  getViewportRef.current = getViewport;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

  // 收起后的把手：与左右侧栏把手一致，靠近热区半显、悬停全显
  const hotZoneRef = useRef<HTMLDivElement>(null);
  const [inHotZone, setInHotZone] = useState(false);
  const [handleFocused, setHandleFocused] = useState(false);

  const toggleVisible = useCallback((next: boolean) => {
    // 收起会卸载画布，重新展开时需要整幅重画
    dirtyRef.current = true;
    setEnabled(next);
    try {
      window.localStorage.setItem(storageKey, next ? '1' : '0');
    } catch {
      // 本地存储不可用时只影响记忆，不影响当前显隐
    }
  }, [storageKey]);

  /** 把最新场景画到画布；面板未挂载（已收起）时保留积压标记 */
  const drawScene = useCallback(() => {
    const canvas = canvasRef.current;
    const panel = panelRef.current;
    const scene = sceneRef.current;
    if (!canvas || !panel || !scene) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    dirtyRef.current = false;
    const started = performance.now();
    const dpr = window.devicePixelRatio || 1;
    const pixelW = Math.round(sizeRef.current.width * dpr);
    const pixelH = Math.round(sizeRef.current.height * dpr);
    if (canvas.width !== pixelW) canvas.width = pixelW;
    if (canvas.height !== pixelH) canvas.height = pixelH;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pixelW, pixelH);
    const t = transformRef.current;
    if (!t) return;
    ctx.setTransform(t.scale * dpr, 0, 0, t.scale * dpr, t.offsetX * dpr, t.offsetY * dpr);
    scene.paint(ctx, t.scale, window.getComputedStyle(panel));
    heavyRef.current = performance.now() - started > HEAVY_PAINT_MS;
  }, []);

  /** 按「内容边界 ∪ 视口」重新计算变换；范围变化时标记需要重画 */
  const refit = useCallback((vp: MinimapRect) => {
    const b = boundsRef.current;
    if (!b) {
      displayBoundsRef.current = null;
      transformRef.current = null;
      return;
    }
    const display = unionRect(b, vp);
    if (sameRect(display, displayBoundsRef.current) && transformRef.current) return;
    displayBoundsRef.current = display;
    transformRef.current = computeTransform(display, sizeRef.current);
    dirtyRef.current = true;
  }, []);

  /** 判断是否需要出现，并把当前视口框定位到缩略图上（纯 DOM 写入，可在每帧平移时调用） */
  const syncViewport = useCallback(() => {
    const b = boundsRef.current;
    const vp = getViewportRef.current();
    // 视口移出内容时扩大显示范围，让视口框留在面板内；
    // 在缩略图上拖动时冻结（导航中心本就限制在内容内），重场景下合并为延迟适配
    if (b && !dragRef.current) {
      const display = unionRect(b, vp);
      if (!sameRect(display, displayBoundsRef.current)) {
        if (!heavyRef.current) {
          refit(vp);
        } else if (refitTimerRef.current === null) {
          refitTimerRef.current = window.setTimeout(() => {
            refitTimerRef.current = null;
            if (!dragRef.current) refit(getViewportRef.current());
            syncViewportRef.current();
          }, HEAVY_PAINT_DELAY);
        }
      }
    }
    const t = transformRef.current;
    // 带回差的占比判断，只在状态翻转时触发 React 渲染；
    // 正在缩略图上拖动时冻结显隐，避免拖到内容中央时面板在手下消失
    const coverage = b ? computeCoverage(vp, b) : { area: 1, side: 1 };
    const nextNeeded = dragRef.current
      ? neededRef.current
      : neededRef.current
        ? coverage.area <= HIDE_AREA || coverage.side <= HIDE_SIDE
        : coverage.area <= SHOW_AREA || coverage.side <= SHOW_SIDE;
    if (nextNeeded !== neededRef.current) {
      neededRef.current = nextNeeded;
      setNeeded(nextNeeded);
    }
    // 刚出现或出现期间内容变化：补画积压的场景
    if (nextNeeded && dirtyRef.current) drawScene();
    const box = viewportBoxRef.current;
    if (!box) return;
    if (!t) {
      box.style.display = 'none';
      return;
    }
    // 夹在面板内（重场景延迟适配期间视口可能暂时超出显示范围）
    const size = sizeRef.current;
    const x1 = Math.max(0, vp.left * t.scale + t.offsetX);
    const y1 = Math.max(0, vp.top * t.scale + t.offsetY);
    const x2 = Math.min(size.width, (vp.left + vp.width) * t.scale + t.offsetX);
    const y2 = Math.min(size.height, (vp.top + vp.height) * t.scale + t.offsetY);
    box.style.display = 'block';
    box.style.transform = `translate(${Math.min(x1, size.width - 4)}px, ${Math.min(y1, size.height - 4)}px)`;
    box.style.width = `${Math.max(4, x2 - x1)}px`;
    box.style.height = `${Math.max(4, y2 - y1)}px`;
  }, [drawScene, refit]);
  // 延迟适配回调读取最新的 syncViewport
  const syncViewportRef = useRef(syncViewport);
  syncViewportRef.current = syncViewport;

  useImperativeHandle(ref, () => ({ syncViewport }), [syncViewport]);

  // 内容刷新：边界（O(n)，很轻）总要算，用来判断是否出现；真正作画只在出现时进行。
  // 轻场景下一帧刷新；重场景（单次绘制 > 8ms）合并为延迟刷新，避免编辑大导图时卡顿
  const paintTimerRef = useRef<number | null>(null);
  const paintFrameRef = useRef<number | null>(null);
  useEffect(() => {
    const refresh = () => {
      paintTimerRef.current = null;
      paintFrameRef.current = null;
      // 读取最新场景：合并刷新期间内容可能又变了多次
      const scene = getSceneRef.current();
      const nextSize = scene.bounds ? computePanelSize(scene.bounds) : DEFAULT_SIZE;
      sceneRef.current = scene;
      boundsRef.current = scene.bounds;
      sizeRef.current = nextSize;
      // 尺寸不变时保留原对象避免多余渲染；画布像素尺寸在绘制时立即跟上
      setSize((prev) => (prev.width === nextSize.width && prev.height === nextSize.height ? prev : nextSize));
      // 内容或面板尺寸变化：按当前视口重新适配
      displayBoundsRef.current = null;
      refit(getViewportRef.current());
      dirtyRef.current = true;
      syncViewport();
    };
    if (heavyRef.current) {
      if (paintTimerRef.current !== null) window.clearTimeout(paintTimerRef.current);
      paintTimerRef.current = window.setTimeout(refresh, HEAVY_PAINT_DELAY);
    } else if (paintFrameRef.current === null) {
      paintFrameRef.current = requestAnimationFrame(refresh);
    }
  }, [enabled, getScene, syncViewport, refit]);

  // 卸载时取消尚未执行的绘制
  // 句柄必须清空：StrictMode 的模拟卸载后组件会复用同一组 ref，残留句柄会阻止再次调度
  useEffect(() => () => {
    if (paintTimerRef.current !== null) window.clearTimeout(paintTimerRef.current);
    if (paintFrameRef.current !== null) cancelAnimationFrame(paintFrameRef.current);
    if (refitTimerRef.current !== null) window.clearTimeout(refitTimerRef.current);
    paintTimerRef.current = null;
    paintFrameRef.current = null;
    refitTimerRef.current = null;
  }, []);

  // 宿主通过渲染改变视口（缩放、窗口尺寸）时重新判断是否出现并同步视口框
  useLayoutEffect(() => {
    syncViewport();
  }, [enabled, getViewport, syncViewport]);

  // 收起且内容足够大时才监听热区，其余情况不增加全局 mousemove 开销
  useEffect(() => {
    if (enabled || !needed) return;
    const handleMouseMove = (e: MouseEvent) => {
      const rect = hotZoneRef.current?.getBoundingClientRect();
      if (!rect) return;
      setInHotZone(e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom);
    };
    document.addEventListener('mousemove', handleMouseMove);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      setInHotZone(false);
    };
  }, [enabled, needed]);

  /** 缩略图像素坐标换算为世界坐标 */
  const toWorld = (clientX: number, clientY: number) => {
    const panel = panelRef.current;
    const t = transformRef.current;
    if (!panel || !t) return null;
    const rect = panel.getBoundingClientRect();
    return {
      x: (clientX - rect.left - t.offsetX) / t.scale,
      y: (clientY - rect.top - t.offsetY) / t.scale,
    };
  };

  /** 导航中心限制在内容范围内，避免视口移到空白处后视口框被裁出面板 */
  const navigateClamped = (x: number, y: number) => {
    const b = boundsRef.current;
    if (!b) return;
    onNavigateRef.current(
      Math.min(b.left + b.width, Math.max(b.left, x)),
      Math.min(b.top + b.height, Math.max(b.top, y)),
    );
  };

  // 拖动会话（dragRef 声明在前，供显隐判断读取）
  const [dragging, setDragging] = useState(false);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // 缩略图交互不能落到画布上（否则会触发平移或取消选中）
    e.stopPropagation();
    if (e.button !== 0) return;
    const world = toWorld(e.clientX, e.clientY);
    if (!world) return;
    const vp = getViewportRef.current();
    const cx = vp.left + vp.width / 2;
    const cy = vp.top + vp.height / 2;
    const inside = world.x >= vp.left && world.x <= vp.left + vp.width && world.y >= vp.top && world.y <= vp.top + vp.height;
    dragRef.current = {
      pointerId: e.pointerId,
      grabDX: inside ? world.x - cx : 0,
      grabDY: inside ? world.y - cy : 0,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    if (!inside) navigateClamped(world.x, world.y);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    e.stopPropagation();
    const world = toWorld(e.clientX, e.clientY);
    if (world) navigateClamped(world.x - drag.grabDX, world.y - drag.grabDY);
  };

  const handlePointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    e.stopPropagation();
    dragRef.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    // 松手后按最终位置重新判断显隐
    syncViewport();
  };

  if (!enabled) {
    // 内容不大时连把手也不出现
    if (!needed) return null;
    const isHighlighted = handleFocused;
    return (
      <>
        {/* 右下角不可见热区，鼠标靠近即唤出展开把手 */}
        <div
          ref={hotZoneRef}
          style={{ position: 'absolute', right: 0, bottom: 0, width: 160, height: 110, pointerEvents: 'none', zIndex: 6 }}
        />
        <Tooltip content="显示缩略图" side="left" sideOffset={6}>
          <button
            type="button"
            className="nb-minimap-handle"
            data-minimap
            data-near={inHotZone || isHighlighted ? 'true' : undefined}
            aria-label="显示缩略图"
            aria-expanded={false}
            style={{ right, bottom }}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onFocus={() => setHandleFocused(true)}
            onBlur={() => setHandleFocused(false)}
            onClick={() => toggleVisible(true)}
          >
            <MapIcon size={14} />
          </button>
        </Tooltip>
      </>
    );
  }

  // 展开但内容不大时面板保持挂载、只做淡出，避免出现 / 消失时重建画布
  return (
    <div
      ref={panelRef}
      className="nb-minimap"
      data-minimap
      data-idle={needed ? undefined : 'true'}
      aria-hidden={needed ? undefined : true}
      data-dragging={dragging ? 'true' : undefined}
      style={{ right, bottom, width: size.width, height: size.height }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas
        ref={canvasRef}
        style={{ width: size.width, height: size.height, display: 'block', filter: canvasFilter }}
      />
      <div ref={viewportBoxRef} className="nb-minimap-viewport" />
      {/* 悬停面板时出现的收起按钮 */}
      <Tooltip content="隐藏缩略图" side="top" sideOffset={6}>
        <button
          type="button"
          className="nb-minimap-close"
          aria-label="隐藏缩略图"
          aria-expanded
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => toggleVisible(false)}
        >
          <X size={12} />
        </button>
      </Tooltip>
    </div>
  );
});
