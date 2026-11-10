// Markdown 文档复制、剪切共用文件序列化规则，避免富文本 HTML 或缺少语法的正文进入剪贴板。
import { Extension, type Editor } from '@tiptap/core';
import { Fragment, type ResolvedPos, type Slice } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { getMarkdownManager, serializeMarkdownFromDoc } from './serialize';

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
      const text = serializeClipboardMarkdown(editor, view.state.selection.content());
      event.clipboardData.clearData();
      event.clipboardData.setData('text/plain', text);
      event.preventDefault();
      if (cut) view.dispatch(view.state.tr.deleteSelection().scrollIntoView().setMeta('uiEvent', 'cut'));
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
