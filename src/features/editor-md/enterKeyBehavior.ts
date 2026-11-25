// NoteBoard 回车类按键统一行为（可视化模式）
//
//   Enter        普通正文先段内换行，紧接着再按一次换段，继续按则增加空段；列表续项，代码块内直接换行；
//   Shift+Enter  列表等容器内为硬换行；Markdown 文档的普通正文、代码块与表格单元格内停用；
//                标题和容器内空段仍按 Enter 的规则处理
//   Ctrl+Enter   跳出：在光标所在的最内层容器块（代码块、表格、列表、引用、提示块、高亮块、折叠块、分栏）下方新建段落；
//                不在容器内时在当前段落 / 标题下方新建段落，不拆分当前内容
//   Alt+Enter    不做任何操作
//   表格单元格   Enter 在单元格内换行（Markdown 表格单元格只能占一行，换行以 <br> 保存）
//
// 修正的问题：Shift+Enter 在代码块中会直接跳出、在标题中插入的换行保存后会把后半截挤出标题、
// 在空行中插入的换行保存后丢失；Ctrl+Enter 原与 Shift+Enter 重复；表格中 Enter 拆出的多段在保存后变成 <br>，前后不一致。

import { Extension, type Editor } from '@tiptap/core';
import type { ResolvedPos } from '@tiptap/pm/model';
import { NodeSelection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { SuggestionPluginKey } from '@tiptap/suggestion';

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

/** 具有独立正文的容器，空段回车仍在容器内换段；列表保留空项退出规则。 */
const PARAGRAPH_CONTAINERS = new Set(['blockquote', 'githubAlert', 'calloutBlock', 'detailsBlock', 'columnBlock']);

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

/** 标题或空行按 Shift+Enter 时，沿用普通 Enter 的换段落逻辑。 */
function replayEnter(editor: Editor): boolean {
  const { view } = editor;
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  view.someProp('handleKeyDown', (handler) => handler(view, event));
  return true;
}

/** 单元格内换行：空单元格里不插入孤立的 <br> */
function lineBreakInCell(editor: Editor): boolean {
  const { selection } = editor.state;
  if (selection.empty && selection.$from.parent.content.size === 0) return true;
  return editor.commands.setHardBreak();
}

/** 普通正文使用原样的换行字符，相邻两次换行用一个真正的段落边界表达。 */
function enterInBody(editor: Editor, selection: TextSelection): boolean {
  const { $from, $to } = selection;
  if ($from.depth !== 1 || $from.parent.type.name !== 'paragraph' || !$from.sameParent($to)) return false;
  // 空段或整段选中时沿用拆段行为。
  if ($from.parentOffset === 0 && $to.parentOffset === $from.parent.content.size) return false;

  if (selection.empty) {
    const before = $from.nodeBefore;
    const followsBreak = before?.text?.endsWith('\n') || before?.type.name === 'hardBreak';
    if (followsBreak || $from.nodeAfter?.text?.startsWith('\n')) {
      // 消耗相邻续行并拆段，避免把两次换行留在同一个段落节点里。
      const breakPos = followsBreak ? $from.pos - 1 : $from.pos;
      return editor.chain().deleteRange({ from: breakPos, to: breakPos + 1 }).splitBlock().run();
    }
  }
  // 换行字符不随标记写回源码，保留可拆分标记供下一行继续输入。
  const { state, view } = editor;
  const continuedMarks = state.storedMarks ?? ($to.parentOffset > 0 ? $from.marks() : []);
  const tr = state.tr.replaceSelectionWith(state.schema.text('\n'), false);
  tr.ensureMarks(continuedMarks.filter((mark) => editor.extensionManager.splittableMarks.includes(mark.type.name)));
  view.dispatch(tr.scrollIntoView());
  return true;
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

interface EnterKeyBehaviorOptions {
  /** 仅 Markdown 文档停用与 Enter 重复的换行，嵌入式编辑器保留原键位。 */
  disableRedundantShiftEnter: boolean;
}

/** 回车类按键统一行为扩展；优先级高于各块扩展，保证规则集中在此处 */
export const EnterKeyBehavior = Extension.create<EnterKeyBehaviorOptions>({
  name: 'nbEnterKeyBehavior',
  priority: 1000,

  addOptions() {
    return { disableRedundantShiftEnter: false };
  },

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        if (isSuggestionActive(editor.state)) return false;
        const { selection } = editor.state;
        const { $from } = selection;
        if (!(selection instanceof TextSelection)) return false;
        // 代码块内直接换行，避免下游的三次回车退出或外层列表拆项。
        if ($from.parent.type.spec.code) return editor.commands.newlineInCode();
        if (isInTableCell($from)) return lineBreakInCell(editor);
        if ($from.depth === 1) return enterInBody(editor, selection);
        // 默认回车会尝试抬升空块，直接拆分容器正文中的空段可在块内连续留白。
        if (selection.empty && $from.depth > 1 && $from.parent.type.name === 'paragraph'
          && $from.parent.content.size === 0 && PARAGRAPH_CONTAINERS.has($from.node(-1).type.name)) {
          return editor.commands.splitBlock();
        }
        return false;
      },
      'Shift-Enter': ({ editor }) => {
        if (isSuggestionActive(editor.state)) return false;
        const { selection } = editor.state;
        const { $from } = selection;
        const { disableRedundantShiftEnter } = this.options;
        // 返回 true 吞掉键盘事件，阻止低优先级的硬换行扩展或浏览器再插入换行。
        if ($from.parent.type.spec.code) return disableRedundantShiftEnter || editor.commands.newlineInCode();
        if (selection instanceof TextSelection && isInTableCell($from)) {
          return disableRedundantShiftEnter || lineBreakInCell(editor);
        }
        if (selection instanceof TextSelection && $from.depth === 1 && $from.parent.type.name === 'paragraph') {
          return disableRedundantShiftEnter || enterInBody(editor, selection) || replayEnter(editor);
        }
        // 标题和空行无法段内换行，交给 Enter 的换段落规则。
        if (!canInsertHardBreak(editor.state)) return replayEnter(editor);
        return editor.commands.setHardBreak();
      },
      'Mod-Enter': ({ editor }) => {
        if (isSuggestionActive(editor.state)) return false;
        return insertParagraphBelow(editor.state, (tr) => editor.view.dispatch(tr));
      },
    };
  },
});
