// 文末辅助输入段落只服务光标导航，不属于作者留白；用户开始编辑后才成为真实正文。
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

// 插件键各编辑器共用（插件状态仍按编辑器各自独立）
const trailingNodeKey = new PluginKey<boolean>('markdownTrailingNode');

/**
 * 暂停 / 恢复补尾段的事务元数据（true 暂停，false 恢复）。
 * 大文档分批装载期间文档只有前半篇：这期间任何其它事务（如代码高亮异步回填的元数据事务）
 * 都不能在半篇末尾补辅助段，否则下一批接在它后面，辅助段变成正文中间多出的空段落。
 * 单个事务的 skipTrailingNode 只能跳过自身，覆盖不了批次之间插入的其它事务。
 */
export const TRAILING_NODE_SUSPEND_META = 'markdownTrailingNodeSuspend';

/** 每个编辑器独立创建插件；只映射原尾段位置，不在输入热路径扫描全文。 */
export function createMarkdownTrailingPlugin(): Plugin {
  return new Plugin<boolean>({
    key: trailingNodeKey,
    state: {
      init: () => false,
      apply: (transaction, suspended) => {
        const meta = transaction.getMeta(TRAILING_NODE_SUSPEND_META) as boolean | undefined;
        return meta === undefined ? suspended : meta;
      },
    },
    appendTransaction(transactions, oldState, state) {
      // 分批装载未完成：文档尚不完整，既不补尾段也不改辅助段身份
      if (trailingNodeKey.getState(state)) return null;
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
