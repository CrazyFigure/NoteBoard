// NoteBoard 文档历史记录：查看界面
// 布局：顶栏（返回文档 / 还原此版本 / 改动跳转）+ 主区（只读版本，高亮相对上一版的改动）+ 右侧版本时间线。
// 覆盖在编辑区之上，编辑器保持挂载；Esc 或「返回文档」退出。

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronDown, ChevronUp, HelpCircle, ListOrdered, Loader2, Pin, PinOff, RotateCcw, Settings, Trash2 } from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';
import { IS_MOBILE_UI } from '../../core/platform';
import * as ipc from '../../core/ipc/commands';
import { onHistoryChanged } from '../../core/ipc/events';
import type { HistoryEntry } from '../../core/ipc/types';
import { showToast } from '../../stores/toastStore';
import { describeEntry, formatEntryTime, groupByMonth } from './historyFormat';
import { openHistorySettings, useVersionHistoryStore } from './versionHistoryStore';
import { dropVersionContent, useVersionContent } from './versionContent';
import { restoreBlockedReason, restoreVersion } from './restoreVersion';
import { viewerFor } from './viewers/viewerRegistry';
import type { ChangeInfo, ChangeNavigator } from './viewers/viewerTypes';
import './versionHistory.css';

/** 设备标记色（按设备 id 稳定取色） */
const DEVICE_COLORS = ['#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#14b8a6'];

function deviceColor(device: string): string {
  let h = 0;
  for (let i = 0; i < device.length; i++) h = (h * 31 + device.charCodeAt(i)) >>> 0;
  return DEVICE_COLORS[h % DEVICE_COLORS.length];
}

/** 路径比较键（事件中的路径与标签路径可能大小写 / 分隔符不同） */
function samePath(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  return norm(a) === norm(b);
}

