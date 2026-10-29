// NoteBoard 同步设置通用控件：密钥输入、确认弹窗、远端服务配置表单与时间格式化

import { useEffect, useId, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronRight, Cloud, ExternalLink, Eye, EyeOff, GitBranch, HelpCircle, Loader2, Network, PlugZap, Plus, X } from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';
import { SettingsSelect } from '../../components/settings/SettingsSelect';
import * as ipc from '../../core/ipc/commands';
import type { GitRepoConfig, HttpHeader, ObjectStorageKind, S3Config, SyncProviderConfig, SyncProviderKind } from '../../core/ipc/types';

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
      {/* 说明文字不绑定复选框：只有点击复选框本身才切换开关，aria-labelledby 保留无障碍名称 */}
      <div id={id} className="nb-sync-row-label">
        <div>{title}</div>
        {desc && <div className="nb-sync-muted">{desc}</div>}
      </div>
      <div className="nb-sync-row-inline">
        {extra}
        <input type="checkbox" aria-labelledby={id} checked={checked} onChange={(e) => onChange(e.target.checked)} />
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
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** 同一表单存在多组密钥时，用名称区分输入框及明文切换按钮。 */
  ariaLabel?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="nb-sync-secret">
      <input
        className="nb-sync-input"
        type={visible ? 'text' : 'password'}
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoComplete="new-password"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
      <Tooltip content={visible ? '隐藏' : '显示明文'} side="top" sideOffset={4}>
        <button
          type="button"
          className="nb-sync-icon-btn"
          aria-label={ariaLabel ? `${visible ? '隐藏' : '显示'}${ariaLabel}` : visible ? '隐藏' : '显示明文'}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </Tooltip>
    </div>
  );
}

