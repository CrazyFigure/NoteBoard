// Markdown 文档复制、剪切共用文件序列化规则，避免富文本 HTML 或缺少语法的正文进入剪贴板。
// Ctrl+C 按设置「复制格式」输出 Markdown 源码或纯文本；Ctrl+Shift+C（Mac 为 Cmd+Shift+C）复制为另一种格式。
import { Extension, type Editor } from '@tiptap/core';
import { Fragment, type Node as ProseMirrorNode, type ResolvedPos, type Slice } from '@tiptap/pm/model';
import { AllSelection, NodeSelection, Plugin } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
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

// 选区完全落在其内部（或从内部向外跨出、未选中容器开头）时应剥离的结构容器
const ENCLOSING_CONTAINER_TYPES = new Set([
  'detailsBlock',
  'calloutBlock',
  'columnsBlock',
  'columnBlock',
  'githubAlert',
  'blockquote',
  'table',
  'tableRow',
  'tableCell',
  'tableHeader',
]);

const LIST_CONTAINER_TYPES = new Set(['bulletList', 'orderedList', 'taskList']);
const LIST_ITEM_TYPES = new Set(['listItem', 'taskItem']);

/** 开放切片沿用祖先列表的起点，需加上选区前被裁掉的项数，避免复制第八项却输出第七项。 */
function restoreListStart(content: Fragment, from: ResolvedPos, openDepth: number, depth = 1): Fragment {
  const first = content.firstChild;
  if (!first || openDepth <= 0 || depth > from.depth || first.type !== from.node(depth).type) return content;
  const attrs = first.type.name === 'orderedList'
    ? { ...first.attrs, start: Number(first.attrs.start ?? 1) + from.index(depth) }
    : first.attrs;
  const children = restoreListStart(first.content, from, openDepth - 1, depth + 1);
  return content.replaceChild(0, first.type.create(attrs, children, first.marks));
}

/** 剥离块节点上的对齐与缩进属性，还原为普通段落/标题（用于未选中完整块格式的场景）。 */
function stripBlockFormatAttrs(node: ProseMirrorNode): Record<string, unknown> {
  const attrs = { ...node.attrs };
  if ('textAlign' in attrs) attrs.textAlign = null;
  if ('indent' in attrs) attrs.indent = 0;
  return attrs;
}

/**
 * 选区从某文本块中间开始时，把开放首链最内层被截断的标题或带对齐/缩进的段落降级为普通段落，
 * 避免未选中开头格式却带出 `### ` 或 `<div align="center">`。
 */
function flattenClippedLeadingBlock(content: Fragment, openStart: number): Fragment {
  const first = content.firstChild;
  if (!first || openStart <= 0) return content;
  if (openStart === 1 && first.isTextblock) {
    const paragraphType = first.type.schema.nodes.paragraph;
    if (!paragraphType) return content;
    return content.replaceChild(0, paragraphType.create(null, first.content));
  }
  const updated = flattenClippedLeadingBlock(first.content, openStart - 1);
  return updated === first.content ? content : content.replaceChild(0, first.copy(updated));
}

/**
 * 构造单文本块选区的剪贴板内容：
 * - 仅选中段内局部文字：一律降级为普通段落，只保留行内格式（粗体/斜体/代码/链接等），不携带任何块/容器格式；
 * - 选中单个文本块的全部文字：剥离外层未选中的结构容器（折叠块、高亮块、分栏、提示块、引用、表格单元格等），
 *   仅在单独的完整列表项或独立标题时保留列表标记/标题级别。
 */
