// NoteBoard Markdown 顶层块安全重排序内核
// 统一负责顶层块命中、落点计算与 ProseMirror 原子移动，避免列表、表格、代码块等嵌套结构接收非法落点

import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/** 顶层块的 DOM、文档位置与节点信息。 */
export interface TopLevelBlockInfo {
  element: HTMLElement;
  pos: number;
  node: ProseMirrorNode;
}

/** 指针对应的顶层块边界落点；落点永远不会进入节点内部。 */
export interface TopLevelDropTarget {
  insertPos: number;
  indicatorClientY: number;
  targetPos: number;
  edge: 'before' | 'after';
  element: HTMLElement;
}

/** 成功移动后的新位置，用于恢复选区和播放落位动效。 */
export interface BlockMoveResult {
  insertedPos: number;
}

/**
 * 将任意编辑器内部元素提升为 ProseMirror 的直接子块。
 * 只接受 editorDom 的直接子节点，从 DOM 层杜绝把块拖入列表项、表格单元格或代码块内部。
 */
export function findTopLevelBlockElement(
  editorDom: HTMLElement,
  target: EventTarget | null,
): HTMLElement | null {
  let element = target instanceof HTMLElement ? target : null;

  while (element && element.parentElement && element.parentElement !== editorDom) {
    element = element.parentElement;
  }

  return element?.parentElement === editorDom ? element : null;
}

/**
 * 读取直接子块对应的顶层文档位置。
 * posAtDOM 可能返回节点内容起点，因此需要通过 before(1) 归一到真正的顶层节点边界。
 */
export function getTopLevelBlockInfo(
  view: EditorView,
  element: HTMLElement,
): TopLevelBlockInfo | null {
  if (element.parentElement !== view.dom) return null;

  try {
    const domPos = view.posAtDOM(element, 0);
    const $domPos = view.state.doc.resolve(domPos);
    const pos = $domPos.depth === 0 ? domPos : $domPos.before(1);
    const $topLevelPos = view.state.doc.resolve(pos);
    const node = view.state.doc.nodeAt(pos);

    if ($topLevelPos.depth !== 0 || !node?.isBlock) return null;
    return { element, pos, node };
  } catch {
    // NodeView 正在重绘或 DOM 已失效时不生成落点，等待下一次指针事件重新解析。
    return null;
  }
}

/**
 * 按垂直坐标解析最近的顶层块边界。
 * 仅遍历 ProseMirror 直接子节点，因此即使指针位于 td、li、pre 内部，结果仍是其所属顶层块的前/后边界。
 */
export function resolveTopLevelDropTarget(
  view: EditorView,
  clientY: number,
): TopLevelDropTarget | null {
  const entries: Array<TopLevelBlockInfo & { rect: DOMRect }> = [];
  const seenPositions = new Set<number>();

  for (const child of Array.from(view.dom.children)) {
    if (!(child instanceof HTMLElement)) continue;
    const info = getTopLevelBlockInfo(view, child);
    if (!info || seenPositions.has(info.pos)) continue;
    seenPositions.add(info.pos);
    entries.push({ ...info, rect: child.getBoundingClientRect() });
  }

  if (entries.length === 0) return null;

  for (const entry of entries) {
    const midpoint = entry.rect.top + entry.rect.height / 2;
    if (clientY < midpoint) {
      return {
        insertPos: entry.pos,
        indicatorClientY: entry.rect.top,
        targetPos: entry.pos,
        edge: 'before',
        element: entry.element,
      };
    }
  }

  const last = entries[entries.length - 1];
  return {
    insertPos: last.pos + last.node.nodeSize,
    indicatorClientY: last.rect.bottom,
    targetPos: last.pos,
    edge: 'after',
    element: last.element,
  };
}

/**
 * 校验块移动是否同时满足：源节点位于文档顶层、目标是顶层边界、目标不在源节点自身范围内。
 * 该校验会在拖拽预览与最终事务提交时各执行一次，防止状态变化绕过 UI 层保护。
 */
export function isTopLevelBlockMoveAllowed(
  doc: ProseMirrorNode,
  sourcePos: number,
  insertPos: number,
): boolean {
  if (!Number.isInteger(sourcePos) || !Number.isInteger(insertPos)) return false;
  if (sourcePos < 0 || insertPos < 0 || insertPos > doc.content.size) return false;

  try {
    const $source = doc.resolve(sourcePos);
    const $insert = doc.resolve(insertPos);
    const sourceNode = doc.nodeAt(sourcePos);

    if ($source.depth !== 0 || $insert.depth !== 0 || !sourceNode?.isBlock) return false;

    const sourceEnd = sourcePos + sourceNode.nodeSize;
    if (insertPos >= sourcePos && insertPos <= sourceEnd) return false;

    return $insert.parent.canReplaceWith(
      $insert.index(),
      $insert.index(),
      sourceNode.type,
      sourceNode.marks,
    );
  } catch {
    // 越界位置或文档结构瞬时变化都视为非法落点。
    return false;
  }
}

/**
 * 以“删除源块 → 映射目标位置 → 插入原节点”的单一事务完成顶层重排序。
 * 提交前再次验证映射后的父节点，确保任何列表、表格、代码块内部位置都无法进入事务。
 */
export function moveTopLevelBlock(
  view: EditorView,
  sourcePos: number,
  insertPos: number,
): BlockMoveResult | null {
  const { state } = view;
  const sourceNode = state.doc.nodeAt(sourcePos);

  if (!sourceNode || !isTopLevelBlockMoveAllowed(state.doc, sourcePos, insertPos)) {
    return null;
  }

  const sourceEnd = sourcePos + sourceNode.nodeSize;
  const mappedInsertPos = insertPos > sourceEnd
    ? insertPos - sourceNode.nodeSize
    : insertPos;

  try {
    const tr = state.tr.delete(sourcePos, sourceEnd);
    const $mappedInsert = tr.doc.resolve(mappedInsertPos);

    if (
      $mappedInsert.depth !== 0
      || !$mappedInsert.parent.canReplaceWith(
        $mappedInsert.index(),
        $mappedInsert.index(),
        sourceNode.type,
        sourceNode.marks,
      )
    ) {
      return null;
    }

    tr.insert(mappedInsertPos, sourceNode);

    // 普通块使用 NodeSelection 保留清晰的移动结果；极少数不可选节点回退到邻近文本选区。
    const selection = NodeSelection.isSelectable(sourceNode)
      ? NodeSelection.create(tr.doc, mappedInsertPos)
      : TextSelection.near(tr.doc.resolve(mappedInsertPos), 1);
    tr.setSelection(selection).scrollIntoView();

    view.dispatch(tr);
    view.focus();
    return { insertedPos: mappedInsertPos };
  } catch {
    // Schema 拒绝或文档在指针释放前变化时保持原文档不变。
    return null;
  }
}
