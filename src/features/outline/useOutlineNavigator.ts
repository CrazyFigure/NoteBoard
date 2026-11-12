// NoteBoard 大纲数据源与跳转（右侧栏大纲与编辑区内目录共用）
// 源码模式（含不挂载可视化内核的大文档）从 CodeMirror 提取标题，否则从 TipTap 文档提取

import { useCallback } from 'react';
import type { Editor } from '@tiptap/core';
import { useWindowStore } from '../../stores/windowStore';
import { useHeadings, type HeadingItem } from './useHeadings';
import { jumpToSourceHeading, useMdSourceView, useSourceHeadings } from './useSourceHeadings';
import type { SourceHeadingItem } from './sourceHeadings';

export function useOutlineNavigator(editor: Editor | null, docKey: string | null) {
  const viewMode = useWindowStore((s) => (docKey ? s.tabs.find((t) => t.key === docKey)?.viewMode : undefined));
  const sourceView = useMdSourceView(docKey);
  // 源码模式，或可视化内核尚未挂载（源码首开、大文档）时，以源码为大纲数据源
  const sourceMode = Boolean(sourceView) && (viewMode === 'source' || !editor);
  const visualOutline = useHeadings(sourceMode ? null : editor);
  const sourceOutline = useSourceHeadings(sourceMode ? sourceView : null);
  const { headings, activeId, setActiveId } = sourceMode ? sourceOutline : visualOutline;

  // 跳转到标题：光标落到标题开头，标题平滑滚动到可视区顶部
  const jumpTo = useCallback(
    (heading: HeadingItem) => {
      if (sourceMode && sourceView) {
        jumpToSourceHeading(sourceView, heading as SourceHeadingItem);
        setActiveId(heading.id);
        return;
      }
      if (!editor) return;
      const { pos } = heading;
      const docSize = editor.state.doc.content.size;
      const targetPos = Math.min(pos + 1, docSize);

      editor.commands.focus();
      editor.commands.setTextSelection(targetPos);

      // 滚动到位置
      requestAnimationFrame(() => {
        try {
          const dom = editor.view.nodeDOM(pos);
          if (dom instanceof HTMLElement) {
            dom.scrollIntoView({ behavior: 'smooth', block: 'start' });
          } else {
            editor.commands.scrollIntoView();
          }
        } catch {
          editor.commands.scrollIntoView();
        }
      });

      setActiveId(heading.id);
    },
    [editor, setActiveId, sourceMode, sourceView],
  );

  return { headings, activeId, setActiveId, jumpTo, sourceMode, sourceView };
}
