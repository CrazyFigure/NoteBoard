// NoteBoard 资源管理器 Store
// 单根纯跟随目录树 + 展开状态 + 监听
// 详见 docs/05-ADR/ADR-007-资源管理器语义.md
// 详见 docs/07-UI布局与交互规范.md §5

import { create } from 'zustand';
import type { FileTreeNode } from '../../core/ipc/types';

interface ExplorerStore {
  /** 当前根路径（null = 未打开任何目录） */
  root: string | null;
  /** 展开的目录集合（路径 → 子节点） */
  expanded: Map<string, FileTreeNode[]>;
  /** 当前定位的文件路径（高亮） */
  revealed: string | null;
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
  /** 设置根路径（跨目录时清空一切） */
  setRoot: (root: string, rootChildren: FileTreeNode[]) => void;
  /** 定位到文件（高亮） */
  setRevealed: (path: string) => void;
  /** 增量更新子节点（监听刷新用） */
  updateChildren: (path: string, children: FileTreeNode[]) => void;
  /** 全量重扫（Flag::Rescan 降级） */
  rescan: (rootChildren: FileTreeNode[]) => void;
  /** 设置 loading */
  setLoading: (loading: boolean) => void;
  /** 清空 */
  clear: () => void;
}

/** 路径规范化比较（大小写不敏感，统一反斜杠并去除末尾斜杠） */
function sameKey(a: string | null, b: string | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  const normA = a.replace(/[/\\]+/g, '\\').replace(/\\+$/, '').toLowerCase();
  const normB = b.replace(/[/\\]+/g, '\\').replace(/\\+$/, '').toLowerCase();
  return normA === normB;
}

export const useExplorerStore = create<ExplorerStore>((set, get) => ({
  root: null,
  expanded: new Map(),
  revealed: null,
  children: new Map(),
  loading: false,

  isExpanded: (path) => get().expanded.has(path.toLowerCase()),

  getChildren: (path) => get().children.get(path.toLowerCase()),

  toggleExpand: (path, children) => {
    const key = path.toLowerCase();
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
    const key = path.toLowerCase();
    set((state) => {
      const newExpanded = new Map(state.expanded);
      newExpanded.set(key, children);
      const newChildren = new Map(state.children);
      newChildren.set(key, children);
      return { expanded: newExpanded, children: newChildren };
    });
  },

  collapse: (path) => {
    const key = path.toLowerCase();
    set((state) => {
      const newExpanded = new Map(state.expanded);
      newExpanded.delete(key);
      return { expanded: newExpanded };
    });
  },

  setRoot: (root, rootChildren) => {
    const key = root.toLowerCase();
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

  setRevealed: (path) => set({ revealed: path }),

  updateChildren: (path, children) => {
    const key = path.toLowerCase();
    set((state) => {
      const newChildren = new Map(state.children);
      newChildren.set(key, children);
      return { children: newChildren };
    });
  },

  rescan: (rootChildren) => {
    const root = get().root;
    if (!root) return;
    set((state) => {
      // 全量重扫：清空所有缓存，只重新加载根
      const newChildren = new Map<string, FileTreeNode[]>();
      newChildren.set(root.toLowerCase(), rootChildren);
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
      children: new Map(),
      loading: false,
    }),
}));

export { sameKey };
