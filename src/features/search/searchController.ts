// NoteBoard 统一搜索替换控制器
// 屏蔽底层差异，统一对接 CodeMirror 6 与 TipTap（Markdown）编辑器

import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { EditorView } from '@codemirror/view';
import {
  SearchQuery,
  setSearchQuery,
  replaceNext as cmReplaceNext,
  replaceAll as cmReplaceAll,
  openSearchPanel,
  closeSearchPanel,
  searchPanelOpen,
} from '@codemirror/search';
import { EDITOR_SEARCH_NAVIGATION_META } from '../../core/editor/searchNavigation';

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
  // TipTap 对扩展存储使用宽泛类型，这里只收窄到搜索插件公开的数据结构。
  const storage = editor.storage as unknown as { searchAndReplace?: SearchAndReplaceStorage };
  return storage.searchAndReplace;
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

/** 匹配区间（文档绝对位置） */
interface MatchRange {
  from: number;
  to: number;
}

/** 跳转方向：基于当前光标的上一个/下一个，或直接跳到首个/末个 */
type NavigateDirection = 'next' | 'prev' | 'first' | 'last';

/**
 * 基于当前选区在匹配列表（按位置升序）中挑选跳转目标索引。
 * - next：选区结束位置之后（含）的第一个匹配；选区恰为某匹配时自然落到其后一个；末尾回绕到首个
 * - prev：选区起始位置之前（含）的最后一个匹配；开头回绕到末个
 */
function pickTargetIndex(
  matches: MatchRange[],
  selFrom: number,
  selTo: number,
  direction: NavigateDirection,
): number {
  const count = matches.length;
  if (count === 0) return -1;
  if (direction === 'first') return 0;
  if (direction === 'last') return count - 1;
  if (direction === 'next') {
    const index = matches.findIndex((m) => m.from >= selTo);
    return index === -1 ? 0 : index;
  }
  for (let i = count - 1; i >= 0; i--) {
    if (matches[i].to <= selFrom) return i;
  }
  return count - 1;
}

/** 当前选区恰好覆盖的匹配项索引（-1 表示选区不在任何匹配项上） */
function findSelectedIndex(matches: MatchRange[], selFrom: number, selTo: number): number {
  return matches.findIndex((m) => m.from === selFrom && m.to === selTo);
}

