// NoteBoard 设置 → 同步与备份
// 多端同步（WebDAV / S3 / GitHub / Gitee / GitLab）、同步时机、同步回收站、备份与恢复。
// 配置修改后防抖自动保存（与其他设置项一致，无需点击保存按钮）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Archive,
  ArchiveRestore,
  CheckCircle2,
  Clock,
  Cloud,
  Copy,
  FolderOpen,
  FolderOutput,
  Info,
  Loader2,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { Tooltip } from '../../components/Tooltip';
import * as ipc from '../../core/ipc/commands';
import type { BackupInfo, SyncConfigFile, SyncProviderConfig } from '../../core/ipc/types';
import { IS_MOBILE_UI } from '../../core/platform';
import { describeSyncReport, SYNC_TOAST_KEY, useSyncStore } from '../../stores/syncStore';
import { showToast } from '../../stores/toastStore';
import { ConfirmDialog, errorText, formatDateTime, formatRelative, formatSize, ProviderForm } from './SyncControls';
import './sync.css';

const SAVE_DEBOUNCE_MS = 600;

/** 深拷贝配置，避免表单修改直接影响 store 中的对象 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function SyncPanel() {
  const storeConfig = useSyncStore((s) => s.config);
  const status = useSyncStore((s) => s.status);
  const saveConfig = useSyncStore((s) => s.saveConfig);
  const setTrashOpen = useSyncStore((s) => s.setTrashOpen);
  const [draft, setDraft] = useState<SyncConfigFile | null>(() => (storeConfig ? clone(storeConfig) : null));
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<SyncConfigFile | null>(null);

  // 首次加载或其他窗口修改配置时同步到表单（本窗口有未保存输入时不覆盖）
  useEffect(() => {
    if (!storeConfig || pendingRef.current) return;
    setDraft((current) => (current && JSON.stringify(current) === JSON.stringify(storeConfig) ? current : clone(storeConfig)));
  }, [storeConfig]);

  useEffect(() => {
    if (!storeConfig) void useSyncStore.getState().init();
  }, [storeConfig]);

  const flush = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    try {
      await saveConfig(pending);
    } catch (error) {
      showToast(`保存同步设置失败：${errorText(error)}`, 'error', 6000);
    }
  }, [saveConfig]);

  // 关闭设置页时立即保存未落盘的输入
  useEffect(() => () => void flush(), [flush]);

  // 表单最新值（update 基于它计算，避免在 setState 回调中产生副作用）
  const draftRef = useRef(draft);
  draftRef.current = draft;

  /** 修改配置：立即更新表单，防抖保存；immediate 用于开关等需要马上生效的操作 */
  const update = useCallback(
    (mutate: (cfg: SyncConfigFile) => void, immediate = false) => {
      const current = pendingRef.current ?? draftRef.current;
      if (!current) return;
      const next = clone(current);
      mutate(next);
      pendingRef.current = next;
      draftRef.current = next;
      setDraft(next);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => void flush(), immediate ? 0 : SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  if (!draft) {
    return (
      <div className="nb-sync-panel">
        <div className="nb-sync-muted">
          <Loader2 size={14} className="nb-sync-spin" style={{ verticalAlign: -2, marginRight: 6 }} />
          正在加载同步设置
        </div>
      </div>
    );
  }

  return (
    <div className="nb-sync-panel">
      <div>
        <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>同步与备份</h3>
        <p style={{ fontSize: 12, color: 'var(--editor-text-muted)', margin: 0 }}>
          在多台电脑和手机之间双向同步一个文件夹，并定期把它备份到本地或云端。
        </p>
      </div>
      <SyncSection draft={draft} update={update} flush={flush} />
      <ProviderSection draft={draft} update={update} />
      <TimingSection draft={draft} update={update} nextSyncAt={status?.nextSyncAt ?? 0} />
      <TrashSection draft={draft} update={update} onOpenTrash={() => setTrashOpen(true)} />
      <BackupSection draft={draft} update={update} flush={flush} />
    </div>
  );
}

type UpdateFn = (mutate: (cfg: SyncConfigFile) => void, immediate?: boolean) => void;

// ── 多端同步：开关、同步文件夹、状态 ──

function SyncSection({ draft, update, flush }: { draft: SyncConfigFile; update: UpdateFn; flush: () => Promise<void> }) {
  const status = useSyncStore((s) => s.status);
  const last = status?.lastSync ?? null;
  const syncing = status?.syncing ?? false;
  const [mobilePath, setMobilePath] = useState(draft.sync.rootDir);

  useEffect(() => setMobilePath(draft.sync.rootDir), [draft.sync.rootDir]);

  const chooseFolder = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === 'string') update((c) => (c.sync.rootDir = selected), true);
  };

  const useDefaultWorkspace = async () => {
    try {
      const dir = await ipc.ensureDefaultWorkspace();
      update((c) => (c.sync.rootDir = dir), true);
    } catch (error) {
      showToast(errorText(error), 'error');
    }
  };

  const syncNow = async () => {
    await flush();
    try {
      await ipc.syncNow();
      showToast('正在同步…', 'info', 2500, SYNC_TOAST_KEY);
    } catch (error) {
      showToast(errorText(error), 'warning', 5000, SYNC_TOAST_KEY);
    }
  };

  const statusClass = syncing ? 'is-running' : !last ? '' : !last.ok ? 'is-error' : last.errors.length ? 'is-warn' : 'is-ok';
  const statusIcon = syncing ? (
    <Loader2 size={16} className="nb-sync-spin" />
  ) : !last ? (
    <Clock size={16} />
  ) : !last.ok ? (
    <AlertCircle size={16} />
  ) : (
    <CheckCircle2 size={16} />
  );

  return (
    <div className="nb-sync-card">
      <div className="nb-sync-card-head">
        <div className="nb-sync-card-title">
          <Cloud size={15} />
          <span>多端同步</span>
        </div>
      </div>

      <div className={`nb-sync-status ${statusClass}`}>
        <div className="nb-sync-status-main">
          {statusIcon}
          <div className="nb-sync-status-text">
            <span>
              {syncing ? '正在同步…' : last ? describeSyncReport(last) : draft.sync.enabled ? '尚未同步' : '多端同步未开启'}
            </span>
            {last && !syncing && (
              <span className="nb-sync-muted">
                上次同步：{formatDateTime(last.at)}（{formatRelative(last.at)}）
                {last.durationMs > 0 ? ` · 耗时 ${(last.durationMs / 1000).toFixed(1)} 秒` : ''}
              </span>
            )}
            {last && !syncing && last.errors.length > 1 && (
              <span className="nb-sync-muted" style={{ whiteSpace: 'pre-wrap' }}>
                {last.errors.slice(0, 5).join('\n')}
                {last.errors.length > 5 ? `\n…共 ${last.errors.length} 条` : ''}
              </span>
            )}
          </div>
        </div>
        <button type="button" className="nb-btn-primary" disabled={!draft.sync.enabled || syncing || !draft.sync.rootDir} onClick={syncNow}>
          <RefreshCw size={14} className={syncing ? 'nb-sync-spin' : ''} />
          立即同步
        </button>
      </div>

      <label className="nb-sync-row">
        <div>
          <div>开启多端同步</div>
          <div className="nb-sync-muted">默认关闭。开启后会立即在后台同步一次，不影响正常编辑。</div>
        </div>
        <input type="checkbox" checked={draft.sync.enabled} onChange={(e) => update((c) => (c.sync.enabled = e.target.checked), true)} />
      </label>

      <div className="nb-sync-notice">
        <Info size={15} />
        <div>
          <strong style={{ color: 'var(--editor-text)' }}>同步规则</strong>
          <ul>
            <li>多台设备之间<strong>双向同步</strong>：任一设备上的新增、修改、删除、重命名都会同步到其他设备。</li>
            <li>
              同一个文件在多台设备上被同时修改（包括一端修改、另一端删除）时，<strong>以最后一次操作的结果为准</strong>；
              Markdown、纯文本等文档如果两端改的是不同段落，会按行合并、两边的修改都保留。
            </li>
            <li>正在编辑的文件被其他设备删除时，你的未保存修改不会丢失，保存后会作为新文件重新创建。</li>
            <li>同步文件夹中的所有文件（包括 NoteBoard 不能打开的格式、图片、附件）都会同步；空文件夹不会同步。</li>
            <li>启用回收站时，被删除的文件会先进入回收站，在任一设备上都可以恢复。</li>
          </ul>
        </div>
      </div>

      <div className="nb-sync-field">
        <span>同步文件夹</span>
        <div className="nb-sync-path">
          {IS_MOBILE_UI ? (
            <input
              className="nb-sync-input"
              type="text"
              value={mobilePath}
              placeholder="例如 /storage/emulated/0/Notes"
              onChange={(e) => setMobilePath(e.target.value)}
              onBlur={() => mobilePath.trim() !== draft.sync.rootDir && update((c) => (c.sync.rootDir = mobilePath.trim()), true)}
            />
          ) : (
            <Tooltip content={draft.sync.rootDir} disabled={!draft.sync.rootDir} side="top" sideOffset={4}>
              <input className="nb-sync-input" type="text" readOnly value={draft.sync.rootDir} placeholder="尚未选择" />
            </Tooltip>
          )}
          {IS_MOBILE_UI ? (
            <button type="button" className="nb-btn-secondary" onClick={useDefaultWorkspace}>
              使用「我的笔记」
            </button>
          ) : (
            <>
              <button type="button" className="nb-btn-secondary" onClick={chooseFolder}>
                <FolderOpen size={14} />
                选择文件夹
              </button>
              {draft.sync.rootDir && (
                <Tooltip content="在文件管理器中打开" side="top" sideOffset={4}>
                  <button type="button" className="nb-sync-icon-btn" onClick={() => void ipc.revealInExplorer(draft.sync.rootDir).catch(() => {})}>
                    <FolderOutput size={15} />
                  </button>
                </Tooltip>
              )}
            </>
          )}
        </div>
        <small>
          只有这个文件夹（含子文件夹）参与同步。多台设备请选择各自存放笔记的文件夹，首次同步时同名文件会自动配对。
          {IS_MOBILE_UI ? ' 使用手机存储中的文件夹需要先授予「所有文件访问权限」。' : ''}
        </small>
      </div>

      <label className="nb-sync-field">
        <span>本机名称</span>
        <input
          className="nb-sync-input"
          type="text"
          value={draft.sync.deviceName}
          maxLength={32}
          onChange={(e) => update((c) => (c.sync.deviceName = e.target.value))}
        />
        <small>用于区分是哪台设备在同步、哪台设备产生的备份</small>
      </label>
    </div>
  );
}