/** WebDAV/S3 共用 Header 编辑器；逐行编辑名称和值，令牌默认隐藏，增删后仍由外层统一保存。 */
function HeaderInputs({ value, onChange }: { value: HttpHeader[]; onChange: (next: HttpHeader[]) => void }) {
  const id = useId();
  /** 只替换当前行，保留其他请求头和输入中的空白，避免改写有效令牌。 */
  const update = (index: number, patch: Partial<HttpHeader>) =>
    onChange(value.map((item, row) => row === index ? { ...item, ...patch } : item));
  return (
    <div className="nb-sync-field nb-sync-headers is-wide" role="group" aria-labelledby={id}>
      <div className="nb-sync-headers-head">
        <span id={id}>Header（可选）</span>
        <Tooltip content="按名称和值添加自定义请求头，例如 Cloudflare Access 的认证头。User-Agent 也可在此设置，未设置时使用 NoteBoard 默认标识。" side="top">
          <button type="button" className="nb-sync-icon-btn" aria-label="Header 说明"><HelpCircle size={14} /></button>
        </Tooltip>
        <Tooltip content="添加 Header" side="top">
          <button type="button" className="nb-sync-icon-btn nb-sync-header-add" aria-label="添加 Header" onClick={() => onChange([...value, { name: '', value: '' }])}>
            <Plus size={15} />
          </button>
        </Tooltip>
      </div>
      {value.map((item, index) => (
        // 行号保持正在编辑的输入框稳定；删除后重建后续行，避免复用其明文显示状态。
        <div className="nb-sync-header-row" key={`${value.length}-${index}`}>
          <input
            className="nb-sync-input"
            aria-label={`Header ${index + 1} 名称`}
            placeholder="名称，如 User-Agent"
            value={item.name}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => update(index, { name: event.target.value })}
          />
          <SecretInput ariaLabel={`Header ${index + 1} 值`} value={item.value} onChange={(next) => update(index, { value: next })} placeholder="值" />
          <Tooltip content="删除 Header" side="top">
            <button type="button" className="nb-sync-icon-btn is-danger" aria-label={`删除 Header ${index + 1}`} onClick={() => onChange(value.filter((_, row) => row !== index))}>
              <X size={14} />
            </button>
          </Tooltip>
        </div>
      ))}
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

/** 顶层只展示连接方式，具体厂商放入下拉，避免按钮数量随服务扩展不断增加。 */
const PROVIDER_GROUPS = [
  { group: 'webdav', label: 'WebDAV', icon: Network },
  { group: 'storage', label: '对象存储', icon: Cloud },
  { group: 'git', label: 'Git 仓库', icon: GitBranch },
] as const;

/** 通用 S3 保留在第一项，原有 AWS、R2 和 MinIO 配置可继续使用。 */
const STORAGE_OPTIONS = [
  { value: 's3', label: '通用 S3（AWS / R2 / MinIO）' },
  { value: 'oss', label: '阿里云 OSS' },
  { value: 'zos', label: '天翼云 ZOS' },
  { value: 'oos', label: '天翼云 OOS' },
  { value: 'obs', label: '华为云 OBS' },
  { value: 'cos', label: '腾讯云 COS' },
] as const;

const GIT_OPTIONS = [
  { value: 'github', label: 'GitHub' },
  { value: 'gitee', label: 'Gitee' },
  { value: 'gitcode', label: 'GitCode' },
  { value: 'gitlab', label: 'GitLab' },
] as const;

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
  s3: '如何获取 S3 端点与访问密钥（AWS / R2 / MinIO）',
  oss: '如何配置阿里云 OSS 与访问密钥',
  zos: '如何配置天翼云 ZOS 与访问密钥',
  oos: '如何配置天翼云 OOS 与访问密钥',
  obs: '如何配置华为云 OBS 与访问密钥',
  cos: '如何配置腾讯云 COS 与访问密钥',
  github: '如何创建 GitHub 仓库与访问令牌',
  gitee: '如何创建 Gitee 仓库与私人令牌',
  gitcode: '如何创建 GitCode 仓库与访问令牌',
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
      </div>
      <div>
        <strong>自定义 Header</strong>：点击「+」逐项填写名称和值；如需指定客户端标识，名称填 <code>User-Agent</code>，值填服务要求的标识，未设置时使用 NoteBoard 默认标识。
      </div>
      <div>
        <strong>Cloudflare Access</strong>：使用 Service Token 时，分别添加 <code>CF-Access-Client-Id</code> 和 <code>CF-Access-Client-Secret</code>，值填写对应的 Client ID 与 Client Secret；WebDAV 用户名和密码仍填写原服务的账号凭证。
      </div>
      <div>请求头名称不能重复，值不能换行。Host、Content-Length、Content-Type 和 Depth 由程序管理；如需自定义 Authorization，请将用户名留空，避免与账号认证冲突。</div>
    </div>
  );
}

function S3Help() {
  return (
    <div className="nb-sync-help">
      <div>先在对象存储控制台创建一个<strong>私有</strong>存储桶，再创建只授予该存储桶读写权限的访问密钥：</div>
      <ul>
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
      <div>阿里云 OSS、天翼云 ZOS / OOS、华为云 OBS、腾讯云 COS 可在「存储服务」下拉中选择，各服务独立保存配置。</div>
      <div>
        <strong>自定义 Header</strong>：需要网关认证或指定客户端标识时，点击「+」添加名称和值；客户端标识的名称填 <code>User-Agent</code>，未设置时使用 NoteBoard 默认标识。
        Cloudflare Access 的 Service Token 需分别添加 <code>CF-Access-Client-Id</code> 和 <code>CF-Access-Client-Secret</code>；S3 访问密钥仍填写在上方对应字段中。
      </div>
      <div>请求头名称不能重复，值不能换行。Host、Content-Length 和 S3 的 Authorization 等由程序管理，无需自行添加。</div>
    </div>
  );
}

