// 保留原文中省略的块间空行：只记录已解析为独立块的边界，不删除实际空段落或语法必需的分隔。
import { Extension, Node, type JSONContent, type MarkdownRendererHelpers, type MarkdownToken } from '@tiptap/core';
import { Blockquote } from '@tiptap/extension-blockquote';

// 只处理能够明确判断 Markdown 边界的内置块；HTML、自定义容器等仍沿用原来的保守分隔。
const SPACING_NODE_TYPES = ['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'taskList', 'codeBlock', 'horizontalRule'];

/** 段落 / 标题使用 div 包裹排版时，标签边界仍需空行，不能套用普通 Markdown 的省略规则。 */
function hasHtmlBlockFormat(node: JSONContent): boolean {
  return (node.type === 'paragraph' || node.type === 'heading')
    && (Number(node.attrs?.indent) > 0 || ['center', 'right'].includes(String(node.attrs?.textAlign)));
}

/** 判断当前两个块能否以单换行安全连接；段落、引用和列表的惰性续行边界不能省略空行。 */
function allowsCompactBoundary(previous: JSONContent, current: JSONContent): boolean {
  if (!SPACING_NODE_TYPES.includes(previous.type ?? '') || !SPACING_NODE_TYPES.includes(current.type ?? '')) return false;
  if (hasHtmlBlockFormat(previous) || hasHtmlBlockFormat(current)) return false;
  // ATX 标题与围栏代码有明确的结束边界；标题、引用、围栏代码本身也能中断前面的段落或容器。
  if (['heading', 'codeBlock'].includes(previous.type ?? '') || ['heading', 'blockquote', 'codeBlock'].includes(current.type ?? '')) return true;
  if (previous.type !== 'paragraph') return false;
  if (current.type === 'taskList') return true;
  const firstParagraph = current.content?.[0]?.content?.[0];
  const firstItemHasText = firstParagraph?.type === 'paragraph' && (firstParagraph.content?.length ?? 0) > 0;
  if (current.type === 'bulletList') return firstItemHasText;
  // 只有从 1 开始的数字列表可以中断段落；改变列表起点或类型后，回写自动恢复必要分隔。
  return current.type === 'orderedList' && firstItemHasText
    && (current.attrs?.start ?? 1) === 1 && (!current.attrs?.type || current.attrs.type === '1');
}

/** 将词法 token 与已解析块对应；出现一对多转换时不猜测位置，相关容器继续保守输出。 */
function tokenMatchesNode(token: MarkdownToken, node: JSONContent): boolean {
  if (token.type === 'paragraph' || token.type === 'text') return node.type === 'paragraph';
  if (token.type === 'list') return node.type === (token.ordered ? 'orderedList' : 'bulletList');
  if (token.type === 'list_item') return node.type === 'listItem';
  if (token.type === 'code') return node.type === 'codeBlock';
  if (token.type === 'hr') return node.type === 'horizontalRule';
  return token.type === node.type;
}

/**
 * 在根文档与引用块中记录原本只有一个换行的相邻块。
 * 空白 token 和前块 raw 尾部共同决定实际间距；空段落保留在正文中，不按“多余空行”剔除。
 * 属性随块编辑、撤销与快照一起保存，新分裂的块不继承它，避免改变新输入的分段习惯。
 */
export function preserveSourceBlockSpacing(node: JSONContent, tokens: MarkdownToken[]): void {
  const entries: Array<{ token: MarkdownToken; compactBefore: boolean }> = [];
  let previous: MarkdownToken | undefined;
  let gap = '';
  for (const token of tokens) {
    if (token.type === 'space') {
      gap += token.raw ?? '';
      continue;
    }
    const singleText = token.tokens?.length === 1 ? token.tokens[0] : undefined;
    const isEmptyParagraph = (token.type === 'paragraph' || token.type === 'text') && singleText?.type === 'text'
      && ['&nbsp;', '\u00a0'].includes(String(singleText.raw ?? singleText.text));
    if (token.type === 'def' || isEmptyParagraph) {
      // 引用定义不输出块节点；&nbsp; 由段落扩展还原为空段落，与下面过滤的空节点对应。
      // 两者都不能被当作普通块跨越，以免压缩用户主动保留的空白段。
      previous = undefined;
      gap = '';
      continue;
    }
    const trailing = /\n[\n \t]*$/.exec(previous?.raw ?? '')?.[0] ?? '';
    const leading = /^[\n \t]*\n/.exec(token.raw ?? '')?.[0] ?? '';
    const separator = trailing + gap + leading;
    entries.push({ token, compactBefore: !!previous && (separator.match(/\n/g)?.length ?? 0) === 1 });
    previous = token;
    gap = '';
  }
  const children = (node.content ?? []).map((child, index) => ({ child, index }))
    .filter(({ child }) => child.type !== 'paragraph' || (child.content?.length ?? 0) > 0);
  if (entries.length !== children.length) return;

  const preserveHere = node.type === 'doc' || node.type === 'blockquote';
  entries.forEach((entry, index) => {
    const { child, index: childIndex } = children[index];
    if (!tokenMatchesNode(entry.token, child)) return;
    const before = children[index - 1];
    if (preserveHere && entry.compactBefore && before && before.index === childIndex - 1
      && tokenMatchesNode(entries[index - 1].token, before.child) && allowsCompactBoundary(before.child, child)) {
      child.attrs = { ...child.attrs, sourceCompactBefore: before.child.type };
    }
    const nested = (entry.token.type === 'list' || entry.token.type === 'taskList')
      ? entry.token.items as MarkdownToken[] | undefined : entry.token.tokens;
    // 文本块内只有行内 token，不再递归扫描；容器中的引用或子列表继续处理。
    if (nested && child.content && !['paragraph', 'heading', 'codeBlock'].includes(child.type ?? '')) {
      preserveSourceBlockSpacing(child, nested);
    }
  });
}

/** 连接块时优先沿用已记录的单换行，其余仍保留默认空行与空段落的渲染行为。 */
function renderBlockChildren(node: JSONContent, helpers: MarkdownRendererHelpers): string {
  const children = node.content ?? [];
  return children.map((child, index) => {
    const rendered = helpers.renderChild?.(child, index) ?? helpers.renderChildren([child]);
    if (index === 0) return rendered;
    const previous = children[index - 1];
    const compact = child.attrs?.sourceCompactBefore === previous.type && allowsCompactBoundary(previous, child);
    return (compact ? '\n' : '\n\n') + rendered;
  }).join('');
}

/** 源码块边界只影响回写，不进入 HTML 或剪贴板，也不复制到新分裂出的块。 */
export const MarkdownBlockSpacing = Extension.create({
  name: 'markdownBlockSpacing',
  addGlobalAttributes() {
    return [{ types: SPACING_NODE_TYPES, attributes: { sourceCompactBefore: { default: null, rendered: false, keepOnSplit: false } } }];
  },
});

/** 根文档沿用原文可省略的分隔空行，schema 与默认 Document 一致。 */
export const MarkdownDocument = Node.create({ name: 'doc', topNode: true, content: 'block+', renderMarkdown: renderBlockChildren });

/** 引用内部使用相同边界规则；非空行加引用前缀，真正的空行仍保留为单独的 > 行。 */
export const MarkdownBlockquote = Blockquote.extend({
  renderMarkdown(node, helpers) {
    if (!node.content) return '';
    return renderBlockChildren(node, helpers).split('\n').map((line) => line.trim() === '' ? '>' : `> ${line}`).join('\n');
  },
});
