// NoteBoard 统一搜索替换控制器
// 屏蔽底层差异，统一对接 CodeMirror 6 与 TipTap（Markdown）编辑器

import type { Editor } from '@tiptap/core';
import { EditorView } from '@codemirror/view';
import {
  SearchQuery,
  setSearchQuery,
  findNext as cmFindNext,
  findPrevious as cmFindPrevious,
  replaceNext as cmReplaceNext,
  replaceAll as cmReplaceAll,
  openSearchPanel,
  closeSearchPanel,
  searchPanelOpen,
} from '@codemirror/search';

export interface SearchOptions {
  searchText: string;
  replaceText: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  isRegex: boolean;
}

export interface ReplaceResult {
  success: boolean;
  replacedCount: number;
  matchIndex: number;
  matchCount: number;
  error?: string;
}

export interface SearchAndReplaceStorage {
  searchTerm: string;
  replaceTerm: string;
  results: { from: number; to: number }[];
  lastSearchTerm: string;
  caseSensitive: boolean;
  lastCaseSensitive: boolean;
  resultIndex: number;
  lastResultIndex: number;
}

export type EditorTarget =
  | { type: 'tiptap'; editor: Editor }
  | { type: 'codemirror'; view: EditorView }
  | null;

/** 获取 TipTap 搜索插件存储数据 */
function getSearchStorage(editor: Editor): SearchAndReplaceStorage | undefined {
  return (editor.storage as Record<string, any>)?.searchAndReplace;
}

/** 转义正则特殊字符 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 构建用于 TipTap / 正则匹配的表达式字符串 */
function buildRegexPattern(text: string, wholeWord: boolean, isRegex: boolean): string {
  if (!text) return '';
  const pattern = isRegex ? text : escapeRegExp(text);
  return wholeWord ? `\\b(?:${pattern})\\b` : pattern;
}

/** 执行搜索更新，返回当前匹配索引与总数 */
export function executeSearch(
  target: EditorTarget,
  options: SearchOptions,
): { matchIndex: number; matchCount: number } {
  if (!target) return { matchIndex: 0, matchCount: 0 };
  const { searchText, replaceText, caseSensitive, wholeWord, isRegex } = options;

  if (target.type === 'codemirror') {
    const { view } = target;
    if (!searchText) {
      if (searchPanelOpen(view.state)) {
        closeSearchPanel(view);
      }
      // 清空搜索状态并折叠选区，避免残留关联高亮
      view.dispatch({
        effects: setSearchQuery.of(new SearchQuery({ search: '', literal: true })),
        selection: view.state.selection.main.empty
          ? undefined
          : { anchor: view.state.selection.main.from },
      });
      return { matchIndex: 0, matchCount: 0 };
    }

    try {
      // 当非正则表达式搜索时开启 literal: true，防止 CodeMirror 对 \\ 进行 unquote 导致匹配异常
      const query = new SearchQuery({
        search: searchText,
        replace: replaceText,
        caseSensitive,
        literal: !isRegex,
        regexp: isRegex,
        wholeWord,
      });

      // 确保 CodeMirror 搜索高亮插件激活
      if (!searchPanelOpen(view.state)) {
        openSearchPanel(view);
      }

      view.dispatch({
        effects: setSearchQuery.of(query),
      });

      let count = 0;
      let current = 0;
      let firstMatch: { from: number; to: number } | null = null;
      const cursor = query.getCursor(view.state.doc);
      let iter = cursor.next();
      const selFrom = view.state.selection.main.from;
      const selTo = view.state.selection.main.to;

      while (!iter.done) {
        count++;
        if (!firstMatch) {
          firstMatch = { from: iter.value.from, to: iter.value.to };
        }
        if (iter.value.from === selFrom && iter.value.to === selTo) {
          current = count;
        }
        iter = cursor.next();
      }

      // 如果没有匹配项，若当前存在非空选区，将其折叠为单光标，解除 highlightSelectionMatches 的全篇匹配高亮
      if (count === 0) {
        if (!view.state.selection.main.empty) {
          view.dispatch({
            selection: { anchor: view.state.selection.main.from },
            userEvent: 'select.search',
          });
        }
        return { matchIndex: 0, matchCount: 0 };
      }

      // 如果当前选区未完全覆盖任何匹配项且存在匹配项，默认选中首个匹配项并滚动居中
      if (count > 0 && current === 0 && firstMatch) {
        current = 1;
        view.dispatch({
          selection: { anchor: firstMatch.from, head: firstMatch.to },
          effects: [EditorView.scrollIntoView(firstMatch.from, { y: 'center' })],
          userEvent: 'select.search',
        });
      }

      return { matchIndex: current > 0 ? current : count > 0 ? 1 : 0, matchCount: count };
    } catch {
      return { matchIndex: 0, matchCount: 0 };
    }
  } else if (target.type === 'tiptap') {
    const { editor } = target;
    if (!searchText) {
      editor.commands.setSearchTerm('');
      editor.commands.resetIndex();
      // 派发事务，强制 ProseMirror 插件执行 apply 以清除旧的高亮装饰
      editor.view.dispatch(editor.state.tr);
      if (!editor.state.selection.empty) {
        editor.commands.setTextSelection(editor.state.selection.from);
      }
      return { matchIndex: 0, matchCount: 0 };
    }

    try {
      const pattern = buildRegexPattern(searchText, wholeWord, isRegex);
      editor.commands.setCaseSensitive(caseSensitive);
      editor.commands.setReplaceTerm(replaceText);
      editor.commands.setSearchTerm(pattern);
      // 派发事务，强制 ProseMirror 插件立即更新计算 results 与高亮 DecorationSet
      editor.view.dispatch(editor.state.tr);

      const storage = getSearchStorage(editor);
      const count = storage?.results?.length ?? 0;
      const index = count > 0 ? (storage?.resultIndex ?? 0) + 1 : 0;

      // 滚动至当前匹配项
      if (count > 0 && storage?.results?.[storage.resultIndex]) {
        const item = storage.results[storage.resultIndex];
        editor.commands.setTextSelection({ from: item.from, to: item.to });
        editor.commands.scrollIntoView();
      } else if (count === 0 && !editor.state.selection.empty) {
        // 无匹配项时折叠选区，避免保留旧选区背景
        editor.commands.setTextSelection(editor.state.selection.from);
      }

      return { matchIndex: index, matchCount: count };
    } catch {
      return { matchIndex: 0, matchCount: 0 };
    }
  }

  return { matchIndex: 0, matchCount: 0 };
}

