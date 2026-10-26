// 首次配对的同名更新确认：全局显示、默认聚焦取消，所有主题使用现有语义色变量。
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, FileText, RefreshCw, Loader2, X } from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';
import * as ipc from '../../core/ipc/commands';
import { useSyncStore, SYNC_TOAST_KEY } from '../../stores/syncStore';
import { showToast } from '../../stores/toastStore';
import { errorText, formatDateTime, formatSize, useEscapeToClose } from './SyncControls';
import './sync.css';

/** 确认仅针对当前列表；文件内容变化、其他窗口决定或配置变化会由后台使其失效。 */
export function SyncUpdateDialog() {
  const pending = useSyncStore((state) => state.status?.updateConfirmation);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // 同步 ref 阻止快速双击在 React 提交状态前重复消费确认标识。
  const deciding = useRef(false);

  const decide = useCallback(async (accept: boolean) => {
    if (!pending || deciding.current) return;
    deciding.current = true;
    setBusy(true);
    setError('');
    try {
      await ipc.syncResolveUpdates(pending.id, accept);
      // 后台通过事件推送最新状态；只清理本次标识，避免旧请求的响应盖掉新一轮确认。
      useSyncStore.setState((state) => state.status?.updateConfirmation?.id === pending.id
        ? { status: { ...state.status, updateConfirmation: null, syncPaused: !accept } } : {});
      if (!accept) showToast('已暂停同步，文件未更新', 'info', 4000, SYNC_TOAST_KEY);
    } catch (failure) {
      if (useSyncStore.getState().status?.updateConfirmation?.id === pending.id) setError(errorText(failure));
    } finally {
      deciding.current = false;
      setBusy(false);
    }
  }, [pending]);
  const cancel = useCallback(() => { void decide(false); }, [decide]);
  useEscapeToClose(!!pending && !busy, cancel);

  useEffect(() => {
    if (!pending) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    // 限制键盘焦点留在确认框内，关闭后恢复原来的操作位置。
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const buttons = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      const first = buttons[0];
      const last = buttons.at(-1);
      if (!first || !last) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', trap, true);
    return () => { window.removeEventListener('keydown', trap, true); if (previous?.isConnected) previous.focus(); };
  }, [pending?.id]);

  if (!pending) return null;
  return (
    <div className="nb-sync-dialog-overlay" role="dialog" aria-modal="true" aria-labelledby="nb-sync-update-title" aria-describedby="nb-sync-update-description" onMouseDown={(event) => event.stopPropagation()}>
      <div className="nb-sync-dialog nb-sync-update-dialog" ref={dialogRef} aria-busy={busy}>
        <div className="nb-sync-dialog-head">
          <div className="nb-sync-dialog-title" id="nb-sync-update-title"><RefreshCw size={17} />确认文件更新</div>
          <Tooltip content="暂不同步" shortcut="Esc" side="bottom">
            <button type="button" className="nb-sync-icon-btn" aria-label="暂不同步" disabled={busy} onClick={cancel}><X size={16} /></button>
          </Tooltip>
        </div>
        <div className="nb-sync-dialog-body">
          <p id="nb-sync-update-description">以下同名文件的内容不同，将按修改时间使用较新版本。请确认更新方向后继续同步。</p>
          <ul className="nb-sync-update-list" aria-label="待更新文件">
            {pending.files.map((file) => (
              <li className="nb-sync-update-file" key={file.path}>
                <div className="nb-sync-update-file-head"><FileText size={16} /><span className="nb-sync-update-path">{file.path}</span></div>
                <div className="nb-sync-update-direction">{file.direction === 'upload' ? <ArrowUpRight size={14} /> : <ArrowDownLeft size={14} />}{file.direction === 'upload' ? '本机 → 远端' : '远端 → 本机'}</div>
                <div className="nb-sync-update-times"><span>本机 · {file.localMtime > 0 ? formatDateTime(file.localMtime) : '时间未知'} · {formatSize(file.localSize)}</span><span>远端 · {file.remoteMtime > 0 ? formatDateTime(file.remoteMtime) : '时间未知'} · {formatSize(file.remoteSize)}</span></div>
              </li>
            ))}
          </ul>
          <p className="nb-sync-muted">内容相同的文件不会重复更新；仅远端存在的文件会下载到本机。修改时间相同时优先使用本机版本。</p>
          {error && <p className="nb-sync-test-result is-error" role="alert">{error}</p>}
        </div>
        <div className="nb-sync-dialog-foot">
          <button type="button" className="nb-btn-secondary" ref={cancelRef} disabled={busy} onClick={cancel}>暂不同步</button>
          <button type="button" className="nb-btn-primary" disabled={busy} onClick={() => void decide(true)}>{busy ? <Loader2 size={14} className="nb-sync-spin" /> : <RefreshCw size={14} />}确认更新并同步</button>
        </div>
      </div>
    </div>
  );
}
