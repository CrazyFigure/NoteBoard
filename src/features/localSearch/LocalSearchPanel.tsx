// NoteBoard 本地文件搜索面板（Ctrl + Shift + F）
// 输入一行或一段文字，同时搜索文件名与文件内容：
//   - 文件名结果通常在几十毫秒内返回，先行展示；内容结果随后补充，旧结果保留到新结果到达，避免闪烁；
//   - 列表虚拟滚动，行高按类型精确计算，结果再多也不卡顿；
//   - 索引在后台更新时静默刷新当前查询。

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Copy, FileSearch, FolderOutput, Search, Settings2, X } from 'lucide-react';
import * as ipc from '../../core/ipc/commands';
import { onLocalSearchUpdated } from '../../core/ipc/events';
import type {
  LocalSearchContentHit,
  LocalSearchContentResult,
  LocalSearchNameHit,
  LocalSearchNameResult,
  LocalSearchPart,
} from '../../core/ipc/types';
import { formatShortcut, setShortcutsSuspended } from '../../core/shortcuts';
import { useLocalSearchSettings } from '../../stores/settingsStore';
import { useLayoutStore } from '../../stores/layoutStore';
import { showToast } from '../../stores/toastStore';
import { Tooltip } from '../../components/Tooltip';
import { getExplorerFileIcon } from '../explorer/fileIcons';
import { formatRelative } from '../sync/syncFormat';
import { formatBytes } from '../versionHistory/historyFormat';
import { useLocalSearchStore } from './localSearchStore';
import { IS_WEB } from '../../core/platform';
import { canManageInstance } from '../account/accountState';
import { openSearchResult, revealSearchResult } from './openResult';
import './localSearch.css';

type ResultTab = 'all' | 'names' | 'content';

type Row =
  | { type: 'header'; key: string; label: string; count: string; more?: ResultTab }
  | { type: 'name'; key: string; hit: LocalSearchNameHit }
  | { type: 'content'; key: string; hit: LocalSearchContentHit };

/** 行高（与样式表保持一致，虚拟列表据此精确定位，不需要测量） */
const HEADER_ROW = 30;
const NAME_ROW = 46;
const CONTENT_HEAD = 42;
const SNIPPET_ROW = 24;
const CONTENT_PAD = 8;
/** 「全部」中最多展示的文件名结果 */
const ALL_NAME_PREVIEW = 6;
/** 输入后等待的时间 */
const DEBOUNCE_MS = 80;
/** 内容结果超过该时间仍未返回才显示进度条 */
const PENDING_DELAY_MS = 250;
/** 最多展示的文本行数（超出后输入框内部滚动） */
const MAX_INPUT_LINES = 6;

/** 查询序号：同一窗口内递增，后端据此放弃被取代的查询 */
let seqCounter = 0;

function rowHeight(row: Row): number {
  if (row.type === 'header') return HEADER_ROW;
  if (row.type === 'name') return NAME_ROW;
  return CONTENT_HEAD + row.hit.snippets.length * SNIPPET_ROW + CONTENT_PAD;
}

function countLabel(n: number, more: boolean): string {
  return `${n.toLocaleString()}${more ? '+' : ''}`;
}

/** 按当前分组生成列表行 */
export function buildRows(tab: ResultTab, names: LocalSearchNameResult | null, contents: LocalSearchContentResult | null): Row[] {
  const rows: Row[] = [];
  const nameHits = names?.hits ?? [];
  const contentHits = contents?.hits ?? [];
  const pushNames = (list: LocalSearchNameHit[]) => list.forEach((hit) => rows.push({ type: 'name', key: `n:${hit.path}`, hit }));
  const pushContents = (list: LocalSearchContentHit[]) => list.forEach((hit) => rows.push({ type: 'content', key: `c:${hit.path}`, hit }));
  if (tab === 'all') {
    if (nameHits.length > 0 && names) {
      const more = names.total > ALL_NAME_PREVIEW ? 'names' : undefined;
      rows.push({ type: 'header', key: 'h:names', label: '文件名', count: countLabel(names.total, false), more });
      pushNames(nameHits.slice(0, ALL_NAME_PREVIEW));
    }
    if (contentHits.length > 0 && contents) {
      rows.push({ type: 'header', key: 'h:content', label: '内容', count: countLabel(contentHits.length, contents.truncated) });
      pushContents(contentHits);
    }
  } else if (tab === 'names') {
    pushNames(nameHits);
  } else {
    pushContents(contentHits);
  }
  return rows;
}

