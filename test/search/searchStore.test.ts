// NoteBoard searchStore 状态管理测试

import { describe, test, expect, beforeEach } from 'vitest';
import { useSearchStore } from '@/stores/searchStore';

describe('searchStore 搜索替换状态管理', () => {
  beforeEach(() => {
    // 重置状态
    useSearchStore.setState({
      isOpen: false,
      searchText: '',
      replaceText: '',
      caseSensitive: false,
      wholeWord: false,
      isRegex: false,
      matchIndex: 0,
      matchCount: 0,
      focusTarget: 'search',
    });
  });

  test('初始状态默认关闭且字段为空', () => {
    const state = useSearchStore.getState();
    expect(state.isOpen).toBe(false);
    expect(state.searchText).toBe('');
    expect(state.replaceText).toBe('');
    expect(state.caseSensitive).toBe(false);
    expect(state.wholeWord).toBe(false);
    expect(state.isRegex).toBe(false);
    expect(state.matchIndex).toBe(0);
    expect(state.matchCount).toBe(0);
  });

  test('openSearch 打开搜索并可设置初始搜索词与聚焦目标', () => {
    const { openSearch } = useSearchStore.getState();
    openSearch('hello', 'replace');

    const state = useSearchStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.searchText).toBe('hello');
    expect(state.focusTarget).toBe('replace');
  });

  test('搜索栏已打开时再次 openSearch 仍会发出新的聚焦请求', () => {
    const { openSearch } = useSearchStore.getState();
    openSearch(undefined, 'search');
    const first = useSearchStore.getState().focusRequest;
    // 点回编辑区后再按 Ctrl+F：其余字段不变，只有聚焦请求序号变化
    openSearch(undefined, 'search');
    expect(useSearchStore.getState().focusRequest).toBe(first + 1);
    openSearch(undefined, 'replace');
    expect(useSearchStore.getState().focusRequest).toBe(first + 2);
  });

  test('closeSearch 关闭搜索并清理焦点目标', () => {
    const { openSearch, closeSearch } = useSearchStore.getState();
    openSearch('test');
    expect(useSearchStore.getState().isOpen).toBe(true);

    closeSearch();
    expect(useSearchStore.getState().isOpen).toBe(false);
    expect(useSearchStore.getState().focusTarget).toBeNull();
  });

  test('设置搜索与替换选项状态', () => {
    const store = useSearchStore.getState();
    store.setSearchText('new query');
    store.setReplaceText('replacement');
    store.setCaseSensitive(true);
    store.setWholeWord(true);
    store.setIsRegex(true);
    store.setMatchStats(2, 5);

    const updated = useSearchStore.getState();
    expect(updated.searchText).toBe('new query');
    expect(updated.replaceText).toBe('replacement');
    expect(updated.caseSensitive).toBe(true);
    expect(updated.wholeWord).toBe(true);
    expect(updated.isRegex).toBe(true);
    expect(updated.matchIndex).toBe(2);
    expect(updated.matchCount).toBe(5);
  });
});
