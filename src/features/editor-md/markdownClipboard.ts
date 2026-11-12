// Markdown 文档复制、剪切共用文件序列化规则，避免富文本 HTML 或缺少语法的正文进入剪贴板。
// Ctrl+C 按设置「复制格式」输出 Markdown 源码或纯文本；Ctrl+Shift+C（Mac 为 Cmd+Shift+C）复制为另一种格式。
import { Extension, type Editor } from '@tiptap/core';
import { Fragment, type ResolvedPos, type Slice } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { getMarkdownManager, serializeMarkdownFromDoc } from './serialize';
import { serializeSelectionPlainText } from './plainTextClipboard';
import { deleteSelectionAcrossTables } from './tableCrossDelete';
import { useSettingsStore } from '../../stores/settingsStore';
import { showToast } from '../../stores/toastStore';
import { USES_COMMAND_KEY } from '../../core/platform';

/** 复制格式：带格式（Markdown 源码）/ 纯文本 */
export type CopyFormat = 'markdown' | 'plain';

/** 另一种格式复制的快捷键（界面文案按 Windows 书写，显示时经 formatShortcut 转换） */
export const ALTERNATE_COPY_SHORTCUT = 'Ctrl+Shift+C';

/** 设置中 Ctrl+C 的复制格式，旧配置缺失时为带格式 */
export function getDefaultCopyFormat(): CopyFormat {
  return useSettingsStore.getState().settings.editor.copyFormat === 'plain' ? 'plain' : 'markdown';
}

/** 编辑器是否启用了 Markdown 剪贴板（仅 Markdown 文档；嵌入式编辑器的 Ctrl+C 不受复制格式设置影响） */
export function hasMarkdownClipboard(editor: Editor): boolean {
  return editor.extensionManager.extensions.some((extension) => extension.name === 'markdownClipboard');
}

/** 右键菜单与快捷键使用的「另一种」复制格式：未启用 Markdown 剪贴板时只提供纯文本 */
export function getAlternateCopyFormat(editor: Editor, defaultFormat = getDefaultCopyFormat()): CopyFormat {
  return hasMarkdownClipboard(editor) && defaultFormat === 'plain' ? 'markdown' : 'plain';
}

/** 按指定格式复制当前选区；空选区不覆盖剪贴板，写入失败时提示 */
export async function copySelectionAs(editor: Editor, format: CopyFormat): Promise<void> {
  const { selection } = editor.state;
  if (selection.empty) return;
  const text = format === 'plain'
    ? serializeSelectionPlainText(editor)
    : serializeClipboardMarkdown(editor, selection.content());
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    showToast(`${format === 'plain' ? '纯文本' : '带格式'}复制失败，请检查剪贴板权限后重试`, 'error');
  }
}

/** 是否按下「另一种格式复制」：Windows / Linux / Android 为 Ctrl+Shift+C，Mac 为 Cmd+Shift+C（按物理键位，不受键盘布局影响） */
function isAlternateCopyKey(event: KeyboardEvent): boolean {
  if (event.code !== 'KeyC' || !event.shiftKey || event.altKey || event.isComposing) return false;
  return USES_COMMAND_KEY ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/**
 * 「另一种格式复制」快捷键，所有可视化编辑器启用（嵌入式编辑器为纯文本复制）。
 * 直接监听编辑器 DOM：全局快捷键层会对 Ctrl+Shift+C 预先 preventDefault（屏蔽开发者工具），
 * 走 handleDOMEvents 会被前序插件按 defaultPrevented 截断；keymap 在只读模式下也不会触发。
 */
export const AlternateCopyShortcut = Extension.create({
  name: 'alternateCopyShortcut',
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [new Plugin({
      view(view) {
        const onKeyDown = (event: KeyboardEvent) => {
          // 只处理编辑区本身的按键；节点视图内的输入框、源码编辑框保持各自行为
          if (event.target !== view.dom || !isAlternateCopyKey(event)) return;
          event.preventDefault();
          if (view.state.selection.empty) return;
          void copySelectionAs(editor, getAlternateCopyFormat(editor));
        };
        view.dom.addEventListener('keydown', onKeyDown);
        return { destroy: () => view.dom.removeEventListener('keydown', onKeyDown) };
      },
    })];
  },
});

