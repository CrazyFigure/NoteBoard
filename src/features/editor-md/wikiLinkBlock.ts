// NoteBoard 嵌入独占段落
// `![[...]]` 在 Markdown 中是行内语法，但显示为整块卡片；若与其它文字或嵌入挤在同一段落，
// 块拖柄、块选中、段落间距都会把它们当成一段。新建或切换为嵌入时统一放进单独的段落：
// 段落中前后还有内容就在该处拆开，嵌入单独成段；段落本来只有它则原地放置。

import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { TextSelection, type Transaction } from '@tiptap/pm/state';

/**
 * 在事务中用嵌入节点替换 [from, to) 的内容，并保证它独占一个段落；光标落在嵌入之后。
 * 所在位置不是普通段落（标题等）或上层不允许再插入段落时，退化为原地行内插入。
 */
export function placeEmbedAsBlock(tr: Transaction, from: number, to: number, embed: ProseMirrorNode): void {
  tr.delete(from, to);
  const $pos = tr.doc.resolve(from);
  const parent = $pos.parent;
  const paragraphType = tr.doc.type.schema.nodes.paragraph;
  const hasBefore = $pos.parentOffset > 0;
  const hasAfter = $pos.parentOffset < parent.content.size;

  const insertInline = () => {
    tr.insert(from, embed);
    tr.setSelection(TextSelection.create(tr.doc, from + embed.nodeSize));
  };

  // 段落里只有它：原地放置即可
  if (!paragraphType || parent.type !== paragraphType || (!hasBefore && !hasAfter)) {
    insertInline();
    return;
  }

  // 上层容器（文档、列表项、引用、表格单元格等）必须允许在此处再放一个段落
  const container = $pos.node(-1);
  const index = $pos.index(-1);
  if (!container.canReplaceWith(index, index, paragraphType)) {
    insertInline();
    return;
  }

  let insertAt: number;
  if (hasBefore && hasAfter) {
    // 前后都有内容：在此处拆成两段，嵌入段落放在两段之间
    tr.split(from);
    insertAt = from + 1;
  } else if (hasBefore) {
    insertAt = $pos.after();
  } else {
    insertAt = $pos.before();
  }
  tr.insert(insertAt, paragraphType.create(null, embed));
  // 光标放在嵌入所在段落的末尾：继续按 Enter 即另起一段
  tr.setSelection(TextSelection.create(tr.doc, insertAt + 1 + embed.nodeSize));
}