/** 厂商差异只影响默认访问规则与填写示例，所有入口共用同一组字段及备份能力。 */
const STORAGE_EXAMPLES: Record<ObjectStorageKind, { endpoint: string; region: string }> = {
  s3: { endpoint: 'https://s3.us-east-1.amazonaws.com', region: 'us-east-1' },
  oss: { endpoint: 'https://oss-cn-hangzhou.aliyuncs.com', region: 'oss-cn-hangzhou' },
  zos: { endpoint: 'https://jiangsu-10.zos.ctyun.cn', region: 'us-east-1' },
  oos: { endpoint: 'https://oos-cn.ctyunapi.cn', region: 'cn（按所用资源池填写）' },
  obs: { endpoint: 'https://obs.cn-north-4.myhuaweicloud.com', region: 'cn-north-4' },
  cos: { endpoint: 'https://cos.ap-guangzhou.myqcloud.com', region: 'ap-guangzhou' },
};

/** 显式判断对象存储入口，避免把 Git 或 WebDAV 凭证混入共用表单。 */
function isObjectStorage(kind: SyncProviderKind): kind is ObjectStorageKind {
  return kind === 's3' || kind === 'oss' || kind === 'zos' || kind === 'oos' || kind === 'obs' || kind === 'cos';
}

/** 根据厂商呈现必要的地址和凭证指引；切换入口后折叠状态由外层重新初始化。 */
function ObjectStorageHelp({ kind }: { kind: Exclude<ObjectStorageKind, 's3'> }) {
  const example = STORAGE_EXAMPLES[kind];
  return (
    <div className="nb-sync-help">
      <div>先在对应云控制台创建私有存储桶，再创建仅允许该桶或指定前缀下对象读取、写入、列举和删除的访问密钥，无需授予删除存储桶的权限。</div>
      {kind === 'oss' && <>
        <div>在 OSS 控制台复制桶的公网 Endpoint，例如 <code>{example.endpoint}</code>；使用 S3 兼容接口时，杭州的签名区域填 <code>{example.region}</code>，其他地域按对应端点填写。</div>
        <div>北京时间 2025 年 3 月 20 日起新开通 OSS 的账号，访问中国内地桶的数据接口需要绑定自定义域名。将已绑定的 HTTPS 域名填入端点，并开启「使用自定义域名」；端点中无需再添加桶名。</div>
        <HelpLink href="https://ram.console.aliyun.com/manage/ak">创建 RAM AccessKey</HelpLink>
        <HelpLink href="https://www.alibabacloud.com/help/zh/oss/user-guide/0048-00000401">查看自定义域名要求</HelpLink>
      </>}
      {kind === 'zos' && <>
        <div>在天翼云对象存储 ZOS 控制台复制桶所在资源池的公网 Endpoint，例如 <code>{example.endpoint}</code>。S3 签名区域通常填 <code>us-east-1</code>，不要填写控制台中的资源池 ID（长串数字或字母）；文件的实际存储地域由 Endpoint 和桶决定。</div>
        <div>首次配置建议开启「路径风格访问」，直接使用 Endpoint 和桶名访问；已绑定自定义域名时改用上方的自定义域名选项。</div>
        <div>ZOS 与 OOS 是不同的对象存储服务，请使用 ZOS 的桶、Endpoint 和对象存储访问密钥，不要填写天翼云开放平台管理 API 的地址或密钥。</div>
        <HelpLink href="https://www.ctyun.cn/products/zos">打开天翼云 ZOS</HelpLink>
      </>}
      {kind === 'oos' && <>
        <div>在天翼云 OOS 控制台查看桶所属对象存储网络或资源池。示例端点为 <code>{example.endpoint}</code>，该端点的区域为 <code>cn</code>；其他资源池需核对其对应签名区域。</div>
        <div>请填写 OOS 数据访问 Endpoint 和对象存储 AK / SK，管理、统计或 IAM Endpoint 不能用于文件同步。这里使用 S3 V4 接口，旧服务需确认支持该签名版本。</div>
        <HelpLink href="https://www.ctyun.cn/document/10026693/10027131">查看 OOS V4 认证说明</HelpLink>
      </>}
      {kind === 'obs' && <>
        <div>在 OBS 控制台复制桶所在地域的 Endpoint，例如 <code>{example.endpoint}</code>，区域填 <code>{example.region}</code>。服务端点中不包含桶名，桶名在上方单独填写。</div>
        <div>在「我的凭证 → 访问密钥」创建 AK / SK，并通过 IAM 授予该桶对象的读写、列举和删除权限；使用此入口会自动按 OBS 的 V4 要求处理请求签名。</div>
        <HelpLink href="https://support.huaweicloud.com/obs_faq/obs_faq_0274.html">查看 OBS 接入说明</HelpLink>
      </>}
      {kind === 'cos' && <>
        <div>在 COS 控制台复制桶所在地域的服务端点，例如 <code>{example.endpoint}</code>，区域填 <code>{example.region}</code>；桶名必须完整包含 APPID，例如 <code>notes-1250000000</code>。</div>
        <div>在访问管理中创建受限子用户密钥，SecretId 填入访问密钥 ID，SecretKey 填入密钥。新建桶使用桶域名访问，服务端点中无需再添加桶名。</div>
        <HelpLink href="https://console.cloud.tencent.com/cam/capi">打开 API 密钥管理</HelpLink>
      </>}
      <div>「对象前缀」用于限定远端目录；同步与远端备份分别保存配置，可使用不同的桶或前缀。建议选择标准存储，归档类型通常需要先解冻才能恢复；当前单个文件或备份包上限为 1 GiB。</div>
      <div>自定义 Header 可填写网关认证或 <code>User-Agent</code>，未设置时使用 NoteBoard 默认标识；Host、Authorization 等签名字段由程序管理。使用 HTTPS，并先点击「测试连接」验证对象读写、列举与删除权限。</div>
    </div>
  );
}

