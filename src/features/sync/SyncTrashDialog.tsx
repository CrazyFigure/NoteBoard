// NoteBoard 同步回收站弹窗
// 列出同步文件夹回收站中的条目：原位置、删除时间、剩余保留天数；支持恢复、彻底删除与清空。
// 回收站中的文件不能直接打开；恢复时原位置已有同名文件会自动追加序号。

import { useCallback, useEffect, useState } from 'react';
import { File, Folder, Loader2, RotateCcw, Trash2, X } from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';
import * as ipc from '../../core/ipc/commands';
import type { SyncTrashItem } from '../../core/ipc/types';
import { syncTrashPath, SYNC_TOAST_KEY, useSyncStore } from '../../stores/syncStore';
import { showToast } from '../../stores/toastStore';
import { joinPath } from '../explorer/pathUtils';
import { applySyncChanges, refreshExplorer } from './syncEffects';
import { ConfirmDialog, errorText, formatDateTime, formatSize, useEscapeToClose } from './SyncControls';
import './sync.css';

const DAY_MS = 24 * 3600 * 1000;

/** 剩余保留时间描述 */
function remainingText(item: SyncTrashItem, now: number): { text: string; urgent: boolean } {
  if (!item.expiresAt) return { text: '不会自动删除', urgent: false };
  const left = item.expiresAt - now;
  if (left <= 0) return { text: '即将彻底删除', urgent: true };
  const days = Math.ceil(left / DAY_MS);
  if (days <= 1) return { text: '1 天内彻底删除', urgent: true };
  return { text: `${days} 天后彻底删除`, urgent: days <= 3 };
}

