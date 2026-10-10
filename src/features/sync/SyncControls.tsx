// NoteBoard 同步设置通用控件：密钥输入、确认弹窗、远端服务配置表单与时间格式化

import { useEffect, useId, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronRight, ExternalLink, Eye, EyeOff, HelpCircle, Loader2, PlugZap, X } from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';
import * as ipc from '../../core/ipc/commands';
import type { GitRepoConfig, SyncProviderConfig, SyncProviderKind } from '../../core/ipc/types';

// ── 格式化 ──

export { formatDateTime, formatRelative } from './syncFormat';

export function formatSize(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return i === 0 ? `${bytes} B` : `${v.toFixed(1)} ${units[i]}`;
}

export function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return '操作失败';
}

/** 在系统浏览器打开链接 */
function openLink(url: string): void {
  void ipc.openExternalUrl(url).catch((e) => console.error('打开链接失败:', e));
}

export function HelpLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Tooltip content={href} side="top" sideOffset={4}>
      <button type="button" className="nb-sync-link" onClick={() => openLink(href)}>
        {children}
        <ExternalLink size={11} />
      </button>
    </Tooltip>
  );
}

// ── 折叠说明块（默认收起，减少设置页篇幅） ──

export function Collapsible({
  title,
  icon,
  variant = 'notice',
  children,
}: {
  title: React.ReactNode;
  icon?: React.ReactNode;
  /** notice：蓝色说明卡片；help：虚线帮助框 */
  variant?: 'notice' | 'help';
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className={`nb-sync-collapsible is-${variant}${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="nb-sync-collapsible-head"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        {icon}
        <span>{title}</span>
        <ChevronRight size={14} className="nb-sync-collapsible-chevron" />
      </button>
      {open && (
        <div id={id} className="nb-sync-collapsible-body">
          {children}
        </div>
      )}
    </div>
  );
}

// ── 开关行（说明文字在左，数值输入与复选框统一放在行末） ──

/** 拖选说明文字时不触发勾选（label 点击默认会切换复选框） */
function guardTextSelection(e: React.MouseEvent<HTMLLabelElement>): void {
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && selection.anchorNode && e.currentTarget.contains(selection.anchorNode)) {
    e.preventDefault();
  }
}

export function ToggleRow({
  title,
  desc,
  checked,
  onChange,
  extra,
}: {
  title: React.ReactNode;
  desc?: React.ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** 复选框之前的附加控件（例如「每 30 分钟」） */
  extra?: React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="nb-sync-row">
      {/* htmlFor 显式绑定复选框：点击行末数值输入框不会误切换开关 */}
      <label htmlFor={id} className="nb-sync-row-label" onClick={guardTextSelection}>
        <div>{title}</div>
        {desc && <div className="nb-sync-muted">{desc}</div>}
      </label>
      <div className="nb-sync-row-inline">
        {extra}
        <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      </div>
    </div>
  );
}

// ── 数值输入（无上下调节按钮、不响应滚轮，只接受数字） ──

/**
 * 使用 text + inputMode=numeric 而非 type=number：没有右侧微调按钮，滚轮滑过也不会改动数值；
 * 输入过程中可以清空重输，失焦时回到有效值。
 */
export function NumberInput({
  value,
  min,
  max,
  disabled,
  onChange,
  ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange: (value: number) => void;
  ariaLabel?: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <input
      className="nb-sync-input is-number"
      type="text"
      inputMode="numeric"
      autoComplete="off"
      aria-label={ariaLabel}
      value={text}
      disabled={disabled}
      onChange={(e) => {
        const digits = e.target.value.replace(/\D/g, '').slice(0, String(max).length);
        setText(digits);
        if (digits !== '') onChange(Math.min(max, Math.max(min, parseInt(digits, 10))));
      }}
      onBlur={() => setText(String(value))}
    />
  );
}

// ── 密钥输入（默认隐藏，可切换明文） ──

export function SecretInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="nb-sync-secret">
      <input
        className="nb-sync-input"
        type={visible ? 'text' : 'password'}
        value={value}
        placeholder={placeholder}
        autoComplete="new-password"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
      <Tooltip content={visible ? '隐藏' : '显示明文'} side="top" sideOffset={4}>
        <button
          type="button"
          className="nb-sync-icon-btn"
          aria-label={visible ? '隐藏' : '显示明文'}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </Tooltip>
    </div>
  );
}

// ── 确认弹窗（位于设置弹窗之上，Esc 只关闭自身） ──

export function useEscapeToClose(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    // 捕获阶段拦截，避免同时触发外层设置弹窗的 Esc 关闭
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [open, onClose]);
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = '确定',
  danger,
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  useEscapeToClose(open && !busy, onClose);
  if (!open) return null;
  return (
    <div className="nb-sync-dialog-overlay" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
      <div className="nb-sync-dialog is-small">
        <div className="nb-sync-dialog-head">
          <div className="nb-sync-dialog-title">
            {danger && <AlertTriangle size={16} color="var(--error-500, #ef4444)" />}
            {title}
          </div>
          <Tooltip content="关闭" shortcut="Esc" side="bottom" sideOffset={4}>
            <button type="button" className="nb-sync-icon-btn" aria-label="关闭" disabled={busy} onClick={onClose}>
              <X size={15} />
            </button>
          </Tooltip>
        </div>
        <div className="nb-sync-dialog-body">{children}</div>
        <div className="nb-sync-dialog-foot">
          <button type="button" className="nb-btn-secondary" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button type="button" className={danger ? 'nb-btn-danger' : 'nb-btn-primary'} disabled={busy} onClick={onConfirm}>
            {busy && <Loader2 size={14} className="nb-sync-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 远端服务配置表单 ──

const KIND_OPTIONS: { kind: SyncProviderKind; label: string }[] = [
  { kind: 'webdav', label: 'WebDAV' },
  { kind: 's3', label: 'S3 对象存储' },
  { kind: 'github', label: 'GitHub' },
  { kind: 'gitee', label: 'Gitee' },
  { kind: 'gitlab', label: 'GitLab' },
];

function Field({
  label,
  hint,
  wide,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`nb-sync-field${wide ? ' is-wide' : ''}`}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

function TextInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      className="nb-sync-input"
      type="text"
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

const HELP_TITLES: Record<SyncProviderKind, string> = {
  webdav: '如何获取 WebDAV 地址与应用密码（坚果云 / Nextcloud / NAS）',
  s3: '如何获取 S3 端点与访问密钥（OSS / COS / AWS / R2 / MinIO）',
  github: '如何创建 GitHub 仓库与访问令牌',
  gitee: '如何创建 Gitee 仓库与私人令牌',
  gitlab: '如何创建 GitLab 项目与访问令牌',
};

function WebDavHelp() {
  return (
    <div className="nb-sync-help">
      <div>
        <strong>坚果云（推荐）</strong>：地址填 <code>https://dav.jianguoyun.com/dav/</code>，用户名是坚果云登录邮箱；
        密码<strong>不是</strong>登录密码，需要在网页版「账户信息 → 安全选项 → 第三方应用管理」中添加应用，生成专用的应用密码。
        <HelpLink href="https://www.jianguoyun.com/#/safety">打开坚果云安全选项</HelpLink>
      </div>
      <div>
        <strong>Nextcloud / ownCloud</strong>：地址形如 <code>https://你的域名/remote.php/dav/files/用户名/</code>，建议在「个人设置 → 安全」中生成应用密码。
      </div>
      <div>
        <strong>群晖 / Alist / 其他 NAS</strong>：在对应服务中开启 WebDAV，填写服务地址、账号和密码即可。
        个别服务要求特定的客户端标识，此时才需要填写 User-Agent，一般留空。
      </div>
    </div>
  );
}

function S3Help() {
  return (
    <div className="nb-sync-help">
      <div>先在对象存储控制台创建一个<strong>私有</strong>存储桶，再创建只授予该存储桶读写权限的访问密钥：</div>
      <ul>
        <li>
          <strong>阿里云 OSS</strong>：端点 <code>https://oss-cn-hangzhou.aliyuncs.com</code>（按存储桶地域替换），区域 <code>oss-cn-hangzhou</code>。
          <HelpLink href="https://ram.console.aliyun.com/manage/ak">创建 AccessKey</HelpLink>
        </li>
        <li>
          <strong>腾讯云 COS</strong>：端点 <code>https://cos.ap-guangzhou.myqcloud.com</code>，区域 <code>ap-guangzhou</code>。
          <HelpLink href="https://console.cloud.tencent.com/cam/capi">API 密钥管理</HelpLink>
        </li>
        <li>
          <strong>AWS S3</strong>：端点 <code>https://s3.us-east-1.amazonaws.com</code>，区域 <code>us-east-1</code>。
          <HelpLink href="https://console.aws.amazon.com/iam/home#/security_credentials">IAM 安全凭证</HelpLink>
        </li>
        <li>
          <strong>Cloudflare R2</strong>：端点 <code>https://账户ID.r2.cloudflarestorage.com</code>，区域填 <code>auto</code>，在 R2「管理 API 令牌」中创建密钥。
        </li>
        <li>
          <strong>MinIO 等自建服务</strong>：填写服务地址（如 <code>http://192.168.1.10:9000</code>）并勾选「路径风格访问」。
        </li>
      </ul>
    </div>
  );
}

function GitHelp({ kind, baseUrl }: { kind: 'github' | 'gitee' | 'gitlab'; baseUrl: string }) {
  if (kind === 'github') {
    return (
      <div className="nb-sync-help">
        <ol>
          <li>在 GitHub 新建一个<strong>私有仓库</strong>（例如 <code>notes-sync</code>），空仓库即可。</li>
          <li>
            创建令牌：头像 → Settings → Developer settings → Personal access tokens → <strong>Fine-grained tokens</strong> → Generate new token；
            Repository access 选择该仓库，Permissions 中把 <strong>Contents</strong> 设为 <strong>Read and write</strong>。
            <HelpLink href="https://github.com/settings/personal-access-tokens/new">直接打开创建页面</HelpLink>
          </li>
          <li>使用经典令牌（classic）时勾选 <code>repo</code> 权限。令牌只显示一次，请立即复制。</li>
        </ol>
        <div>每次同步产生一次提交；单个文件不能超过约 90MB。国内网络访问不稳定时可在系统中设置代理。</div>
      </div>
    );
  }
  if (kind === 'gitee') {
    return (
      <div className="nb-sync-help">
        <ol>
          <li>
            在 Gitee 新建仓库（建议私有），<strong>创建时勾选「使用 Readme 文件初始化这个仓库」</strong>——Gitee 的接口无法向完全空白的仓库写入。
          </li>
          <li>
            生成私人令牌：设置 → 安全设置 → 私人令牌 → 生成新令牌，勾选 <code>projects</code> 权限。
            <HelpLink href="https://gitee.com/profile/personal_access_tokens">打开私人令牌页面</HelpLink>
          </li>
          <li>所属空间填写仓库地址中的用户名或组织名，例如 <code>gitee.com/zhangsan/notes</code> 中的 <code>zhangsan</code>。</li>
        </ol>
        <div>Gitee 不支持一次提交多个文件，每个文件的变更会单独提交；单个文件不能超过 50MB。</div>
      </div>
    );
  }
  const base = (baseUrl.trim() || 'https://gitlab.com').replace(/\/+$/, '');
  return (
    <div className="nb-sync-help">
      <ol>
        <li>使用 gitlab.com 时服务地址留空；自建 GitLab 填写实例地址，例如 <code>https://gitlab.example.com</code>。</li>
        <li>新建一个私有项目，所属填写用户名或群组路径（子群组用 / 分隔，例如 <code>team/notes</code>）。</li>
        <li>
          创建令牌：头像 → Edit profile → Access tokens → Add new token，勾选 <code>api</code> 权限（账号在项目中需要 Developer 及以上角色）。
          <HelpLink href={`${base}/-/user_settings/personal_access_tokens`}>打开令牌页面</HelpLink>
        </li>
      </ol>
      <div>每次同步产生一次提交；单个文件不能超过 50MB（自建实例以服务端设置为准）。</div>
    </div>
  );
}

function GitFields({
  kind,
  value,
  onChange,
}: {
  kind: 'github' | 'gitee' | 'gitlab';
  value: GitRepoConfig;
  onChange: (patch: Partial<GitRepoConfig>) => void;
}) {
  const ownerLabel = kind === 'gitee' ? '所属空间（用户名/组织）' : kind === 'gitlab' ? '用户名 / 群组路径' : '所有者（用户名/组织）';
  const tokenLabel = kind === 'gitee' ? '私人令牌' : '访问令牌（Personal access token）';
  return (
    <div className="nb-sync-grid">
      {kind !== 'gitee' && (
        <Field
          label={kind === 'gitlab' ? '服务地址（自建实例）' : '服务地址（GitHub Enterprise）'}
          hint={kind === 'gitlab' ? '使用 gitlab.com 时留空' : '使用 github.com 时留空'}
          wide
        >
          <TextInput
            value={value.baseUrl}
            onChange={(v) => onChange({ baseUrl: v })}
            placeholder={kind === 'gitlab' ? 'https://gitlab.example.com' : 'https://github.example.com'}
          />
        </Field>
      )}
      <Field label={ownerLabel}>
        <TextInput value={value.owner} onChange={(v) => onChange({ owner: v })} placeholder={kind === 'gitlab' ? 'team/notes' : 'zhangsan'} />
      </Field>
      <Field label="仓库名">
        <TextInput value={value.repo} onChange={(v) => onChange({ repo: v })} placeholder="notes-sync" />
      </Field>
      <Field label={tokenLabel} wide>
        <SecretInput value={value.token} onChange={(v) => onChange({ token: v })} placeholder="粘贴令牌" />
      </Field>
      <Field label="分支" hint="留空使用仓库默认分支">
        <TextInput value={value.branch} onChange={(v) => onChange({ branch: v })} placeholder="默认分支" />
      </Field>
      <Field label="仓库内目录" hint="留空表示仓库根目录">
        <TextInput value={value.remoteDir} onChange={(v) => onChange({ remoteDir: v })} placeholder="例如 notes" />
      </Field>
    </div>
  );
}

/** 远端服务配置（同步与远端备份共用） */
export function ProviderForm({
  value,
  onChange,
  showHelp = true,
}: {
  value: SyncProviderConfig;
  onChange: (next: SyncProviderConfig) => void;
  showHelp?: boolean;
}) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  // 切换类型或修改配置后清除旧的测试结果
  useEffect(() => {
    setResult(null);
  }, [value]);

  const patchGit = (kind: 'github' | 'gitee' | 'gitlab', patch: Partial<GitRepoConfig>) =>
    onChange({ ...value, [kind]: { ...value[kind], ...patch } });

  const handleTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      const text = await ipc.syncTestConnection(value);
      setResult({ ok: true, text });
    } catch (error) {
      setResult({ ok: false, text: errorText(error) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="nb-sync-segment" role="radiogroup" aria-label="同步方式">
        {KIND_OPTIONS.map((option) => (
          <button
            key={option.kind}
            type="button"
            role="radio"
            aria-checked={value.kind === option.kind}
            className={`nb-sync-segment-btn${value.kind === option.kind ? ' is-active' : ''}`}
            onClick={() => onChange({ ...value, kind: option.kind })}
          >
            {option.label}
          </button>
        ))}
      </div>

      {value.kind === 'webdav' && (
        <div className="nb-sync-grid">
          <Field label="服务地址" wide>
            <TextInput
              value={value.webdav.url}
              onChange={(v) => onChange({ ...value, webdav: { ...value.webdav, url: v } })}
              placeholder="https://dav.jianguoyun.com/dav/"
            />
          </Field>
          <Field label="用户名">
            <TextInput
              value={value.webdav.username}
              onChange={(v) => onChange({ ...value, webdav: { ...value.webdav, username: v } })}
              placeholder="账号 / 邮箱"
            />
          </Field>
          <Field label="密码 / 应用密码">
            <SecretInput
              value={value.webdav.password}
              onChange={(v) => onChange({ ...value, webdav: { ...value.webdav, password: v } })}
              placeholder="坚果云请填写应用密码"
            />
          </Field>
          <Field label="远端文件夹" hint="不存在时自动创建">
            <TextInput
              value={value.webdav.remoteDir}
              onChange={(v) => onChange({ ...value, webdav: { ...value.webdav, remoteDir: v } })}
              placeholder="NoteBoard"
            />
          </Field>
          <Field label="User-Agent（可选）" hint="留空使用 NoteBoard 默认标识">
            <TextInput
              value={value.webdav.userAgent}
              onChange={(v) => onChange({ ...value, webdav: { ...value.webdav, userAgent: v } })}
              placeholder="NoteBoard"
            />
          </Field>
        </div>
      )}

      {value.kind === 's3' && (
        <div className="nb-sync-grid">
          <Field label="服务端点（Endpoint）" wide>
            <TextInput
              value={value.s3.endpoint}
              onChange={(v) => onChange({ ...value, s3: { ...value.s3, endpoint: v } })}
              placeholder="https://oss-cn-hangzhou.aliyuncs.com"
            />
          </Field>
          <Field label="区域（Region）">
            <TextInput value={value.s3.region} onChange={(v) => onChange({ ...value, s3: { ...value.s3, region: v } })} placeholder="us-east-1" />
          </Field>
          <Field label="存储桶（Bucket）">
            <TextInput value={value.s3.bucket} onChange={(v) => onChange({ ...value, s3: { ...value.s3, bucket: v } })} placeholder="my-notes" />
          </Field>
          <Field label="Access Key ID">
            <TextInput
              value={value.s3.accessKeyId}
              onChange={(v) => onChange({ ...value, s3: { ...value.s3, accessKeyId: v } })}
              placeholder="AKIA…"
            />
          </Field>
          <Field label="Secret Access Key">
            <SecretInput
              value={value.s3.secretAccessKey}
              onChange={(v) => onChange({ ...value, s3: { ...value.s3, secretAccessKey: v } })}
              placeholder="密钥"
            />
          </Field>
          <Field label="对象前缀（远端目录）" hint="留空表示存储桶根目录">
            <TextInput value={value.s3.prefix} onChange={(v) => onChange({ ...value, s3: { ...value.s3, prefix: v } })} placeholder="NoteBoard" />
          </Field>
          <Field label="User-Agent（可选）" hint="留空使用 NoteBoard 默认标识">
            <TextInput
              value={value.s3.userAgent}
              onChange={(v) => onChange({ ...value, s3: { ...value.s3, userAgent: v } })}
              placeholder="NoteBoard"
            />
          </Field>
          <div className="nb-sync-field is-wide">
            <ToggleRow
              title="路径风格访问"
              desc="MinIO 等自建服务通常需要开启"
              checked={value.s3.pathStyle}
              onChange={(checked) => onChange({ ...value, s3: { ...value.s3, pathStyle: checked } })}
            />
          </div>
        </div>
      )}

      {(value.kind === 'github' || value.kind === 'gitee' || value.kind === 'gitlab') && (
        <GitFields kind={value.kind} value={value[value.kind]} onChange={(patch) => patchGit(value.kind as 'github' | 'gitee' | 'gitlab', patch)} />
      )}

      {/* 获取地址与密钥的说明：默认收起，切换服务类型后标题随之变化 */}
      {showHelp && (
        <Collapsible key={value.kind} variant="help" icon={<HelpCircle size={14} />} title={HELP_TITLES[value.kind]}>
          {value.kind === 'webdav' && <WebDavHelp />}
          {value.kind === 's3' && <S3Help />}
          {(value.kind === 'github' || value.kind === 'gitee' || value.kind === 'gitlab') && (
            <GitHelp kind={value.kind} baseUrl={value.gitlab.baseUrl} />
          )}
        </Collapsible>
      )}

      <div className="nb-sync-actions">
        <button type="button" className="nb-btn-secondary" disabled={testing} onClick={handleTest}>
          {testing ? <Loader2 size={14} className="nb-sync-spin" /> : <PlugZap size={14} />}
          {testing ? '正在测试' : '测试连接'}
        </button>
        {result && (
          <span className={`nb-sync-test-result ${result.ok ? 'is-ok' : 'is-error'}`} role="status">
            {result.ok ? <CheckCircle2 size={13} style={{ verticalAlign: -2, marginRight: 4 }} /> : <AlertTriangle size={13} style={{ verticalAlign: -2, marginRight: 4 }} />}
            {result.text}
          </span>
        )}
      </div>
    </div>
  );
}
