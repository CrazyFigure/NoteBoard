// NoteBoard 大纲面板 - useHeadings hook
// 遍历 PM doc 提取标题节点，不解析 Markdown 原文
// 详见 docs/09-开发路线图.md 9.1
//
// 设计：
// 1. doc.descendants 遍历，node.type.name === 'heading'
// 2. 提取 level, text, pos
// 3. 当前项高亮：pos <= cursorPos 的最后一个
// 4. selectionUpdate + debounce 100ms
// 5. 编辑区滚动 + debounce 50ms：光标仍在可视区内时跟随光标，
//    光标已滚出可视区时改为跟随可视区最上方所在的章节

import { useState, useEffect, useCallback, useRef } from 'react';
import type { Editor } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';
import { EDITOR_SEARCH_NAVIGATION_META } from '../../core/editor/searchNavigation';
import { findVisualScrollContainer } from '../editor-md/visualScroller';

export interface HeadingItem {
  id: string;
  level: number;
  text: string;
  pos: number;
}

/** 视口顶部判定阈值：标题顶部进入可视区顶端该距离内，即视为当前阅读章节 */
export const VIEWPORT_TOP_THRESHOLD = 40;

/** 取 pos <= targetPos 的最后一个标题 */
export function findHeadingBeforePos<T extends HeadingItem>(headings: readonly T[], targetPos: number): T | null {
  let active: T | null = null;
  for (const h of headings) {
    if (h.pos <= targetPos) {
      active = h;
    } else {
      break;
    }
  }
  return active;
}

/** 判断文档位置所在行是否与滚动容器可视区相交 */
function isPosInViewport(editor: Editor, pos: number, viewport: DOMRect): boolean {
  try {
    const coords = editor.view.coordsAtPos(pos);
    return coords.bottom > viewport.top && coords.top < viewport.bottom;
  } catch {
    return false;
  }
}

/** 取顶部已进入可视区顶端阈值内的最后一个标题，即可视区最上方所在章节 */
function findHeadingAtViewportTop(
  editor: Editor,
  headings: readonly HeadingItem[],
  viewport: DOMRect,
): HeadingItem | null {
  const topLine = viewport.top + VIEWPORT_TOP_THRESHOLD;
  let active: HeadingItem | null = null;
  for (const h of headings) {
    const dom = editor.view.nodeDOM(h.pos);
    if (!(dom instanceof HTMLElement)) continue;
    const rect = dom.getBoundingClientRect();
    // 未渲染（display: none）的标题矩形全为 0，不能参与位置判定
    if (rect.width === 0 && rect.height === 0) continue;
    if (rect.top <= topLine) {
      active = h;
    } else {
      break;
    }
  }
  return active;
}

/** 标题内容与位置完全一致时复用旧数组，避免无变化事务造成无效大纲渲染。 */
function areHeadingsEqual(previous: readonly HeadingItem[], next: readonly HeadingItem[]): boolean {
  if (previous.length !== next.length) return false;
  return previous.every((item, index) => {
    const candidate = next[index];
    return candidate
      && item.id === candidate.id
      && item.level === candidate.level
      && item.text === candidate.text
      && item.pos === candidate.pos;
  });
}

/**
 * 从 TipTap 编辑器提取标题列表
 */
export function useHeadings(editor: Editor | null) {
  const [headings, setHeadings] = useState<HeadingItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 选区监听始终读取最新标题，但监听 Effect 不依赖标题数组，切断
  // “Effect 提取新数组 → setState → Effect 重跑”的 React #185 更新闭环。
  const headingsRef = useRef<HeadingItem[]>([]);

  // 提取标题
  const extractHeadings = useCallback((editor: Editor): HeadingItem[] => {
    const items: HeadingItem[] = [];
    const doc = editor.state.doc;

    doc.descendants((node, pos) => {
      if (node.type.name === 'heading') {
        const level = node.attrs.level as number;
        const text = node.textContent;
        if (text) {
          items.push({
            id: `h-${pos}`,
            level,
            text,
            pos,
          });
        }
      }
      return true; // 继续遍历
    });

    return items;
  }, []);

  // 更新标题列表
  const updateHeadings = useCallback(() => {
    if (!editor) {
      if (headingsRef.current.length === 0) return;
      headingsRef.current = [];
      setHeadings([]);
      return;
    }
    const items = extractHeadings(editor);
    if (areHeadingsEqual(headingsRef.current, items)) return;
    // ref 先于 React 状态同步，保证同一 Effect 随后的活动标题计算读取新文档标题。
    headingsRef.current = items;
    setHeadings(items);
  }, [editor, extractHeadings]);

  // 计算当前活动标题
  // scroller 为空表示由选区变化驱动：用户主动移动了光标，直接跟随光标；
  // 否则由滚动驱动：光标仍在可视区内跟随光标，已滚出则跟随可视区最上方章节
  const updateActiveHeading = useCallback((scroller: HTMLElement | null = null) => {
    const currentHeadings = headingsRef.current;
    if (!editor || editor.isDestroyed || currentHeadings.length === 0) {
      setActiveId(null);
      return;
    }

    const cursorPos = editor.state.selection.from;
    let active = findHeadingBeforePos(currentHeadings, cursorPos);

    const viewport = scroller?.getBoundingClientRect();
    // 编辑区隐藏（如切到源码模式）时尺寸为 0，无法判定可视区，保持光标跟随
    if (viewport && viewport.height > 0 && !isPosInViewport(editor, cursorPos, viewport)) {
      active = findHeadingAtViewportTop(editor, currentHeadings, viewport);
    }

    setActiveId(active?.id ?? null);
  }, [editor]);

  // 监听编辑器更新
  useEffect(() => {
    if (!editor) {
      // 空活动编辑器必须同步清空 ref；否则下次打开标题完全相同的文档时会误判为无需刷新。
      headingsRef.current = [];
      setHeadings((previous) => previous.length === 0 ? previous : []);
      setActiveId(null);
      return;
    }

    // 初始提取
    updateHeadings();
    updateActiveHeading();

    // doc 更新 → 重新提取标题
    const handleUpdate = () => {
      updateHeadings();
    };

    // selectionUpdate → debounce 100ms 更新当前项
    const handleSelectionUpdate = ({ transaction }: { transaction: Transaction }) => {
      // 搜索产生的程序化选区本身不驱动大纲；只有搜索把页面滚走时，才由滚动联动按可视区跟随。
      if (transaction.getMeta(EDITOR_SEARCH_NAVIGATION_META)) return;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        updateActiveHeading();
      }, 100);
    };

    // 编辑区滚动 → debounce 50ms 按可视区重新判定当前项
    let scroller: HTMLElement | null = null;
    try {
      scroller = findVisualScrollContainer(editor.view.dom);
    } catch {
      // 视图尚未挂载时无法取得 DOM，仅保留光标跟随
      scroller = null;
    }
    const handleScroll = () => {
      if (scrollDebounceRef.current) clearTimeout(scrollDebounceRef.current);
      scrollDebounceRef.current = setTimeout(() => {
        updateActiveHeading(scroller);
      }, 50);
    };

    editor.on('update', handleUpdate);
    editor.on('selectionUpdate', handleSelectionUpdate);
    scroller?.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      editor.off('update', handleUpdate);
      editor.off('selectionUpdate', handleSelectionUpdate);
      scroller?.removeEventListener('scroll', handleScroll);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (scrollDebounceRef.current) clearTimeout(scrollDebounceRef.current);
    };
  }, [editor, updateHeadings, updateActiveHeading]);

  return { headings, activeId, setActiveId };
}
