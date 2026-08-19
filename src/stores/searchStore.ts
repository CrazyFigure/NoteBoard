// NoteBoard 搜索与替换状态管理
// 支持跨 Markdown（可视化/源码）与代码/纯文本编辑器的统一检索状态

import { create } from 'zustand';

export interface SearchState {
  /** 搜索栏是否打开 */
  isOpen: boolean;
  /** 搜索关键字 */
  searchText: string;
  /** 替换目标文本 */
  replaceText: string;
  /** 是否区分大小写 */
  caseSensitive: boolean;
  /** 是否全字匹配 */
  wholeWord: boolean;
  /** 是否正则表达式 */
  isRegex: boolean;
  /** 当前匹配项索引（1-based，0 表示无匹配） */
  matchIndex: number;
  /** 匹配项总数 */
  matchCount: number;
  /** 打开时应聚焦的输入框 */
  focusTarget: 'search' | 'replace' | null;

  // ── 操作 Actions ──
  openSearch: (initialText?: string, focusTarget?: 'search' | 'replace') => void;
  closeSearch: () => void;
  setSearchText: (text: string) => void;
  setReplaceText: (text: string) => void;
  setCaseSensitive: (val: boolean) => void;
  setWholeWord: (val: boolean) => void;
  setIsRegex: (val: boolean) => void;
  setMatchStats: (current: number, total: number) => void;
  setFocusTarget: (target: 'search' | 'replace' | null) => void;
}

export const useSearchStore = create<SearchState>((set) => ({
  isOpen: false,
  searchText: '',
  replaceText: '',
  caseSensitive: false,
  wholeWord: false,
  isRegex: false,
  matchIndex: 0,
  matchCount: 0,
  focusTarget: 'search',

  // 打开搜索栏，可传入初始搜索词与聚焦目标
  openSearch: (initialText, focusTarget = 'search') => {
    set((state) => ({
      isOpen: true,
      searchText: initialText !== undefined ? initialText : state.searchText,
      focusTarget,
    }));
  },

  // 关闭搜索栏
  closeSearch: () => {
    set({
      isOpen: false,
      focusTarget: null,
    });
  },

  // 设置搜索文本
  setSearchText: (text) => set({ searchText: text }),

  // 设置替换文本
  setReplaceText: (text) => set({ replaceText: text }),

  // 切换区分大小写
  setCaseSensitive: (val) => set({ caseSensitive: val }),

  // 切换全字匹配
  setWholeWord: (val) => set({ wholeWord: val }),

  // 切换正则表达式
  setIsRegex: (val) => set({ isRegex: val }),

  // 更新当前匹配数统计
  setMatchStats: (current, total) => set({ matchIndex: current, matchCount: total }),

  // 设置焦点目标
  setFocusTarget: (target) => set({ focusTarget: target }),
}));