/** 查找下一个匹配项 */
export function executeFindNext(
  target: EditorTarget,
  options: SearchOptions,
): { matchIndex: number; matchCount: number } {
  if (!target || !options.searchText) return { matchIndex: 0, matchCount: 0 };

  if (target.type === 'codemirror') {
    const { view } = target;
    if (!searchPanelOpen(view.state)) {
      openSearchPanel(view);
    }
    cmFindNext(view);
    return executeSearch(target, options);
  } else if (target.type === 'tiptap') {
    const { editor } = target;
    const storage = getSearchStorage(editor);
    const results = storage?.results ?? [];
    if (results.length > 0 && storage) {
      const nextIndex = (storage.resultIndex + 1) % results.length;
      storage.resultIndex = nextIndex;
      const targetItem = results[nextIndex];
      if (targetItem) {
        editor.commands.setTextSelection({ from: targetItem.from, to: targetItem.to });
        editor.commands.scrollIntoView();
      }
      return { matchIndex: nextIndex + 1, matchCount: results.length };
    }
  }

  return { matchIndex: 0, matchCount: 0 };
}

/** 查找上一个匹配项 */
export function executeFindPrev(
  target: EditorTarget,
  options: SearchOptions,
): { matchIndex: number; matchCount: number } {
  if (!target || !options.searchText) return { matchIndex: 0, matchCount: 0 };

  if (target.type === 'codemirror') {
    const { view } = target;
    if (!searchPanelOpen(view.state)) {
      openSearchPanel(view);
    }
    cmFindPrevious(view);
    return executeSearch(target, options);
  } else if (target.type === 'tiptap') {
    const { editor } = target;
    const storage = getSearchStorage(editor);
    const results = storage?.results ?? [];
    if (results.length > 0 && storage) {
      const prevIndex = (storage.resultIndex - 1 + results.length) % results.length;
      storage.resultIndex = prevIndex;
      const targetItem = results[prevIndex];
      if (targetItem) {
        editor.commands.setTextSelection({ from: targetItem.from, to: targetItem.to });
        editor.commands.scrollIntoView();
      }
      return { matchIndex: prevIndex + 1, matchCount: results.length };
    }
  }

  return { matchIndex: 0, matchCount: 0 };
}