function buildSingleTextblockClipboardContent(editor: Editor): Fragment | string {
  const { schema, selection } = editor.state;
  const { $from, $to } = selection;
  const parent = $from.parent;

  // 代码块内拖选或首次 Ctrl+A 全选代码文字时，直接复制代码原文，不包裹代码围栏
  if (parent.type.spec.code) {
    return parent.textBetween($from.parentOffset, $to.parentOffset, '\n');
  }

  const isPartial = selection.from > $from.start() || selection.to < $from.end();
  const inlineContent = parent.content.cut($from.parentOffset, $to.parentOffset);
  if (isPartial) {
    return Fragment.from(schema.nodes.paragraph.create(null, inlineContent));
  }

  // 选中单个列表项的唯一段落全文时，保留该项对应的列表标记与编号（但不向上带出外层折叠块或未选中的父项）
  if ($from.depth >= 2) {
    const itemDepth = $from.depth - 1;
    const itemNode = $from.node(itemDepth);
    const listDepth = itemDepth - 1;
    if (LIST_ITEM_TYPES.has(itemNode.type.name) && itemNode.childCount === 1 && listDepth >= 1) {
      const listNode = $from.node(listDepth);
      if (LIST_CONTAINER_TYPES.has(listNode.type.name)) {
        const listAttrs = listNode.type.name === 'orderedList'
          ? { ...listNode.attrs, start: Number(listNode.attrs.start ?? 1) + $from.index(listDepth) }
          : listNode.attrs;
        const paragraph = schema.nodes.paragraph.create(null, inlineContent);
        const item = itemNode.type.create(itemNode.attrs, Fragment.from(paragraph), itemNode.marks);
        return Fragment.from(listNode.type.create(listAttrs, Fragment.from(item), listNode.marks));
      }
    }
  }

  // 独立标题的完整文本保留标题级别（去掉未选中的外层容器与对齐/缩进）
  if (parent.type.name === 'heading') {
    return Fragment.from(parent.type.create(stripBlockFormatAttrs(parent), inlineContent));
  }

  return Fragment.from(schema.nodes.paragraph.create(null, inlineContent));
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

/** 将选区补成可独立序列化的文档；按实际选中范围剥离未选中的外层块/容器格式，单元格选区等切片补回表格容器。 */
function serializeClipboardMarkdown(editor: Editor, slice: Slice): string {
  const { doc, schema, selection } = editor.state;
  const isStructuralSelection =
    selection instanceof AllSelection
    || selection instanceof NodeSelection
    || selection instanceof CellSelection;

  let content: Fragment;
  if (!isStructuralSelection && selection.$from.sameParent(selection.$to)) {
    const single = buildSingleTextblockClipboardContent(editor);
    if (typeof single === 'string') return single;
    content = single;
  } else if (!isStructuralSelection) {
    // 跨块文本选区：剥离将整个选区包裹在内的外层容器（折叠块、高亮块、分栏、提示块、引用、单元格、单个列表项），
    // 若跨多个同级列表项则保留该列表容器并修正起始编号
    let nextContent = slice.content;
    let openStart = slice.openStart;
    let openEnd = slice.openEnd;
    let baseDepth = 1;
    const sharedDepth = selection.$from.sharedDepth(selection.to);
    const keepSharedList = sharedDepth > 0 && LIST_CONTAINER_TYPES.has(selection.$from.node(sharedDepth).type.name);
    const unwrapCount = keepSharedList ? sharedDepth - 1 : sharedDepth;
    for (let step = 0; step < unwrapCount; step += 1) {
      if (nextContent.childCount !== 1 || openStart <= 0 || openEnd <= 0 || !nextContent.firstChild) break;
      nextContent = nextContent.firstChild.content;
      openStart -= 1;
      openEnd -= 1;
      baseDepth += 1;
    }

    // 选区从结构容器内部开始并向外跨出时，用户并未选中容器开头（如折叠标题），展开该开放首容器
    while (
      openStart > 0
      && nextContent.firstChild
      && ENCLOSING_CONTAINER_TYPES.has(nextContent.firstChild.type.name)
    ) {
      const rest: ProseMirrorNode[] = [];
      for (let idx = 1; idx < nextContent.childCount; idx += 1) rest.push(nextContent.child(idx));
      nextContent = nextContent.firstChild.content.append(Fragment.from(rest));
      openStart -= 1;
      baseDepth += 1;
    }

    // 首块从文本中间起选时，剥离首块的标题或对齐/缩进格式
    if (selection.from > selection.$from.start()) {
      nextContent = flattenClippedLeadingBlock(nextContent, openStart);
    }

    content = restoreListStart(nextContent, selection.$from, openStart, baseDepth);
  } else {
    content = restoreListStart(slice.content, selection.$from, slice.openStart);
  }

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
