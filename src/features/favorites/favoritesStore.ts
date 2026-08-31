// NoteBoard 收藏夹全局状态管理 (Zustand)
// 负责前后端 IPC 数据同步、弹窗生命周期与增删改查动作

import { create } from 'zustand';
import type {
  FavoritesData,
  FavoriteNode,
  FavoriteFolderItem,
  FavoriteFileItem,
} from '../../core/ipc/types';
import * as ipc from '../../core/ipc/commands';
import {
  cloneRoots,
  findNodeById,
  findFolderById,
  findParentFolder,
  findFavoriteByPath,
  addNodeToFolder,
  removeNodeById,
  moveNode,
} from './favoritesUtils';
import { showToast } from '../../stores/toastStore';

export interface AddModalTarget {
  key?: string;
  displayName?: string;
  name?: string;
  path?: string;
}

interface FavoritesState {
  data: FavoritesData;
  loaded: boolean;
  activeFolderId: string;
  expandedFolderIds: string[];
  searchQuery: string;
  managerModalOpen: boolean;
  addModalState: {
    open: boolean;
    target: AddModalTarget | null;
    initialFolderId?: string;
  };

  // 数据加载与持久化
  loadFavorites: () => Promise<void>;
  saveFavoritesData: (nextData: FavoritesData) => Promise<void>;

  // 收藏与文件夹操作
  addFavorite: (folderId: string, name: string, path: string) => Promise<string>;
  removeFavorite: (id: string) => Promise<void>;
  createFolder: (parentId: string, name: string) => Promise<string>;
  renameFolder: (id: string, newName: string) => Promise<void>;
  renameFavorite: (id: string, newName: string) => Promise<void>;
  moveItem: (sourceId: string, targetFolderId: string, targetIndex?: number) => Promise<void>;

  // 辅助状态切换
  setActiveFolder: (folderId: string) => void;
  toggleFolderExpanded: (folderId: string) => void;
  setFolderExpanded: (folderId: string, expanded: boolean) => void;
  setSearchQuery: (query: string) => void;
  openFavoritesModal: (folderId?: string) => void;
  closeFavoritesModal: () => void;
  openAddModal: (target: AddModalTarget, initialFolderId?: string) => void;
  closeAddModal: () => void;
}

const DEFAULT_DATA: FavoritesData = {
  schemaVersion: 1,
  roots: [],
};

