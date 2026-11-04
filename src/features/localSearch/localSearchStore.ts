// NoteBoard 本地文件搜索：面板开关与上次查询（轻量模块，快捷键注册处静态引入，不含界面代码）

import { create } from 'zustand';
import { IS_NATIVE_MOBILE, IS_WEB } from '../../core/platform';

/** 本地文件搜索仅桌面端提供（网页端与移动端没有本机磁盘索引） */
export const SUPPORTS_LOCAL_SEARCH = !IS_WEB && !IS_NATIVE_MOBILE;

interface LocalSearchState {
  open: boolean;
  /** 上次输入的查询：重新打开面板时保留，便于继续查看结果 */
  query: string;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  setQuery: (query: string) => void;
}

export const useLocalSearchStore = create<LocalSearchState>((set) => ({
  open: false,
  query: '',
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
  setQuery: (query) => set({ query }),
}));
