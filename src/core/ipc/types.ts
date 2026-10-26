// NoteBoard 前后端共享类型
// 与 src-tauri/src/dto.rs 手工同步
// 序列化约定：结构体字段 camelCase，枚举变体 kebab-case

// preview 为插件提供的二进制只读查看，禁止混入文本保存链路。
export type DocumentKind = 'markdown' | 'code' | 'board' | 'image' | 'mindmap' | 'drawio' | 'bitable' | 'preview' | 'unsupported';
// infographic：NoteBoard 自研信息图声明式源码（YAML/JSON），与 md 内嵌 ```infographic 块同源
export type LanguageId = 'markdown' | 'sql' | 'json' | 'yaml' | 'xml' | 'mermaid' | 'plantuml' | 'infographic' | 'plaintext';
export type SavePolicy = 'auto' | 'manual';
export type ViewMode = 'visual' | 'source';
export type Encoding = 'utf8' | 'utf8-bom' | 'gbk';
export type Eol = 'crlf' | 'lf';
export type ThemeId = 'chen-guang' | 'hu-po' | 'mo-ye';
export type ThemeMode = ThemeId | 'system';
// 编辑区宽度：预设档位或自定义百分比字符串（如 '75%'）
export type ContentWidth = 'narrow' | 'standard' | 'wide' | 'full' | (string & {});

// ── 枚举清单（与 Rust build.rs 生成的 contract-enums.json 一致）──

export const ALL_DOCUMENT_KINDS: DocumentKind[] = ['markdown', 'code', 'board', 'image', 'mindmap', 'drawio', 'bitable', 'preview', 'unsupported'];
export const ALL_ENCODINGS: Encoding[] = ['utf8', 'utf8-bom', 'gbk'];
export const ALL_EOLS: Eol[] = ['crlf', 'lf'];
export const ALL_LANGUAGE_IDS: LanguageId[] = ['markdown', 'sql', 'json', 'yaml', 'xml', 'mermaid', 'plantuml', 'infographic', 'plaintext'];
export const ALL_THEME_IDS: ThemeId[] = ['chen-guang', 'hu-po', 'mo-ye'];

// ── 文档载荷 ──

export interface DocumentPayload {
  key: string;
  displayName: string;
  dirPath: string;
  kind: DocumentKind;
  language: LanguageId;
  content: string | null;
  encoding: Encoding;
  eol: Eol;
  size: number;
  mtime: number;
  readonly: boolean;
}

export interface WriteResult {
  ok: boolean;
  mtime: number;
  size: number;
  error: WriteError | null;
}

export type WriteError =
  | { kind: 'permission-denied'; path: string }
  | { kind: 'disk-full' }
  | { kind: 'file-locked'; path: string }
  | { kind: 'readonly'; path: string }
  | { kind: 'path-not-found'; path: string }
  | { kind: 'io'; message: string };

// ── 文件树节点 ──

export interface FileTreeNode {
  path: string;
  name: string;
  isDir: boolean;
  kind: DocumentKind | null;
  size: number | null;
  mtime: number | null;
  isHidden: boolean;
  isSymlink: boolean;
}

// ── 窗口意图 ──

export type WindowIntent =
  | { type: 'empty' }
  | { type: 'open-files'; paths: string[] }
  | { type: 'adopt-documents'; docs: TransferredDocument[] };

/**
 * 迁移文档（S04 扩充字段；旧字段保留兼容读入）。
 * kind/language/encoding/eol/readonly/mtime/size/baseline/revision/history 为新增，
 * 缺省时由 adopt 侧按集中策略补齐（按 key 推断类型、utf8/lf、基线取 content）。
 */
