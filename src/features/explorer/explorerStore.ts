// NoteBoard 资源管理器 Store
// 单根纯跟随目录树 + 展开状态 + 监听
// 详见 docs/05-ADR/ADR-007-资源管理器语义.md
// 详见 docs/07-UI布局与交互规范.md §5

import { create } from 'zustand';
import type { FileTreeNode } from '../../core/ipc/types';
import { sameKey, isSubPath, normalizePath, getPathChain, pathKey } from './pathUtils';

interface ExplorerStore {
  /** 当前根路径（null = 未打开任何目录） */
  root: string | null;
  /** 展开的目录集合（路径 → 子节点） */
  expanded: Map<string, FileTreeNode[]>;
  /** 当前定位的文件路径（高亮） */
  revealed: string | null;
  /** 定位触发版本计数器（用于通知节点执行滚动） */
  revealCount: number;
  /** 子节点缓存（按目录路径索引） */
  children: Map<string, FileTreeNode[]>;
  /** 是否正在加载 */
  loading: boolean;

  // ── 查询 ──
  isExpanded: (path: string) => boolean;
  getChildren: (path: string) => FileTreeNode[] | undefined;

  // ── 操作 ──
  /** 切换目录展开 */
  toggleExpand: (path: string, children?: FileTreeNode[]) => void;
  /** 展开目录 */
  expand: (path: string, children: FileTreeNode[]) => void;
  /** 收起目录 */
  collapse: (path: string) => void;
  /** 收起全部已展开的目录（保留子节点缓存，再次展开时可立即显示） */
  collapseAll: () => void;
  /**
   * 定时刷新结果批量回写：仅替换内容有变化的目录，并移除已被删除/改名的展开目录
   * @param root 发起刷新时的根路径（根已切换则丢弃结果）
   * @param fresh 目录 pathKey → 最新子节点
   * @param goneDirs 已不存在的展开目录 pathKey（连同其后代一起收起并清除缓存）
   */
  applyRefresh: (root: string, fresh: Map<string, FileTreeNode[]>, goneDirs: string[]) => void;
  /** 设置根路径（跨目录时清空一切） */
  setRoot: (root: string, rootChildren: FileTreeNode[]) => void;
  /** 定位到文件（高亮并可选择触发滚动） */
  setRevealed: (path: string | null, shouldScroll?: boolean) => void;
  /** 增量更新子节点（监听刷新用） */
  updateChildren: (path: string, children: FileTreeNode[]) => void;
  /** 加载更多：将 nextBatch 追加到 dirPath 对应的子节点末尾，newRemaining > 0 时在末尾补充加载更多占位节点 */
  appendChildren: (dirPath: string, nextBatch: FileTreeNode[], newRemaining: number) => void;
  /** 全量重扫（Flag::Rescan 降级） */
  rescan: (rootChildren: FileTreeNode[]) => void;
  /** 设置 loading */
  setLoading: (loading: boolean) => void;
  /** 清空 */
  clear: () => void;
}