export const useFavoritesStore = create<FavoritesState>((set, get) => ({
  data: DEFAULT_DATA,
  loaded: false,
  activeFolderId: 'root',
  expandedFolderIds: [],
  searchQuery: '',
  managerModalOpen: false,
  addModalState: {
    open: false,
    target: null,
    initialFolderId: 'root',
  },

  /**
   * 从 Rust 后端读取持久化的 favorites.json
   */
  loadFavorites: async () => {
    try {
      const data = await ipc.loadFavorites();
      set({ data, loaded: true });
    } catch (error) {
      console.error('[favoritesStore] 读取收藏夹失败:', error);
      set({ loaded: true });
    }
  },

  /**
   * 内部保存方法，更新内存状态并异步落盘
   */
  saveFavoritesData: async (nextData: FavoritesData) => {
    set({ data: nextData });
    try {
      await ipc.saveFavorites(nextData);
    } catch (error) {
      console.error('[favoritesStore] 保存收藏夹失败:', error);
      showToast('收藏夹保存失败', 'error');
    }
  },

  /**
   * 添加一个文件到指定文件夹（若已存在则更新所在文件夹和名称）
   */
  addFavorite: async (folderId: string, name: string, path: string) => {
    const { data, saveFavoritesData } = get();
    const existing = findFavoriteByPath(data.roots, path);

    const now = Date.now();
    let nextRoots: FavoriteNode[];

    if (existing) {
      // 若原先已收藏，先从旧位置移除
      const { newRoots } = removeNodeById(data.roots, existing.id);
      const updatedItem: FavoriteFileItem = {
        ...existing,
        name: name.trim() || existing.name,
      };
      nextRoots = addNodeToFolder(newRoots, folderId, updatedItem);
    } else {
      const newItem: FavoriteFileItem = {
        id: `fav_${now}_${Math.random().toString(36).slice(2, 7)}`,
        type: 'file',
        name: name.trim() || path.split(/[\\/]/).pop() || '未命名',
        path,
        createdAt: now,
      };
      nextRoots = addNodeToFolder(data.roots, folderId, newItem);
    }

    await saveFavoritesData({ ...data, roots: nextRoots });
    return existing ? existing.id : '';
  },

  /**
   * 移除收藏项或文件夹
   */
  removeFavorite: async (id: string) => {
    const { data, saveFavoritesData, activeFolderId } = get();
    const { newRoots, removedNode } = removeNodeById(data.roots, id);
    if (!removedNode) return;

    // 若删除的正好是当前选中的文件夹，重置选中到 root
    let nextActiveId = activeFolderId;
    if (activeFolderId === id) {
      nextActiveId = 'root';
    }

    set({ activeFolderId: nextActiveId });
    await saveFavoritesData({ ...data, roots: newRoots });
  },

  /**
   * 在指定父目录下创建新的子文件夹
   */
  createFolder: async (parentId: string, name: string) => {
    const { data, saveFavoritesData, expandedFolderIds } = get();
    const now = Date.now();
    const newFolder: FavoriteFolderItem = {
      id: `folder_${now}_${Math.random().toString(36).slice(2, 7)}`,
      type: 'folder',
      name: name.trim() || '新建文件夹',
      createdAt: now,
      children: [],
    };

    const nextRoots = addNodeToFolder(data.roots, parentId, newFolder);
    // 自动展开父文件夹（非 root）
    const nextExpanded = parentId && parentId !== 'root'
      ? Array.from(new Set([...expandedFolderIds, parentId]))
      : expandedFolderIds;

    set({ expandedFolderIds: nextExpanded });
    await saveFavoritesData({ ...data, roots: nextRoots });
    return newFolder.id;
  },

  /**
   * 重命名文件夹
   */
  renameFolder: async (id: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const { data, saveFavoritesData } = get();
    const newRoots = cloneRoots(data.roots);
    const folder = findFolderById(newRoots, id);
    if (!folder) return;

    folder.name = trimmed;
    await saveFavoritesData({ ...data, roots: nextRootsSafe(newRoots) });
  },

  /**
   * 重命名文件收藏项
   */
  renameFavorite: async (id: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const { data, saveFavoritesData } = get();
    const newRoots = cloneRoots(data.roots);
    const node = findNodeById(newRoots, id);
    if (!node || node.type !== 'file') return;

    node.name = trimmed;
    await saveFavoritesData({ ...data, roots: nextRootsSafe(newRoots) });
  },

  /**
   * 移动节点（文件或文件夹）到目标文件夹或目标索引位置
   */
  moveItem: async (sourceId: string, targetFolderId: string, targetIndex?: number) => {
    const { data, saveFavoritesData } = get();
    const nextRoots = moveNode(data.roots, sourceId, targetFolderId, targetIndex);
    await saveFavoritesData({ ...data, roots: nextRoots });
  },

  setActiveFolder: (folderId: string) => {
    set({ activeFolderId: folderId });
  },

  toggleFolderExpanded: (folderId: string) => {
    set((state) => {
      const isExpanded = state.expandedFolderIds.includes(folderId);
      const next = isExpanded
        ? state.expandedFolderIds.filter((id) => id !== folderId)
        : [...state.expandedFolderIds, folderId];
      return { expandedFolderIds: next };
    });
  },

  setFolderExpanded: (folderId: string, expanded: boolean) => {
    set((state) => {
      const isExpanded = state.expandedFolderIds.includes(folderId);
      if (expanded && !isExpanded) {
        return { expandedFolderIds: [...state.expandedFolderIds, folderId] };
      }
      if (!expanded && isExpanded) {
        return { expandedFolderIds: state.expandedFolderIds.filter((id) => id !== folderId) };
      }
      return state;
    });
  },

  setSearchQuery: (query: string) => {
    set({ searchQuery: query });
  },

  openFavoritesModal: (folderId?: string) => {
    set({
      managerModalOpen: true,
      activeFolderId: folderId || 'root',
      searchQuery: '',
    });
  },

  closeFavoritesModal: () => {
    set({ managerModalOpen: false, searchQuery: '' });
  },

  openAddModal: (target: AddModalTarget, initialFolderId?: string) => {
    const { data } = get();
    const existing = target.path ? findFavoriteByPath(data.roots, target.path) : null;
    let folder = initialFolderId || 'root';
    if (existing) {
      const parent = findParentFolder(data.roots, existing.id);
      folder = parent ? parent.id : 'root';
    }
    set({
      addModalState: {
        open: true,
        target,
        initialFolderId: folder,
      },
    });
  },

  closeAddModal: () => {
    set({
      addModalState: {
        open: false,
        target: null,
      },
    });
  },
}));

function nextRootsSafe(roots: FavoriteNode[]): FavoriteNode[] {
  return roots;
}
