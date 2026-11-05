// 设置 → 账号：当前登录账号、修改密码、退出登录，以及“我的共享”管理。
import { useEffect, useState } from 'react';
import { File, Folder, KeyRound, Loader2, LogOut, MonitorSmartphone, Settings2, Share2, Trash2, Unlink } from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';
import { showToast } from '../../stores/toastStore';
import { ConfirmDialog, SecretInput } from '../sync/SyncControls';
import { formatDateTime } from '../sync/syncFormat';
import { accountApi, errorMessage, logout, type ShareInfo } from './accountApi';
import { getWebAccount } from './accountState';
import { describeGrants, useShareStore } from './shareStore';
import { Avatar } from './Avatar';
import '../sync/sync.css';
import './account.css';

export function AccountPanel() {
  const account = getWebAccount();
  const [confirmOthers, setConfirmOthers] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!account) return null;
  const admin = account.role === 'admin';

  const logoutOthers = async () => {
    setBusy(true);
    try {
      await accountApi.logoutOthers();
      showToast('其他设备已退出登录', 'success');
      setConfirmOthers(false);
    } catch (error) {
      showToast(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="nb-sync-panel">
      <div>
        <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>账号</h3>
      </div>

      <div className="nb-sync-card">
        <div className="nb-account-profile">
          <Avatar name={account.username} size={44} />
          <div className="nb-account-profile-main">
            <div className="nb-account-profile-name">
              <span className="nb-account-ellipsis">{account.username}</span>
              <span className={`nb-account-role${admin ? ' is-admin' : ''}`}>{admin ? '管理员' : '成员'}</span>
            </div>
            <span className="nb-sync-muted">{admin ? '账号来自部署配置' : '笔记与设置仅自己可见'}</span>
          </div>
          <div className="nb-account-actions">
            <Tooltip content="其他浏览器需重新登录" side="top" sideOffset={4}>
              <button type="button" className="nb-btn-secondary nb-account-btn" onClick={() => setConfirmOthers(true)}>
                <MonitorSmartphone size={14} />
                退出其他设备
              </button>
            </Tooltip>
            <button type="button" className="nb-btn-secondary nb-account-btn is-danger-text" onClick={() => void logout()}>
              <LogOut size={14} />
              退出登录
            </button>
          </div>
        </div>
      </div>

      <PasswordCard admin={admin} />
      <MySharesCard />

      <ConfirmDialog open={confirmOthers} title="退出其他设备" confirmLabel="退出" busy={busy} onConfirm={() => void logoutOthers()} onClose={() => setConfirmOthers(false)}>
        除当前浏览器外，此账号的其他登录都将失效。
      </ConfirmDialog>
    </div>
  );
}

function PasswordCard({ admin }: { admin: boolean }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (admin) {
    return (
      <div className="nb-sync-card">
        <div className="nb-sync-card-title"><KeyRound size={15} />密码</div>
        <div className="nb-sync-muted">管理员密码在 Docker / 1Panel 的环境变量中修改，重启容器后生效。</div>
      </div>
    );
  }

  // 前端只做即时提示，规则以服务端校验为准。
  const mismatch = !!confirm && next !== confirm;
  const tooShort = !!next && [...next].length < 8;
  const ready = !!current && !!next && !mismatch && !tooShort && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError('');
    try {
      await accountApi.changePassword(current, next);
      setCurrent(''); setNext(''); setConfirm('');
      showToast('密码已修改，其他设备需重新登录', 'success');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="nb-sync-card" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <div className="nb-sync-card-title"><KeyRound size={15} />修改密码</div>
      <div className="nb-account-form">
        <label className="nb-sync-field">
          <span>当前密码</span>
          <SecretInput value={current} onChange={(value) => { setCurrent(value); setError(''); }} />
        </label>
        <label className="nb-sync-field">
          <span>新密码</span>
          <SecretInput value={next} onChange={(value) => { setNext(value); setError(''); }} placeholder="至少 8 位" />
          {tooShort && <small className="nb-account-field-error">至少 8 位</small>}
        </label>
        <label className="nb-sync-field">
          <span>确认新密码</span>
          <SecretInput value={confirm} onChange={(value) => { setConfirm(value); setError(''); }} />
          {mismatch && <small className="nb-account-field-error">两次输入不一致</small>}
        </label>
      </div>
      {error && <div className="nb-account-error" role="alert">{error}</div>}
      <div className="nb-account-form-foot">
        <span className="nb-sync-muted">修改后其他设备需重新登录</span>
        <button type="submit" className="nb-btn-primary nb-account-btn" disabled={!ready}>
          {busy && <Loader2 size={14} className="nb-sync-spin" />}
          保存密码
        </button>
      </div>
    </form>
  );
}

function MySharesCard() {
  const shares = useShareStore((state) => state.shares);
  const loaded = useShareStore((state) => state.loaded);
  const openDialog = useShareStore((state) => state.openDialog);
  const [removing, setRemoving] = useState<ShareInfo | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void useShareStore.getState().refresh().catch((error) => showToast(errorMessage(error), 'error'));
  }, []);

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await accountApi.removeShare(removing.id);
      await useShareStore.getState().refresh();
      showToast('已停止共享', 'success');
      setRemoving(null);
    } catch (error) {
      showToast(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const recipients = (share: ShareInfo) => share.grants
    .map((grant) => `${grant.userId === '*' ? '所有用户' : grant.username ?? '已移除的用户'}${grant.permission === 'edit' ? '（可编辑）' : '（只读）'}`)
    .join('、');

  return (
    <div className="nb-sync-card">
      <div className="nb-sync-card-head">
        <div className="nb-sync-card-title"><Share2 size={15} />我的共享</div>
        {loaded && shares.length > 0 && <span className="nb-sync-muted">{shares.length} 项</span>}
      </div>
      {!loaded ? (
        <div className="nb-account-loading"><Loader2 size={16} className="nb-sync-spin" />正在加载…</div>
      ) : shares.length ? (
        <div className="nb-sync-list">
          {shares.map((share) => (
            <div key={share.id} className="nb-sync-list-item">
              {share.isDir ? <Folder size={15} /> : share.missing ? <Unlink size={15} /> : <File size={15} />}
              <div className="nb-sync-list-main">
                <span className="nb-sync-list-name">
                  {share.path.split('/').pop()}
                  {share.missing && <span className="nb-account-role is-warn" style={{ marginLeft: 6 }}>已失效</span>}
                </span>
                <Tooltip content={<span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><span>{share.path}</span><span>{recipients(share)}</span></span>} side="top" sideOffset={4}>
                  <span className="nb-sync-list-meta">{describeGrants(share)} · {share.path}</span>
                </Tooltip>
              </div>
              <div className="nb-sync-list-actions">
                {!share.missing && (
                  <Tooltip content="管理共享" side="top" sideOffset={4}>
                    <button type="button" className="nb-sync-icon-btn" aria-label="管理共享" onClick={() => openDialog(share.path)}>
                      <Settings2 size={14} />
                    </button>
                  </Tooltip>
                )}
                <Tooltip content="停止共享" side="top" sideOffset={4}>
                  <button type="button" className="nb-sync-icon-btn is-danger" aria-label="停止共享" onClick={() => setRemoving(share)}>
                    <Trash2 size={14} />
                  </button>
                </Tooltip>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="nb-sync-list"><div className="nb-sync-list-empty">在资源管理器中右键文件或文件夹，选择“共享…”</div></div>
      )}
      <ConfirmDialog open={!!removing} title="停止共享" confirmLabel="停止共享" danger busy={busy} onConfirm={() => void remove()} onClose={() => setRemoving(null)}>
        {removing && <>“{removing.path.split('/').pop()}”将不再对 {recipients(removing)} 可见，文件本身不受影响。</>}
        {removing && <span className="nb-sync-muted">创建于 {formatDateTime(removing.createdAt)}</span>}
      </ConfirmDialog>
    </div>
  );
}