// ── 同步服务 ──

function ProviderSection({ draft, update }: { draft: SyncConfigFile; update: UpdateFn }) {
  const onChange = (provider: SyncProviderConfig) => update((c) => (c.sync.provider = provider));
  return (
    <div className="nb-sync-card">
      <div className="nb-sync-card-head">
        <div className="nb-sync-card-title">
          <Cloud size={15} />
          <span>同步方式</span>
        </div>
        <span className="nb-sync-muted">密码与令牌加密保存在本机，不会上传</span>
      </div>
      <ProviderForm value={draft.sync.provider} onChange={onChange} />
    </div>
  );
}

// ── 同步时机 ──

function TimingSection({ draft, update, nextSyncAt }: { draft: SyncConfigFile; update: UpdateFn; nextSyncAt: number }) {
  return (
    <div className="nb-sync-card">
      <div className="nb-sync-card-title">
        <Clock size={15} />
        <span>同步时机</span>
      </div>
      <label className="nb-sync-row">
        <div>
          <div>保存后同步</div>
          <div className="nb-sync-muted">每次手动或自动保存后同步；连续保存会合并，停止保存约 3 秒后同步一次</div>
        </div>
        <input type="checkbox" checked={draft.sync.syncOnSave} onChange={(e) => update((c) => (c.sync.syncOnSave = e.target.checked), true)} />
      </label>
      <div className="nb-sync-row">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', flex: 1 }}>
          <input
            type="checkbox"
            checked={draft.sync.intervalEnabled}
            onChange={(e) => update((c) => (c.sync.intervalEnabled = e.target.checked), true)}
          />
          <div>
            <div>定时同步</div>
            <div className="nb-sync-muted">
              拉取其他设备的改动
              {draft.sync.enabled && draft.sync.intervalEnabled && nextSyncAt > 0 ? ` · 下次约 ${formatRelative(nextSyncAt)}` : ''}
            </div>
          </div>
        </label>
        <div className="nb-sync-row-inline">
          每
          <input
            className="nb-sync-input is-number"
            type="number"
            min={1}
            max={1440}
            value={draft.sync.intervalMinutes}
            disabled={!draft.sync.intervalEnabled}
            onChange={(e) => update((c) => (c.sync.intervalMinutes = Math.max(1, parseInt(e.target.value, 10) || 1)))}
          />
          分钟
        </div>
      </div>
      <label className="nb-sync-row">
        <div>
          <div>启动后同步</div>
          <div className="nb-sync-muted">每次打开 NoteBoard 后在后台同步一次，不阻塞正常使用</div>
        </div>
        <input
          type="checkbox"
          checked={draft.sync.syncOnStartup}
          onChange={(e) => update((c) => (c.sync.syncOnStartup = e.target.checked), true)}
        />
      </label>
      <label className="nb-sync-row">
        <div>
          <div>没有变化时也提示</div>
          <div className="nb-sync-muted">默认只在有增删改、出错或手动同步时弹出结果提示</div>
        </div>
        <input
          type="checkbox"
          checked={draft.sync.notifyNoChange}
          onChange={(e) => update((c) => (c.sync.notifyNoChange = e.target.checked), true)}
        />
      </label>
    </div>
  );
}