export interface TransferredDocument {
  key: string;
  content: string | null;
  boardScene: unknown | null;
  isDirty: boolean;
  viewMode: ViewMode | null;
  viewState: ViewStateDto;
  kind?: DocumentKind | null;
  language?: string | null;
  encoding?: string | null;
  eol?: string | null;
  readonly?: boolean;
  mtime?: number;
  size?: number;
  baseline?: string | null;
  revision?: number;
  history?: unknown;
  /** R06：编辑器侧 captureViewState 的判别联合快照（选区/滚动/折叠/查看变换） */
  viewStateSnapshot?: unknown;
  /** 标签显示名（未命名文档的 key 不含可读名称，须随载荷传递；缺省按 key 推断） */
  displayName?: string | null;
}

// ── 打开请求队列（S04 C 节协议） ──

/** 打开请求来源 */
export type OpenRequestSource = 'cli' | 'second-instance' | 'drop' | 'dialog' | 'restore';

/** 单个文件的打开请求 */
export interface OpenRequestDto {
  requestId: string;
  batchId: string;
  sequence: number;
  source: OpenRequestSource;
  path: string;
  cwd: string | null;
}

/** list_open_requests 返回条目（携带读取时队列版本） */
export interface OpenRequestItemDto {
  request: OpenRequestDto;
  queueVersion: number;
}

/** 打开请求处理结果（业务处理有明确结果才 ack） */
export type OpenOutcome = 'opened' | 'focused' | 'cancelled' | 'failed';

/** 监听就绪握手结果 */
export interface WindowBootDto {
  protocolVersion: number;
  consumerId: string;
  /** empty | explicit-open | handoff */
  startupMode: 'empty' | 'explicit-open' | 'handoff';
  transferId: string | null;
  queueVersion: number;
  /** 握手时除本窗口外没有其他存活窗口（只有这种窗口才恢复最近关闭窗口快照；缺省视为 true） */
  isSoleWindow?: boolean;
}

// ── 文档迁移（transferId 协议） ──

/** 迁移状态机 */
export type TransferState = 'preparing' | 'target-prepared' | 'committed' | 'aborted';

/** 迁移发起响应 */
export interface BeginTransferResponse {
  transferId: string;
  targetLabel: string;
}

/** 迁移状态查询结果 */
export interface TransferStatusDto {
  transferId: string;
  state: TransferState;
  key: string | null;
}

// ── S07 统一文件准备判别结果（G 节） ──

/** already-open 在读盘前返回；text 携带已读入的完整 payload；其余分支不读正文 */
export type PreparedDocument =
  | { type: 'directory'; path: string }
  | {
      type: 'image';
      key: string;
      displayName: string;
      dirPath: string;
      language: string;
      size: number;
      mtime: number;
    }
  | { type: 'text'; payload: DocumentPayload }
  | {
      type: 'unsupported';
      key: string;
      displayName: string;
      dirPath: string;
      language: string;
      size: number;
    }
  | { type: 'already-open'; key: string; ownerLabel: string; ownerIsSelf: boolean }
  | { type: 'failed'; message: string; missing: boolean };

export interface ViewStateDto {
  selection: { anchor: number; head: number } | null;
  scrollTop: number;
  boardViewport: { scrollX: number; scrollY: number; zoom: number } | null;
  foldedRanges: Array<{ from: number; to: number }>;
}

// ── 注册结果 ──

export type RegisterResult =
  | { type: 'ok' }
  | { type: 'already-open'; ownerLabel: string };

// ── 字体 ──

export interface FontFamily {
  family: string;
  isMonospace: boolean;
  hasCjk: boolean;
}

/** S06 新增 verifying：后台校验中（faces 为空，未验证完成不得当 ready 使用） */
export type FontPackState = 'missing' | 'verifying' | 'ready' | 'invalid';

/** 后端已校验的单个字体字形；path 仅指向 NoteBoard 应用数据目录。 */
export interface FontPackFace {
  family: string;
  weight: string;
  style: string;
  path: string;
}

/** 字体包状态与可注册字形清单。 */
export interface FontPackStatus {
  id: string;
  version: string;
  state: FontPackState;
  installedSizeBytes: number;
  downloadSizeBytes: number;
  downloadUrl: string;
  faces: FontPackFace[];
}

