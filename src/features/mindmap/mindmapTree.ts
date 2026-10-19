// 思维导图树操作统一使用显式栈，避免导入深层节点时耗尽 JavaScript 调用栈。
import type { MindNode } from './mindmapTypes';

/** 以原有先序顺序遍历全部节点，折叠仅影响显示，不能跳过正文数据。 */
export function* walkMindNodes(root: MindNode): Generator<MindNode> {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    yield node;
    for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index]);
  }
}

/** 获取节点数与层级深度；根节点计为第一层，遍历不依赖展开状态。 */
export function getMindmapTreeStats(root: MindNode): { nodeCount: number; maxDepth: number } {
  let nodeCount = 0;
  let maxDepth = 0;
  const stack = [{ node: root, depth: 1 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    nodeCount += 1;
    maxDepth = Math.max(maxDepth, depth);
    for (const child of node.children) stack.push({ node: child, depth: depth + 1 });
  }
  return { nodeCount, maxDepth };
}

/** 转换整棵树但不递归；节点顺序保持不变，重复对象按非法循环输入处理。 */
export function mapMindmapTree<T extends object>(
  root: T,
  childrenOf: (source: T) => T[],
  createNode: (source: T) => MindNode,
): MindNode {
  const result = createNode(root);
  const seen = new WeakSet<object>([root]);
  const stack = [{ source: root, target: result }];
  while (stack.length > 0) {
    const { source, target } = stack.pop()!;
    for (const child of childrenOf(source)) {
      if (!child || typeof child !== 'object' || seen.has(child)) throw new Error('思维导图包含无效节点或循环引用');
      seen.add(child);
      const next = createNode(child);
      target.children.push(next);
      stack.push({ source: child, target: next });
    }
  }
  return result;
}

/** 复制节点字段与富文本标记，不经过整树 JSON 编解码。 */
export function cloneMindmapTree(root: MindNode): MindNode {
  return mapMindmapTree(root, (node) => node.children, (node) => ({
    ...node,
    marks: node.marks?.map((mark) => ({ ...mark })),
    children: [],
  }));
}

/** 查找指定节点；提供给画布、搜索与移动操作复用。 */
export function findMindNode(root: MindNode, id: string): MindNode | null {
  for (const node of walkMindNodes(root)) if (node.id === id) return node;
  return null;
}

/** 查找父节点及子节点位置，移动时避免递归扫描。 */
export function findMindNodeParent(root: MindNode, id: string): { parent: MindNode; index: number } | null {
  for (const parent of walkMindNodes(root)) {
    const index = parent.children.findIndex((node) => node.id === id);
    if (index >= 0) return { parent, index };
  }
  return null;
}

/** 仅复制目标到根的路径；可同时展开其祖先，深树搜索和替换不使用递归或反复整树扫描。 */
export function updateMindmapNode(root: MindNode, id: string, update: (node: MindNode) => MindNode, expandParents = false): MindNode {
  interface Frame { node: MindNode; parent: Frame | null; index: number }
  const stack: Frame[] = [{ node: root, parent: null, index: 0 }];
  while (stack.length > 0) {
    let frame = stack.pop()!;
    if (frame.node.id !== id) {
      for (let index = frame.node.children.length - 1; index >= 0; index -= 1) stack.push({ node: frame.node.children[index], parent: frame, index });
      continue;
    }
    let next = update(frame.node);
    while (frame.parent) {
      const parent = frame.parent.node;
      if (next !== frame.node || (expandParents && parent.isExpanded === false)) {
        const children = parent.children.slice();
        children[frame.index] = next;
        next = { ...parent, children, ...(expandParents ? { isExpanded: true } : {}) };
      } else next = parent;
      frame = frame.parent;
    }
    return next;
  }
  return root;
}

/**
 * 显式栈 JSON 序列化：保留 JSON.stringify 的字段顺序及空字段规则，支持深层合法节点。
 * 调用方决定是否缩进；不修改原始节点，也不把未定义的对象字段写入文件。
 */
export function stringifyMindmapJson(value: unknown, pretty: boolean): string {
  type Work = { value: unknown; depth: number } | { literal: string };
  const stack: Work[] = [{ value, depth: 0 }];
  const output: string[] = [];
  while (stack.length > 0) {
    const work = stack.pop()!;
    if ('literal' in work) {
      output.push(work.literal);
      continue;
    }
    const current = work.value;
    if (!current || typeof current !== 'object') {
      output.push(JSON.stringify(current) ?? 'null');
      continue;
    }
    const array = Array.isArray(current);
    const entries = array
      ? current.map((item, index) => [String(index), item] as const)
      : Object.entries(current).filter(([, item]) => item !== undefined && typeof item !== 'function');
    if (entries.length === 0) {
      output.push(array ? '[]' : '{}');
      continue;
    }
    const pad = pretty ? '  '.repeat(work.depth + 1) : '';
    output.push(array ? '[' : '{');
    stack.push({ literal: `${pretty ? `\n${'  '.repeat(work.depth)}` : ''}${array ? ']' : '}'}` });
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, item] = entries[index];
      if (index < entries.length - 1) stack.push({ literal: ',' });
      stack.push({ value: item, depth: work.depth + 1 });
      stack.push({ literal: `${pretty ? `\n${pad}` : ''}${array ? '' : `${JSON.stringify(key)}:${pretty ? ' ' : ''}`}` });
    }
  }
  return output.join('');
}
