// NoteBoard 现代浮动搜索与替换栏
// 适用于 Markdown（可视化/源码）、TXT 及全部代码文档
// 样式与交互遵循设计规范与主题色彩 Token

import React, { useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Search,
  ChevronUp,
  ChevronDown,
  X,
  Replace,
  Grid2X2,
} from 'lucide-react';
import { useSearchStore } from '../../stores/searchStore';
import { useWindowStore } from '../../stores/windowStore';
import { showToast } from '../../stores/toastStore';
import { getEditorView } from '../editor-code/CodeEditor';
import { getActiveTipTapEditor, getActiveSourceView } from '../editor-md/TipTapEditor';
import {
  executeSearch,
  executeFindNext,
  executeFindPrev,
  executeReplace,
  executeReplaceAll,
  focusActiveEditor,
  type EditorTarget,
} from './searchController';

export function SearchReplaceBar() {
  const {
    isOpen,
    searchText,
    replaceText,
    caseSensitive,
    wholeWord,
    isRegex,
    matchIndex,
    matchCount,
    focusTarget,
    closeSearch,
    setSearchText,
    setReplaceText,
    setCaseSensitive,
    setWholeWord,
    setIsRegex,
    setMatchStats,
  } = useSearchStore();

  const activeKey = useWindowStore((s) => s.activeKey);
  const tabs = useWindowStore((s) => s.tabs);
  const activeTab = useMemo(() => tabs.find((t) => t.key === activeKey), [tabs, activeKey]);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);

  // 解析当前活动的编辑器目标（TipTap 可视化 / CM6 源码 / CM6 代码与纯文本）
  const getTarget = useCallback((): EditorTarget => {
    if (!activeTab || !activeKey) return null;
    if (activeTab.kind === 'markdown') {
      if (activeTab.viewMode === 'source') {
        const view = getActiveSourceView(activeKey);
        return view ? { type: 'codemirror', view } : null;
      } else {
        const editor = getActiveTipTapEditor(activeKey);
        return editor ? { type: 'tiptap', editor } : null;
      }
    } else if (activeTab.kind === 'code') {
      const view = getEditorView();
      return view ? { type: 'codemirror', view } : null;
    }
    return null;
  }, [activeTab, activeKey]);

  // 搜索选项参数
  const searchOptions = useMemo(
    () => ({
      searchText,
      replaceText,
      caseSensitive,
      wholeWord,
      isRegex,
    }),
    [searchText, replaceText, caseSensitive, wholeWord, isRegex],
  );

  // 触发实时搜索并更新匹配统计
  const runSearch = useCallback(() => {
    if (!isOpen) return;
    const target = getTarget();
    const stats = executeSearch(target, searchOptions);
    setMatchStats(stats.matchIndex, stats.matchCount);
  }, [isOpen, getTarget, searchOptions, setMatchStats]);

  // 当搜索词、选项或当前文档切换时，实时重跑搜索
  useEffect(() => {
    runSearch();
  }, [runSearch]);

  // 打开搜索栏或切换聚焦目标时，自动聚焦并全选输入框内容
  useEffect(() => {
    if (!isOpen) return;
    const timer = setTimeout(() => {
      if (focusTarget === 'replace') {
        if (replaceInputRef.current) {
          replaceInputRef.current.focus();
          replaceInputRef.current.select();
        }
      } else {
        if (searchInputRef.current) {
          searchInputRef.current.focus();
          searchInputRef.current.select();
        }
      }
    }, 20);
    return () => clearTimeout(timer);
  }, [isOpen, focusTarget]);

  // 处理关闭与焦点回归
  const handleClose = useCallback(() => {
    const target = getTarget();
    closeSearch();
    // 清除搜索高亮状态
    if (target) {
      executeSearch(target, {
        searchText: '',
        replaceText: '',
        caseSensitive: false,
        wholeWord: false,
        isRegex: false,
      });
    }
    focusActiveEditor(target);
  }, [getTarget, closeSearch]);

  // 查找下一处
  const handleFindNext = useCallback(() => {
    const target = getTarget();
    const stats = executeFindNext(target, searchOptions);
    setMatchStats(stats.matchIndex, stats.matchCount);
  }, [getTarget, searchOptions, setMatchStats]);

  // 查找上一处
  const handleFindPrev = useCallback(() => {
    const target = getTarget();
    const stats = executeFindPrev(target, searchOptions);
    setMatchStats(stats.matchIndex, stats.matchCount);
  }, [getTarget, searchOptions, setMatchStats]);

  // 替换单处
  const handleReplace = useCallback(() => {
    // 校验搜索关键字是否为空
    if (!searchText) {
      showToast('请输入要搜索的内容', 'warning');
      return;
    }
    const target = getTarget();
    // 校验当前视图是否支持替换
    if (!target) {
      showToast('当前视图不支持替换操作', 'warning');
      return;
    }
    const result = executeReplace(target, searchOptions);
    setMatchStats(result.matchIndex, result.matchCount);
    // 根据替换执行结果弹出状态提示
    if (result.error) {
      showToast(`替换失败: ${result.error}`, 'error');
    } else if (result.success && result.replacedCount > 0) {
      showToast('已替换 1 处匹配项', 'success');
    } else {
      showToast('未找到可替换的内容', 'warning');
    }
  }, [getTarget, searchOptions, searchText, setMatchStats]);

  // 替换全部
  const handleReplaceAll = useCallback(() => {
    // 校验搜索关键字是否为空
    if (!searchText) {
      showToast('请输入要搜索的内容', 'warning');
      return;
    }
    const target = getTarget();
    // 校验当前视图是否支持替换
    if (!target) {
      showToast('当前视图不支持替换操作', 'warning');
      return;
    }
    const result = executeReplaceAll(target, searchOptions);
    setMatchStats(result.matchIndex, result.matchCount);
    // 根据全部替换执行结果弹出状态提示
    if (result.error) {
      showToast(`全部替换失败: ${result.error}`, 'error');
    } else if (result.success && result.replacedCount > 0) {
      showToast(`已替换全部 ${result.replacedCount} 处匹配项`, 'success');
    } else {
      showToast('未找到匹配项，未执行替换', 'warning');
    }
  }, [getTarget, searchOptions, searchText, setMatchStats]);

  if (!isOpen) return null;

  return (
    <div
      role="search"
      aria-label="查找与替换"
      style={{
        position: 'absolute',
        top: 12,
        right: 20,
        zIndex: 40,
        width: 380,
        maxWidth: 'calc(100% - 40px)',
        boxSizing: 'border-box',
        background: 'var(--editor-surface, var(--editor-bg))',
        border: '1px solid var(--editor-border)',
        borderRadius: 12,
        boxShadow: 'var(--shadow-lg, 0 10px 25px -5px rgba(0, 0, 0, 0.15))',
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        fontFamily: 'var(--ui-font-family, -apple-system, sans-serif)',
        fontSize: 13,
        color: 'var(--editor-text)',
        backdropFilter: 'blur(8px)',
        userSelect: 'none',
      }}
    >
      {/* ── 第一行：搜索输入框 + 匹配计数 + 上下导航 + 关闭 ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', boxSizing: 'border-box' }}>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            boxSizing: 'border-box',
            display: 'flex',
            alignItems: 'center',
            height: 32,
            padding: '0 8px',
            borderRadius: 8,
            border: '1px solid var(--editor-border)',
            background: 'var(--editor-bg)',
            gap: 6,
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = 'var(--editor-border-focus)';
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = 'var(--editor-border)';
          }}
        >
          <Search size={14} style={{ color: 'var(--editor-text-muted)', flexShrink: 0 }} />
          <input
            ref={searchInputRef}
            type="text"
            value={searchText}
            placeholder="搜索..."
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey) {
                  handleFindPrev();
                } else {
                  handleFindNext();
                }
              } else if (e.key === 'ArrowDown') {
                replaceInputRef.current?.focus();
              }
            }}
            style={{
              flex: 1,
              minWidth: 0,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              color: 'var(--editor-text)',
              fontSize: 13,
            }}
          />
          {searchText && (
            <span
              style={{
                fontSize: 12,
                color: matchCount > 0 ? 'var(--editor-text-secondary)' : 'var(--editor-text-muted)',
                fontVariantNumeric: 'tabular-nums',
                flexShrink: 0,
                paddingLeft: 4,
                whiteSpace: 'nowrap',
              }}
            >
              {matchIndex}/{matchCount}
            </span>
          )}
        </div>

        {/* 上一个匹配项 */}
        <button
          type="button"
          onClick={handleFindPrev}
          title="上一个匹配项 (Shift+Enter 或 Shift+F3)"
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            background: 'transparent',
            color: 'var(--editor-text-secondary)',
            cursor: 'pointer',
            flexShrink: 0,
            boxSizing: 'border-box',
            transition: 'all var(--transition-fast)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--toolbar-hover)';
            e.currentTarget.style.color = 'var(--editor-text)';
            e.currentTarget.style.transform = 'scale(1.08)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'var(--editor-text-secondary)';
            e.currentTarget.style.transform = 'scale(1)';
          }}
          onMouseDown={(e) => {
            e.currentTarget.style.background = 'var(--toolbar-active)';
            e.currentTarget.style.transform = 'scale(0.92)';
          }}
          onMouseUp={(e) => {
            e.currentTarget.style.background = 'var(--toolbar-hover)';
            e.currentTarget.style.transform = 'scale(1.08)';
          }}
        >
          <ChevronUp size={16} />
        </button>

        {/* 下一个匹配项 */}
        <button
          type="button"
          onClick={handleFindNext}
          title="下一个匹配项 (Enter 或 F3)"
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            background: 'transparent',
            color: 'var(--editor-text-secondary)',
            cursor: 'pointer',
            flexShrink: 0,
            boxSizing: 'border-box',
            transition: 'all var(--transition-fast)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--toolbar-hover)';
            e.currentTarget.style.color = 'var(--editor-text)';
            e.currentTarget.style.transform = 'scale(1.08)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'var(--editor-text-secondary)';
            e.currentTarget.style.transform = 'scale(1)';
          }}
          onMouseDown={(e) => {
            e.currentTarget.style.background = 'var(--toolbar-active)';
            e.currentTarget.style.transform = 'scale(0.92)';
          }}
          onMouseUp={(e) => {
            e.currentTarget.style.background = 'var(--toolbar-hover)';
            e.currentTarget.style.transform = 'scale(1.08)';
          }}
        >
          <ChevronDown size={16} />
        </button>

        {/* 关闭按钮 */}
        <button
          type="button"
          onClick={handleClose}
          title="关闭"
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            background: 'transparent',
            color: 'var(--editor-text-secondary)',
            cursor: 'pointer',
            flexShrink: 0,
            boxSizing: 'border-box',
            transition: 'all var(--transition-fast)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--toolbar-hover)';
            e.currentTarget.style.color = 'var(--editor-text)';
            e.currentTarget.style.transform = 'scale(1.08)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'var(--editor-text-secondary)';
            e.currentTarget.style.transform = 'scale(1)';
          }}
          onMouseDown={(e) => {
            e.currentTarget.style.background = 'var(--toolbar-active)';
            e.currentTarget.style.transform = 'scale(0.92)';
          }}
          onMouseUp={(e) => {
            e.currentTarget.style.background = 'var(--toolbar-hover)';
            e.currentTarget.style.transform = 'scale(1.08)';
          }}
        >
          <X size={16} />
        </button>
      </div>

      {/* ── 第二行：替换输入框 + 替换按钮 + 全部替换按钮 ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', boxSizing: 'border-box' }}>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            boxSizing: 'border-box',
            display: 'flex',
            alignItems: 'center',
            height: 32,
            padding: '0 8px',
            borderRadius: 8,
            border: '1px solid var(--editor-border)',
            background: 'var(--editor-bg)',
            gap: 6,
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = 'var(--editor-border-focus)';
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = 'var(--editor-border)';
          }}
        >
          <Replace size={14} style={{ color: 'var(--editor-text-muted)', flexShrink: 0 }} />
          <input
            ref={replaceInputRef}
            type="text"
            value={replaceText}
            placeholder="替换为..."
            onChange={(e) => setReplaceText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (e.ctrlKey || e.altKey) {
                  handleReplaceAll();
                } else {
                  handleReplace();
                }
              } else if (e.key === 'ArrowUp') {
                searchInputRef.current?.focus();
              }
            }}
            style={{
              flex: 1,
              minWidth: 0,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              color: 'var(--editor-text)',
              fontSize: 13,
            }}
          />
        </div>

        {/* 替换当前匹配项 */}
        <button
          type="button"
          onClick={handleReplace}
          title="替换当前匹配 (Enter)"
          style={{
            height: 32,
            padding: '0 8px',
            borderRadius: 8,
            border: '1px solid var(--editor-border)',
            background: 'var(--editor-bg)',
            color: 'var(--editor-text)',
            fontSize: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            cursor: 'pointer',
            flexShrink: 0,
            whiteSpace: 'nowrap',
            boxSizing: 'border-box',
            transition: 'all var(--transition-fast)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--toolbar-hover)';
            e.currentTarget.style.borderColor = 'var(--editor-border-focus)';
            e.currentTarget.style.transform = 'translateY(-1px)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'var(--editor-bg)';
            e.currentTarget.style.borderColor = 'var(--editor-border)';
            e.currentTarget.style.transform = 'translateY(0)';
          }}
          onMouseDown={(e) => {
            e.currentTarget.style.background = 'var(--toolbar-active)';
            e.currentTarget.style.transform = 'translateY(0) scale(0.96)';
          }}
          onMouseUp={(e) => {
            e.currentTarget.style.background = 'var(--toolbar-hover)';
            e.currentTarget.style.transform = 'translateY(-1px)';
          }}
        >
          <Replace size={13} />
          <span>替换</span>
        </button>

        {/* 替换全部匹配项 */}
        <button
          type="button"
          onClick={handleReplaceAll}
          title="全部替换 (Ctrl+Alt+Enter)"
          style={{
            height: 32,
            padding: '0 8px',
            borderRadius: 8,
            border: '1px solid var(--editor-border)',
            background: 'var(--editor-bg)',
            color: 'var(--editor-text)',
            fontSize: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            cursor: 'pointer',
            flexShrink: 0,
            whiteSpace: 'nowrap',
            boxSizing: 'border-box',
            transition: 'all var(--transition-fast)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--toolbar-hover)';
            e.currentTarget.style.borderColor = 'var(--editor-border-focus)';
            e.currentTarget.style.transform = 'translateY(-1px)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'var(--editor-bg)';
            e.currentTarget.style.borderColor = 'var(--editor-border)';
            e.currentTarget.style.transform = 'translateY(0)';
          }}
          onMouseDown={(e) => {
            e.currentTarget.style.background = 'var(--toolbar-active)';
            e.currentTarget.style.transform = 'translateY(0) scale(0.96)';
          }}
          onMouseUp={(e) => {
            e.currentTarget.style.background = 'var(--toolbar-hover)';
            e.currentTarget.style.transform = 'translateY(-1px)';
          }}
        >
          <Grid2X2 size={13} />
          <span>全部</span>
        </button>
      </div>

      {/* ── 第三行：选项设置（区分大小写 / 全字匹配 / 正则表达式） ── */}
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12, paddingTop: 2, width: '100%', boxSizing: 'border-box' }}>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            cursor: 'pointer',
            fontSize: 12,
            whiteSpace: 'nowrap',
            color: caseSensitive ? 'var(--editor-text)' : 'var(--editor-text-secondary)',
          }}
        >
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(e) => setCaseSensitive(e.target.checked)}
            style={{
              accentColor: 'var(--editor-accent, #3b82f6)',
              cursor: 'pointer',
            }}
          />
          <span>区分大小写</span>
        </label>

        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            cursor: 'pointer',
            fontSize: 12,
            whiteSpace: 'nowrap',
            color: wholeWord ? 'var(--editor-text)' : 'var(--editor-text-secondary)',
          }}
        >
          <input
            type="checkbox"
            checked={wholeWord}
            onChange={(e) => setWholeWord(e.target.checked)}
            style={{
              accentColor: 'var(--editor-accent, #3b82f6)',
              cursor: 'pointer',
            }}
          />
          <span>全字匹配</span>
        </label>

        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            cursor: 'pointer',
            fontSize: 12,
            whiteSpace: 'nowrap',
            color: isRegex ? 'var(--editor-text)' : 'var(--editor-text-secondary)',
          }}
        >
          <input
            type="checkbox"
            checked={isRegex}
            onChange={(e) => setIsRegex(e.target.checked)}
            style={{
              accentColor: 'var(--editor-accent, #3b82f6)',
              cursor: 'pointer',
            }}
          />
          <span>正则表达式</span>
        </label>
      </div>
    </div>
  );
}