/** 下载进度事件统一使用字节数，totalBytes 在服务端未返回长度时允许为空。 */
export interface DownloadProgress {
  downloadedBytes: number;
  totalBytes?: number | null;
  percent?: number | null;
}

// ── 设置 ──

export interface Settings {
  schemaVersion: number;
  revision: number;
  appearance: AppearanceSettings;
  typography: TypographySettings;
  editor: EditorSettings;
  file: FileSettings;
  layout: LayoutSettings;
  system: SystemSettings;
}

export interface AppearanceSettings {
  themeMode: ThemeMode;
  systemLightTheme: ThemeId;
  systemDarkTheme: ThemeId;
}

export interface TypographySettings {
  // 正文西文字体（留空跟随系统）
  contentFontFamily: string;
  // 正文中文字体（留空跟随系统）
  contentFontFamilyZh?: string;
  // 代码西文等宽字体
  monoFontFamily: string;
  // 代码中文等宽/中文字体
  monoFontFamilyZh?: string;
  contentFontSize: number;
  monoFontSize: number;
  contentLineHeight: number;
  // Markdown 正文段落间距 (px，缺省 14)
  contentParagraphSpacing?: number;
  // 代码/纯文本行高
  monoLineHeight?: number;
  // Markdown / 正文编辑区最大宽度（预设 wide/standard 等或百分比，默认 wide）
  contentWidth: ContentWidth;
  // 代码 / 纯文本 / Markdown 源码编辑区最大宽度（预设 full/wide 等或百分比，默认 full）
  monoContentWidth?: ContentWidth;
  // 代码 / 纯文本 / Markdown 源码编辑区上下内边距 (px，缺省 16)
  monoPaddingY?: number;
  // 代码 / 纯文本 / Markdown 源码编辑区左右内边距 (px，缺省 24；源码模式左侧取一半)
  monoPaddingX?: number;
  // 文件树西文字体（留空跟随系统）
  explorerFontFamily?: string;
  // 文件树中文字体（留空跟随系统）
  explorerFontFamilyZh?: string;
  // 文件树字号 (px)
  explorerFontSize?: number;
  // 文件树条目行高 (px)
  explorerLineHeight?: number;
  // 软件界面 UI 西文字体（留空跟随系统）
  uiFontFamily?: string;
  // 软件界面 UI 中文字体（留空跟随系统）
  uiFontFamilyZh?: string;
  // 软件界面 UI 字号 (px)
  uiFontSize?: number;
}

export interface EditorSettings {
  defaultViewMode: ViewMode;
  softWrap: boolean;
  showLineNumbers: boolean;
  showIndentGuides: boolean;
  tabSize: number;
  insertSpaces: boolean;
  enableMath: boolean;
  enableMermaid: boolean;
  enableAlerts: boolean;
  enableBlockHandle: boolean;
  // 显示空格与空白字符（点/箭头）
  showWhitespace: boolean;
  // 显示换行符号（↵）
  showLineEndings: boolean;
  // Markdown 进入可视化模式时的格式规范化策略（缺省视为 ask）
  markdownNormalization?: MarkdownNormalizationPolicy;
  // 可视化模式中代码块默认展开（缺省视为 true；仅影响显示，不写入文件）
  codeBlockDefaultExpanded?: boolean;
  // 可视化模式中折叠块 <details> 默认展开（缺省视为 false；源码带 open 属性时始终展开）
  detailsDefaultExpanded?: boolean;
  // 可视化模式中 Enter 与 Shift+Enter 互换：Enter 段内换行、Shift+Enter 换段落（缺省视为 false）
  swapEnterKeys?: boolean;
  // 思维导图节点最大宽度（px），超出后自动换行；缺省视为 280
  mindmapNodeMaxWidth?: number;
  // 思维导图节点标题默认对齐（缺省视为 left）
  mindmapTextAlign?: 'left' | 'center';
  // 思维导图节点图片默认显示方式：原始比例 / 宽度填充（缺省视为 original）
  mindmapImageFit?: 'original' | 'fill';
}

