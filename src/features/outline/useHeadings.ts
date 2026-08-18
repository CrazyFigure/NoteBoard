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

export interface HeadingItem {
  id: string;
  level: number;
  text: string;
  pos: number;
}

/**
 * 从 TipTap 编辑器提取标题列表
 */
export function useHeadings(editor: Editor | null) {
  const [headings, setHeadings] = useState<HeadingItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      setHeadings([]);
      return;
    }
    const items = extractHeadings(editor);
    setHeadings(items);
  }, [editor, extractHeadings]);

  // 计算当前活动标题
  const updateActiveHeading = useCallback(() => {
    if (!editor || headings.length === 0) {
      setActiveId(null);
      return;
    }

    const cursorPos = editor.state.selection.from;
    let active: HeadingItem | null = null;

    for (const h of headings) {
      if (h.pos <= cursorPos) {
        active = h;
      } else {
        break;
      }
    }

    setActiveId(active?.id ?? null);
  }, [editor, headings]);

  // 监听编辑器更新
  useEffect(() => {
    if (!editor) {
      setHeadings([]);
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
    const handleSelectionUpdate = () => {
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
