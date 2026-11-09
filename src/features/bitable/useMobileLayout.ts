// 多维表格移动端布局辅助
// 1. 视口宽度：竖屏手机上限制固定列 / 甘特左侧栏的宽度，避免把可滚动区域挤没；
// 2. 横屏收起工具栏：手机横屏高度只有三四百像素，内容向下滚动时收起顶部工具栏，向上滚动时再展开（同浏览器地址栏）。

import { useEffect, useState, type RefObject } from 'react';
import { IS_MOBILE_UI } from '../../core/platform';

/** 横屏等矮视口的判定：高度不超过该值时启用滚动收起工具栏 */
export const SHORT_VIEWPORT_QUERY = '(max-height: 500px)';

/** 滚动方向累计超过该距离才切换收起 / 展开，过滤手指抖动 */
const CHROME_TOGGLE_DISTANCE = 24;
/** 距顶部不超过该值时始终展开 */
const CHROME_TOP_ZONE = 8;
/** 切换后的锁定时长：工具栏收起会让滚动容器变高、scrollTop 被钳制，期间的滚动事件不参与判定，避免来回抖动 */
const CHROME_TOGGLE_LOCK_MS = 350;

/** 移动端返回视口宽度（随旋转与窗口尺寸更新）；桌面返回 null，不改变既有布局 */
export function useMobileViewportWidth(): number | null {
  const [width, setWidth] = useState<number | null>(() => (IS_MOBILE_UI && typeof window !== 'undefined' ? window.innerWidth : null));
  useEffect(() => {
    if (!IS_MOBILE_UI) return;
    const update = () => setWidth(window.innerWidth);
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return width;
}

/** 单个滚动容器的方向追踪状态 */
export interface ScrollTrack {
  /** 当前方向开始时的位置 */
  anchor: number;
  /** 上一次的位置 */
  last: number;
}

/**
 * 根据一次纵向滚动更新追踪状态，返回期望的收起状态（null 表示保持不变）。
 * 纯函数，便于单测：方向反转时重置起点，同方向累计超过阈值才切换。
 */
export function trackChromeScroll(track: ScrollTrack, top: number): boolean | null {
  const step = top - track.last;
  const run = track.last - track.anchor;
  // 方向反转：以上一次位置作为新方向的起点
  if ((step > 0 && run < 0) || (step < 0 && run > 0)) track.anchor = track.last;
  track.last = top;
  if (top <= CHROME_TOP_ZONE) return false;
  const distance = top - track.anchor;
  if (distance >= CHROME_TOGGLE_DISTANCE) return true;
  if (distance <= -CHROME_TOGGLE_DISTANCE) return false;
  return null;
}

/**
 * 矮视口（手机横屏）下随内容滚动收起 / 展开工具栏。
 * 在根节点捕获阶段监听所有后代滚动容器（表格、看板列、甘特图），只看纵向变化；
 * 工具栏自身的横向滚动、工具栏内输入框聚焦时不收起。
 */
export function useCollapsibleChrome(rootRef: RefObject<HTMLElement | null>, excludeSelector: string): boolean {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const root = rootRef.current;
    if (!IS_MOBILE_UI || !root || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(SHORT_VIEWPORT_QUERY);
    const tracks = new WeakMap<Element, ScrollTrack>();
    let current = false;
    let lockUntil = 0;

    const apply = (next: boolean) => {
      if (next === current) return;
      current = next;
      lockUntil = performance.now() + CHROME_TOGGLE_LOCK_MS;
      setCollapsed(next);
    };

    const onScroll = (e: Event) => {
      const el = e.target;
      if (!(el instanceof HTMLElement) || el.closest(excludeSelector)) return;
      const top = el.scrollTop;
      let track = tracks.get(el);
      if (!track) {
        track = { anchor: top, last: top };
        tracks.set(el, track);
        return;
      }
      if (!mq.matches) {
        track.anchor = track.last = top;
        apply(false);
        return;
      }
      // 锁定期内只同步位置，不做判定
      if (performance.now() < lockUntil) {
        track.anchor = track.last = top;
        return;
      }
      const next = trackChromeScroll(track, top);
      if (next === null) return;
      if (next) {
        // 正在工具栏里输入（如搜索）时不收起，避免输入框突然消失
        const bars = Array.from(root.querySelectorAll<HTMLElement>(excludeSelector));
        if (document.activeElement && bars.some((bar) => bar.contains(document.activeElement))) return;
        // 内容只比视口略高时不收起：收起后容器变高、内容放得下，scrollTop 归零又会立刻展开，来回跳动
        const barsHeight = bars.reduce((sum, bar) => sum + bar.offsetHeight, 0);
        if (el.scrollHeight - el.clientHeight < barsHeight + CHROME_TOGGLE_DISTANCE + CHROME_TOP_ZONE) return;
      }
      apply(next);
    };
    // 旋转回竖屏：恢复展开
    const onMediaChange = () => {
      if (!mq.matches) apply(false);
    };

    root.addEventListener('scroll', onScroll, true);
    mq.addEventListener?.('change', onMediaChange);
    return () => {
      root.removeEventListener('scroll', onScroll, true);
      mq.removeEventListener?.('change', onMediaChange);
    };
  }, [rootRef, excludeSelector]);

  return collapsed;
}

/**
 * 竖屏窄屏下实际生效的固定列数：固定列总宽超过视口的一定比例时，从右往左减少固定列，
 * 保证仍有足够宽度横向滚动查看其余字段（只影响显示，不改动用户保存的设置）。
 */
export function limitFrozenCount(widths: number[], frozenCount: number, leadingWidth: number, viewportWidth: number | null, ratio = 0.6): number {
  if (viewportWidth === null || frozenCount <= 0) return frozenCount;
  const budget = viewportWidth * ratio;
  let acc = leadingWidth;
  for (let i = 0; i < frozenCount; i++) {
    acc += widths[i] ?? 0;
    if (acc > budget) return i;
  }
  return frozenCount;
}

/**
 * 窄屏下按比例压缩甘特图左侧字段列宽，使左侧栏不超过视口的一定比例（每列不低于 minWidth）。
 * 宽度足够或桌面端原样返回。
 */
export function fitPaneWidths(widths: number[], leadingWidth: number, viewportWidth: number | null, ratio = 0.5, minWidth = 90): number[] {
  if (viewportWidth === null || widths.length === 0) return widths;
  const total = widths.reduce((sum, w) => sum + w, 0);
  const budget = viewportWidth * ratio - leadingWidth;
  if (total <= budget) return widths;
  const scale = Math.max(0, budget) / total;
  return widths.map((w) => Math.max(minWidth, Math.floor(w * scale)));
}
