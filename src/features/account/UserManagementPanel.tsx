// 设置 → 用户管理（仅管理员）：新建、停用 / 启用、重置密码与删除普通用户。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy, Dices, KeyRound, Loader2, Search, Trash2, UserCheck, UserPlus, UserX, Users, X } from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';
import { showToast } from '../../stores/toastStore';
import { ConfirmDialog, SecretInput, useEscapeToClose } from '../sync/SyncControls';
import { formatDateTime, formatRelative } from '../sync/syncFormat';
import { accountApi, errorMessage, generatePassword, type ManagedUser } from './accountApi';
import { getWebAccount } from './accountState';
import { Avatar } from './Avatar';
import '../sync/sync.css';
import './account.css';

type DialogState =
  | { kind: 'create' }
  | { kind: 'reset'; user: ManagedUser }
  | { kind: 'delete'; user: ManagedUser }
  | { kind: 'disable'; user: ManagedUser }
  | null;

export function UserManagementPanel() {
  const admin = getWebAccount();
  const [users, setUsers] = useState<ManagedUser[] | null>(null);
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState<DialogState>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');

  const reload = useCallback(async () => {
    try {
      setUsers(await accountApi.listUsers());
      setLoadError('');
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const list = [...users ?? []].sort((a, b) => Number(a.disabled) - Number(b.disabled) || a.username.localeCompare(b.username, 'zh-CN'));
    return keyword ? list.filter((user) => user.username.toLowerCase().includes(keyword)) : list;
  }, [users, query]);

  /** 简单操作统一处理忙碌态、提示与刷新。 */
  const run = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try {
      await action();
      await reload();
      showToast(message, 'success');
      setDialog(null);
    } catch (error) {
      showToast(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggle = (user: ManagedUser) => {
    // 停用会立即让对方退出登录，需要确认；启用直接执行。
    if (!user.disabled) setDialog({ kind: 'disable', user });
    else void run(() => accountApi.setDisabled(user.id, false), `已启用 ${user.username}`);
  };

  return (
    <div className="nb-sync-panel">
      <div>
        <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>用户管理</h3>
      </div>

      <div className="nb-sync-card">
        <div className="nb-sync-card-head">
          <div className="nb-sync-card-title"><Users size={15} />成员{users ? `（${users.length + 1}）` : ''}</div>
        </div>
        <div className="nb-users-toolbar">
          <div className="nb-users-search">
            <Search size={13} />
            <input className="nb-sync-input" value={query} placeholder="搜索用户名" aria-label="搜索用户名" onChange={(event) => setQuery(event.target.value)} />
          </div>
          <span style={{ flex: 1 }} />
          <button type="button" className="nb-btn-primary nb-account-btn" onClick={() => setDialog({ kind: 'create' })}>
            <UserPlus size={14} />
            新建用户
          </button>
        </div>

        <div className="nb-sync-list">
          {/* 管理员来自部署配置，只展示不提供操作。 */}
          {admin && !query && (
            <div className="nb-sync-list-item nb-users-item">
              <Avatar name={admin.username} />
              <div className="nb-sync-list-main">
                <span className="nb-sync-list-name">{admin.username}<span className="nb-account-role is-admin">管理员</span></span>
                <span className="nb-sync-list-meta">部署配置提供，数据位于原工作区</span>
              </div>
            </div>
          )}
          {users === null && !loadError && <div className="nb-account-loading"><Loader2 size={16} className="nb-sync-spin" />正在加载…</div>}
          {loadError && <div className="nb-sync-list-empty">{loadError}</div>}
          {users && !filtered.length && <div className="nb-sync-list-empty">{query ? '没有匹配的用户' : '还没有普通用户'}</div>}
          {filtered.map((user) => (
            <div key={user.id} className={`nb-sync-list-item nb-users-item${user.disabled ? ' is-disabled' : ''}`}>
              <Avatar name={user.username} />
              <div className="nb-sync-list-main">
                <span className="nb-sync-list-name">
                  <span className="nb-account-ellipsis">{user.username}</span>
                  {user.disabled && <span className="nb-account-role is-off">已停用</span>}
                  {user.conflict && (
                    <Tooltip content="与管理员同名，无法登录" side="top" sideOffset={4}>
                      <span className="nb-account-role is-warn">重名</span>
                    </Tooltip>
                  )}
                </span>
                <span className="nb-sync-list-meta">
                  {user.lastLoginAt ? `最近登录 ${formatRelative(user.lastLoginAt)}` : '从未登录'} · 创建于 {formatDateTime(user.createdAt)}
                </span>
              </div>
              <div className="nb-sync-list-actions">
                <Tooltip content="重置密码" side="top" sideOffset={4}>
                  <button type="button" className="nb-sync-icon-btn" aria-label={`重置 ${user.username} 的密码`} disabled={busy} onClick={() => setDialog({ kind: 'reset', user })}>
                    <KeyRound size={14} />
                  </button>
                </Tooltip>
                <Tooltip content={user.disabled ? '启用' : '停用'} side="top" sideOffset={4}>
                  <button type="button" className="nb-sync-icon-btn" aria-label={`${user.disabled ? '启用' : '停用'} ${user.username}`} disabled={busy} onClick={() => toggle(user)}>
                    {user.disabled ? <UserCheck size={14} /> : <UserX size={14} />}
                  </button>
                </Tooltip>
                <Tooltip content="删除" side="top" sideOffset={4}>
                  <button type="button" className="nb-sync-icon-btn is-danger" aria-label={`删除 ${user.username}`} disabled={busy} onClick={() => setDialog({ kind: 'delete', user })}>
                    <Trash2 size={14} />
                  </button>
                </Tooltip>
              </div>
            </div>
          ))}
        </div>
        <div className="nb-sync-muted">每个用户的笔记、设置与历史彼此独立；多端同步仅管理员可用。</div>
      </div>

      {dialog?.kind === 'create' && (
        <PasswordDialog
          title="新建用户"
          withUsername
          confirmLabel="创建"
          onClose={() => setDialog(null)}
          onSubmit={async (username, password) => {
            await accountApi.createUser(username, password);
            await reload();
            showToast(`已创建 ${username}`, 'success');
          }}
        />
      )}
      {dialog?.kind === 'reset' && (
        <PasswordDialog
          title={`重置“${dialog.user.username}”的密码`}
          confirmLabel="重置"
          hint="对方的所有登录将失效"
          onClose={() => setDialog(null)}
          onSubmit={async (_, password) => {
            await accountApi.resetPassword(dialog.user.id, password);
            showToast('密码已重置', 'success');
          }}
        />
      )}
      <ConfirmDialog
        open={dialog?.kind === 'disable'}
        title="停用用户"
        confirmLabel="停用"
        danger
        busy={busy}
        onConfirm={() => dialog?.kind === 'disable' && void run(() => accountApi.setDisabled(dialog.user.id, true), `已停用 ${dialog.user.username}`)}
        onClose={() => setDialog(null)}
      >
        {dialog?.kind === 'disable' && <>“{dialog.user.username}”将立即退出登录，其共享暂时对他人不可见。数据保留，可随时启用。</>}
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog?.kind === 'delete'}
        title="删除用户"
        confirmLabel="删除"
        danger
        busy={busy}
        onConfirm={() => dialog?.kind === 'delete' && void run(() => accountApi.deleteUser(dialog.user.id), `已删除 ${dialog.user.username}`)}
        onClose={() => setDialog(null)}
      >
        {dialog?.kind === 'delete' && <>“{dialog.user.username}”的账号与共享将被删除，笔记数据移入服务器回收目录（/data/trash/users）。</>}
      </ConfirmDialog>
    </div>
  );
}

/** 新建用户与重置密码共用：支持一键生成随机密码并复制，便于转交给对方。 */
function PasswordDialog({
  title,
  withUsername,
  confirmLabel,
  hint,
  onSubmit,
  onClose,
}: {
  title: string;
  withUsername?: boolean;
  confirmLabel: string;
  hint?: string;
  onSubmit: (username: string, password: string) => Promise<void>;
  onClose: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  useEscapeToClose(!busy, onClose);

  const tooShort = !!password && [...password].length < 8;
  const ready = (!withUsername || !!username.trim()) && [...password].length >= 8 && !busy;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(withUsername ? `账号：${username.trim()}\n密码：${password}` : password);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      showToast('复制失败，请手动复制', 'error');
    }
  };

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit(username.trim(), password);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };

  return (
    <div className="nb-sync-dialog-overlay nb-account-dialog" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
      <form className="nb-sync-dialog is-small" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className="nb-sync-dialog-head">
          <div className="nb-sync-dialog-title"><span className="nb-account-ellipsis">{title}</span></div>
          <Tooltip content="关闭" shortcut="Esc" side="bottom" sideOffset={4}>
            <button type="button" className="nb-sync-icon-btn" aria-label="关闭" disabled={busy} onClick={onClose}>
              <X size={15} />
            </button>
          </Tooltip>
        </div>
        <div className="nb-sync-dialog-body">
          {withUsername && (
            <label className="nb-sync-field">
              <span>用户名</span>
              <input
                className="nb-sync-input"
                value={username}
                autoFocus
                maxLength={32}
                autoComplete="off"
                spellCheck={false}
                placeholder="文字、数字和 . _ -"
                onChange={(event) => { setUsername(event.target.value); setError(''); }}
              />
            </label>
          )}
          <label className="nb-sync-field">
            <span>{withUsername ? '初始密码' : '新密码'}</span>
            <div className="nb-password-row">
              <SecretInput value={password} onChange={(value) => { setPassword(value); setError(''); }} placeholder="至少 8 位" />
              <Tooltip content="生成随机密码" side="top" sideOffset={4}>
                <button type="button" className="nb-sync-icon-btn" aria-label="生成随机密码" onClick={() => { setPassword(generatePassword()); setError(''); }}>
                  <Dices size={15} />
                </button>
              </Tooltip>
              <Tooltip content={copied ? '已复制' : withUsername ? '复制账号和密码' : '复制密码'} side="top" sideOffset={4}>
                <button type="button" className="nb-sync-icon-btn" aria-label="复制" disabled={!password} onClick={() => void copy()}>
                  {copied ? <Check size={15} color="var(--success-600, #16a34a)" /> : <Copy size={15} />}
                </button>
              </Tooltip>
            </div>
            {tooShort && <small className="nb-account-field-error">至少 8 位</small>}
          </label>
          {hint && <div className="nb-sync-muted">{hint}</div>}
          {error && <div className="nb-account-error" role="alert">{error}</div>}
        </div>
        <div className="nb-sync-dialog-foot">
          <button type="button" className="nb-btn-secondary nb-account-btn" disabled={busy} onClick={onClose}>取消</button>
          <button type="submit" className="nb-btn-primary nb-account-btn" disabled={!ready}>
            {busy && <Loader2 size={14} className="nb-sync-spin" />}
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