// ── 回收站 ──

function TrashSection({ draft, update, onOpenTrash }: { draft: SyncConfigFile; update: UpdateFn; onOpenTrash: () => void }) {
  return (
    <div className="nb-sync-card">
      <div className="nb-sync-card-head">
        <div className="nb-sync-card-title">
          <Trash2 size={15} />
          <span>回收站</span>
        </div>
        <button type="button" className="nb-btn-secondary" disabled={!draft.sync.rootDir} onClick={onOpenTrash}>
          打开回收站
        </button>
      </div>
      <label className="nb-sync-row">
        <div>
          <div>启用回收站</div>
          <div className="nb-sync-muted">
            同步文件夹中删除的文件和文件夹先移入回收站（文件树底部的「回收站」），回收站同样参与同步，任一设备都能恢复；
            关闭后删除会同步为直接删除。
          </div>
        </div>
        <input type="checkbox" checked={draft.sync.trashEnabled} onChange={(e) => update((c) => (c.sync.trashEnabled = e.target.checked), true)} />
      </label>
      <div className="nb-sync-row">
        <div>
          <div>保留天数</div>
          <div className="nb-sync-muted">超过天数后自动彻底删除；填 0 表示不自动删除</div>
        </div>
        <div className="nb-sync-row-inline">
          <input
            className="nb-sync-input is-number"
            type="number"
            min={0}
            max={3650}
            value={draft.sync.trashDays}
            onChange={(e) => update((c) => (c.sync.trashDays = Math.max(0, parseInt(e.target.value, 10) || 0)))}
          />
          天
        </div>
      </div>
    </div>
  );
}

