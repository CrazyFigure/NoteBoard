// NoteBoard 全选按键行为（可视化模式）
//
//   Ctrl/Cmd+A  第一次：选中光标所在文本块（段落、标题、代码块、列表项 / 表格单元格 / 引用等容器内的段落）的全部内容；
//               再按一次：全选整个文档（交给 TipTap 默认的 selectAll）
//   以下情况直接全选文档：文本块为空、已整块选中、选区跨越多个块、选中的是整个节点（图片、图表等）

import { Extension } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

/** 全选按键行为扩展；优先级高于各块扩展，保证规则集中在此处 */
export const SelectAllBehavior = Extension.create({
  name: 'nbSelectAllBehavior',
  priority: 1000,

  addKeyboardShortcuts() {
    return {
      'Mod-a': ({ editor }) => {
        const { selection } = editor.state;
        if (!(selection instanceof TextSelection)) return false;
        const { $from, $to } = selection;
        // 选区不在同一个文本块内时交给默认的全选
        if (!$from.parent.isTextblock || !$from.sameParent($to)) return false;
        const start = $from.start();
        const end = $from.end();
        // 空文本块或已整块选中：让出给默认全选，实现「两次全选文档」
        if (start === end || (selection.from === start && selection.to === end)) return false;
        return editor.commands.setTextSelection({ from: start, to: end });
      },
    };
  },
});
