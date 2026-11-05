// NoteBoard 本地文件搜索：面板开关与上次查询（轻量模块，快捷键注册处静态引入，不含界面代码）

import { create } from 'zustand';
import { IS_NATIVE_MOBILE, IS_WEB } from '../../core/platform';
import { useLocalSearchSettings } from '../../stores/settingsStore';

/**
 * 桌面端搜索本机磁盘；网页端由服务器提供全局搜索（管理员开启，按用户权限限定范围）。
 * 移动端没有磁盘索引，不提供。
 */
export const SUPPORTS_LOCAL_SEARCH = !IS_NATIVE_MOBILE;

interface LocalSearchState {
  open: boolean;
  /** 上次输入的查询：重新打开面板时保留，便于继续查看结果 */
  query: string;
  /** 网页端：当前部署是否包含搜索服务 */
  webAvailable: boolean;
  /** 网页端：管理员是否已开启全局搜索 */
  webEnabled: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  setQuery: (query: string) => void;
  setWebState: (state: { available?: boolean; enabled?: boolean }) => void;
}

export const useLocalSearchStore = create<LocalSearchState>((set) => ({
  open: false,
  query: '',
  webAvailable: false,
  webEnabled: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
  setQuery: (query) => set({ query }),
  setWebState: ({ available, enabled }) => set((s) => ({
    webAvailable: available ?? s.webAvailable,
    webEnabled: enabled ?? s.webEnabled,
  })),
}));

/** 搜索是否已开启：桌面端看本机设置，网页端看服务器上管理员的开关 */
export function useLocalSearchEnabled(): boolean {
  const desktopEnabled = useLocalSearchSettings().enabled;
  const webEnabled = useLocalSearchStore((s) => s.webEnabled);
  return IS_WEB ? webEnabled : desktopEnabled;
}