// ── 备份 ──

function BackupSection({ draft, update, flush }: { draft: SyncConfigFile; update: UpdateFn; flush: () => Promise<void> }) {
  const status = useSyncStore((s) => s.status);
  const last = status?.lastBackup ?? null;
  const backingUp = status?.backingUp ?? false;
  const backup = draft.backup;
  const [list, setList] = useState<BackupInfo[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [confirm, setConfirm] = useState<{ type: 'restore-root' | 'delete'; item: BackupInfo } | null>(null);
  const [busy, setBusy] = useState(false);

  // 备份目标配置签名：变化后旧列表作废
  const targetKey = useMemo(
    () => JSON.stringify([backup.target, backup.localDir, backup.target === 'remote' ? backup.provider : null]),
    [backup.target, backup.localDir, backup.provider],
  );

  const refresh = useCallback(async () => {
    await flush();
    setLoadingList(true);
    setListError(null);
    try {
      setList(await ipc.backupList());
    } catch (error) {
      setList(null);
      setListError(errorText(error));
    } finally {
      setLoadingList(false);
    }
  }, [flush]);

  useEffect(() => {
    setList(null);
    setListError(null);
  }, [targetKey]);

  // 一次备份完成后刷新列表
  const lastAt = last?.at ?? 0;
  const listShownRef = useRef(false);
  listShownRef.current = list !== null;
  useEffect(() => {
    // 只在新的备份结果出现时刷新（列表未展开时不主动拉取）
    if (lastAt && listShownRef.current) void refresh();
  }, [lastAt, refresh]);

  const chooseLocalDir = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === 'string') update((c) => (c.backup.localDir = selected), true);
  };

  const backupNow = async () => {
    await flush();
    try {
      await ipc.backupNow();
      showToast('正在备份…', 'info', 2500, SYNC_TOAST_KEY);
    } catch (error) {
      showToast(errorText(error), 'warning', 5000, SYNC_TOAST_KEY);
    }
  };

  const restoreToOther = async (item: BackupInfo) => {
    const selected = await open({ directory: true, multiple: false, title: '选择恢复到的文件夹' });
    if (typeof selected !== 'string') return;
    try {
      const msg = await ipc.backupRestore(item.name, selected);
      showToast(msg, 'success', 6000, SYNC_TOAST_KEY);
    } catch (error) {
      showToast(`恢复失败：${errorText(error)}`, 'error', 7000, SYNC_TOAST_KEY);
    }
  };

  const confirmAction = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.type === 'restore-root') {
        const msg = await ipc.backupRestore(confirm.item.name, null);
        showToast(msg, 'success', 6000, SYNC_TOAST_KEY);
      } else {
        await ipc.backupDelete(confirm.item.name);
        setList((l) => l?.filter((b) => b.name !== confirm.item.name) ?? l);
      }
      setConfirm(null);
    } catch (error) {
      showToast(`${confirm.type === 'delete' ? '删除' : '恢复'}失败：${errorText(error)}`, 'error', 7000, SYNC_TOAST_KEY);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="nb-sync-card">
      <div className="nb-sync-card-title">
        <Archive size={15} />
        <span>备份</span>
      </div>

      <div className={`nb-sync-status ${backingUp ? 'is-running' : !last ? '' : last.ok ? 'is-ok' : 'is-error'}`}>
        <div className="nb-sync-status-main">
          {backingUp ? <Loader2 size={16} className="nb-sync-spin" /> : !last ? <Clock size={16} /> : last.ok ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
          <div className="nb-sync-status-text">
            <span>{backingUp ? '正在备份…' : last ? last.message : '尚未备份'}</span>
            {last && !backingUp && (
              <span className="nb-sync-muted">
                上次备份：{formatDateTime(last.at)}（{formatRelative(last.at)}）
                {status?.nextBackupAt ? ` · 下次自动备份：${formatDateTime(status.nextBackupAt)}` : ''}
              </span>
            )}
          </div>
        </div>
        <button type="button" className="nb-btn-primary" disabled={backingUp || !draft.sync.rootDir} onClick={backupNow}>
          <Archive size={14} />
          立即备份
        </button>
      </div>
      <div className="nb-sync-muted">
        备份同步文件夹中的全部文件（不含回收站），打包为 ZIP；备份与同步开关相互独立，未开启同步也可以备份。
      </div>

      <div className="nb-sync-row">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', flex: 1 }}>
          <input type="checkbox" checked={backup.autoEnabled} onChange={(e) => update((c) => (c.backup.autoEnabled = e.target.checked), true)} />
          <div>
            <div>自动备份</div>
            <div className="nb-sync-muted">按间隔在后台自动备份</div>
          </div>
        </label>
        <div className="nb-sync-row-inline">
          每
          <input
            className="nb-sync-input is-number"
            type="number"
            min={1}
            max={720}
            value={backup.intervalHours}
            disabled={!backup.autoEnabled}
            onChange={(e) => update((c) => (c.backup.intervalHours = Math.max(1, parseInt(e.target.value, 10) || 1)))}
          />
          小时
        </div>
      </div>
      <div className="nb-sync-row">
        <div>
          <div>保留份数</div>
          <div className="nb-sync-muted">只保留本机最新的 N 份备份，更早的自动清理；填 0 表示全部保留</div>
        </div>
        <div className="nb-sync-row-inline">
          <input
            className="nb-sync-input is-number"
            type="number"
            min={0}
            max={1000}
            value={backup.keepCount}
            onChange={(e) => update((c) => (c.backup.keepCount = Math.max(0, parseInt(e.target.value, 10) || 0)))}
          />
          份
        </div>
      </div>

      <div className="nb-sync-field">
        <span>备份位置</span>
        <div className="nb-sync-segment" role="radiogroup" aria-label="备份位置">
          {(
            [
              ['local', '本地文件夹'],
              ['remote', '云端（WebDAV / S3 / Git 仓库）'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={backup.target === value}
              className={`nb-sync-segment-btn${backup.target === value ? ' is-active' : ''}`}
              onClick={() => update((c) => (c.backup.target = value), true)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {backup.target === 'local' ? (
        <div className="nb-sync-field">
          <span>本地备份文件夹</span>
          <div className="nb-sync-path">
            <Tooltip content={backup.localDir} disabled={!backup.localDir} side="top" sideOffset={4}>
              <input className="nb-sync-input" type="text" readOnly value={backup.localDir} placeholder="尚未选择" />
            </Tooltip>
            {!IS_MOBILE_UI && (
              <button type="button" className="nb-btn-secondary" onClick={chooseLocalDir}>
                <FolderOpen size={14} />
                选择文件夹
              </button>
            )}
          </div>
          <small>建议选择另一块硬盘、U 盘或网盘同步目录；不能位于同步文件夹内部</small>
        </div>
      ) : (
        <div className="nb-sync-field">
          <div className="nb-sync-card-head">
            <span style={{ fontSize: 12, fontWeight: 500 }}>云端备份服务</span>
            <button
              type="button"
              className="nb-btn-secondary"
              onClick={() => update((c) => (c.backup.provider = clone(c.sync.provider)), true)}
            >
              <Copy size={13} />
              使用同步方式的配置
            </button>
          </div>
          <small>备份文件保存在远端目录下的 NoteBoard-Backups 文件夹中</small>
          <ProviderForm value={backup.provider} onChange={(provider) => update((c) => (c.backup.provider = provider))} showHelp={false} />
        </div>
      )}

      <div className="nb-sync-field">
        <div className="nb-sync-card-head">
          <span style={{ fontSize: 12, fontWeight: 500 }}>备份列表</span>
          <button type="button" className="nb-btn-secondary" disabled={loadingList} onClick={() => void refresh()}>
            <RefreshCw size={13} className={loadingList ? 'nb-sync-spin' : ''} />
            {list ? '刷新' : '查看备份'}
          </button>
        </div>
        {listError && <div className="nb-sync-test-result is-error">{listError}</div>}
        {list && (
          <div className="nb-sync-list">
            {list.length === 0 && <div className="nb-sync-list-empty">还没有备份</div>}
            {list.map((item) => (
              <div key={item.name} className="nb-sync-list-item">
                <Archive size={15} />
                <div className="nb-sync-list-main">
                  <span className="nb-sync-list-name">
                    {formatDateTime(item.createdAt)}
                    {item.isOwn ? <span className="nb-sync-chip">本机</span> : <span className="nb-sync-chip">{item.device}</span>}
                  </span>
                  <span className="nb-sync-list-meta">
                    {item.size ? `${formatSize(item.size)} · ` : ''}
                    {item.name}
                  </span>
                </div>
                <div className="nb-sync-list-actions">
                  <Tooltip content="恢复到同步文件夹" side="top" sideOffset={4}>
                    <button type="button" className="nb-sync-icon-btn" disabled={!draft.sync.rootDir} onClick={() => setConfirm({ type: 'restore-root', item })}>
                      <ArchiveRestore size={15} />
                    </button>
                  </Tooltip>
                  {!IS_MOBILE_UI && (
                    <Tooltip content="恢复到其他文件夹" side="top" sideOffset={4}>
                      <button type="button" className="nb-sync-icon-btn" onClick={() => void restoreToOther(item)}>
                        <FolderOutput size={15} />
                      </button>
                    </Tooltip>
                  )}
                  <Tooltip content="删除这份备份" side="top" sideOffset={4}>
                    <button type="button" className="nb-sync-icon-btn is-danger" onClick={() => setConfirm({ type: 'delete', item })}>
                      <Trash2 size={15} />
                    </button>
                  </Tooltip>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirm?.type === 'restore-root'}
        title="恢复备份到同步文件夹"
        confirmLabel="恢复"
        busy={busy}
        onConfirm={() => void confirmAction()}
        onClose={() => !busy && setConfirm(null)}
      >
        <div>
          将同步文件夹恢复为 <strong>{confirm ? formatDateTime(confirm.item.createdAt) : ''}</strong> 的备份状态：
        </div>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li>备份中的文件会覆盖当前内容；</li>
          <li>
            备份之外的现有文件会
            {draft.sync.trashEnabled ? '移入回收站中的「恢复备份前的文件」文件夹，可随时找回' : '被删除（回收站未启用）'}；
          </li>
          <li>
            {draft.sync.enabled
              ? '恢复后立即同步，并以本机为准推送到其他设备——其他设备在此期间的较新改动不会把恢复结果覆盖回去（被替换的内容同样可在回收站找回）。'
              : '多端同步未开启，只影响本机文件。'}
          </li>
        </ul>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirm?.type === 'delete'}
        title="删除备份"
        confirmLabel="删除"
        danger
        busy={busy}
        onConfirm={() => void confirmAction()}
        onClose={() => !busy && setConfirm(null)}
      >
        确定要永久删除备份「{confirm?.item.name}」吗？此操作无法撤销。
      </ConfirmDialog>
    </div>
  );
}
