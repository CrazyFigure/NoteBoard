// NoteBoard 编辑区内目录（设置「Markdown 大纲位置」为「编辑区内」时显示）
// 固定在编辑区左上 / 右上角，不随正文滚动；沉浸阅读时同样显示
// 展开时为正文让出侧边留白：宿主内边距只改一次（一次重排），正文位移用 FLIP 合成层动画补间，长文档不卡顿
// 当前章节高亮、点击跳转与右侧栏大纲共用 useOutlineNavigator

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlignLeft, ChevronsLeft, ChevronsRight } from 'lucide-react';
import type { Editor } from '@tiptap/core';
import { Tooltip } from '../../components/Tooltip';
import { IS_MOBILE_UI } from '../../core/platform';
import { useLayoutStore } from '../../stores/layoutStore';
import { useSettingsStore } from '../../stores/settingsStore';
import type { HeadingItem } from './useHeadings';
import { useOutlineNavigator } from './useOutlineNavigator';
import './inlineOutline.css';

/** 收起时为开关按钮预留的侧边留白，避免与块把手、首行文字重叠 */
const COLLAPSED_GUTTER = 48;
/** 目录列表宽度 */
const PANEL_WIDTH = 208;
/** 展开时的侧边留白：外边距 12 + 列表 + 与正文间距 20 */
const EXPANDED_GUTTER = 12 + PANEL_WIDTH + 20;
/** 正文位移动画时长与缓动，与目录淡入保持一致 */
const SHIFT_DURATION = 280;
const SHIFT_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';
/** 展开状态按用户记忆（跨文档、跨重启），缺省展开 */
const EXPANDED_STORAGE_KEY = 'nb.inlineOutline.expanded';

type Side = 'left' | 'right';