/** 渲染高亮片段 */
function Parts({ parts }: { parts: LocalSearchPart[] }) {
  return (
    <>
      {parts.map((part, i) => (part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>))}
    </>
  );
}

/** 取片段中的第一处命中文字，用于打开后定位 */
function firstHitText(hit: LocalSearchContentHit, snippetIndex = 0): string {
  const snippet = hit.snippets[snippetIndex] ?? hit.snippets[0];
  return snippet?.parts.find((p) => p.hit)?.text ?? '';
}

function copyPath(path: string): void {
  navigator.clipboard.writeText(path).then(
    () => showToast('已复制路径', 'success'),
    () => showToast('复制失败', 'error'),
  );
}

export function LocalSearchPanel() {
  const open = useLocalSearchStore((s) => s.open);
  if (!open) return null;
  return <LocalSearchDialog />;
}

function LocalSearchDialog() {
  const { enabled, roots } = useLocalSearchSettings();
  const setOpen = useLocalSearchStore((s) => s.setOpen);
  const [query, setQuery] = useState(() => useLocalSearchStore.getState().query);
  const [names, setNames] = useState<LocalSearchNameResult | null>(null);
  const [contents, setContents] = useState<LocalSearchContentResult | null>(null);
  // 当前查询的结果是否都已返回（用于判断「没有结果」，避免内容未返回时误报）
  const [settled, setSettled] = useState({ names: false, content: false });
  const [pending, setPending] = useState(false);
  const [tab, setTab] = useState<ResultTab>('all');
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const latestSeq = useRef(0);
  const queryRef = useRef(query);
  queryRef.current = query;
  // 网页端由服务器决定索引范围，只看管理员是否已开启
  const webEnabled = useLocalSearchStore((s) => s.webEnabled);
  const ready = IS_WEB ? webEnabled : enabled && roots.length > 0;
  // 网页普通用户无法开启，不提供「前往设置」
  const canConfigure = !IS_WEB || canManageInstance();
  const notReadyText = IS_WEB
    ? (canConfigure ? '全局搜索未开启' : '管理员尚未开启全局搜索')
    : (enabled ? '尚未添加索引位置' : '本地文件搜索未开启');
  // 可配置时说明去设置里做什么
  const notReadyHint = !canConfigure ? '' : IS_WEB || !enabled ? '在设置中开启后即可搜索文件名与内容' : '在设置中添加要搜索的文件夹或磁盘';

  const close = useCallback(() => setOpen(false), [setOpen]);

  // 面板打开期间暂停应用快捷键（面板自行处理按键），关闭时恢复
  useEffect(() => {
    setShortcutsSuspended(true);
    return () => setShortcutsSuspended(false);
  }, []);

  // 打开时聚焦并全选上次的查询，直接输入即可替换
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  /** 发起查询；silent 为索引更新触发的静默刷新 */
  const runSearch = useCallback(
    (text: string, silent: boolean) => {
      const seq = ++seqCounter;
      latestSeq.current = seq;
      if (!text.trim() || !ready) {
        setNames(null);
        setContents(null);
        setSettled({ names: true, content: true });
        setPending(false);
        return;
      }
      if (!silent) setSettled({ names: false, content: false });
      const pendingTimer = silent ? 0 : window.setTimeout(() => {
        if (latestSeq.current === seq) setPending(true);
      }, PENDING_DELAY_MS);
      ipc.localSearchNames(text, seq, 200).then(
        (result) => {
          if (!result || latestSeq.current !== seq) return;
          setNames(result);
          setSettled((s) => ({ ...s, names: true }));
        },
        (error) => console.error('[localSearch] 文件名搜索失败:', error),
      );
      ipc.localSearchContent(text, seq, 100).then(
        (result) => {
          if (latestSeq.current !== seq) return;
          window.clearTimeout(pendingTimer);
          setPending(false);
          if (!result) return;
          setContents(result);
          setSettled((s) => ({ ...s, content: true }));
        },
        (error) => {
          window.clearTimeout(pendingTimer);
          if (latestSeq.current === seq) setPending(false);
          console.error('[localSearch] 内容搜索失败:', error);
        },
      );
    },
    [ready],
  );

  // 输入防抖后查询；首次打开带有上次查询时立即执行
  const firstRun = useRef(true);
  useEffect(() => {
    useLocalSearchStore.getState().setQuery(query);
    if (firstRun.current) {
      firstRun.current = false;
      runSearch(query, false);
      return;
    }
    const timer = window.setTimeout(() => runSearch(query, false), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, runSearch]);

  // 索引更新（后台建索引进展、文件变化）时静默刷新当前结果
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onLocalSearchUpdated(() => {
      if (queryRef.current.trim()) runSearch(queryRef.current, true);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [runSearch]);

  // 输入框按内容自动增高（最多 MAX_INPUT_LINES 行）
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    const lineHeight = parseFloat(getComputedStyle(input).lineHeight) || 20;
    input.style.height = `${Math.min(input.scrollHeight, lineHeight * MAX_INPUT_LINES + 2)}px`;
  }, [query]);

  const rows = useMemo(() => buildRows(tab, names, contents), [tab, names, contents]);
  const selectable = useMemo(() => rows.filter((r) => r.type !== 'header'), [rows]);
  // 选中项按 key 记忆：静默刷新后仍停留在同一文件
  const active = selectable.find((r) => r.key === activeKey) ?? selectable[0] ?? null;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: (i) => rowHeight(rows[i]),
    getItemKey: (i) => rows[i].key,
    overscan: 8,
    // 首帧尚未测量列表尺寸时按面板常见高度渲染，避免结果首次出现时空白一帧
    initialRect: { width: 760, height: 480 },
  });

  // 结果或分组变化时重新计算行位置
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [rows, virtualizer]);

  const moveActive = (delta: number) => {
    if (selectable.length === 0) return;
    const current = active ? selectable.indexOf(active) : -1;
    const next = Math.min(selectable.length - 1, Math.max(0, current + delta));
    const row = selectable[next];
    setActiveKey(row.key);
    virtualizer.scrollToIndex(rows.indexOf(row), { align: 'auto' });
  };

  const openRow = (row: Row | null, snippetIndex?: number) => {
    if (!row || row.type === 'header') return;
    close();
    if (row.type === 'name') {
      void openSearchResult(row.hit.path, row.hit.isDir);
    } else {
      void openSearchResult(row.hit.path, false, firstHitText(row.hit, snippetIndex));
    }
  };

  const revealRow = (row: Row | null) => {
    if (!row || row.type === 'header') return;
    revealSearchResult(row.hit.path);
  };

  const switchTab = (next: ResultTab) => {
    setTab(next);
    setActiveKey(null);
    if (listRef.current) listRef.current.scrollTop = 0;
  };

  const goSettings = () => {
    close();
    useLayoutStore.setState({ settingsTarget: 'localSearch' });
    useLayoutStore.getState().setSettingsModalVisible(true);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 输入法组字期间的按键交给输入法
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const mod = e.ctrlKey || e.metaKey;
    const input = e.currentTarget;
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        close();
        return;
      case 'Enter':
        if (e.shiftKey) return; // Shift + Enter 换行
        e.preventDefault();
        if (mod) revealRow(active);
        else openRow(active);
        return;
      case 'ArrowDown':
      case 'ArrowUp': {
        // 多行输入时，光标不在首行 / 末行则交给输入框移动光标
        const before = input.value.slice(0, input.selectionStart);
        const after = input.value.slice(input.selectionEnd);
        if (e.key === 'ArrowUp' && before.includes('\n')) return;
        if (e.key === 'ArrowDown' && after.includes('\n')) return;
        e.preventDefault();
        moveActive(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      case 'PageDown':
      case 'PageUp':
        e.preventDefault();
        moveActive(e.key === 'PageDown' ? 8 : -8);
        return;
      case 'Tab': {
        // Tab / Shift + Tab 切换分组
        e.preventDefault();
        const order: ResultTab[] = ['all', 'names', 'content'];
        const i = order.indexOf(tab);
        switchTab(order[(i + (e.shiftKey ? order.length - 1 : 1)) % order.length]);
        return;
      }
      default:
        // 面板打开时应用快捷键已暂停，再次按下 Ctrl + Shift + F 关闭面板
        if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
          e.preventDefault();
          close();
        }
    }
  };

  const hasQuery = query.trim().length > 0;
  const noResults = hasQuery && ready && settled.names && settled.content && rows.length === 0;
  const tabCount = (t: ResultTab) => {
    if (t === 'names') return names ? countLabel(names.total, false) : '';
    if (t === 'content') return contents ? countLabel(contents.hits.length, contents.truncated) : '';
    return '';
  };

  return (
    <div className="nb-ls-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="nb-ls-panel" role="dialog" aria-label="本地文件搜索">
        <div className="nb-ls-input-row">
          <Search size={17} className="nb-ls-input-icon" />
          <textarea
            ref={inputRef}
            className="nb-ls-input"
            rows={1}
            value={query}
            spellCheck={false}
            placeholder="搜索文件名与内容"
            aria-label="搜索文件名与内容"
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveKey(null);
            }}
            onKeyDown={handleKeyDown}
          />
          {query && (
            <Tooltip content="清空" side="bottom" sideOffset={4}>
              <button
                type="button"
                className="nb-ls-icon-btn"
                aria-label="清空"
                onClick={() => {
                  setQuery('');
                  inputRef.current?.focus();
                }}
              >
                <X size={15} />
              </button>
            </Tooltip>
          )}
        </div>
        <div className={`nb-ls-progress${pending ? ' is-active' : ''}`} />

        {ready && hasQuery && (
          <div className="nb-ls-tabs" role="tablist">
            {(['all', 'names', 'content'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                className={`nb-ls-tab${tab === t ? ' is-active' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => switchTab(t)}
              >
                {t === 'all' ? '全部' : t === 'names' ? '文件名' : '内容'}
                {tabCount(t) && <span className="nb-ls-tab-count">{tabCount(t)}</span>}
              </button>
            ))}
          </div>
        )}

        <div ref={listRef} className="nb-ls-list" onMouseDown={(e) => e.preventDefault()}>
          {!ready ? (
            <div className="nb-ls-empty">
              <FileSearch size={28} />
              <div>{notReadyText}</div>
              {notReadyHint && <div className="nb-ls-empty-sub">{notReadyHint}</div>}
              {canConfigure && (
                <button type="button" className="nb-btn-secondary" onClick={goSettings}>
                  <Settings2 size={14} />
                  前往设置
                </button>
              )}
            </div>
          ) : !hasQuery ? (
            <div className="nb-ls-empty is-hint">
              <div>输入文字搜索文件名与内容</div>
              <div className="nb-ls-empty-sub">也可粘贴一段文字，查找出处</div>
            </div>
          ) : noResults ? (
            <div className="nb-ls-empty is-hint">没有找到匹配的文件</div>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = rows[item.index];
                const style: React.CSSProperties = { position: 'absolute', top: 0, left: 0, right: 0, height: item.size, transform: `translateY(${item.start}px)` };
                if (row.type === 'header') {
                  return (
                    <div key={row.key} className="nb-ls-header" style={style}>
                      <span>{row.label}</span>
                      <span className="nb-ls-header-count">{row.count}</span>
                      {row.more && (
                        <button type="button" className="nb-ls-more" onClick={() => switchTab(row.more!)}>
                          查看全部
                        </button>
                      )}
                    </div>
                  );
                }
                const isActive = active?.key === row.key;
                return (
                  <div
                    key={row.key}
                    className={`nb-ls-row nb-ls-row-${row.type}${isActive ? ' is-active' : ''}`}
                    style={style}
                    role="option"
                    aria-selected={isActive}
                    onMouseMove={() => !isActive && setActiveKey(row.key)}
                    onClick={() => openRow(row)}
                  >
                    {row.type === 'name' ? <NameRow hit={row.hit} /> : <ContentRow hit={row.hit} onOpenSnippet={(i) => openRow(row, i)} />}
                    <div className="nb-ls-row-actions">
                      <Tooltip content="打开所在文件夹" shortcut="Ctrl+Enter" side="top" sideOffset={4}>
                        <button type="button" className="nb-ls-icon-btn" aria-label="打开所在文件夹" onClick={(e) => { e.stopPropagation(); revealRow(row); }}>
                          <FolderOutput size={14} />
                        </button>
                      </Tooltip>
                      <Tooltip content="复制路径" side="top" sideOffset={4}>
                        <button type="button" className="nb-ls-icon-btn" aria-label="复制路径" onClick={(e) => { e.stopPropagation(); copyPath(row.hit.path); }}>
                          <Copy size={14} />
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="nb-ls-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span><kbd>Enter</kbd> 打开</span>
          <span><kbd>{formatShortcut('Ctrl')}</kbd><kbd>Enter</kbd> 打开所在文件夹</span>
          <span><kbd>Shift</kbd><kbd>Enter</kbd> 换行</span>
          <span><kbd>Tab</kbd> 切换分组</span>
          <span><kbd>Esc</kbd> 关闭</span>
        </div>
      </div>
    </div>
  );
}

function NameRow({ hit }: { hit: LocalSearchNameHit }) {
  return (
    <>
      <span className="nb-ls-row-icon">{getExplorerFileIcon(hit.name, { size: 18, isDir: hit.isDir })}</span>
      <div className="nb-ls-row-main">
        <div className="nb-ls-row-title"><Parts parts={hit.nameParts} /></div>
        <div className="nb-ls-row-path">{hit.dir}</div>
      </div>
      <div className="nb-ls-row-meta">
        {!hit.isDir && <span>{formatBytes(hit.size)}</span>}
        {hit.mtime > 0 && <span>{formatRelative(hit.mtime)}</span>}
      </div>
    </>
  );
}

function ContentRow({ hit, onOpenSnippet }: { hit: LocalSearchContentHit; onOpenSnippet: (index: number) => void }) {
  return (
    <div className="nb-ls-content">
      <div className="nb-ls-content-head">
        <span className="nb-ls-row-icon">{getExplorerFileIcon(hit.name, { size: 16 })}</span>
        <span className="nb-ls-row-title">{hit.name}</span>
        <span className="nb-ls-row-path">{hit.dir}</span>
        <span className="nb-ls-row-meta">
          <span>{hit.matches >= 999 ? '999+' : hit.matches} 处</span>
          {hit.mtime > 0 && <span>{formatRelative(hit.mtime)}</span>}
        </span>
      </div>
      {hit.snippets.map((snippet, i) => (
        <div
          key={`${snippet.line}-${i}`}
          className="nb-ls-snippet"
          onClick={(e) => {
            e.stopPropagation();
            onOpenSnippet(i);
          }}
        >
          <span className="nb-ls-snippet-line">{snippet.line}</span>
          <span className="nb-ls-snippet-text"><Parts parts={snippet.parts} /></span>
        </div>
      ))}
    </div>
  );
}