/** Markdown 规范化策略：每次询问 / 总是规范化 / 保持源码模式 */
export type MarkdownNormalizationPolicy = 'ask' | 'always' | 'never';

export interface FileSettings {
  // 自动保存设置：Markdown / 画板 / 其他文本（默认均关闭，即手动保存）
  autoSaveMarkdown: boolean;
  autoSaveBoard: boolean;
  autoSaveOther: boolean;
  // 信息图（.infographic / .ig）单独的自动保存开关；缺省时沿用 autoSaveOther
  autoSaveInfographic?: boolean;
  // 思维导图 / Draw.io / 多维表格自动保存（旧版设置缺失时视为关闭）
  autoSaveMindmap?: boolean;
  autoSaveDrawio?: boolean;
  autoSaveBitable?: boolean;
  forceManualSave: boolean;
  showHiddenFiles: boolean;
  restoreSession: boolean;
  imageDirName: string;
  largeFileConfirmMb: number;
  // 未保存文件的用户可见暂存目录（绝对路径）
  stagingDirectory: string;
}

// ── 暂存 ──

export interface StagingDocument {
  key: string;
  displayName: string;
  content: string;
  encoding: Encoding;
  eol: Eol;
  // 首次为空，后续传回既有路径以覆盖同一份副本
  targetPath: string | null;
}

export interface StagingResult {
  key: string;
  targetPath: string;
}

// ── 最近关闭窗口 ──

export interface SessionTabSnapshot {
  key: string;
  isPinned: boolean;
  viewMode: ViewMode | null;
  sourcePath: string | null;
  stagedPath: string | null;
  displayName: string;
}

export interface SessionWindowSnapshot {
  seq: number;
  explorerRoot: string;
  layout: {
    explorerVisible: boolean;
    explorerWidth: number;
    outlineVisible: boolean;
    outlineWidth: number;
  };
  tabs: SessionTabSnapshot[];
  activeKey: string;
}

export interface SessionSnapshot {
  schemaVersion: number;
  savedAt: number;
  windows: SessionWindowSnapshot[];
}

export interface LayoutSettings {
  statusBarVisible: boolean;
  uiScale: number;
}

/** 系统集成设置（仅桌面端生效） */
export interface SystemSettings {
  /** 关闭按钮最小化到托盘（默认 false）：开启后关闭仅隐藏窗口，不弹未保存确认 */
  closeToTray: boolean;
  /** 全局唤起窗口快捷键（默认留空不注册），格式如 Ctrl+Alt+N */
  showWindowShortcut: string;
}

// ── 事件载荷 ──

export interface ExternalChangePayload {
  key: string;
  changeType: 'modified' | 'deleted' | 'renamed';
  mtime: number;
  size: number;
  newPath?: string;
}

export interface CreateWindowResponse {
  label: string;
}

export interface ProbeResult {
  size: number;
  kind: DocumentKind;
  isText: boolean;
  exists: boolean;
  isDir: boolean;
}

export interface PathExistsResult {
  exists: boolean;
  isDir: boolean;
}

export interface ReconcileResult {
  removed: string[];
}

export interface ConfirmHandoffResult {
  done: boolean;
}

// ── 应用更新相关类型 ──

export interface UpdateCheckResult {
  // 当前运行客户端版本
  currentVersion: string;
  // 远程 GitHub 最新发布版本
  latestVersion: string;
  // Release 标题
  releaseName?: string | null;
  // GitHub Release 页面链接
  releaseUrl: string;
  // 发布时间戳字符串
  publishedAt?: string | null;
  // 是否有可用新版本
  updateAvailable: boolean;
  // 匹配到的 Windows 安装包文件名
  installerAssetName?: string | null;
  // 安装包直接下载链接
  installerDownloadUrl?: string | null;
  // 安装包文件大小（字节数）
  installerSize?: number | null;
  // Release 更新说明
  releaseBody?: string | null;
  // 当前版本之后所有未安装版本的更新日志（最新版在前）
  releaseNotes?: UpdateReleaseNote[];
  // 未安装版本超出单页 Release 列表，更早的日志需前往 Release 页面查看
  releaseNotesTruncated?: boolean;
  // Windows 免安装版：不提供安装包，引导前往 Release 页面下载
  portable?: boolean;
}

