// NoteBoard 回车类按键统一行为（可视化模式）
//
//   Enter        换段落：新段落 / 列表新项；空行再按一次跳出列表、引用、提示块、高亮块、折叠块；
//                代码块内为换行，末尾连按三次跳出（以上沿用各扩展原有逻辑）
//   Shift+Enter  段内换行（Markdown 硬换行，源码为行尾两个空格）；代码块内为换行；
//                标题不能包含换行、空行没有可换的内容 → 都按 Enter 处理
//   Ctrl+Enter   跳出：在光标所在的最内层容器块（代码块、表格、列表、引用、提示块、高亮块、折叠块、分栏）下方新建段落；
//                不在容器内时在当前段落 / 标题下方新建段落，不拆分当前内容
//   Alt+Enter    不做任何操作
//   表格单元格   Enter 与 Shift+Enter 都是单元格内换行（Markdown 表格单元格只能占一行，换行以 <br> 保存）
//
// 设置「Enter 与 Shift+Enter 互换」开启时，正文中两键对调：Enter 段内换行、Shift+Enter 换段落；
// 代码块、表格、标题、空行不受影响（按上面的规则处理）。
//
// 修正的问题：Shift+Enter 在代码块中会直接跳出、在标题中插入的换行保存后会把后半截挤出标题、
// 在空行中插入的换行保存后丢失；Ctrl+Enter 原与 Shift+Enter 重复；表格中 Enter 拆出的多段在保存后变成 <br>，前后不一致。

import { Extension, type Editor } from '@tiptap/core';
import type { ResolvedPos } from '@tiptap/pm/model';
import { NodeSelection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { SuggestionPluginKey } from '@tiptap/suggestion';
import { useSettingsStore } from '../../stores/settingsStore';

/** Ctrl+Enter 可以跳出的容器块（列表按整个列表跳出，分栏按整组分栏跳出） */
const CONTAINER_TYPES = new Set([
  'blockquote',
  'githubAlert',
  'calloutBlock',
  'detailsBlock',
  'columnsBlock',
  'bulletList',
  'orderedList',
  'taskList',
  'table',
]);

/** 正在重放 Enter 时跳过本扩展的处理，交给其余扩展的原有 Enter 逻辑 */
let replayingEnter = false;

/** 是否开启「Enter 与 Shift+Enter 互换」 */
function isSwapped(): boolean {
  return useSettingsStore.getState().settings.editor.swapEnterKeys === true;
}

/** 斜杠菜单等联想浮层打开时，Enter 用于确认候选项，本扩展不接管 */
function isSuggestionActive(state: EditorState): boolean {
  return SuggestionPluginKey.getState(state)?.active === true;
}

/** 光标是否在表格单元格内 */
function isInTableCell($pos: ResolvedPos): boolean {
  for (let depth = $pos.depth; depth > 0; depth--) {
    const role = $pos.node(depth).type.spec.tableRole;
    if (role === 'cell' || role === 'header_cell') return true;
  }
  return false;
}

/** 当前位置能否插入有意义的段内换行：非代码、非标题、且所在行不为空 */
function canInsertHardBreak(state: EditorState): boolean {
  const { selection } = state;
  if (!(selection instanceof TextSelection)) return false;
  const parent = selection.$from.parent;
  if (!parent.isTextblock || parent.type.spec.code) return false;
  if (parent.type.name === 'heading') return false;
  return parent.content.size > 0;
}

/** 以普通 Enter 重放一次按键，走各扩展原有的换段落 / 跳出逻辑 */
function replayEnter(editor: Editor): boolean {
  const { view } = editor;
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  replayingEnter = true;
  try {
    view.someProp('handleKeyDown', (handler) => handler(view, event));
  } finally {
    replayingEnter = false;
  }
  return true;
}

/** 单元格内换行：空单元格里不插入孤立的 <br> */
function lineBreakInCell(editor: Editor): boolean {
  const { selection } = editor.state;
  if (selection.empty && selection.$from.parent.content.size === 0) return true;
  return editor.commands.setHardBreak();
}

/**
 * Ctrl+Enter：在光标所在的最内层容器块（或当前文本块）下方新建空段落并移入光标。
 * 导出供测试使用。
 */
export function insertParagraphBelow(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const { selection, schema } = state;
  const paragraph = schema.nodes.paragraph;
  if (!paragraph) return false;

  let insertPos: number;
  if (selection instanceof NodeSelection && selection.node.isBlock) {
    // 选中整个块（图片、图表、公式块等）：在其下方新建
    insertPos = selection.to;
  } else {
    const { $from } = selection;
    // 由内向外找第一个容器块；代码块本身也算容器（避免代码块位于引用等容器内时直接跳出外层）
    let depth = $from.depth;
    for (let d = $from.depth; d > 0; d--) {
      const node = $from.node(d);
      if (node.type.spec.code || CONTAINER_TYPES.has(node.type.name)) {
        depth = d;
        break;
      }
    }
    insertPos = $from.after(depth);
  }

  const $insert = state.doc.resolve(insertPos);
  const index = $insert.index();
  if (!$insert.parent.canReplaceWith(index, index, paragraph)) return false;
  if (dispatch) {
    const tr = state.tr.insert(insertPos, paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, insertPos + 1));
    dispatch(tr.scrollIntoView());
  }
  return true;
}

/** 回车类按键统一行为扩展；优先级高于各块扩展，保证规则集中在此处 */
export const EnterKeyBehavior = Extension.create({
  name: 'nbEnterKeyBehavior',
  priority: 1000,

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        if (replayingEnter || isSuggestionActive(editor.state)) return false;
        const { $from } = editor.state.selection;
        if (editor.state.selection instanceof TextSelection && isInTableCell($from)) return lineBreakInCell(editor);
        // 互换模式：有内容的正文行中 Enter 为段内换行，其余情况走原有 Enter 逻辑
        if (isSwapped() && canInsertHardBreak(editor.state)) return editor.commands.setHardBreak();
        return false;
      },
      'Shift-Enter': ({ editor }) => {
        if (replayingEnter || isSuggestionActive(editor.state)) return false;
        const { selection } = editor.state;
        // 代码块内 Shift+Enter 也是换行，不再跳出代码块
        if (selection.$from.parent.type.spec.code) return editor.commands.newlineInCode();
        if (selection instanceof TextSelection && isInTableCell(selection.$from)) return lineBreakInCell(editor);
        // 互换模式下 Shift+Enter 为换段落；标题、空行无法段内换行，同样按 Enter 处理
        if (isSwapped() || !canInsertHardBreak(editor.state)) return replayEnter(editor);
        return editor.commands.setHardBreak();
      },
      'Mod-Enter': ({ editor }) => {
        if (isSuggestionActive(editor.state)) return false;
        return insertParagraphBelow(editor.state, (tr) => editor.view.dispatch(tr));
      },
    };
  },
});
