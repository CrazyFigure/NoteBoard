// NoteBoard 文档历史记录：思维导图差异（按节点 id，纯函数）
//
// 以新版本的树为骨架生成「合并树」：
//   - 新版本才有的节点：新增
//   - 两版都有、自身内容（文字 / 备注 / 图标 / 图片 / 格式 / 颜色 / 宽度等）不同：修改
//   - 两版都有、父节点或同级顺序变化：移动
//   - 旧版本才有的节点：连同仍被删除的子孙作为「幽灵子树」挂回原父节点（父节点也被删时挂到最近的存活祖先）
// 有改动的节点所在分支全部展开，保证改动可见。

import type { MindNode } from '../../mindmap/mindmapTypes';

export type MindDiffKind = 'ins' | 'del' | 'mod' | 'moved';

export interface MindDiffChange {
  id: string;
  kind: MindDiffKind;
  /** 修改前的标题（修改 / 删除时） */
  oldText?: string;
  text: string;
}

export interface MindmapDiffResult {
  root: MindNode;
  marks: Map<string, MindDiffKind>;
  /** 按合并树前序排列的改动（整棵新增 / 删除的子树只算顶层一处） */
  changes: MindDiffChange[];
}

interface Located {
  node: MindNode;
  parentId: string | null;
  index: number;
}

function index(root: MindNode): Map<string, Located> {
  const map = new Map<string, Located>();
  const stack: Array<{ node: MindNode; parentId: string | null; index: number }> = [{ node: root, parentId: null, index: 0 }];
  while (stack.length) {
    const cur = stack.pop()!;
    map.set(cur.node.id, cur);
    (cur.node.children ?? []).forEach((child, i) => stack.push({ node: child, parentId: cur.node.id, index: i }));
  }
  return map;
}

/** 节点自身内容的比较键（不含子节点与折叠状态） */
function ownKey(node: MindNode): string {
  const { children: _c, isExpanded: _e, ...rest } = node;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

/** 同级顺序：只比较两版共有的兄弟之间的相对次序 */
function siblingRank(parent: MindNode | undefined, id: string, common: (id: string) => boolean): number {
  if (!parent) return 0;
  let rank = 0;
  for (const c of parent.children ?? []) {
    if (c.id === id) return rank;
    if (common(c.id)) rank += 1;
  }
  return -1;
}

export function diffMindmaps(base: MindNode | null, target: MindNode): MindmapDiffResult {
  const marks = new Map<string, MindDiffKind>();
  if (!base) return { root: target, marks, changes: [] };
  const oldIdx = index(base);
  const newIdx = index(target);
  const common = (id: string) => oldIdx.has(id) && newIdx.has(id);

  // 1. 新版本节点：新增 / 修改 / 移动
  for (const [id, loc] of newIdx) {
    const old = oldIdx.get(id);
    if (!old) {
      marks.set(id, 'ins');
      continue;
    }
    if (ownKey(old.node) !== ownKey(loc.node)) {
      marks.set(id, 'mod');
      continue;
    }
    if (old.parentId !== loc.parentId) {
      marks.set(id, 'moved');
      continue;
    }
    const oldParent = old.parentId ? oldIdx.get(old.parentId)?.node : undefined;
    const newParent = loc.parentId ? newIdx.get(loc.parentId)?.node : undefined;
    if (siblingRank(oldParent, id, common) !== siblingRank(newParent, id, common)) marks.set(id, 'moved');
  }

  // 2. 合并树：复制新树，挂回被删除的子树
  const clone = (node: MindNode): MindNode => ({ ...node, children: (node.children ?? []).map(clone) });
  const root = clone(target);
  const mergedIdx = index(root);
  // 被删除节点的幽灵副本：只保留同样被删除的子孙（仍存在的子孙已在新位置出现）
  const ghost = (node: MindNode): MindNode => {
    marks.set(node.id, 'del');
    return { ...node, isExpanded: true, children: (node.children ?? []).filter((c) => !newIdx.has(c.id)).map(ghost) };
  };
  const topDeleted: Located[] = [];
  for (const [id, loc] of oldIdx) {
    if (newIdx.has(id)) continue;
    // 只处理最上层被删除的节点（父节点存活或父节点也在新树中被移走）
    if (loc.parentId && !newIdx.has(loc.parentId) && oldIdx.has(loc.parentId)) continue;
    topDeleted.push(loc);
  }
  // 按原位置顺序插入，保证同一父节点下多个删除项的相对次序
  topDeleted.sort((a, b) => a.index - b.index);
  for (const loc of topDeleted) {
    // 最近的存活祖先
    let anchorId = loc.parentId;
    while (anchorId && !mergedIdx.has(anchorId)) anchorId = oldIdx.get(anchorId)?.parentId ?? null;
    const anchor = mergedIdx.get(anchorId ?? root.id)?.node ?? root;
    const children = anchor.children ?? (anchor.children = []);
    const pos = Math.min(loc.index, children.length);
    const g = ghost(loc.node);
    children.splice(pos, 0, g);
    for (const [gid, gl] of index(g)) mergedIdx.set(gid, gl);
  }

  // 3. 展开改动所在分支，收集改动（前序）
  const changes: MindDiffChange[] = [];
  const walk = (node: MindNode, ancestors: MindNode[], insideWhole: boolean): boolean => {
    const kind = marks.get(node.id);
    const whole = kind === 'ins' || kind === 'del';
    if (kind && !(insideWhole && whole)) {
      const old = oldIdx.get(node.id)?.node;
      changes.push({ id: node.id, kind, text: node.text, oldText: kind === 'mod' || kind === 'del' ? old?.text : undefined });
    }
    let changed = Boolean(kind);
    for (const c of node.children ?? []) {
      if (walk(c, [...ancestors, node], insideWhole || whole)) changed = true;
    }
    if (changed) for (const a of ancestors) a.isExpanded = true;
    return changed;
  };
  walk(root, [], false);
  return { root, marks, changes };
}