// 单个版本的更新日志条目
export interface UpdateReleaseNote {
  // 版本号（不含 v 前缀）
  version: string;
  // Release 标题
  name?: string | null;
  // 该版本 Release 页面链接
  url: string;
  // 发布时间戳字符串
  publishedAt?: string | null;
  // 更新日志正文
  body?: string | null;
}

export interface UpdateDownloadProgress {
  // 已下载字节数
  downloadedBytes: number;
  // 文件总字节数
  totalBytes?: number;
  // 当前进度百分比 (0-100)
  percent?: number;
}

// ── 收藏夹相关类型 ──

export interface FavoriteFileItem {
  id: string;
  type: 'file';
  name: string;
  path: string;
  createdAt: number;
}

export interface FavoriteFolderItem {
  id: string;
  type: 'folder';
  name: string;
  createdAt: number;
  children: FavoriteNode[];
}

export type FavoriteNode = FavoriteFileItem | FavoriteFolderItem;

export interface FavoritesData {
  schemaVersion: number;
  roots: FavoriteNode[];
}



// ── 平台信息与移动端桥接 ──

/** 平台信息（get_platform_info） */
export interface PlatformInfo {
  /** windows / macos / linux / android / ios */
  platform: string;
  isMobile: boolean;
  /** 默认笔记工作区路径（移动端应用私有目录；桌面端仅调试强制移动布局时使用） */
  defaultWorkspace: string;
  /** 外部存储根目录（Android，例如 /storage/emulated/0） */
  externalRoot: string;
  /** 是否已获得外部存储完整访问权限（Android） */
  allFilesAccess: boolean;
}

// ── 多端同步与备份 ──

/** 远端服务类型 */
export type SyncProviderKind = 'webdav' | 's3' | 'github' | 'gitee' | 'gitcode' | 'gitlab';

export interface WebDavConfig {
  url: string;
  username: string;
  password: string;
  /** 自定义 User-Agent，留空使用 NoteBoard/版本号 */
  userAgent: string;
  remoteDir: string;
}

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
  pathStyle: boolean;
  /** 自定义 User-Agent，留空使用 NoteBoard/版本号 */
  userAgent: string;
}

export interface GitRepoConfig {
  /** 自建实例地址（GitLab 自建 / GitHub Enterprise），留空使用官方地址 */
  baseUrl: string;
  owner: string;
  repo: string;
  branch: string;
  token: string;
  remoteDir: string;
}

/** 一套远端服务配置（各类型输入都保留，切换类型不丢失） */
export interface SyncProviderConfig {
  kind: SyncProviderKind;
  webdav: WebDavConfig;
  s3: S3Config;
  github: GitRepoConfig;
  gitee: GitRepoConfig;
  gitcode: GitRepoConfig;
  gitlab: GitRepoConfig;
}

export interface SyncSettings {
  enabled: boolean;
  rootDir: string;
  deviceName: string;
  provider: SyncProviderConfig;
  syncOnSave: boolean;
  intervalEnabled: boolean;
  intervalMinutes: number;
  syncOnStartup: boolean;
  notifyNoChange: boolean;
  trashEnabled: boolean;
  trashDays: number;
}

export type BackupTarget = 'local' | 'remote';

export interface BackupSettings {
  autoEnabled: boolean;
  intervalHours: number;
  /** 只保留本机最新 N 份，0 表示不限制 */
  keepCount: number;
  target: BackupTarget;
  localDir: string;
  provider: SyncProviderConfig;
}

export interface SyncConfigFile {
  version: number;
  deviceId: string;
  sync: SyncSettings;
  backup: BackupSettings;
}

export interface SyncCounts {
  added: number;
  modified: number;
  deleted: number;
}

