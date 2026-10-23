// NoteBoard 文档历史记录：界面状态
// 每窗口一份：当前查看的文档、版本列表、选中版本与「显示更改」开关。
// 本模块只依赖 IPC 封装，查看界面本身按需懒加载，不进入首屏。

import { create } from 'zustand';
import * as ipc from '../../core/ipc/commands';
import type { HistoryConfigView, HistoryEntry } from '../../core/ipc/types';
import { useWindowStore } from '../../stores/windowStore';
import { useLayoutStore } from '../../stores/layoutStore';
import { showToast } from '../../stores/toastStore';

export type VersionHistoryStatus = 'idle' | 'loading' | 'ready' | 'error';

interface VersionHistoryState {
  open: boolean;
  docKey: string | null;
  path: string | null;
  displayName: string;
  kind: string;
  config: HistoryConfigView | null;
  entries: HistoryEntry[];
  status: VersionHistoryStatus;
  error: string | null;
  selectedId: string | null;
  showChanges: boolean;
  /** 打开指定标签的历史记录 */
  openFor: (docKey: string) => Promise<void>;
  close: () => void;
  refresh: () => Promise<void>;
  select: (id: string) => void;
  setShowChanges: (value: boolean) => void;
}

export const useVersionHistoryStore = create<VersionHistoryState>((set, get) => ({
  open: false,
  docKey: null,
  path: null,
  displayName: '',
  kind: 'code',
  config: null,
  entries: [],
  status: 'idle',
  error: null,
  selectedId: null,
  showChanges: true,
  openFor: async (docKey) => {
    const tab = useWindowStore.getState().getTab(docKey);
    if (!tab || tab.toolKind) return;
    set({
      open: true,
      docKey,
      path: tab.path,
      displayName: tab.displayName,
      kind: tab.kind,
      entries: [],
      selectedId: null,
      status: 'loading',
      error: null,
    });
    await get().refresh();
  },
  close: () => set({ open: false, entries: [], selectedId: null, status: 'idle', error: null }),
  refresh: async () => {
    const { path, docKey } = get();
    try {
      const config = await ipc.historyGetConfig();
      if (get().docKey !== docKey) return;
      if (!path || config.mode === 'off') {
        set({ config, entries: [], status: 'ready' });
        return;
      }
      const list = await ipc.historyList(path);
      // 等待期间切换了文档：丢弃旧结果
      if (get().docKey !== docKey) return;
      const selected = get().selectedId;
      const keep = selected && list.entries.some((e) => e.id === selected);
      set({
        config,
        entries: list.entries,
        status: 'ready',
        error: null,
        selectedId: keep ? selected : (list.entries[0]?.id ?? null),
      });
    } catch (error) {
      if (get().docKey !== docKey) return;
      set({ status: 'error', error: error instanceof Error ? error.message : String(error) });
    }
  },
  select: (id) => set({ selectedId: id }),
  setShowChanges: (value) => set({ showChanges: value }),
}));

/** 打开当前活动标签的历史记录（工具栏、标签菜单与快捷键共用） */
export function openVersionHistory(docKey?: string | null): void {
  const key = docKey ?? useWindowStore.getState().activeKey;
  if (!key) return;
  const tab = useWindowStore.getState().getTab(key);
  if (!tab || tab.toolKind) return;
  if (tab.kind === 'image' || tab.kind === 'preview' || tab.kind === 'unsupported') {
    showToast('此格式不记录历史版本', 'info');
    return;
  }
  // 切到对应标签再打开，保证返回文档时停在同一处
  if (useWindowStore.getState().activeKey !== key) useWindowStore.getState().activateTab(key);
  void useVersionHistoryStore.getState().openFor(key);
}

/** 打开设置并定位到「历史记录」栏目 */
export function openHistorySettings(): void {
  useLayoutStore.setState({ settingsTarget: 'history', settingsModalVisible: true });
}