export function SyncTrashDialog() {
  const open = useSyncStore((s) => s.trashOpen);
  const setOpen = useSyncStore((s) => s.setTrashOpen);
  const config = useSyncStore((s) => s.config);
  const [items, setItems] = useState<SyncTrashItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ type: 'delete'; item: SyncTrashItem } | { type: 'empty' } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const close = useCallback(() => setOpen(false), [setOpen]);
  useEscapeToClose(open && !confirm, close);

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(await ipc.syncTrashList());
    } catch (e) {
      setItems([]);
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    if (open) {
      setItems(null);
      void load();
    }
  }, [open, load]);

  if (!open) return null;
  const root = config?.sync.rootDir ?? '';
  const trash = syncTrashPath(config);
  const now = Date.now();

  /** 回收站目录变化后刷新文件树（回收站节点所在的同步根目录） */
  const refreshTrashNode = async () => {
    if (trash) await refreshExplorer([joinPath(trash, '_')]);
  };

  const restore = async (item: SyncTrashItem) => {
    setBusyId(item.id);
    try {
      const restored = await ipc.syncTrashRestore(item.id);
      showToast(`已恢复到：${restored}`, 'success', 5000, SYNC_TOAST_KEY);
      // 原路径上若有已打开、被标记为已删除的文档，恢复后自动解除断开状态并重新加载
      await applySyncChanges([{ kind: 'added', path: restored }]);
      await refreshTrashNode();
      await load();
    } catch (e) {
      showToast(`恢复失败：${errorText(e)}`, 'error', 6000, SYNC_TOAST_KEY);
    } finally {
      setBusyId(null);
    }
  };

  const confirmAction = async () => {
    if (!confirm) return;
    setConfirmBusy(true);
    try {
      if (confirm.type === 'delete') {
        await ipc.syncTrashDelete(confirm.item.id);
        showToast(`已彻底删除「${confirm.item.name}」`, 'success', 4000, SYNC_TOAST_KEY);
      } else {
        const n = await ipc.syncTrashEmpty();
        showToast(`已清空回收站（${n} 项）`, 'success', 4000, SYNC_TOAST_KEY);
      }
      await refreshTrashNode();
      setConfirm(null);
      await load();
    } catch (e) {
      showToast(errorText(e), 'error', 6000, SYNC_TOAST_KEY);
    } finally {
      setConfirmBusy(false);
    }
  };

  return (
    <div className="nb-sync-dialog-overlay" role="dialog" aria-modal="true" aria-label="回收站" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="nb-sync-dialog">
        <div className="nb-sync-dialog-head">
          <div className="nb-sync-dialog-title">
            <Trash2 size={16} color="var(--accent-strong)" />
            回收站
            {items && items.length > 0 && <span className="nb-sync-muted">（{items.length} 项）</span>}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              type="button"
              className="nb-btn-danger"
              disabled={!items || items.length === 0}
              onClick={() => setConfirm({ type: 'empty' })}
            >
              清空回收站
            </button>
            <Tooltip content="关闭" shortcut="Esc" side="bottom" sideOffset={4}>
              <button type="button" className="nb-sync-icon-btn" aria-label="关闭" onClick={close}>
                <X size={15} />
              </button>
            </Tooltip>
          </div>
        </div>
        <div className="nb-sync-dialog-body">
          <div className="nb-sync-muted">
            {config?.sync.trashEnabled
              ? `同步文件夹中删除的文件会保留在这里${config.sync.trashDays > 0 ? ` ${config.sync.trashDays} 天` : ''}，并同步到其他设备。`
              : '回收站当前未启用，新的删除不会再进入回收站；已有条目仍可恢复。'}
            回收站中的文件不能直接打开，恢复后即可使用；原位置已有同名文件时会自动重命名。
            {root ? '' : ' 尚未设置同步文件夹。'}
          </div>
          {error && <div className="nb-sync-test-result is-error">{error}</div>}
          {!items ? (
            <div className="nb-sync-list-empty">
              <Loader2 size={16} className="nb-sync-spin" />
            </div>
          ) : (
            <div className="nb-sync-list">
              {items.length === 0 && <div className="nb-sync-list-empty">回收站是空的</div>}
              {items.map((item) => {
                const remain = remainingText(item, now);
                return (
                  <div key={item.id} className="nb-sync-list-item">
                    {item.isDir ? <Folder size={16} /> : <File size={16} />}
                    <div className="nb-sync-list-main">
                      <Tooltip content={`原位置：${item.origPath}`} side="top" sideOffset={4}>
                        <span className="nb-sync-list-name">{item.name}</span>
                      </Tooltip>
                      <span className="nb-sync-list-meta">
                        原位置：{item.origPath || '同步文件夹根目录'} · 删除于 {formatDateTime(item.trashedAt)} ·{' '}
                        <span className={remain.urgent ? 'is-urgent' : ''}>{remain.text}</span>
                        {item.isDir ? ` · ${item.fileCount} 个文件` : ''} · {formatSize(item.size)}
                      </span>
                    </div>
                    <div className="nb-sync-list-actions">
                      <Tooltip content="恢复到原位置" side="top" sideOffset={4}>
                        <button type="button" className="nb-sync-icon-btn" disabled={busyId !== null} onClick={() => void restore(item)}>
                          {busyId === item.id ? <Loader2 size={15} className="nb-sync-spin" /> : <RotateCcw size={15} />}
                        </button>
                      </Tooltip>
                      <Tooltip content="彻底删除" side="top" sideOffset={4}>
                        <button
                          type="button"
                          className="nb-sync-icon-btn is-danger"
                          disabled={busyId !== null}
                          onClick={() => setConfirm({ type: 'delete', item })}
                        >
                          <Trash2 size={15} />
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.type === 'empty' ? '清空回收站' : '彻底删除'}
        confirmLabel={confirm?.type === 'empty' ? '全部删除' : '彻底删除'}
        danger
        busy={confirmBusy}
        onConfirm={() => void confirmAction()}
        onClose={() => !confirmBusy && setConfirm(null)}
      >
        {confirm?.type === 'empty'
          ? `将永久删除回收站中的全部 ${items?.length ?? 0} 项，其他设备的回收站也会同步清空。此操作无法撤销。`
          : `将永久删除「${confirm?.type === 'delete' ? confirm.item.name : ''}」，其他设备的回收站中也会一并删除。此操作无法撤销。`}
      </ConfirmDialog>
    </div>
  );
}
