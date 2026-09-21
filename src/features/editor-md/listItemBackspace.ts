// NoteBoard 空列表项退格修复
//
// 问题（可视化模式）：
//   TipTap 内置的 listKeymap 在「列表项首个块的开头」按 Backspace 时，会无条件执行
//   liftListItem（减少缩进）。而 ProseMirror 的 liftToOuterList 在被提升项「后面还有兄弟项」时
//   会把这些兄弟项收编为被提升项的子列表（prosemirror-schema-list 源码原注释：
//   "There are siblings after the lifted items, which must become children of the last item"）。
//   于是用户只想删掉一个空节点，实际却把后面整段同级列表降了一级 —— 层级全乱。
//
// 期望：
//   空列表项上的退格应该只删除这一个节点，后续同级项整体上移、层级保持不变。
//
// 方案：
//   以高于内置 listKeymap（priority 默认 100）的优先级接管 Backspace，
//   仅当「光标位于一个空的列表项中」且「其父列表还有其它兄弟项」时，直接删除该列表项节点；
//   其余情况一律返回 false 交回原有逻辑，保证「非空列表项减少缩进」等标准行为不受影响。

import { Extension, type Editor } from '@tiptap/core';
import { Selection, type EditorState, type Transaction } from '@tiptap/pm/state';
import type { Node as ProseMirrorNode, ResolvedPos } from '@tiptap/pm/model';

/** 参与修复的列表项节点名：无序/有序列表为 listItem，任务列表为 taskItem */
const LIST_ITEM_NODE_NAMES = ['listItem', 'taskItem'];

/** 向上查找光标所属的列表项节点，返回该节点与其深度 */
function findEnclosingListItem(
  $from: ResolvedPos,
): { node: ProseMirrorNode; depth: number } | null {
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (LIST_ITEM_NODE_NAMES.includes(node.type.name)) {
      return { node, depth };
    }
  }
  return null;
}

/**
 * 判断列表项是否为「空节点」。
 * 仅当它只有一个子节点、该子节点是空文本块（段落/标题）时才成立：
 * 既排除有内容的项，也排除带子列表的项 —— 后者若直接删除会连带丢失下级内容。
 */
function isEmptyListItem(node: ProseMirrorNode): boolean {
  if (node.childCount !== 1) return false;
  const firstChild = node.firstChild;
  if (!firstChild || !firstChild.isTextblock) return false;
  return firstChild.content.size === 0;
}

/**
 * 删除光标所在的空列表项（不改变其余列表项的层级）。
 *
 * 处理条件（全部满足才接管，否则返回 false 交回默认逻辑）：
 * 1. 空选区且位于当前块开头；
 * 2. 光标位于某个列表项的直接子块中；
 * 3. 该列表项是空的（只有一个空文本块、无子列表）；
 * 4. 其父列表还有其它兄弟项 —— 只剩自身时删除会产生非法空列表。
 *
 * 命中后光标落到前一个同级列表项末尾，符合「退格删掉一整行」的直觉。
 */
export function removeEmptyListItem(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
): boolean {
  const { selection } = state;

  // 有选区时属于普通删除，不介入
  if (!selection.empty) return false;

  const $from = selection.$from;
  // 必须处于当前块的开头（空段落的 parentOffset 即为 0）
  if ($from.parentOffset !== 0) return false;
  if (!$from.parent.isTextblock) return false;

  const listItem = findEnclosingListItem($from);
  if (!listItem) return false;
  // 光标须位于列表项的直接子块中，避免误判更深层嵌套列表内的位置
  if (listItem.depth !== $from.depth - 1) return false;
  if (!isEmptyListItem(listItem.node)) return false;

  const parentList = $from.node(listItem.depth - 1);
  if (parentList.childCount <= 1) return false;

  if (!dispatch) return true;

  const deleteFrom = $from.before(listItem.depth);
  const deleteTo = $from.after(listItem.depth);
  const tr = state.tr.delete(deleteFrom, deleteTo);

  // 光标落到前一个同级列表项末尾；若被删项是列表首项、前方无落点，
  // 则退到删除位置之后的最近文本位置
  const $boundary = tr.doc.resolve(deleteFrom);
  const target =
    Selection.findFrom($boundary, -1, true) ?? Selection.findFrom($boundary, 1, true);
  if (target) tr.setSelection(target);

  dispatch(tr.scrollIntoView());
  return true;
}

export const ListEmptyItemBackspaceFix = Extension.create({
  name: 'listEmptyItemBackspaceFix',
  // 必须高于内置 listKeymap，否则它的 Backspace 会先执行 liftListItem 把层级改乱
  priority: 1000,

  addKeyboardShortcuts() {
    // 直接使用回调参数中的 editor，避免依赖扩展上下文绑定
    const run = ({ editor }: { editor: Editor }) =>
      removeEmptyListItem(editor.state, (tr) => editor.view.dispatch(tr));
    return {
      Backspace: run,
      // 与内置 listKeymap 保持一致的按键覆盖范围（Windows 为 Ctrl+Backspace）
      'Mod-Backspace': run,
    };
  },
});