/** 复用对象存储字段；自定义域名和路径风格互斥，厂商入口隐藏不支持的路径风格。 */
function ObjectStorageFields({ kind, value, onChange }: {
  kind: ObjectStorageKind;
  value: S3Config;
  onChange: (patch: Partial<S3Config>) => void;
}) {
  const example = STORAGE_EXAMPLES[kind];
  return (
    <div className="nb-sync-grid">
      <Field label="服务端点（Endpoint）" wide>
        <TextInput value={value.endpoint} onChange={(endpoint) => onChange({ endpoint })} placeholder={value.customDomain ? 'https://storage.example.com' : example.endpoint} />
      </Field>
      <Field label="区域（Region）" hint={kind === 'zos' ? 'S3 签名区域通常填 us-east-1，不是天翼云资源池 ID' : undefined}>
        <TextInput value={value.region} onChange={(region) => onChange({ region })} placeholder={example.region} />
      </Field>
      <Field label="存储桶（Bucket）">
        <TextInput value={value.bucket} onChange={(bucket) => onChange({ bucket })} placeholder={kind === 'cos' ? 'notes-1250000000' : 'my-notes'} />
      </Field>
      <Field label={kind === 'cos' ? '访问密钥 ID（SecretId）' : 'Access Key ID'}>
        <TextInput value={value.accessKeyId} onChange={(accessKeyId) => onChange({ accessKeyId })} placeholder="访问密钥 ID" />
      </Field>
      <Field label={kind === 'cos' ? '访问密钥（SecretKey）' : 'Secret Access Key'}>
        <SecretInput value={value.secretAccessKey} onChange={(secretAccessKey) => onChange({ secretAccessKey })} placeholder="密钥" />
      </Field>
      <Field label="对象前缀（远端目录）" hint="留空表示存储桶根目录">
        <TextInput value={value.prefix} onChange={(prefix) => onChange({ prefix })} placeholder="NoteBoard" />
      </Field>
      <HeaderInputs value={value.headers} onChange={(headers) => onChange({ headers })} />
      <div className="nb-sync-field is-wide">
        <ToggleRow title="使用自定义域名" desc="已在云控制台将此域名绑定到存储桶时开启" checked={value.customDomain ?? false}
          onChange={(customDomain) => onChange({ customDomain, pathStyle: false })} />
      </div>
      {(kind === 's3' || kind === 'zos' || kind === 'oos') && !value.customDomain && <div className="nb-sync-field is-wide">
        <ToggleRow title="路径风格访问" desc={kind === 'zos' ? 'ZOS 建议开启，直接使用服务端点与桶名访问' : 'MinIO 等自建服务通常需要开启，其他服务按其要求设置'} checked={value.pathStyle}
          onChange={(pathStyle) => onChange({ pathStyle })} />
      </div>}
    </div>
  );
}