export default function HistoryView() {
  const open = useVersionHistoryStore((s) => s.open);
  const docKey = useVersionHistoryStore((s) => s.docKey);
  const path = useVersionHistoryStore((s) => s.path);
  const displayName = useVersionHistoryStore((s) => s.displayName);
  const kind = useVersionHistoryStore((s) => s.kind);
  const config = useVersionHistoryStore((s) => s.config);
  const entries = useVersionHistoryStore((s) => s.entries);
  const status = useVersionHistoryStore((s) => s.status);
  const error = useVersionHistoryStore((s) => s.error);
  const selectedId = useVersionHistoryStore((s) => s.selectedId);
  const showChanges = useVersionHistoryStore((s) => s.showChanges);
  const { close, refresh, select, setShowChanges } = useVersionHistoryStore.getState();

  const [changeInfo, setChangeInfo] = useState<ChangeInfo>({ count: 0, index: -1 });
  const [restoring, setRestoring] = useState(false);
  // 移动端：版本列表以全屏面板展开
  const [listOpen, setListOpen] = useState(false);
  // 最新版本仍在合并窗口中时内容会变：收到变更事件后递增以重新读取
  const [contentRevision, setContentRevision] = useState(0);
  const navigatorRef = useRef<ChangeNavigator | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selIndex = entries.findIndex((e) => e.id === selectedId);
  const selected = selIndex >= 0 ? entries[selIndex] : null;
  const baseEntry = selIndex >= 0 ? (entries[selIndex + 1] ?? null) : null;
  const target = useVersionContent(path, selected?.id ?? null, !selected?.open, selected?.open ? contentRevision : 0);
  const base = useVersionContent(path, baseEntry?.id ?? null, !baseEntry?.open);
  const groups = useMemo(() => groupByMonth(entries), [entries]);
  const Viewer = viewerFor(kind);

  // 其他窗口保存或后台记录了新版本：刷新列表
  useEffect(() => {
    if (!open || !path) return;
    let timer: number | undefined;
    const unlisten = onHistoryChanged((p) => {
      if (!samePath(p.path, path)) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void refresh();
        setContentRevision((n) => n + 1);
      }, 200);
    });
    return () => {
      window.clearTimeout(timer);
      void unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [open, path, refresh]);

  // 选中项滚动到可见区域
  useEffect(() => {
    if (!selectedId) return;
    listRef.current?.querySelector<HTMLElement>(`[data-entry-id="${selectedId}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  const moveSelection = useCallback((delta: number) => {
    const list = useVersionHistoryStore.getState().entries;
    const index = list.findIndex((e) => e.id === useVersionHistoryStore.getState().selectedId);
    const next = list[Math.max(0, Math.min(list.length - 1, index + delta))];
    if (next) select(next.id);
  }, [select]);

  // 键盘：Esc 退出；↑/↓ 切换版本；Alt+↑/↓ 跳转改动
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"], .nb-sync-dialog-overlay')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        if (e.key === 'ArrowDown') navigatorRef.current?.next();
        else navigatorRef.current?.prev();
      } else if (!e.ctrlKey && !e.metaKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        moveSelection(e.key === 'ArrowDown' ? 1 : -1);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [open, close, moveSelection]);

  if (!open) return null;

  const blocked = restoreBlockedReason(docKey);
  const isLatest = selIndex === 0;
  const restoreDisabledReason = !selected ? '请选择版本' : isLatest ? '已是最新版本' : blocked;

  const doRestore = async () => {
    if (!docKey || !selected || restoreDisabledReason) return;
    setRestoring(true);
    const result = await restoreVersion(docKey, selected);
    setRestoring(false);
    if (result.ok) {
      showToast(`已还原到 ${formatEntryTime(selected.at)} 的版本`, 'success');
      close();
    } else {
      showToast(result.message, 'error', 5000);
    }
  };

  const togglePin = async (entry: HistoryEntry) => {
    if (!path) return;
    try {
      await ipc.historyPin(path, entry.id, !entry.pinned);
      await refresh();
    } catch (err) {
      showToast(`操作失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  const deleteEntry = async (entry: HistoryEntry) => {
    if (!path) return;
    try {
      await ipc.historyDeleteEntry(path, entry.id);
      dropVersionContent(path, entry.id);
      await refresh();
    } catch (err) {
      showToast(`删除失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  // ── 主区内容 ──
  let stage: React.ReactNode;
  if (status === 'loading' && entries.length === 0) {
    stage = (
      <div className="nb-vh-loading">
        <Loader2 size={16} className="nb-sync-spin" />
        正在加载
      </div>
    );
  } else if (status === 'error') {
    stage = (
      <div className="nb-vh-empty">
        <div className="nb-vh-empty-title">读取历史失败</div>
        <div>{error}</div>
      </div>
    );
  } else if (config?.mode === 'off') {
    stage = (
      <div className="nb-vh-empty">
        <div className="nb-vh-empty-title">历史记录未开启</div>
        <div>开启后每次保存都会留下版本</div>
        <button type="button" className="nb-btn-primary" onClick={openHistorySettings}>
          <Settings size={14} />
          去开启
        </button>
      </div>
    );
  } else if (!path) {
    stage = (
      <div className="nb-vh-empty">
        <div className="nb-vh-empty-title">暂无历史版本</div>
        <div>保存文档后开始记录</div>
      </div>
    );
  } else if (entries.length === 0) {
    stage = (
      <div className="nb-vh-empty">
        <div className="nb-vh-empty-title">暂无历史版本</div>
        <div>下次保存时开始记录</div>
      </div>
    );
  } else if (target.error) {
    stage = (
      <div className="nb-vh-empty">
        <div className="nb-vh-empty-title">无法读取此版本</div>
        <div>{target.error}</div>
      </div>
    );
  } else if (target.content === null || (baseEntry && base.content === null && !base.error)) {
    stage = (
      <div className="nb-vh-loading">
        <Loader2 size={16} className="nb-sync-spin" />
        正在读取版本
      </div>
    );
  } else {
    stage = (
      <>
        {!baseEntry && showChanges && <div className="nb-vh-banner">最早的版本，没有可对比的内容</div>}
        <Suspense
          fallback={
            <div className="nb-vh-loading">
              <Loader2 size={16} className="nb-sync-spin" />
              正在加载
            </div>
          }
        >
          <Viewer
            key={`${docKey}:${kind}`}
            path={path}
            docKey={docKey ?? path}
            kind={kind}
            base={baseEntry ? base.content : null}
            target={target.content}
            showChanges={showChanges}
            onChangeInfo={setChangeInfo}
            navigatorRef={navigatorRef}
          />
        </Suspense>
      </>
    );
  }

  const subtitle = selected
    ? `${formatEntryTime(selected.at)} · ${selected.isOwn ? '本机' : selected.origin.name || '其他设备'}`
    : '历史记录';
  const hasChanges = showChanges && changeInfo.count > 0;

  /** 上一处 / 下一处（桌面在顶栏，移动端悬浮在正文右下角） */
  const navButtons = (
    <>
      <Tooltip content="上一处" shortcut="Alt+↑" side="bottom" sideOffset={6} delayDuration={100}>
        <button
          type="button"
          className="nb-vh-btn nb-vh-icon-btn is-outline"
          aria-label="上一处"
          disabled={!hasChanges || changeInfo.index <= 0}
          onClick={() => navigatorRef.current?.prev()}
        >
          <ChevronUp size={15} />
        </button>
      </Tooltip>
      <Tooltip content="下一处" shortcut="Alt+↓" side="bottom" sideOffset={6} delayDuration={100}>
        <button
          type="button"
          className="nb-vh-btn nb-vh-icon-btn is-outline"
          aria-label="下一处"
          disabled={!hasChanges || changeInfo.index >= changeInfo.count - 1}
          onClick={() => navigatorRef.current?.next()}
        >
          <ChevronDown size={15} />
        </button>
      </Tooltip>
    </>
  );
  const counter = (
    <span className="nb-vh-counter">
      改动 {hasChanges ? <strong>{Math.max(1, changeInfo.index + 1)}</strong> : <strong>0</strong>}
      /{hasChanges ? changeInfo.count : 0}
    </span>
  );

  return (
    <div className={`nb-vh-root${IS_MOBILE_UI ? ' is-mobile' : ''}`} role="region" aria-label="历史记录">
      <div className="nb-vh-topbar">
        <div className="nb-vh-topbar-left">
          <Tooltip content="返回文档" shortcut="Esc" side="bottom" sideOffset={6} delayDuration={100}>
            <button type="button" className="nb-vh-btn" aria-label="返回文档" onClick={close}>
              <ArrowLeft size={IS_MOBILE_UI ? 20 : 15} />
              {!IS_MOBILE_UI && '返回文档'}
            </button>
          </Tooltip>
          <div className="nb-vh-title">
            <span className="nb-vh-title-name">{displayName}</span>
            <span className="nb-vh-title-sub">{subtitle}</span>
          </div>
        </div>
        <div className="nb-vh-topbar-center">
          <Tooltip content={restoreDisabledReason ?? '替换当前内容，可撤销'} side="bottom" sideOffset={6} delayDuration={100}>
            <span style={{ display: 'inline-flex' }}>
              <button
                type="button"
                className="nb-btn-primary"
                disabled={Boolean(restoreDisabledReason) || restoring}
                onClick={() => void doRestore()}
              >
                {restoring ? <Loader2 size={14} className="nb-sync-spin" /> : <RotateCcw size={14} />}
                还原此版本
              </button>
            </span>
          </Tooltip>
        </div>
        <div className="nb-vh-topbar-right">
          {IS_MOBILE_UI ? (
            <>
              <button
                type="button"
                className="nb-vh-btn nb-vh-icon-btn"
                aria-label="还原此版本"
                disabled={Boolean(restoreDisabledReason) || restoring}
                onClick={() => void doRestore()}
              >
                {restoring ? <Loader2 size={18} className="nb-sync-spin" /> : <RotateCcw size={18} />}
              </button>
              <button
                type="button"
                className={`nb-vh-btn nb-vh-icon-btn${listOpen ? ' is-on' : ''}`}
                aria-label="版本列表"
                aria-expanded={listOpen}
                onClick={() => setListOpen(!listOpen)}
              >
                <ListOrdered size={18} />
              </button>
            </>
          ) : (
            <>
              {counter}
              {navButtons}
            </>
          )}
        </div>
      </div>

      <div className="nb-vh-body">
        <div className="nb-vh-stage">
          {stage}
          {IS_MOBILE_UI && hasChanges && (
            <div className="nb-vh-float-nav">
              {counter}
              {navButtons}
            </div>
          )}
        </div>

        <aside className={`nb-vh-panel${IS_MOBILE_UI ? ' is-sheet' : ''}${listOpen ? ' is-open' : ''}`} aria-label="版本列表">
          <div className="nb-vh-panel-head">
            历史记录
            <Tooltip content="保存时自动记录，短时间内的连续保存合为一版" side="bottom" sideOffset={4} delayDuration={100}>
              <span className="nb-vh-help" aria-label="说明">
                <HelpCircle size={14} />
              </span>
            </Tooltip>
            <span style={{ flex: 1 }} />
            <Tooltip content="历史记录设置" side="bottom" sideOffset={4} delayDuration={100}>
              <button type="button" className="nb-vh-mini-btn" aria-label="历史记录设置" onClick={openHistorySettings}>
                <Settings size={14} />
              </button>
            </Tooltip>
          </div>
          <div className="nb-vh-list" ref={listRef} role="listbox" aria-label="版本">
            {groups.map((group) => (
              <div key={group.key}>
                <div className="nb-vh-month">{group.label}</div>
                {group.entries.map((entry) => {
                  const active = entry.id === selectedId;
                  const isFirst = entry.id === entries[0]?.id;
                  return (
                    <div
                      key={entry.id}
                      data-entry-id={entry.id}
                      role="option"
                      aria-selected={active}
                      tabIndex={0}
                      className={`nb-vh-item${active ? ' is-active' : ''}`}
                      onClick={() => {
                        select(entry.id);
                        setListOpen(false);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          select(entry.id);
                        }
                      }}
                    >
                      <div className="nb-vh-item-time">
                        {formatEntryTime(entry.at)}
                        {isFirst && <span className="nb-vh-badge">最新</span>}
                        {entry.pinned && (
                          <span className="nb-vh-pin" aria-label="已固定">
                            <Pin size={11} />
                          </span>
                        )}
                      </div>
                      <div className="nb-vh-item-desc">{describeEntry(entry, entries)}</div>
                      <div className="nb-vh-item-device">
                        <span className="nb-vh-dot" style={{ background: deviceColor(entry.origin.device) }} />
                        {entry.isOwn ? `${entry.origin.name || '本机'}（本机）` : entry.origin.name || '其他设备'}
                      </div>
                      <div className="nb-vh-item-actions">
                        {/* 其他设备的版本只读：固定与删除只对本机版本开放 */}
                        {entry.isOwn && (
                          <Tooltip content={entry.pinned ? '取消固定' : '固定，不自动清理'} side="top" sideOffset={4} delayDuration={100}>
                            <button
                              type="button"
                              className="nb-vh-mini-btn"
                              aria-label={entry.pinned ? '取消固定' : '固定'}
                              onClick={(e) => {
                                e.stopPropagation();
                                void togglePin(entry);
                              }}
                            >
                              {entry.pinned ? <PinOff size={13} /> : <Pin size={13} />}
                            </button>
                          </Tooltip>
                        )}
                        {entry.isOwn && !isFirst && (
                          <Tooltip content="删除此版本" side="top" sideOffset={4} delayDuration={100}>
                            <button
                              type="button"
                              className="nb-vh-mini-btn is-danger"
                              aria-label="删除此版本"
                              onClick={(e) => {
                                e.stopPropagation();
                                void deleteEntry(entry);
                              }}
                            >
                              <Trash2 size={13} />
                            </button>
                          </Tooltip>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="nb-vh-panel-foot">
            <span>显示更改</span>
            <button
              type="button"
              role="switch"
              aria-checked={showChanges}
              aria-label="显示更改"
              className={`nb-vh-switch${showChanges ? ' is-on' : ''}`}
              onClick={() => setShowChanges(!showChanges)}
            />
          </div>
        </aside>
      </div>
    </div>
  );
}