/** 查找最近的可纵向滚动祖先容器 */
function findScrollContainer(start: HTMLElement | null): HTMLElement | null {
  for (let node = start; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    const scrollable = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
    if (scrollable && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/**
 * 将 TipTap 文档位置滚动到滚动容器垂直居中。
 * ProseMirror 自带的 scrollIntoView 只在 DOM 选区位于编辑器内时生效；搜索栏输入框
 * 持有焦点时它会直接跳过滚动，因此这里按坐标手动滚动最近的滚动容器（与 CodeMirror 居中行为一致）。
 */
function scrollTipTapPositionToCenter(editor: Editor, pos: number): void {
  const { view } = editor;
  let coords: { top: number; bottom: number };
  try {
    coords = view.coordsAtPos(pos);
  } catch {
    return;
  }
  const container = findScrollContainer(view.dom as HTMLElement);
  if (container) {
    const box = container.getBoundingClientRect();
    container.scrollTop += (coords.top + coords.bottom) / 2 - (box.top + box.bottom) / 2;
  } else {
    window.scrollBy({ top: (coords.top + coords.bottom) / 2 - window.innerHeight / 2 });
  }
}

/**
 * 在 TipTap 正文内选择并滚动到搜索结果。
 * 事务携带搜索来源标记，右侧大纲据此忽略联动，不把 Ctrl+F 误表现为目录跳转。
 */
function navigateTipTapSearchResult(editor: Editor, from: number, to = from): void {
  const maxPosition = editor.state.doc.content.size;
  const safeFrom = Math.max(1, Math.min(from, maxPosition));
  const safeTo = Math.max(1, Math.min(to, maxPosition));
  const transaction = editor.state.tr
    .setSelection(TextSelection.create(editor.state.doc, safeFrom, safeTo))
    .setMeta(EDITOR_SEARCH_NAVIGATION_META, true)
    .scrollIntoView();
  editor.view.dispatch(transaction);
  // 焦点在搜索栏时 ProseMirror 不会滚动，手动把匹配项滚到可视区中央
  scrollTipTapPositionToCenter(editor, safeFrom);
}

/** 折叠 TipTap 选区为光标（原地折叠，不滚动），用于清除旧选区背景 */
function collapseTipTapSelection(editor: Editor): void {
  if (editor.state.selection.empty) return;
  const transaction = editor.state.tr
    .setSelection(TextSelection.create(editor.state.doc, editor.state.selection.from))
    .setMeta(EDITOR_SEARCH_NAVIGATION_META, true);
  editor.view.dispatch(transaction);
}

/**
 * 同步 TipTap 搜索插件的"当前项"索引（决定 -current 高亮），-1 表示无当前项。
 * 插件仅在索引变化时重算装饰，因此变化后需派发一次空事务。
 */
function syncTipTapResultIndex(editor: Editor, index: number): void {
  const storage = getSearchStorage(editor);
  if (!storage || storage.resultIndex === index) return;
  storage.resultIndex = index;
  editor.view.dispatch(editor.state.tr);
}

/** 应用 CodeMirror 搜索条件并返回全部匹配区间（搜索词为空时返回 null） */
function applyCodeMirrorQuery(view: EditorView, options: SearchOptions): MatchRange[] | null {
  const { searchText, replaceText, caseSensitive, wholeWord, isRegex } = options;
  if (!searchText) return null;
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

  const matches: MatchRange[] = [];
  const cursor = query.getCursor(view.state.doc);
  let iter = cursor.next();
  while (!iter.done) {
    matches.push({ from: iter.value.from, to: iter.value.to });
    iter = cursor.next();
  }
  return matches;
}

/** 应用 TipTap 搜索条件并返回全部匹配区间（按位置升序） */
function applyTipTapQuery(editor: Editor, options: SearchOptions): MatchRange[] {
  const { searchText, replaceText, caseSensitive, wholeWord, isRegex } = options;
  const pattern = buildRegexPattern(searchText, wholeWord, isRegex);
  editor.commands.setCaseSensitive(caseSensitive);
  editor.commands.setReplaceTerm(replaceText);
  editor.commands.setSearchTerm(pattern);
  // 派发事务，强制 ProseMirror 插件立即更新计算 results 与高亮 DecorationSet
  editor.view.dispatch(editor.state.tr);
  return getSearchStorage(editor)?.results ?? [];
}

/**
 * 执行搜索更新，返回当前匹配索引与总数。
 * 仅刷新高亮与计数，不移动选区、不滚动：输入/修改搜索词或编辑正文时都不会自动跳转，
 * 跳转只由用户显式触发（上一个/下一个/首个/末个）。
 * 选区恰好位于某匹配项上时 matchIndex 为其序号，否则为 0。
 */
export function executeSearch(
  target: EditorTarget,
  options: SearchOptions,
): { matchIndex: number; matchCount: number } {
  if (!target) return { matchIndex: 0, matchCount: 0 };
  const { searchText } = options;

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
      const matches = applyCodeMirrorQuery(view, options) ?? [];

      // 如果没有匹配项，若当前存在非空选区，将其折叠为单光标，解除 highlightSelectionMatches 的全篇匹配高亮
      if (matches.length === 0) {
        if (!view.state.selection.main.empty) {
          view.dispatch({
            selection: { anchor: view.state.selection.main.from },
            userEvent: 'select.search',
          });
        }
        return { matchIndex: 0, matchCount: 0 };
      }

      const { from, to } = view.state.selection.main;
      return { matchIndex: findSelectedIndex(matches, from, to) + 1, matchCount: matches.length };
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
      collapseTipTapSelection(editor);
      return { matchIndex: 0, matchCount: 0 };
    }

    try {
      const results = applyTipTapQuery(editor, options);
      if (results.length === 0) {
        // 无匹配项时折叠选区，避免保留旧选区背景
        collapseTipTapSelection(editor);
        return { matchIndex: 0, matchCount: 0 };
      }

      // 仅当选区恰好在某匹配项上时将其标记为当前项，否则不标记任何当前项
      const { from, to } = editor.state.selection;
      const index = findSelectedIndex(results, from, to);
      syncTipTapResultIndex(editor, index);
      return { matchIndex: index + 1, matchCount: results.length };
    } catch {
      return { matchIndex: 0, matchCount: 0 };
    }
  }

  return { matchIndex: 0, matchCount: 0 };
}

/** 按方向跳转到匹配项（选中并滚动到可视区中央） */
function executeNavigate(
  target: EditorTarget,
  options: SearchOptions,
  direction: NavigateDirection,
): { matchIndex: number; matchCount: number } {
  if (!target || !options.searchText) return { matchIndex: 0, matchCount: 0 };

  if (target.type === 'codemirror') {
    const { view } = target;
    try {
      const matches = applyCodeMirrorQuery(view, options) ?? [];
      if (matches.length === 0) return executeSearch(target, options);
      const { from, to } = view.state.selection.main;
      const index = pickTargetIndex(matches, from, to, direction);
      const item = matches[index];
      view.dispatch({
        selection: { anchor: item.from, head: item.to },
        effects: [EditorView.scrollIntoView(item.from, { y: 'center' })],
        userEvent: 'select.search',
      });
      return { matchIndex: index + 1, matchCount: matches.length };
    } catch {
      return { matchIndex: 0, matchCount: 0 };
    }
  } else if (target.type === 'tiptap') {
    const { editor } = target;
    try {
      const results = applyTipTapQuery(editor, options);
      if (results.length === 0) return executeSearch(target, options);
      const { from, to } = editor.state.selection;
      const index = pickTargetIndex(results, from, to, direction);
      const item = results[index];
      // 先写入当前项索引，随后的选区事务会触发插件重算 -current 高亮
      const storage = getSearchStorage(editor);
      if (storage) storage.resultIndex = index;
      navigateTipTapSearchResult(editor, item.from, item.to);
      return { matchIndex: index + 1, matchCount: results.length };
    } catch {
      return { matchIndex: 0, matchCount: 0 };
    }
  }

  return { matchIndex: 0, matchCount: 0 };
}

/** 查找下一个匹配项（基于当前光标位置，到末尾后回绕） */
export function executeFindNext(
  target: EditorTarget,
  options: SearchOptions,
): { matchIndex: number; matchCount: number } {
  return executeNavigate(target, options, 'next');
}

/** 查找上一个匹配项（基于当前光标位置，到开头后回绕） */
export function executeFindPrev(
  target: EditorTarget,
  options: SearchOptions,
): { matchIndex: number; matchCount: number } {
  return executeNavigate(target, options, 'prev');
}

/** 跳转到第一个匹配项 */
export function executeFindFirst(
  target: EditorTarget,
  options: SearchOptions,
): { matchIndex: number; matchCount: number } {
  return executeNavigate(target, options, 'first');
}

/** 跳转到最后一个匹配项 */
export function executeFindLast(
  target: EditorTarget,
  options: SearchOptions,
): { matchIndex: number; matchCount: number } {
  return executeNavigate(target, options, 'last');
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

  // 替换目标：选区恰好在某匹配项上则替换它，否则替换光标之后（含）的下一个匹配项
  if (target.type === 'codemirror') {
    const { view } = target;
    // 确保 SearchQuery 最新状态已应用至编辑器并获取匹配列表
    const matches = applyCodeMirrorQuery(view, options) ?? [];
    if (matches.length === 0) {
      return { success: false, replacedCount: 0, matchIndex: 0, matchCount: 0 };
    }
    const { from, to } = view.state.selection.main;
    if (findSelectedIndex(matches, from, to) === -1) {
      const item = matches[pickTargetIndex(matches, from, to, 'next')];
      view.dispatch({ selection: { anchor: item.from, head: item.to }, userEvent: 'select.search' });
    }
    // 选区已对准目标匹配项：replaceNext 会替换它并选中、滚动到下一个匹配项
    const replaced = cmReplaceNext(view);
    const statsAfter = executeSearch(target, options);
    return {
      success: replaced,
      replacedCount: replaced ? 1 : 0,
      matchIndex: statsAfter.matchIndex,
      matchCount: statsAfter.matchCount,
    };
  } else if (target.type === 'tiptap') {
    const { editor } = target;
    // 确保 TipTap 搜索状态为最新
    const results = applyTipTapQuery(editor, options);
    if (results.length === 0) {
      return { success: false, replacedCount: 0, matchIndex: 0, matchCount: 0 };
    }
    const { from, to } = editor.state.selection;
    const selectedIndex = findSelectedIndex(results, from, to);
    const current = results[selectedIndex !== -1 ? selectedIndex : pickTargetIndex(results, from, to, 'next')];
    // 以纯文本替换匹配片段（不经 HTML 解析），光标落在替换文本之后；不抢占搜索栏焦点
    // 替换为空串时用 delete 而非 insertText（后者会走 deleteRange，可能连带删除整个空段落）
    const tr = options.replaceText
      ? editor.state.tr.insertText(options.replaceText, current.from, current.to)
      : editor.state.tr.delete(current.from, current.to);
    const caret = tr.mapping.map(current.to);
    tr.setSelection(TextSelection.near(tr.doc.resolve(caret))).setMeta(EDITOR_SEARCH_NAVIGATION_META, true);
    editor.view.dispatch(tr);
    // 自动定位到替换位置之后的下一个匹配项，便于连续替换
    const statsAfter = executeNavigate(target, options, 'next');
    return {
      success: true,
      replacedCount: 1,
      matchIndex: statsAfter.matchIndex,
      matchCount: statsAfter.matchCount,
    };
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
