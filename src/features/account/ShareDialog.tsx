// 共享对话框：所有者为文件或文件夹选择接收者与“只读 / 可编辑”权限；授权由服务端逐请求校验。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Share2, Trash2, Users, X } from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';
import { SettingsSelect } from '../../components/settings/SettingsSelect';
import { showToast } from '../../stores/toastStore';
import { useEscapeToClose } from '../sync/SyncControls';
import { ALL_USERS, accountApi, errorMessage, type ShareGrant, type SharePermission, type ShareTarget } from './accountApi';
import { useShareStore } from './shareStore';
import { Avatar } from './Avatar';
import '../sync/sync.css';
import './account.css';

const PERMISSIONS = [
  { value: 'read', label: '只读' },
  { value: 'edit', label: '可编辑' },
] as const;

/** 由全局共享状态驱动，资源管理器与“我的共享”均可打开。 */
export function ShareDialogHost() {
  const path = useShareStore((state) => state.dialogPath);
  const close = useShareStore((state) => state.closeDialog);
  if (!path) return null;
  return <ShareDialog key={path} path={path} onClose={close} />;
}

function ShareDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const [targets, setTargets] = useState<ShareTarget[]>([]);
  const [grants, setGrants] = useState<ShareGrant[]>([]);
  const [existing, setExisting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pick, setPick] = useState('');
  const [pickPermission, setPickPermission] = useState<SharePermission>('read');
  const name = path.split('/').pop() || path;

  useEscapeToClose(!busy, onClose);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([accountApi.shareTargets(), accountApi.getShare(path)])
      .then(([list, share]) => {
        if (cancelled) return;
        setTargets(list);
        setGrants(share?.grants ?? []);
        setExisting(!!share);
      })
      .catch((cause) => { if (!cancelled) setError(errorMessage(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [path]);

  const usernameOf = useCallback((userId: string) => userId === ALL_USERS ? '所有用户' : targets.find((item) => item.id === userId)?.username ?? '已移除的用户', [targets]);

  // 候选对象：尚未授权的用户；“所有用户”放在首位。
  const options = useMemo(() => {
    const granted = new Set(grants.map((grant) => grant.userId));
    const list = [{ value: ALL_USERS, label: '所有用户' }, ...targets.map((item) => ({ value: item.id, label: item.role === 'admin' ? `${item.username}（管理员）` : item.username }))];
    return list.filter((item) => !granted.has(item.value));
  }, [grants, targets]);

  // 当前选择失效（刚被添加）时自动切换到下一个候选。
  useEffect(() => {
    if (!options.some((item) => item.value === pick)) setPick(options[0]?.value ?? '');
  }, [options, pick]);

  const add = () => {
    if (!pick) return;
    setGrants((list) => [...list, { userId: pick, permission: pickPermission }]);
  };

  const save = async (next: ShareGrant[]) => {
    setBusy(true);
    setError('');
    try {
      await accountApi.setShare(path, next);
      await useShareStore.getState().refresh();
      showToast(next.length ? '共享已更新' : '已停止共享', 'success');
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };

  return (
    <div className="nb-sync-dialog-overlay nb-account-dialog" role="dialog" aria-modal="true" aria-label={`共享 ${name}`} onMouseDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div className="nb-sync-dialog is-small">
        <div className="nb-sync-dialog-head">
          <div className="nb-sync-dialog-title">
            <Share2 size={16} color="var(--accent-strong)" />
            <span className="nb-account-ellipsis">共享“{name}”</span>
          </div>
          <Tooltip content="关闭" shortcut="Esc" side="bottom" sideOffset={4}>
            <button type="button" className="nb-sync-icon-btn" aria-label="关闭" disabled={busy} onClick={onClose}>
              <X size={15} />
            </button>
          </Tooltip>
        </div>
        <div className="nb-sync-dialog-body nb-share-body">
          <div className="nb-share-path">{path}</div>
          {loading ? (
            <div className="nb-account-loading"><Loader2 size={16} className="nb-sync-spin" />正在加载…</div>
          ) : (
            <>
              <div className="nb-share-add">
                <div className="nb-share-add-user">
                  {options.length ? (
                    <SettingsSelect value={pick} options={options} onChange={setPick} ariaLabel="共享对象" />
                  ) : (
                    <span className="nb-sync-muted">已添加全部用户</span>
                  )}
                </div>
                <SettingsSelect value={pickPermission} options={PERMISSIONS} onChange={setPickPermission} ariaLabel="权限" />
                <button type="button" className="nb-btn-soft nb-account-btn" disabled={!pick || busy} onClick={add}>添加</button>
              </div>

              <div className="nb-share-section-title">有权访问</div>
              {grants.length ? (
                <div className="nb-sync-list">
                  {grants.map((grant) => (
                    <div key={grant.userId} className="nb-sync-list-item nb-share-grant">
                      {grant.userId === ALL_USERS ? <span className="nb-account-avatar is-group"><Users size={13} /></span> : <Avatar name={usernameOf(grant.userId)} size={26} />}
                      <div className="nb-sync-list-main">
                        <span className="nb-sync-list-name">{usernameOf(grant.userId)}</span>
                        {grant.userId === ALL_USERS && <span className="nb-sync-list-meta">包括之后新建的用户</span>}
                      </div>
                      <SettingsSelect
                        value={grant.permission}
                        options={PERMISSIONS}
                        ariaLabel={`${usernameOf(grant.userId)} 的权限`}
                        onChange={(permission) => setGrants((list) => list.map((item) => item.userId === grant.userId ? { ...item, permission } : item))}
                      />
                      <Tooltip content="移除" side="top" sideOffset={4}>
                        <button type="button" className="nb-sync-icon-btn is-danger" aria-label={`移除 ${usernameOf(grant.userId)}`} disabled={busy} onClick={() => setGrants((list) => list.filter((item) => item.userId !== grant.userId))}>
                          <Trash2 size={14} />
                        </button>
                      </Tooltip>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="nb-sync-list"><div className="nb-sync-list-empty">尚未共享给任何人</div></div>
              )}
              <div className="nb-sync-muted">接收者在资源管理器的“共享给我”中访问同一份文件。</div>
            </>
          )}
          {error && <div className="nb-account-error" role="alert">{error}</div>}
        </div>
        <div className="nb-sync-dialog-foot nb-share-foot">
          {existing && (
            <button type="button" className="nb-btn-secondary nb-account-btn is-danger-text" disabled={busy || loading} onClick={() => void save([])}>
              停止共享
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className="nb-btn-secondary nb-account-btn" disabled={busy} onClick={onClose}>取消</button>
          <button type="button" className="nb-btn-primary nb-account-btn" disabled={busy || loading} onClick={() => void save(grants)}>
            {busy && <Loader2 size={14} className="nb-sync-spin" />}
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