/** 开放切片沿用祖先列表的起点，需加上选区前被裁掉的项数，避免复制第八项却输出第七项。 */
function restoreListStart(content: Fragment, from: ResolvedPos, openDepth: number, depth = 1): Fragment {
  const first = content.firstChild;
  if (!first || depth > openDepth || first.type !== from.node(depth).type) return content;
  const attrs = first.type.name === 'orderedList'
    ? { ...first.attrs, start: Number(first.attrs.start ?? 1) + from.index(depth) }
    : first.attrs;
  const children = restoreListStart(first.content, from, openDepth, depth + 1);
  return content.replaceChild(0, first.type.create(attrs, children, first.marks));
}

/** 片段缺少表头时用首个选中行承载 Markdown 表头，避免文件序列化规则凭空补出一行。 */
function prepareClipboardTables(content: Fragment): Fragment {
  const nodes = [];
  for (let index = 0; index < content.childCount; index += 1) {
    const node = content.child(index);
    let children = prepareClipboardTables(node.content);
    const firstRow = children.firstChild;
    if (node.type.spec.tableRole === 'table' && firstRow) {
      const cells = Array.from({ length: firstRow.childCount }, (_, cellIndex) => firstRow.child(cellIndex));
      // 真实选中的空白表头也必须保留；仅转换完全由正文单元格组成的首行。
      if (cells.every((cell) => cell.type.spec.tableRole === 'cell')) {
        const header = node.type.schema.nodes.tableHeader;
        children = children.replaceChild(0, firstRow.copy(Fragment.from(
          cells.map((cell) => header.create(cell.attrs, cell.content, cell.marks)),
        )));
      }
    }
    nodes.push(node.copy(children));
  }
  return Fragment.from(nodes);
}

/** 将选区补成可独立序列化的文档；单元格选区等切片需要补回表格、段落或列表容器。 */
function serializeClipboardMarkdown(editor: Editor, slice: Slice): string {
  const { doc, schema, selection } = editor.state;
  let content = restoreListStart(slice.content, selection.$from, slice.openStart);
  for (let depth = selection.$from.depth; !doc.type.validContent(content) && depth > 0; depth -= 1) {
    const parent = selection.$from.node(depth);
    if (parent.type.validContent(content)) content = Fragment.from(parent.copy(content));
  }
  // 剪贴板片段不继承整份文件末尾的换行，正文中的空白和各节点源码属性仍交给共享流水线保留。
  // 整篇的顶层块原文记录只对应完整文档，片段一律按规则输出，结果不随复制范围变化。
  const fragmentDoc = doc.type.create({ ...doc.attrs, trailingNewline: '', sourceBlocks: null }, prepareClipboardTables(content));
  const manager = getMarkdownManager(editor);
  if (!manager) throw new Error('[NoteBoard] Markdown 剪贴板缺少 MarkdownManager');
  return serializeMarkdownFromDoc(manager, schema, fragmentDoc);
}

/** 仅供 Markdown 文档启用；复制、剪切和右键菜单均经同一个原生剪贴板事件入口。 */
export const MarkdownClipboard = Extension.create({
  name: 'markdownClipboard',
  priority: 1000,
  addProseMirrorPlugins() {
    const editor = this.editor;
    // 写入成功后才删除选区；只读模式让原生剪切保护生效，空选区不覆盖已有剪贴板。
    const writeSelection = (view: EditorView, event: ClipboardEvent): boolean => {
      const cut = event.type === 'cut';
      if ((cut && !view.editable) || view.state.selection.empty || !event.clipboardData) return false;
      // 复制按设置输出纯文本或源码；剪切始终保留格式，避免在文档内移动内容时丢失排版
      const text = !cut && getDefaultCopyFormat() === 'plain'
        ? serializeSelectionPlainText(editor)
        : serializeClipboardMarkdown(editor, view.state.selection.content());
      event.clipboardData.clearData();
      event.clipboardData.setData('text/plain', text);
      event.preventDefault();
      // 跨表格边界的选区按表格规则删除（见 tableCrossDelete.ts），其余走默认删除
      if (cut) {
        const tr = deleteSelectionAcrossTables(view.state) ?? view.state.tr.deleteSelection().scrollIntoView();
        view.dispatch(tr.setMeta('uiEvent', 'cut'));
      }
      return true;
    };
    return [new Plugin({
      props: {
        handleDOMEvents: {
          copy: writeSelection,
          cut: writeSelection,
        },
      },
    })];
  },
});