function readExpanded(): boolean {
  try {
    return localStorage.getItem(EXPANDED_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

function writeExpanded(expanded: boolean): void {
  try {
    localStorage.setItem(EXPANDED_STORAGE_KEY, expanded ? '1' : '0');
  } catch {
    // 存储不可用时只影响下次打开的初始状态
  }
}

/** 宿主内当前可见的编辑内核容器（可视化滚动容器或源码容器）与其中的正文元素 */
function findVisibleKernel(host: HTMLElement): { container: HTMLElement; content: HTMLElement | null; scroller: HTMLElement | null } | null {
  for (const child of Array.from(host.children)) {
    if (!(child instanceof HTMLElement) || child.offsetParent === null) continue;
    const content = child.querySelector<HTMLElement>('.ProseMirror, .cm-content');
    if (!content) continue;
    const scroller = child.matches('.nb-md-visual-scroller') ? child : child.querySelector<HTMLElement>('.cm-scroller');
    return { container: child, content, scroller };
  }
  return null;
}

/** 记录可视区顶部第一个块及其相对位置：正文换行宽度变化后据此恢复阅读位置 */
function captureScrollAnchor(scroller: HTMLElement | null): { scroller: HTMLElement; block: Element; offset: number } | null {
  if (!scroller || !scroller.matches('.nb-md-visual-scroller')) return null;
  const blocks = scroller.querySelector('.ProseMirror')?.children;
  if (!blocks || blocks.length === 0) return null;
  const top = scroller.getBoundingClientRect().top;
  // 二分查找底边越过可视区顶部的第一个块，长文档不逐块测量
  let low = 0;
  let high = blocks.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (blocks[mid].getBoundingClientRect().bottom <= top) low = mid + 1;
    else high = mid;
  }
  const block = blocks[low];
  return { scroller, block, offset: block.getBoundingClientRect().top - top };
}

function restoreScrollAnchor(anchor: ReturnType<typeof captureScrollAnchor>): void {
  if (!anchor || !anchor.block.isConnected) return;
  // 浏览器自带滚动锚定已修正时差值为 0，不会重复调整
  const drift = anchor.block.getBoundingClientRect().top - anchor.scroller.getBoundingClientRect().top - anchor.offset;
  if (Math.abs(drift) >= 1) anchor.scroller.scrollTop += drift;
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * 须作为编辑器根节点的直接子元素渲染：目录相对根节点定位，侧边留白也加在根节点上。
 * 根节点经目录自身的 parentElement 取得——父组件的 ref 要在子组件 layout effect 之后才赋值，首次挂载时还是空的。
 */
interface InlineOutlineProps {
  editor: Editor | null;
  docKey: string;
  /** 是否为当前活动文档：后台保活实例保留留白，但不提取标题 */
  active: boolean;
  reading: boolean;
}

/** 入口：按设置决定是否挂载，关闭时由内部组件卸载清理留白 */
export function InlineOutline(props: InlineOutlineProps) {
  const enabled = useSettingsStore((s) => s.settings.editor.outlinePosition === 'inline');
  const side: Side = useSettingsStore((s) => (s.settings.editor.outlineInlineSide === 'right' ? 'right' : 'left'));
  // 极窄模式只保留编辑区，空间不足以放目录；移动端另有大纲面板
  const compactMode = useLayoutStore((s) => s.compactMode);
  if (!enabled || compactMode || IS_MOBILE_UI) return null;
  return <InlineOutlineInner {...props} side={side} />;
}

function InlineOutlineInner({ editor, docKey, active, reading, side }: InlineOutlineProps & { side: Side }) {
  const [expanded, setExpanded] = useState(readExpanded);
  const { headings, activeId, jumpTo } = useOutlineNavigator(active ? editor : null, active ? docKey : null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // 首次挂载直接套用留白，之后的展开 / 收起 / 换边才播放位移动画
  const appliedRef = useRef(false);

  // 侧边留白：只改一次内边距，正文从旧位置平滑移到新位置
  useLayoutEffect(() => {
    const host = panelRef.current?.parentElement;
    if (!host) return;
    const gutter = `${expanded ? EXPANDED_GUTTER : COLLAPSED_GUTTER}px`;
    const own = side === 'left' ? 'paddingLeft' : 'paddingRight';
    const other = side === 'left' ? 'paddingRight' : 'paddingLeft';
    if (host.style[own] === gutter && !host.style[other]) return;

    const kernel = findVisibleKernel(host);
    const animate = appliedRef.current && !!kernel?.content && !prefersReducedMotion();
    const before = animate ? kernel!.content!.getBoundingClientRect().left : 0;
    const anchor = captureScrollAnchor(kernel?.scroller ?? null);

    host.style[other] = '';
    host.style[own] = gutter;
    appliedRef.current = true;
    restoreScrollAnchor(anchor);

    if (!animate || !kernel?.content) return;
    // 位移加在整个内核容器上：正文本身位移会撑出横向滚动条，容器外层裁剪不会
    const dx = before - kernel.content.getBoundingClientRect().left;
    if (Math.abs(dx) < 0.5 || typeof kernel.container.animate !== 'function') return;
    kernel.container.animate(
      [{ transform: `translateX(${dx}px)` }, { transform: 'translateX(0)' }],
      { duration: SHIFT_DURATION, easing: SHIFT_EASING },
    );
  }, [expanded, side]);

  // 卸载（关闭设置、切到极窄模式）时撤销留白
  useEffect(() => {
    const host = panelRef.current?.parentElement;
    return () => {
      if (!host) return;
      host.style.paddingLeft = '';
      host.style.paddingRight = '';
    };
  }, []);

  const toggle = useCallback(() => {
    setExpanded((prev) => {
      writeExpanded(!prev);
      return !prev;
    });
  }, []);

  // 当前章节滚出目录可视范围时让它回到视野；只滚动目录自身，不牵动编辑区
  useEffect(() => {
    const list = listRef.current;
    if (!expanded || !activeId || !list) return;
    const item = list.querySelector<HTMLElement>(`[data-heading-id="${activeId}"]`);
    if (!item) return;
    const top = item.offsetTop;
    const bottom = top + item.offsetHeight;
    if (top < list.scrollTop) list.scrollTo({ top: top - 8, behavior: 'smooth' });
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTo({ top: bottom - list.clientHeight + 8, behavior: 'smooth' });
  }, [activeId, expanded]);

  // 目录与侧边留白都不在正文滚动容器内：在这些位置滚动滚轮时转交给正文；
  // 指针在目录列表上且列表还能朝该方向滚动时，留给列表自己滚
  useEffect(() => {
    const host = panelRef.current?.parentElement;
    if (!host) return;
    const handleWheel = (event: WheelEvent) => {
      const target = event.target as Node | null;
      const panel = panelRef.current;
      if (target !== host && !(panel && target && panel.contains(target))) return;
      const list = listRef.current;
      if (list && target && list.contains(target)) {
        const canScroll = event.deltaY < 0 ? list.scrollTop > 0 : list.scrollTop + list.clientHeight < list.scrollHeight - 1;
        if (canScroll) return;
      }
      // 行 / 页为单位的滚轮（部分鼠标驱动）按行高、视口高度换算成像素
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? host.clientHeight : 1;
      findVisibleKernel(host)?.scroller?.scrollBy({ top: event.deltaY * unit, left: 0 });
    };
    host.addEventListener('wheel', handleWheel, { passive: true });
    return () => host.removeEventListener('wheel', handleWheel);
  }, []);

  // 缩进以文档中最浅的标题级别为起点，只有 h2/h3 的文档不会整体右缩
  const minLevel = useMemo(() => headings.reduce((min, h) => Math.min(min, h.level), 6), [headings]);

  const label = expanded ? '收起目录' : '展开目录';
  const CollapseIcon = side === 'left' ? ChevronsLeft : ChevronsRight;

  return (
    <div
      ref={panelRef}
      className="nb-inline-outline"
      data-side={side}
      data-expanded={expanded ? 'true' : 'false'}
      data-reading={reading ? 'true' : undefined}
      style={{ width: PANEL_WIDTH }}
    >
      <Tooltip content={label} side={side === 'left' ? 'right' : 'left'} sideOffset={6}>
        <button
          type="button"
          className="nb-inline-outline-toggle"
          aria-label={label}
          aria-expanded={expanded}
          onClick={toggle}
        >
          {/* 两个图标叠放交叉淡入并旋转，切换时不跳变 */}
          <span className="nb-inline-outline-icon is-list" aria-hidden="true"><AlignLeft size={16} strokeWidth={2} /></span>
          <span className="nb-inline-outline-icon is-collapse" aria-hidden="true"><CollapseIcon size={16} strokeWidth={2} /></span>
        </button>
      </Tooltip>

      {/* 收起时整块设为 inert：不可聚焦、不响应指针，列表项本身不随展开状态重渲染 */}
      <div ref={listRef} className="nb-inline-outline-list" role="navigation" aria-label="目录" inert={!expanded}>
        <OutlineItems headings={headings} activeId={activeId} minLevel={minLevel} side={side} onJump={jumpTo} />
      </div>
    </div>
  );
}

interface OutlineItemsProps {
  headings: HeadingItem[];
  activeId: string | null;
  minLevel: number;
  side: Side;
  onJump: (heading: HeadingItem) => void;
}

/** 目录项列表：memo 隔离展开 / 收起，长文档上百个标题时切换只改容器属性 */
const OutlineItems = memo(function OutlineItems({ headings, activeId, minLevel, side, onJump }: OutlineItemsProps) {
  if (headings.length === 0) return <div className="nb-inline-outline-empty">暂无标题</div>;
  return (
    <>
      {headings.map((h, index) => (
        <Tooltip key={h.id} content={h.text} side={side === 'left' ? 'right' : 'left'} sideOffset={8}>
          <button
            type="button"
            className={`nb-inline-outline-item${h.id === activeId ? ' is-active' : ''}`}
            data-heading-id={h.id}
            data-level={h.level}
            style={{
              paddingLeft: 8 + Math.min(h.level - minLevel, 4) * 12,
              // 展开时逐项轻微错峰淡入，前 12 项之后不再延迟
              ['--nb-io-delay' as string]: `${Math.min(index, 12) * 14}ms`,
            }}
            onClick={() => onJump(h)}
          >
            <span className="nb-inline-outline-text">{h.text}</span>
          </button>
        </Tooltip>
      ))}
    </>
  );
});
