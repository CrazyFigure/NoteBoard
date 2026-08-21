// NoteBoard 前后端共享类型
// 与 src-tauri/src/dto.rs 手工同步
// 序列化约定：结构体字段 camelCase，枚举变体 kebab-case

export type DocumentKind = 'markdown' | 'code' | 'board' | 'image' | 'mindmap' | 'drawio' | 'unsupported';
export type LanguageId = 'markdown' | 'sql' | 'json' | 'yaml' | 'xml' | 'mermaid' | 'plantuml' | 'plaintext';
export type SavePolicy = 'auto' | 'manual';
export type ViewMode = 'visual' | 'source';
export type Encoding = 'utf8' | 'utf8-bom' | 'gbk';
export type Eol = 'crlf' | 'lf';
export type ThemeId = 'chen-guang' | 'hu-po' | 'mo-ye';
export type ThemeMode = ThemeId | 'system';
// 编辑区宽度：预设档位或自定义百分比字符串（如 '75%'）
export type ContentWidth = 'narrow' | 'standard' | 'wide' | 'full' | (string & {});

// ── 枚举清单（与 Rust build.rs 生成的 contract-enums.json 一致）──

export const ALL_DOCUMENT_KINDS: DocumentKind[] = ['markdown', 'code', 'board', 'image', 'mindmap', 'drawio', 'unsupported'];
export const ALL_ENCODINGS: Encoding[] = ['utf8', 'utf8-bom', 'gbk'];
export const ALL_EOLS: Eol[] = ['crlf', 'lf'];
export const ALL_LANGUAGE_IDS: LanguageId[] = ['markdown', 'sql', 'json', 'yaml', 'xml', 'mermaid', 'plantuml', 'plaintext'];
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

export interface TransferredDocument {
  key: string;
  content: string | null;
  boardScene: unknown | null;
  isDirty: boolean;
  viewMode: ViewMode | null;
  viewState: ViewStateDto;
}

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

// ── 设置 ──

export interface Settings {
  schemaVersion: number;
  revision: number;
  appearance: AppearanceSettings;
  typography: TypographySettings;
  editor: EditorSettings;
  file: FileSettings;
  layout: LayoutSettings;
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
  // 代码/纯文本行高
  monoLineHeight?: number;
  // Markdown / 正文编辑区最大宽度（预设 wide/standard 等或百分比，默认 wide）
  contentWidth: ContentWidth;
  // 代码 / 纯文本编辑区最大宽度（预设 full/wide 等或百分比，默认 full）
  monoContentWidth?: ContentWidth;
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
}

export interface FileSettings {
  // 自动保存设置：Markdown / 画板 / 其他文本（默认均关闭，即手动保存）
  autoSaveMarkdown: boolean;
  autoSaveBoard: boolean;
  autoSaveOther: boolean;
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
}

export interface UpdateDownloadProgress {
  // 已下载字节数
  downloadedBytes: number;
  // 文件总字节数
  totalBytes?: number;
  // 当前进度百分比 (0-100)
  percent?: number;
}

