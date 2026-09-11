// NoteBoard 大纲面板 - useHeadings hook
// 遍历 PM doc 提取标题节点，不解析 Markdown 原文
// 详见 docs/09-开发路线图.md 9.1
//
// 设计：
// 1. doc.descendants 遍历，node.type.name === 'heading'
// 2. 提取 level, text, pos
// 3. 当前项高亮：pos <= cursorPos 的最后一个
// 4. selectionUpdate + debounce 100ms

import { useState, useEffect, useCallback, useRef } from 'react';
import type { Editor } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';
import { EDITOR_SEARCH_NAVIGATION_META } from '../../core/editor/searchNavigation';

export interface HeadingItem {
  id: string;
  level: number;
  text: string;
  pos: number;
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
  const updateActiveHeading = useCallback(() => {
    const currentHeadings = headingsRef.current;
    if (!editor || currentHeadings.length === 0) {
      setActiveId(null);
      return;
    }

    const cursorPos = editor.state.selection.from;
    let active: HeadingItem | null = null;

    for (const h of currentHeadings) {
      if (h.pos <= cursorPos) {
        active = h;
      } else {
        break;
      }
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
      // Ctrl+F 只负责正文查找；搜索产生的程序化选区不得驱动右侧大纲滚动。
      if (transaction.getMeta(EDITOR_SEARCH_NAVIGATION_META)) return;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        updateActiveHeading();
      }, 100);
    };

    editor.on('update', handleUpdate);
    editor.on('selectionUpdate', handleSelectionUpdate);

    return () => {
      editor.off('update', handleUpdate);
      editor.off('selectionUpdate', handleSelectionUpdate);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [editor, updateHeadings, updateActiveHeading]);

  return { headings, activeId, setActiveId };
}