export interface SyncReport {
  at: number;
  durationMs: number;
  trigger: string;
  ok: boolean;
  /** 本机 → 云端 */
  upload: SyncCounts;
  /** 云端 → 本机 */
  download: SyncCounts;
  merged: number;
  conflicts: number;
  errors: string[];
  message: string;
}

export interface BackupReport {
  at: number;
  ok: boolean;
  trigger: string;
  name: string;
  size: number;
  fileCount: number;
  removedOld: number;
  message: string;
}

/** 首次配对时内容不同的同名文件；方向由 SHA-256 和两端修改时间确定。 */
export interface SyncFileUpdate {
  path: string;
  direction: 'upload' | 'download';
  localMtime: number;
  remoteMtime: number;
  localSize: number;
  remoteSize: number;
  fingerprint: string;
}

export interface SyncUpdateConfirmation {
  id: string;
  files: SyncFileUpdate[];
}

export interface SyncStatus {
  /** 旧宿主未提供字段时按未暂停处理。 */
  syncPaused?: boolean;
  updateConfirmation?: SyncUpdateConfirmation | null;
  syncing: boolean;
  backingUp: boolean;
  lastSync: SyncReport | null;
  lastBackup: BackupReport | null;
  nextSyncAt: number;
  nextBackupAt: number;
}

/** 同步对本机文件的改动 */
export interface SyncLocalChange {
  kind: 'modified' | 'added' | 'deleted' | 'moved';
  path: string;
  from?: string;
}

export interface SyncReportEvent {
  kind: 'sync' | 'backup';
  report: SyncReport | BackupReport;
  notify: boolean;
}

export interface SyncTrashItem {
  /** 回收站内相对路径（.nb-trash/xxx） */
  id: string;
  name: string;
  isDir: boolean;
  origPath: string;
  trashedAt: number;
  /** 自动彻底删除时间，0 表示不会自动删除 */
  expiresAt: number;
  size: number;
  fileCount: number;
}

export interface BackupInfo {
  name: string;
  size: number;
  createdAt: number;
  device: string;
  isOwn: boolean;
}

// ── 文档历史记录 ──

/** 历史记录模式：关闭 / 仅本机 / 跨设备同步 */
export type HistoryMode = 'off' | 'local' | 'sync';

export interface HistoryConfigView {
  mode: HistoryMode;
  /** 保留天数，0 表示永久 */
  retentionDays: number;
  mergeWindowMin: number;
  /** 容量上限（MB），0 表示按模式默认 */
  maxTotalMb: number;
  effectiveMaxMb: number;
  /** 已开启多端同步（可选择跨设备同步） */
  syncAvailable: boolean;
  /** 同步服务为 Git 类仓库 */
  gitBackend: boolean;
}

export interface HistoryOptionsInput {
  retentionDays: number;
  mergeWindowMin: number;
  maxTotalMb: number;
}

export type HistoryReason =
  | 'initial'
  | 'save'
  | 'external'
  | 'before-sync'
  | 'sync-pull'
  | 'sync-merge'
  | 'before-restore'
  | 'restore';

export interface HistoryStats {
  ins: number;
  del: number;
  modified?: number;
  /** char 字符 / element 画板元素 / node 导图节点 / row 表格行 / cell 图形单元 */
  unit: string;
}

export interface HistoryEntry {
  id: string;
  start: number;
  at: number;
  hash: string;
  size: number;
  reason: HistoryReason;
  origin: { device: string; name: string };
  stats?: HistoryStats;
  restoredFrom?: string;
  pinned?: boolean;
  /** 合并窗口中（后续保存仍会并入这一版） */
  open?: boolean;
  isOwn: boolean;
}

export interface HistoryListResult {
  docId: string | null;
  kind: string;
  deviceId: string;
  /** 新到旧 */
  entries: HistoryEntry[];
}

export interface HistoryReadResult {
  content: string;
  encoding: Encoding;
  size: number;
}

export interface HistoryUsage {
  bytes: number;
  docs: number;
  entries: number;
}

export type HistoryCheckpointReason = 'close' | 'before-restore' | 'restore';
