// NoteBoard 双链操作：通过弹窗插入 / 编辑
// 工具栏、右键菜单、斜杠菜单、补全框「更多选项」与双击已有链接共用；可视化与源码模式各自写回。

import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorView as ProseMirrorView } from '@tiptap/pm/view';
import type { EditorView as CodeMirrorView } from '@codemirror/view';
import { openWikiLinkDialog } from './wikiLinkDialogStore';
import { openWikiLink } from './wikiLinkNavigation';
import { placeEmbedAsBlock } from '../editor-md/wikiLinkBlock';

/** 选中文字作为显示名预填的长度上限（过长的选区不适合作为链接文字） */
const ALIAS_PREFILL_MAX = 60;

/** 插入弹窗的预填内容（补全框「更多选项」带入已输入的查询） */
export interface WikiLinkPrefill {
  inner?: string;
  embed?: boolean;
}

/** 可视化模式：弹窗选择后在选区处插入双链节点（选中文字预填为显示名） */
export async function insertWikiLinkInEditor(editor: Editor, docKey: string, prefill?: WikiLinkPrefill): Promise<void> {
  const { from, to } = editor.state.selection;
  const selected = editor.state.doc.textBetween(from, to, ' ').trim();
  const alias = selected && selected.length <= ALIAS_PREFILL_MAX && !/[[\]|\n]/.test(selected) ? selected : '';
  const result = await openWikiLinkDialog({ mode: 'insert', docKey, alias, inner: prefill?.inner, embed: prefill?.embed });
  if (editor.isDestroyed) return;
  if (result?.action !== 'confirm') {
    editor.commands.focus();
    return;
  }
  if (result.embed) {
    // 嵌入单独成段：与前后文字或其它嵌入分开，块拖柄与选中按卡片区分
    editor
      .chain()
      .focus()
      .command(({ tr, state }) => {
        placeEmbedAsBlock(tr, from, to, state.schema.nodes.wikiLink.create({ inner: result.inner, embed: true }));
        return true;
      })
      .run();
    return;
  }
  editor
    .chain()
    .focus()
    .insertContentAt({ from, to }, [{ type: 'wikiLink', attrs: { inner: result.inner, embed: false } }])
    .run();
}

/** 源码中嵌入独占一段：所在行前后还有文字时用空行隔开 */
function blockSpacing(view: CodeMirrorView, from: number, to: number): { before: string; after: string } {
  const { doc } = view.state;
  const lineBefore = doc.sliceString(doc.lineAt(from).from, from);
  const lineAfter = doc.sliceString(to, doc.lineAt(to).to);
  return {
    before: lineBefore.trim() ? '\n\n' : '',
    after: lineAfter.trim() ? '\n\n' : '',
  };
}

/** 源码模式：弹窗选择后在选区处写入 `[[...]]` / `![[...]]` */
export async function insertWikiLinkInSource(view: CodeMirrorView, docKey: string, prefill?: WikiLinkPrefill): Promise<void> {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to).trim();
  const alias = selected && selected.length <= ALIAS_PREFILL_MAX && !/[[\]|\n]/.test(selected) ? selected : '';
  const result = await openWikiLinkDialog({ mode: 'insert', docKey, alias, inner: prefill?.inner, embed: prefill?.embed });
  if (result?.action !== 'confirm') {
    view.focus();
    return;
  }
  const syntax = `${result.embed ? '!' : ''}[[${result.inner}]]`;
  const spacing = result.embed ? blockSpacing(view, from, to) : { before: '', after: '' };
  const insert = `${spacing.before}${syntax}${spacing.after}`;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + spacing.before.length + syntax.length },
  });
  view.focus();
}

/** 编辑可视化文档中位于 pos 的双链节点：保存、删除或打开 */
export async function editWikiLinkNode(view: ProseMirrorView, pos: number, docKey: string): Promise<void> {
  const node = view.state.doc.nodeAt(pos);
  if (!node || node.type.name !== 'wikiLink') return;
  const inner = String(node.attrs.inner ?? '');
  const result = await openWikiLinkDialog({ mode: 'edit', docKey, inner, embed: node.attrs.embed === true });
  if (!result) {
    view.focus();
    return;
  }
  if (result.action === 'open') {
    void openWikiLink(result.inner, docKey);
    return;
  }
  // 弹窗期间文档可能变化（协同、自动格式化等），按位置重新确认仍是同一个节点
  const current = view.state.doc.nodeAt(pos);
  if (!current || current.type.name !== 'wikiLink') return;
  const { tr } = view.state;
  if (result.action === 'remove') {
    tr.delete(pos, pos + current.nodeSize);
    tr.setSelection(TextSelection.create(tr.doc, Math.min(pos, tr.doc.content.size)));
  } else if (result.embed) {
    // 嵌入（含由链接切换为嵌入、以及与其它内容挤在同一段的旧嵌入）保存后单独成段
    const embed = current.type.create({ ...current.attrs, inner: result.inner, embed: true });
    placeEmbedAsBlock(tr, pos, pos + current.nodeSize, embed);
  } else {
    tr.setNodeMarkup(pos, undefined, { ...current.attrs, inner: result.inner, embed: false });
    tr.setSelection(TextSelection.create(tr.doc, Math.min(pos + current.nodeSize, tr.doc.content.size)));
  }
  view.dispatch(tr);
  view.focus();
}
