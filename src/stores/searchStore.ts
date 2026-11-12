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
  /**
   * 聚焦请求序号：每次 openSearch 自增。
   * 搜索栏已打开且聚焦目标不变时（如点回编辑区后再按 Ctrl+F），其余字段可能完全不变，
   * 搜索栏据此序号重新聚焦输入框。
   */
  focusRequest: number;

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

/**
 * 创建一份独立的搜索状态（文本对比左右两侧等需要各自搜索栏的视图使用）。
 * 全局搜索栏使用下方的 useSearchStore 单例。
 */
export function createSearchStore() {
  return create<SearchState>((set) => ({
    isOpen: false,
    searchText: '',
    replaceText: '',
    caseSensitive: false,
    wholeWord: false,
    isRegex: false,
    matchIndex: 0,
    matchCount: 0,
    focusTarget: 'search',
    focusRequest: 0,

    // 打开搜索栏，可传入初始搜索词与聚焦目标；已打开时也会请求重新聚焦输入框
    openSearch: (initialText, focusTarget = 'search') => {
      set((state) => ({
        isOpen: true,
        searchText: initialText !== undefined ? initialText : state.searchText,
        focusTarget,
        focusRequest: state.focusRequest + 1,
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
}

/** 搜索状态 Hook 类型（全局单例与 createSearchStore 创建的实例通用） */
export type SearchStoreHook = ReturnType<typeof createSearchStore>;

/** 全局搜索状态（主编辑区悬浮搜索栏） */
export const useSearchStore = createSearchStore();
