// Markdown 可视化模式 Tab 兜底：正文读取缩进设置，结构化块优先使用各自的缩进或单元格导航。
import { Extension, type Editor } from '@tiptap/core';
import { Plugin, TextSelection } from '@tiptap/pm/state';
import { getEditorIndentation, leadingIndentLength } from '../../core/editor/indentation';
import { useSettingsStore } from '../../stores/settingsStore';

/**
 * 代码块按设置缩进所选逻辑行；只修改行首，保留选区方向，反向缩进不替换或丢弃正文。
 * 空光标按 Tab 时在光标处插入一层缩进，跨块选区不作破坏性替换。
 */
export function handleCodeBlockTab(editor: Editor, outdent: boolean): boolean {
  if (!editor.isEditable || !editor.isActive('codeBlock')) return false;
  const { state } = editor;
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.$from.sameParent(selection.$to)) return true;
  const { unit, tabSize } = getEditorIndentation();
  const tr = state.tr;
  if (!outdent && selection.empty) {
    editor.view.dispatch(tr.insertText(unit).scrollIntoView());
    return true;
  }
  const blockStart = selection.$from.start();
  const text = selection.$from.parent.textContent;
  const from = selection.from - blockStart;
  // 非空选区恰好结束于下一行开头时，下一行不属于选中的逻辑行。
  const end = (selection.empty ? selection.to : selection.to - 1) - blockStart;
  let lineStart = from === 0 ? 0 : text.lastIndexOf('\n', from - 1) + 1;
  while (lineStart <= end) {
    const position = tr.mapping.map(blockStart + lineStart);
    if (outdent) {
      const length = leadingIndentLength(text.slice(lineStart), tabSize);
      if (length) tr.delete(position, position + length);
    } else {
      tr.insertText(unit, position);
    }
    const nextLine = text.indexOf('\n', lineStart);
    if (nextLine < 0) break;
    lineStart = nextLine + 1;
  }
  if (tr.docChanged) {
    tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(selection.anchor), tr.mapping.map(selection.head)));
    editor.view.dispatch(tr.scrollIntoView());
  }
  return true;
}

/**
 * 只处理块扩展尚未消费的 Tab；列表首项、表格首格等边界保留焦点且不改内容。
 * 普通文本按 Tab 替换选区为设置中的一层缩进，Shift+Tab 删除当前逻辑行开头的一层缩进。
 */
function handleTextTab(editor: Editor, outdent: boolean): boolean {
  // 阅读模式不修改正文；浏览器的焦点遍历由全局守卫统一取消。
  if (!editor.isEditable) return false;
  const { state } = editor;
  const { unit, tabSize } = getEditorIndentation();
  const { selection } = state;
  // 图片等节点选区没有可插入文本的位置，但也不能让焦点跳到块内按钮。
  if (!(selection instanceof TextSelection)) return true;
  const { $from, $to } = selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    // 列表和表格的原有快捷键已先运行；无法执行时不再插入空格或删除单元格正文。
    if (['listItem', 'taskItem'].includes(node.type.name) || node.type.spec.tableRole) return true;
  }
  if (!outdent) {
    editor.view.dispatch(state.tr.insertText(unit).scrollIntoView());
    return true;
  }
  // 跨块反向缩进不删除选区内容；单块内按硬换行定位当前行，保持其余行和文本格式。
  if (!$from.sameParent($to)) return true;
  const beforeCursor = state.doc.textBetween($from.start(), selection.from, '\n', '\n');
  const lineStart = $from.start() + beforeCursor.lastIndexOf('\n') + 1;
  const lineText = state.doc.textBetween(lineStart, $from.end(), '\n', '\n');
  const length = leadingIndentLength(lineText, tabSize);
  if (length) editor.view.dispatch(state.tr.delete(lineStart, lineStart + length).scrollIntoView());
  return true;
}

/** 所有平台共用同一按键映射；低于默认块扩展优先级，避免覆盖列表、表格和代码块的行为。 */
export const TabKeyBehavior = Extension.create({
  name: 'nbTabKeyBehavior',
  priority: 50,
  addKeyboardShortcuts() {
    return {
      Tab: ({ editor }) => handleTextTab(editor, false),
      'Shift-Tab': ({ editor }) => handleTextTab(editor, true),
    };
  },
  addProseMirrorPlugins() {
    return [new Plugin({
      view(view) {
        // 原生制表符的显示宽度同步设置；CSS 变量同时供代码块和块内源码区域使用。
        const updateWidth = () => {
          const width = String(getEditorIndentation().tabSize);
          view.dom.style.tabSize = width;
          view.dom.style.setProperty('--nb-tab-size', width);
        };
        updateWidth();
        const unsubscribe = useSettingsStore.subscribe((state, previous) => {
          if (state.settings.editor.tabSize !== previous.settings.editor.tabSize) updateWidth();
        });
        return { destroy: unsubscribe };
      },
    })];
  },
});
