// 文末辅助输入段落只服务光标导航，不属于作者留白；用户开始编辑后才成为真实正文。
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

/** 每个编辑器独立创建插件；只映射原尾段位置，不在输入热路径扫描全文。 */
export function createMarkdownTrailingPlugin(): Plugin {
  return new Plugin({
    key: new PluginKey('markdownTrailingNode'),
    appendTransaction(transactions, oldState, state) {
      const tr = state.tr;
      const oldLast = oldState.doc.lastChild;
      if (oldLast?.attrs.sourceTrailingPlaceholder) {
        // 只映射原尾段位置，不在每次键入时遍历全文；输入、排版或拆段后清除辅助身份。
        let position = oldState.doc.content.size - oldLast.nodeSize;
        for (const transaction of transactions) position = transaction.mapping.map(position);
        const node = state.doc.nodeAt(position);
        if (node?.attrs.sourceTrailingPlaceholder && (node.content.size > 0
          || position + node.nodeSize !== state.doc.content.size || node.attrs.textAlign || node.attrs.indent)) {
          tr.setNodeMarkup(position, undefined, { ...node.attrs, sourceTrailingPlaceholder: false });
        }
      }
      // 与原扩展一致：段落以外的结尾补输入段；尊重程序调用的显式跳过标记。
      if (state.doc.lastChild?.type.name !== 'paragraph'
        && !transactions.some((transaction) => transaction.getMeta('skipTrailingNode'))) {
        tr.insert(state.doc.content.size, state.schema.nodes.paragraph.create({ sourceTrailingPlaceholder: true }));
      }
      return tr.docChanged ? tr : null;
    },
  });
}

/** 替代 StarterKit 的无来源尾段，保留块后输入能力，同时避免打开文档就多出空行。 */
export const MarkdownTrailingNode = Extension.create({
  name: 'markdownTrailingNode',
  addGlobalAttributes() {
    return [{ types: ['paragraph'], attributes: {
      sourceTrailingPlaceholder: { default: false, rendered: false, keepOnSplit: false },
    } }];
  },
  addProseMirrorPlugins() {
    return [createMarkdownTrailingPlugin()];
  },
});
