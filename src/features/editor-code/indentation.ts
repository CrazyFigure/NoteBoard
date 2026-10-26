// CodeMirror 各入口共用缩进：设置热更新、Tab 显示宽度及始终留在编辑区的按键行为。
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { indentUnit } from '@codemirror/language';
import { indentMore, indentLess } from '@codemirror/commands';
import { ViewPlugin, type EditorView } from '@codemirror/view';
import { getEditorIndentation } from '../../core/editor/indentation';
import { useSettingsStore } from '../../stores/settingsStore';

/** 每个实例独立持有配置和订阅；设置变化只重配缩进，不重建正文、选区或撤销栈。 */
export function createIndentationExtension(): Extension {
  const compartment = new Compartment();
  const configuration = (): Extension => {
    const { tabSize, unit } = getEditorIndentation();
    return [EditorState.tabSize.of(tabSize), indentUnit.of(unit)];
  };
  return [
    compartment.of(configuration()),
    ViewPlugin.fromClass(class {
      private unsubscribe: () => void;
      private handleKeyDown: (event: KeyboardEvent) => void;

      constructor(private view: EditorView) {
        this.unsubscribe = useSettingsStore.subscribe((state, previous) => {
          const next = state.settings.editor;
          const before = previous.settings.editor;
          if (next.tabSize === before.tabSize && next.insertSpaces === before.insertSpaces) return;
          view.dispatch({ effects: compartment.reconfigure(configuration()) });
        });
        // 捕获阶段先于 CodeMirror 内部的临时焦点模式检查；Esc 或 Ctrl+M 后也始终执行缩进。
        // 仅处理无修饰键的 Tab / Shift+Tab，保留系统及应用的组合快捷键。
        this.handleKeyDown = (event) => {
          if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey) return;
          event.preventDefault();
          view.setTabFocusMode(false);
          // 只读或无可减少的缩进时命令可以不改正文，但也不执行浏览器的焦点遍历。
          if (event.shiftKey) indentLess(view);
          else indentMore(view);
        };
        view.contentDOM.addEventListener('keydown', this.handleKeyDown, true);
      }

      /** 关闭文档时释放设置订阅和捕获监听，不保留已销毁的编辑器实例。 */
      destroy() {
        this.unsubscribe();
        this.view.contentDOM.removeEventListener('keydown', this.handleKeyDown, true);
      }
    }),
  ];
}
