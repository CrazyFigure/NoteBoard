// NoteBoard 大纲面板 - 源码模式数据源
// 源码模式下（含不挂载可视化内核的大文档）从 CodeMirror 文档提取标题，交互与可视化大纲一致：
// 1. 文档变化 → debounce 200ms 重新提取（大文档每次按键不全文扫描）
// 2. 选区变化 → debounce 100ms 跟随光标
// 3. 编辑区滚动 → debounce 50ms：光标仍在可视区内时跟随光标，否则跟随可视区最上方章节
// 🔴 大纲随首屏装载：这里只依赖 CodeMirror 类型，运行时能力取自视图实例本身，不把编辑器内核打进首屏包。

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { EditorView } from '@codemirror/view';
import {
  getMdSourceView,
  subscribeMdSourceViewUpdates,
  subscribeMdSourceViews,
} from '../editor-md/editorInstances';
import { extractSourceHeadings, type SourceHeadingItem } from './sourceHeadings';
import { findHeadingBeforePos, VIEWPORT_TOP_THRESHOLD } from './useHeadings';

/** 标题内容与原文位置完全一致时复用旧数组，避免无效渲染（文字范围变化必须更新，重命名依赖它） */
function areSourceHeadingsEqual(previous: readonly SourceHeadingItem[], next: readonly SourceHeadingItem[]): boolean {
  if (previous.length !== next.length) return false;
  return previous.every((item, index) => {
    const candidate = next[index];
    return item.level === candidate.level
      && item.text === candidate.text
      && item.pos === candidate.pos
      && item.textFrom === candidate.textFrom
      && item.textTo === candidate.textTo;
  });
}

/** 当前文档的源码视图（视图在初始化后才创建，销毁时注销；均会触发重新绑定） */
export function useMdSourceView(docKey: string | null): EditorView | null {
  return useSyncExternalStore(
    subscribeMdSourceViews,
    () => (docKey ? getMdSourceView(docKey) ?? null : null),
  );
}

/** 跳转到源码标题：光标落在标题文字开头，标题行滚动到可视区顶部 */
export function jumpToSourceHeading(view: EditorView, heading: SourceHeadingItem): void {
  const length = view.state.doc.length;
  const pos = Math.min(heading.pos, length);
  // 取视图自身的构造器创建滚动效果，避免静态引入 CodeMirror 运行时
  const ViewClass = view.constructor as typeof EditorView;
  view.dispatch({
    selection: { anchor: Math.min(heading.textFrom, length) },
    effects: ViewClass.scrollIntoView(pos, { y: 'start' }),
  });
  view.focus();
}

/** 重命名源码标题：只替换标题文字，保留标记符与闭合 #；只读时不修改 */
export function renameSourceHeading(view: EditorView, heading: SourceHeadingItem, value: string): void {
  if (view.state.readOnly) return;
  const text = value.replace(/\s*\r?\n\s*/g, ' ').trim();
  if (!text || heading.textTo > view.state.doc.length) return;
  view.dispatch({ changes: { from: heading.textFrom, to: heading.textTo, insert: text } });
}

/**
 * 从源码视图提取标题列表（view 为 null 时清空）
 */
export function useSourceHeadings(view: EditorView | null) {
  const [headings, setHeadings] = useState<SourceHeadingItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const headingsRef = useRef<SourceHeadingItem[]>([]);

  useEffect(() => {
    if (!view) {
      headingsRef.current = [];
      setHeadings((previous) => previous.length === 0 ? previous : []);
      setActiveId(null);
      return;
    }

    let extractTimer: ReturnType<typeof setTimeout> | null = null;
    let selectionTimer: ReturnType<typeof setTimeout> | null = null;
    let scrollTimer: ReturnType<typeof setTimeout> | null = null;

    const refreshHeadings = () => {
      const items = extractSourceHeadings(view.state.doc.toJSON());
      if (areSourceHeadingsEqual(headingsRef.current, items)) return;
      headingsRef.current = items;
      setHeadings(items);
    };

    // byViewport 为 false 表示由选区驱动，直接跟随光标
    const updateActiveHeading = (byViewport: boolean) => {
      const list = headingsRef.current;
      if (list.length === 0) {
        setActiveId(null);
        return;
      }
      const head = view.state.selection.main.head;
      let active = findHeadingBeforePos(list, head);
      const viewport = byViewport ? view.scrollDOM.getBoundingClientRect() : null;
      // 源码区隐藏时尺寸为 0，无法判定可视区，保持光标跟随
      if (viewport && viewport.height > 0) {
        try {
          const cursorBlock = view.lineBlockAt(head);
          const cursorTop = view.documentTop + cursorBlock.top;
          const cursorBottom = view.documentTop + cursorBlock.bottom;
          if (cursorBottom <= viewport.top || cursorTop >= viewport.bottom) {
            const topBlock = view.lineBlockAtHeight(viewport.top + VIEWPORT_TOP_THRESHOLD - view.documentTop);
            active = findHeadingBeforePos(list, topBlock.from);
          }
        } catch {
          // 视图已销毁时保持光标跟随
        }
      }
      setActiveId(active?.id ?? null);
    };

    refreshHeadings();
    updateActiveHeading(false);

    const unsubscribe = subscribeMdSourceViewUpdates(view, (update) => {
      if (update.docChanged) {
        // 大文档逐键全文扫描会拖慢输入，合并到停顿后再提取；当前项随后按光标重算
        if (extractTimer) clearTimeout(extractTimer);
        extractTimer = setTimeout(() => {
          refreshHeadings();
          updateActiveHeading(false);
        }, 200);
        return;
      }
      if (update.selectionSet) {
        if (selectionTimer) clearTimeout(selectionTimer);
        selectionTimer = setTimeout(() => updateActiveHeading(false), 100);
      }
    });

    const scroller = view.scrollDOM;
    const handleScroll = () => {
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => updateActiveHeading(true), 50);
    };
    scroller.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      unsubscribe();
      scroller.removeEventListener('scroll', handleScroll);
      if (extractTimer) clearTimeout(extractTimer);
      if (selectionTimer) clearTimeout(selectionTimer);
      if (scrollTimer) clearTimeout(scrollTimer);
    };
  }, [view]);

  return { headings, activeId, setActiveId };
}
