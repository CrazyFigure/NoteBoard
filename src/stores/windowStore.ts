// NoteBoard windowStore
// tab 列表 + 激活 tab（每窗口一份，纯 UI 状态）
// 详见 docs/05-ADR/ADR-010-状态管理与跨窗口同步.md §2

import { create } from 'zustand';

export interface Tab {
  /** 唯一 ID（用文件路径规范化 key） */
  key: string;
  /** 显示名（文件名含扩展名） */
  displayName: string;
  /** 文档路径，null 表示未命名 */
  path: string | null;
  /** 文档类型 */
  kind: 'markdown' | 'code' | 'board' | 'unsupported';
  /** 语言 ID */
  language: string;
  /** 是否脏（有未保存修改） */
  isDirty: boolean;
  /** 是否预览态（单击树节点打开时为 true） */
  isPreview: boolean;
  /** 视图模式（Markdown 用） */
  viewMode: 'visual' | 'source' | null;
  /** 外部变更状态 */
  externalStatus: 'clean' | 'modified' | 'deleted' | 'renamed' | null;
  /** 文件已断开（被删除） */
  isDetached: boolean;
}

interface WindowStore {
  tabs: Tab[];
  activeKey: string | null;

  // ── 查询 ──
  activeTab: () => Tab | null;
  getTab: (key: string) => Tab | null;

  // ── 操作 ──
  openTab: (tab: Tab) => void;
  closeTab: (key: string) => void;
  closeOtherTabs: (key: string) => void;
  closeTabsRight: (key: string) => void;
  activateTab: (key: string) => void;
  setTabDirty: (key: string, isDirty: boolean) => void;
  setTabPreview: (key: string, isPreview: boolean) => void;
  setTabViewMode: (key: string, mode: 'visual' | 'source') => void;
  setTabExternalStatus: (key: string, status: Tab['externalStatus']) => void;
  setTabDetached: (key: string, isDetached: boolean) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  updateTabPath: (key: string, newPath: string, newDisplayName: string) => void;
  /** 窗口级关闭：批量请求关闭多个 tab */
  requestCloseBatch: (keys: string[]) => void;
  /** 窗口级关闭的 pending keys */
  pendingCloseKeys: string[];
  /** 清除 pendingCloseKeys */
  clearPendingClose: () => void;
  /** 标记关闭完成后真正关 tab */
  confirmCloseBatch: (keys: string[]) => void;
}

export const useWindowStore = create<WindowStore>((set, get) => ({
  tabs: [],
  activeKey: null,
  pendingCloseKeys: [],

  activeTab: () => {
    const { tabs, activeKey } = get();
    return tabs.find((t) => t.key === activeKey) ?? null;
  },

  getTab: (key) => {
    return get().tabs.find((t) => t.key === key) ?? null;
  },

  openTab: (tab) => {
    set((state) => {
      const existing = state.tabs.find((t) => t.key === tab.key);
      if (existing) {
        // 已存在，激活即可
        return { activeKey: tab.key };
      }
      return { tabs: [...state.tabs, tab], activeKey: tab.key };
    });
  },

  closeTab: (key) => {
    set((state) => {
      const idx = state.tabs.findIndex((t) => t.key === key);
      if (idx < 0) return {};
      const newTabs = state.tabs.filter((t) => t.key !== key);
      let newActive = state.activeKey;
      if (state.activeKey === key) {
        // 激活相邻 tab
        newActive = newTabs[Math.min(idx, newTabs.length - 1)]?.key ?? null;
      }
      return { tabs: newTabs, activeKey: newActive };
    });
  },

  closeOtherTabs: (key) => {
    set((state) => ({
      tabs: state.tabs.filter((t) => t.key === key),
      activeKey: key,
    }));
  },

  closeTabsRight: (key) => {
    set((state) => {
      const idx = state.tabs.findIndex((t) => t.key === key);
      if (idx < 0) return {};
      return { tabs: state.tabs.slice(0, idx + 1) };
    });
  },

  activateTab: (key) => {
    set({ activeKey: key });
  },

  setTabDirty: (key, isDirty) => {
    set((state) => ({
      tabs: state.tabs.map((t) => (t.key === key ? { ...t, isDirty } : t)),
    }));
  },

  setTabPreview: (key, isPreview) => {
    set((state) => ({
      tabs: state.tabs.map((t) => (t.key === key ? { ...t, isPreview } : t)),
    }));
  },

  setTabViewMode: (key, mode) => {
    set((state) => ({
      tabs: state.tabs.map((t) => (t.key === key ? { ...t, viewMode: mode } : t)),
    }));
  },

  setTabExternalStatus: (key, status) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.key === key ? { ...t, externalStatus: status } : t,
      ),
    }));
  },

  setTabDetached: (key, isDetached) => {
    set((state) => ({
      tabs: state.tabs.map((t) => (t.key === key ? { ...t, isDetached } : t)),
    }));
  },

  reorderTabs: (fromIndex, toIndex) => {
    set((state) => {
      const newTabs = [...state.tabs];
      const [moved] = newTabs.splice(fromIndex, 1);
      if (!moved) return {};
      newTabs.splice(toIndex, 0, moved);
      return { tabs: newTabs };
    });
  },

  updateTabPath: (key, newPath, newDisplayName) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.key === key
          ? { ...t, path: newPath, displayName: newDisplayName, key: newPath }
          : t,
      ),
      activeKey: state.activeKey === key ? newPath : state.activeKey,
    }));
  },

  requestCloseBatch: (keys) => {
    set({ pendingCloseKeys: keys });
  },

  clearPendingClose: () => {
    set({ pendingCloseKeys: [] });
  },

  confirmCloseBatch: (keys) => {
    set((state) => {
      const newTabs = state.tabs.filter((t) => !keys.includes(t.key));
      let newActive = state.activeKey;
      if (state.activeKey && keys.includes(state.activeKey)) {
        newActive = newTabs[0]?.key ?? null;
      }
      return { tabs: newTabs, activeKey: newActive, pendingCloseKeys: [] };
    });
  },
}));
