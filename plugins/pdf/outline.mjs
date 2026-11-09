// PDF 书签解析：把 PDF.js 的大纲树展平为带层级的节点，目标统一换算为页序号与页内坐标。
export const OUTLINE_LIMIT = 5000;

/** 文件自带的展开状态优先（count > 0 为展开）；未声明时只展开第一层。 */
export function buildOutline(raw, limit = OUTLINE_LIMIT) {
  const nodes = [];
  const walk = (items, depth, parent) => {
    for (const item of items ?? []) {
      if (nodes.length >= limit) return;
      const node = {
        title: String(item?.title ?? '').replace(/\s+/g, ' ').trim() || '（无标题）',
        dest: item?.dest ?? null, depth, parent, children: [],
        bold: Boolean(item?.bold), italic: Boolean(item?.italic),
        expanded: Number.isFinite(item?.count) && item.count !== 0 ? item.count > 0 : depth === 0,
        target: undefined, pending: null,
      };
      nodes.push(node); parent?.children.push(node);
      walk(item?.items, depth + 1, node);
    }
  };
  walk(Array.isArray(raw) ? raw : [], 0, null);
  return nodes;
}

/** 命名目标先查表；XYZ 带左上角，FitH/FitBH 只带顶部，其它方式跳到页首。 */
export async function resolveDest(doc, dest) {
  const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
  if (!Array.isArray(explicit) || !explicit.length) return null;
  const [ref, mode, ...args] = explicit;
  // 少数生成器直接写页序号而不是页面引用。
  const index = Number.isInteger(ref) ? ref : ref && typeof ref === 'object' ? await doc.getPageIndex(ref) : NaN;
  if (!Number.isInteger(index) || index < 0 || index >= doc.numPages) return null;
  const name = mode?.name;
  const top = name === 'XYZ' ? args[1] : name === 'FitH' || name === 'FitBH' ? args[0] : null;
  const left = name === 'XYZ' ? args[0] : null;
  return { index, left: Number.isFinite(left) ? left : null, top: Number.isFinite(top) ? top : null };
}

/** 当前位置取起始页不晚于当前页的最后一个书签；书签顺序不必与页码一致。 */
export function currentNode(nodes, pageIndex) {
  let best = null;
  for (const node of nodes) {
    const index = node.target?.index;
    if (index == null || index > pageIndex) continue;
    if (!best || index >= best.target.index) best = node;
  }
  return best;
}

/** 被折叠的节点不可见，高亮落到最外层折叠的祖先上。 */
export function visibleNode(node) {
  let shown = node;
  for (let parent = node?.parent; parent; parent = parent.parent) if (!parent.expanded) shown = parent;
  return shown;
}