/** 替换当前匹配项并跳到下一个 */
export function executeReplace(
  target: EditorTarget,
  options: SearchOptions,
): ReplaceResult {
  if (!target || !options.searchText) return { success: false, replacedCount: 0, matchIndex: 0, matchCount: 0 };
  const { searchText, wholeWord, isRegex } = options;

  // 校验正则表达式合法性
  if (isRegex) {
    try {
      const pattern = buildRegexPattern(searchText, wholeWord, isRegex);
      new RegExp(pattern);
    } catch {
      return {
        success: false,
        replacedCount: 0,
        matchIndex: 0,
        matchCount: 0,
        error: '正则表达式格式错误',
      };
    }
  }

  if (target.type === 'codemirror') {
    const { view } = target;
    // 确保 SearchQuery 最新状态已应用至编辑器并获取匹配数
    const statsBefore = executeSearch(target, options);
    if (statsBefore.matchCount === 0) {
      return { success: false, replacedCount: 0, matchIndex: 0, matchCount: 0 };
    }
    // 执行单处替换
    cmReplaceNext(view);
    const statsAfter = executeSearch(target, options);
    return {
      success: true,
      replacedCount: 1,
      matchIndex: statsAfter.matchIndex,
      matchCount: statsAfter.matchCount,
    };
  } else if (target.type === 'tiptap') {
    const { editor } = target;
    // 确保 TipTap 搜索状态为最新
    const statsBefore = executeSearch(target, options);
    if (statsBefore.matchCount === 0) {
      return { success: false, replacedCount: 0, matchIndex: 0, matchCount: 0 };
    }
    const storage = getSearchStorage(editor);
    const results = storage?.results ?? [];
    const idx = storage?.resultIndex ?? 0;
    const current = results[idx] || results[0];
    if (current) {
      // 替换当前选中的匹配片段
      editor.chain().focus().insertContentAt({ from: current.from, to: current.to }, options.replaceText).run();
      const statsAfter = executeSearch(target, options);
      return {
        success: true,
        replacedCount: 1,
        matchIndex: statsAfter.matchIndex,
        matchCount: statsAfter.matchCount,
      };
    }
  }

  return { success: false, replacedCount: 0, matchIndex: 0, matchCount: 0 };
}

/** 替换全部匹配项 */
export function executeReplaceAll(
  target: EditorTarget,
  options: SearchOptions,
): ReplaceResult {
  if (!target || !options.searchText) return { success: false, replacedCount: 0, matchIndex: 0, matchCount: 0 };
  const { searchText, wholeWord, isRegex } = options;

  // 校验正则表达式合法性
  if (isRegex) {
    try {
      const pattern = buildRegexPattern(searchText, wholeWord, isRegex);
      new RegExp(pattern);
    } catch {
      return {
        success: false,
        replacedCount: 0,
        matchIndex: 0,
        matchCount: 0,
        error: '正则表达式格式错误',
      };
    }
  }

  if (target.type === 'codemirror') {
    const { view } = target;
    // 确保 SearchQuery 最新状态已应用至编辑器并计算待替换总数
    const statsBefore = executeSearch(target, options);
    if (statsBefore.matchCount === 0) {
      return { success: false, replacedCount: 0, matchIndex: 0, matchCount: 0 };
    }
    const countToReplace = statsBefore.matchCount;
    // 执行全部替换
    cmReplaceAll(view);
    const statsAfter = executeSearch(target, options);
    return {
      success: true,
      replacedCount: countToReplace,
      matchIndex: statsAfter.matchIndex,
      matchCount: statsAfter.matchCount,
    };
  } else if (target.type === 'tiptap') {
    const { editor } = target;
    // 确保 TipTap 搜索状态为最新
    executeSearch(target, options);
    const storage = getSearchStorage(editor);
    const results = [...(storage?.results ?? [])];
    const count = results.length;
    if (count === 0) {
      return { success: false, replacedCount: 0, matchIndex: 0, matchCount: 0 };
    }
    const tr = editor.state.tr;
    // 从后向前替换，防止位置偏移
    for (let i = results.length - 1; i >= 0; i--) {
      tr.insertText(options.replaceText, results[i].from, results[i].to);
    }
    editor.view.dispatch(tr);
    const statsAfter = executeSearch(target, options);
    return {
      success: true,
      replacedCount: count,
      matchIndex: statsAfter.matchIndex,
      matchCount: statsAfter.matchCount,
    };
  }

  return { success: false, replacedCount: 0, matchIndex: 0, matchCount: 0 };
}

/** 获取编辑器中当前选中的文本（用于填充搜索初始词） */
export function getSelectedText(target: EditorTarget): string {
  if (!target) return '';

  if (target.type === 'codemirror') {
    const { view } = target;
    const sel = view.state.selection.main;
    if (sel.empty) return '';
    return view.state.sliceDoc(sel.from, sel.to);
  } else if (target.type === 'tiptap') {
    const { editor } = target;
    const { from, to, empty } = editor.state.selection;
    if (empty) return '';
    return editor.state.doc.textBetween(from, to, ' ');
  }

  return '';
}

/** 让活动编辑器重新获取焦点 */
export function focusActiveEditor(target: EditorTarget): void {
  if (!target) return;
  if (target.type === 'codemirror') {
    target.view.focus();
  } else if (target.type === 'tiptap') {
    target.editor.commands.focus();
  }
}