export const useExplorerStore = create<ExplorerStore>((set, get) => ({
  root: null,
  expanded: new Map(),
  revealed: null,
  revealCount: 0,
  children: new Map(),
  loading: false,

  isExpanded: (path) => get().expanded.has(pathKey(path)),

  getChildren: (path) => get().children.get(pathKey(path)),

  toggleExpand: (path, children) => {
    const key = pathKey(path);
    set((state) => {
      const newExpanded = new Map(state.expanded);
      if (newExpanded.has(key)) {
        newExpanded.delete(key);
      } else if (children) {
        newExpanded.set(key, children);
      }
      return { expanded: newExpanded };
    });
  },

  expand: (path, children) => {
    const key = pathKey(path);
    set((state) => {
      const newExpanded = new Map(state.expanded);
      newExpanded.set(key, children);
      const newChildren = new Map(state.children);
      newChildren.set(key, children);
      return { expanded: newExpanded, children: newChildren };
    });
  },

  collapse: (path) => {
    const key = pathKey(path);
    set((state) => {
      const newExpanded = new Map(state.expanded);
      newExpanded.delete(key);
      return { expanded: newExpanded };
    });
  },

  collapseAll: () => {
    if (get().expanded.size === 0) return;
    set({ expanded: new Map() });
  },

  applyRefresh: (root, fresh, goneDirs) => {
    set((state) => {
      // 刷新期间根目录已切换：结果作废
      if (!state.root || pathKey(state.root) !== pathKey(root)) return {};

      let newChildren: Map<string, FileTreeNode[]> | null = null;
      for (const [key, nodes] of fresh) {
        const prev = state.children.get(key);
        const merged = mergeNodes(prev, nodes);
        // 内容完全一致时保持原数组引用，避免整棵树无谓重渲染
        if (merged === prev) continue;
        newChildren ??= new Map(state.children);
        newChildren.set(key, merged);
      }

      let newExpanded: Map<string, FileTreeNode[]> | null = null;
      if (goneDirs.length > 0) {
        newExpanded = new Map(state.expanded);
        newChildren ??= new Map(state.children);
        // 被删除或改名的目录：自身及所有后代一律收起并清除缓存
        for (const gone of goneDirs) {
          for (const key of [...newExpanded.keys()]) {
            if (isSubPath(gone, key)) newExpanded.delete(key);
          }
          for (const key of [...newChildren.keys()]) {
            if (isSubPath(gone, key)) newChildren.delete(key);
          }
        }
      }

      if (!newChildren && !newExpanded) return {};
      return {
        ...(newChildren ? { children: newChildren } : {}),
        ...(newExpanded ? { expanded: newExpanded } : {}),
      };
    });
  },

  setRoot: (root, rootChildren) => {
    const key = pathKey(root);
    set(() => {
      const newExpanded = new Map<string, FileTreeNode[]>();
      const newChildren = new Map<string, FileTreeNode[]>();
      newChildren.set(key, rootChildren);
      return {
        root,
        expanded: newExpanded,
        children: newChildren,
        revealed: null,
      };
    });
  },

  // 设置高亮项并选择是否累加定位计数器触发平滑滚动
  setRevealed: (path, shouldScroll = true) =>
    set((state) => ({
      revealed: path,
      revealCount: shouldScroll ? state.revealCount + 1 : state.revealCount,
    })),

  updateChildren: (path, children) => {
    const key = pathKey(path);
    set((state) => {
      const newChildren = new Map(state.children);
      newChildren.set(key, children);
      return { children: newChildren };
    });
  },

  appendChildren: (dirPath, nextBatch, newRemaining) => {
    const key = pathKey(dirPath);
    set((state) => {
      const current = state.children.get(key);
      if (!current) return {};
      // 过滤掉旧的溢出占位节点，追加新批次，按需添加新占位
      const realNodes = current.filter((n) => !n.path.startsWith('nb:overflow:'));
      const updated: FileTreeNode[] = [
        ...realNodes,
        ...nextBatch,
        ...(newRemaining > 0
          ? [
              {
                path: `nb:overflow:${newRemaining}:${dirPath}`,
                name: `加载更多（剩余 ${newRemaining} 个）`,
                isDir: false,
                kind: null,
                size: null,
                mtime: null,
                isHidden: false,
                isSymlink: false,
              } as FileTreeNode,
            ]
          : []),
      ];
      const newChildren = new Map(state.children);
      newChildren.set(key, updated);
      return { children: newChildren };
    });
  },

  rescan: (rootChildren) => {
    const root = get().root;
    if (!root) return;
    set(() => {
      // 全量重扫：清空所有缓存，只重新加载根
      const newChildren = new Map<string, FileTreeNode[]>();
      newChildren.set(pathKey(root), rootChildren);
      // 保留 expanded 但清空 children，按需重新加载
      return { children: newChildren };
    });
  },

  setLoading: (loading) => set({ loading }),

  clear: () =>
    set({
      root: null,
      expanded: new Map(),
      revealed: null,
      revealCount: 0,
      children: new Map(),
      loading: false,
    }),
}));

/** 判断两个节点内容是否一致 */
function sameNode(a: FileTreeNode, b: FileTreeNode): boolean {
  return (
    a.path === b.path &&
    a.name === b.name &&
    a.isDir === b.isDir &&
    a.kind === b.kind &&
    a.size === b.size &&
    a.mtime === b.mtime &&
    a.isHidden === b.isHidden &&
    a.isSymlink === b.isSymlink &&
    a.readonly === b.readonly
  );
}

/**
 * 合并新旧子节点列表：未变化的节点复用旧对象（memo 的 TreeNode 不会重渲染），
 * 整个列表都未变化时直接返回旧数组
 */
function mergeNodes(prev: FileTreeNode[] | undefined, next: FileTreeNode[]): FileTreeNode[] {
  if (!prev) return next;
  const prevByPath = new Map(prev.map((n) => [n.path, n]));
  let changed = prev.length !== next.length;
  const merged = next.map((n, i) => {
    const old = prevByPath.get(n.path);
    if (old && sameNode(old, n)) {
      if (prev[i] !== old) changed = true;
      return old;
    }
    changed = true;
    return n;
  });
  return changed ? merged : prev;
}

export { sameKey, isSubPath, normalizePath, getPathChain };