/** Git 托管平台类服务 */
type GitKind = 'github' | 'gitee' | 'gitcode' | 'gitlab';

function isGitKind(kind: SyncProviderKind): kind is GitKind {
  return kind === 'github' || kind === 'gitee' || kind === 'gitcode' || kind === 'gitlab';
}

function GitHelp({ kind, baseUrl }: { kind: GitKind; baseUrl: string }) {
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
  if (kind === 'gitcode') {
    return (
      <div className="nb-sync-help">
        <ol>
          <li>
            在 GitCode 新建仓库（建议私有），<strong>创建时勾选「添加 README 文件」</strong>初始化仓库——接口无法向完全空白的仓库写入。
          </li>
          <li>
            创建访问令牌：头像 → 个人设置 → 访问令牌 → 新建访问令牌，授予仓库的读写权限。令牌只显示一次，请立即复制。
            <HelpLink href="https://gitcode.com/setting/token-classic">打开访问令牌页面</HelpLink>
          </li>
          <li>所属空间填写仓库地址中的用户名或组织名，例如 <code>gitcode.com/zhangsan/notes</code> 中的 <code>zhangsan</code>。</li>
        </ol>
        <div>GitCode 不支持一次提交多个文件，每个文件的变更会单独提交；单个文件不能超过 50MB。</div>
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
  kind: GitKind;
  value: GitRepoConfig;
  onChange: (patch: Partial<GitRepoConfig>) => void;
}) {
  const ownerLabel = kind === 'gitee' || kind === 'gitcode' ? '所属空间（用户名/组织）' : kind === 'gitlab' ? '用户名 / 群组路径' : '所有者（用户名/组织）';
  const tokenLabel = kind === 'gitee' ? '私人令牌' : kind === 'gitcode' ? '访问令牌' : '访问令牌（Personal access token）';
  return (
    <div className="nb-sync-grid">
      {/* Gitee / GitCode 只支持官方地址，不显示服务地址 */}
      {kind !== 'gitee' && kind !== 'gitcode' && (
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
  // 分类往返保留本次最后选中的服务；外部载入的已有配置直接定位到对应分类与厂商。
  const [lastStorage, setLastStorage] = useState<ObjectStorageKind>(isObjectStorage(value.kind) ? value.kind : 's3');
  const [lastGit, setLastGit] = useState<GitKind>(isGitKind(value.kind) ? value.kind : 'github');
  const group = isObjectStorage(value.kind) ? 'storage' : isGitKind(value.kind) ? 'git' : 'webdav';

  /** 仅切换当前类型，保留所有服务的输入，并记住离开分类前的具体服务。 */
  const selectKind = (kind: SyncProviderKind) => {
    if (isObjectStorage(value.kind)) setLastStorage(value.kind);
    if (isGitKind(value.kind)) setLastGit(value.kind);
    if (kind === 'zos') {
      // 只为从未填写过的 ZOS 配置预填官方示例参数，已有区域和访问方式均不覆盖。
      const storage = value.zos;
      const fresh = !storage.endpoint.trim() && !storage.region.trim() && !storage.bucket.trim()
        && !storage.accessKeyId.trim() && !storage.secretAccessKey && !storage.prefix.trim()
        && !storage.headers.length && !storage.customDomain && !storage.pathStyle;
      onChange(fresh ? { ...value, kind, zos: { ...storage, region: 'us-east-1', pathStyle: true } } : { ...value, kind });
    } else {
      onChange({ ...value, kind });
    }
  };

  /** 分类内再次点击保持当前厂商，分类间往返恢复最后选择。 */
  const selectGroup = (next: typeof group) => {
    if (next !== group) selectKind(next === 'storage' ? lastStorage : next === 'git' ? lastGit : 'webdav');
  };

  // 切换类型或修改配置后清除旧的测试结果
  useEffect(() => {
    setResult(null);
  }, [value]);

  const patchGit = (kind: GitKind, patch: Partial<GitRepoConfig>) =>
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
      <div className="nb-sync-segment nb-sync-provider-groups" role="radiogroup" aria-label="同步方式">
        {PROVIDER_GROUPS.map((option, index) => (
          <button
            key={option.group}
            type="button"
            role="radio"
            aria-checked={group === option.group}
            tabIndex={group === option.group ? 0 : -1}
            className={`nb-sync-segment-btn${group === option.group ? ' is-active' : ''}`}
            onClick={() => selectGroup(option.group)}
            onKeyDown={(event) => {
              // 单选分组支持方向键与首尾跳转，下拉沿用设置页已有的键盘和 Esc 行为。
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? PROVIDER_GROUPS.length - 1
                : event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (index + 1) % PROVIDER_GROUPS.length
                  : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (index + PROVIDER_GROUPS.length - 1) % PROVIDER_GROUPS.length : -1;
              if (next < 0) return;
              event.preventDefault();
              selectGroup(PROVIDER_GROUPS[next].group);
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
            }}
          >
            <option.icon size={15} aria-hidden="true" />
            {option.label}
          </button>
        ))}
      </div>

      {isObjectStorage(value.kind) && <div className="nb-sync-field nb-sync-service-picker">
        <span>存储服务</span>
        <SettingsSelect ariaLabel="对象存储服务" value={value.kind} options={STORAGE_OPTIONS} onChange={selectKind} />
      </div>}
      {isGitKind(value.kind) && <div className="nb-sync-field nb-sync-service-picker">
        <span>托管平台</span>
        <SettingsSelect ariaLabel="Git 托管平台" value={value.kind} options={GIT_OPTIONS} onChange={selectKind} />
      </div>}

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
          <HeaderInputs value={value.webdav.headers} onChange={(headers) => onChange({ ...value, webdav: { ...value.webdav, headers } })} />
        </div>
      )}

      {isObjectStorage(value.kind) && (
        <ObjectStorageFields key={`storage-${value.kind}`} kind={value.kind} value={value[value.kind]}
          onChange={(patch) => onChange({ ...value, [value.kind]: { ...value[value.kind as ObjectStorageKind], ...patch } })} />
      )}

      {isGitKind(value.kind) && (
        <GitFields kind={value.kind} value={value[value.kind]} onChange={(patch) => patchGit(value.kind as GitKind, patch)} />
      )}

      {/* 获取地址与密钥的说明：默认收起，切换服务类型后标题随之变化 */}
      {showHelp && (
        <Collapsible key={value.kind} variant="help" icon={<HelpCircle size={14} />} title={HELP_TITLES[value.kind]}>
          {value.kind === 'webdav' && <WebDavHelp />}
          {value.kind === 's3' && <S3Help />}
          {isObjectStorage(value.kind) && value.kind !== 's3' && <ObjectStorageHelp kind={value.kind} />}
          {isGitKind(value.kind) && <GitHelp kind={value.kind} baseUrl={value.gitlab.baseUrl} />}
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
