// NoteBoard 可折叠块的展开状态
// 代码块与折叠块（<details>）共用：展开/收起只是可视化模式的显示状态，不写入 Markdown，
// 因此点击展开/收起不会让文档变为"已修改"。
// 1. 初始状态取设置中的默认值；光标位于块内时（如刚插入）直接展开；
// 2. 设置项变化时，已打开文档中的块统一切换到新默认值；
// 3. 光标进入已收起的块（方向键、搜索跳转、撤销等）时自动展开，避免在看不见的内容里输入；
// 4. 收起时若光标在块内，先把光标移到块后方。

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Selection } from '@tiptap/pm/state';

type GetPos = () => number | undefined;

/** 读取节点当前位置；节点已脱离文档时返回 null */
function positionOf(getPos: GetPos): number | null {
  try {
    const pos = getPos();
    return typeof pos === 'number' ? pos : null;
  } catch {
    return null;
  }
}

/** 选区是否完整落在节点内容内部（不含选中整个节点的 NodeSelection） */
export function isSelectionInside(editor: Editor, getPos: GetPos, node: ProseMirrorNode): boolean {
  const pos = positionOf(getPos);
  if (pos === null) return false;
  const { from, to } = editor.state.selection;
  return from > pos && to < pos + node.nodeSize;
}

/**
 * 可折叠块的展开状态。
 * @param forceExpanded 源码中显式要求展开（如 `<details open>`）时为 true
 */
export function useCollapsibleState(
  editor: Editor,
  getPos: GetPos,
  node: ProseMirrorNode,
  defaultExpanded: boolean,
  forceExpanded = false,
): [boolean, (expanded: boolean) => void] {
  // 节点内容随编辑变化，回调中始终读取最新节点
  const nodeRef = useRef(node);
  nodeRef.current = node;

  const [expanded, setExpandedState] = useState(
    () => forceExpanded || defaultExpanded || isSelectionInside(editor, getPos, node),
  );

  // 设置项变化时整体切换到新默认值（首次渲染跳过，避免覆盖初始状态）
  const initialRef = useRef(true);
  useEffect(() => {
    if (initialRef.current) {
      initialRef.current = false;
      return;
    }
    setExpandedState(forceExpanded || defaultExpanded);
  }, [defaultExpanded, forceExpanded]);

  // 收起状态下监听选区：光标进入块内即自动展开
  useEffect(() => {
    if (expanded) return undefined;
    const handleSelection = () => {
      if (isSelectionInside(editor, getPos, nodeRef.current)) setExpandedState(true);
    };
    editor.on('selectionUpdate', handleSelection);
    return () => {
      editor.off('selectionUpdate', handleSelection);
    };
  }, [expanded, editor, getPos]);

  const setExpanded = useCallback(
    (next: boolean) => {
      if (!next && isSelectionInside(editor, getPos, nodeRef.current)) {
        const pos = positionOf(getPos);
        if (pos !== null) {
          const { state, view } = editor;
          // 光标移到块后方最近的可编辑位置；找不到（块位于文末且后方无内容）时让编辑器失焦
          const after = Selection.near(state.doc.resolve(pos + nodeRef.current.nodeSize), 1);
          if (after.from >= pos + nodeRef.current.nodeSize) {
            view.dispatch(state.tr.setSelection(after));
          } else {
            view.dom.blur();
          }
        }
      }
      setExpandedState(next);
    },
    [editor, getPos],
  );

  return [expanded, setExpanded];
}
