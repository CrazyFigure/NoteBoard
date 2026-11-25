// NoteBoard 空列表项退格修复
//
// 问题（可视化模式）：
//   TipTap 内置的 listKeymap 在「列表项首个块的开头」按 Backspace 时，会无条件执行
//   liftListItem（减少缩进）。而 ProseMirror 的 liftToOuterList 在被提升项「后面还有兄弟项」时
//   会把这些兄弟项收编为被提升项的子列表（prosemirror-schema-list 源码原注释：
//   "There are siblings after the lifted items, which must become children of the last item"）。
//   于是用户只想删掉一个空节点，实际却把后面整段同级列表降了一级 —— 层级全乱。
//
// Markdown 正文中，列表首个空项退格后退出列表，并在原处留下正文空段。
// 内层列表的空项和其余同级空项仍直接删除，保留后续项目的层级。

import { Extension, type Editor } from '@tiptap/core';
import { liftListItem } from '@tiptap/pm/schema-list';
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
 * 处理光标所在的空列表项，保持其余列表项的层级。
 *
 * 处理条件（全部满足才接管，否则返回 false 交回默认逻辑）：
 * 1. 空选区且位于当前块开头；
 * 2. 光标位于某个列表项的直接子块中；
 * 3. 该列表项是空的（只有一个空文本块、无子列表）；
 * 4. 其父列表还有其它兄弟项 —— 只剩自身时删除会产生非法空列表。
 *
 * Markdown 非嵌套列表的首项提升为正文空段，光标随段落移动。其余空项直接删除。
 */
export function removeEmptyListItem(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
  preserveLeadingParagraph = false,
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

  const listDepth = listItem.depth - 1;
  const parentList = $from.node(listDepth);
  if (parentList.childCount <= 1) return false;

  // 用原生提升命令保留空段和光标。直接嵌在列表项里的子列表仍须避免提升后重挂后续同级项。
  const listParent = $from.node(listDepth - 1);
  if (preserveLeadingParagraph && $from.index(listDepth) === 0 && !LIST_ITEM_NODE_NAMES.includes(listParent.type.name)
    && liftListItem(listItem.node.type)(state, dispatch)) return true;

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

export const ListEmptyItemBackspaceFix = Extension.create<{ preserveLeadingParagraph: boolean }>({
  name: 'listEmptyItemBackspaceFix',
  // 必须高于内置 listKeymap，否则它的 Backspace 会先执行 liftListItem 把层级改乱
  priority: 1000,

  addOptions() {
    return { preserveLeadingParagraph: false };
  },

  addKeyboardShortcuts() {
    const { preserveLeadingParagraph } = this.options;
    const run = ({ editor }: { editor: Editor }) =>
      removeEmptyListItem(editor.state, (tr) => editor.view.dispatch(tr), preserveLeadingParagraph);
    return {
      Backspace: run,
      // 与内置 listKeymap 保持一致的按键覆盖范围（Windows 为 Ctrl+Backspace）
      'Mod-Backspace': run,
    };
  },
});
