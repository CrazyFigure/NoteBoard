// NoteBoard 前后端共享类型
// 与 src-tauri/src/dto.rs 手工同步
// 序列化约定：结构体字段 camelCase，枚举变体 kebab-case

export type DocumentKind = 'markdown' | 'code' | 'board' | 'image' | 'unsupported';
export type LanguageId = 'markdown' | 'sql' | 'json' | 'yaml' | 'xml' | 'plaintext';
export type SavePolicy = 'auto' | 'manual';
export type ViewMode = 'visual' | 'source';
export type Encoding = 'utf8' | 'utf8-bom' | 'gbk';
export type Eol = 'crlf' | 'lf';
export type ThemeId = 'chen-guang' | 'hu-po' | 'mo-ye';
export type ThemeMode = ThemeId | 'system';
// 编辑区宽度：预设档位或自定义百分比字符串（如 '75%'）
export type ContentWidth = 'narrow' | 'standard' | 'wide' | 'full' | (string & {});

// ── 枚举清单（与 Rust build.rs 生成的 contract-enums.json 一致）──

export const ALL_DOCUMENT_KINDS: DocumentKind[] = ['markdown', 'code', 'board', 'image', 'unsupported'];
export const ALL_ENCODINGS: Encoding[] = ['utf8', 'utf8-bom', 'gbk'];
export const ALL_EOLS: Eol[] = ['crlf', 'lf'];
export const ALL_LANGUAGE_IDS: LanguageId[] = ['markdown', 'sql', 'json', 'yaml', 'xml', 'plaintext'];
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
  contentFontFamily: string;
  monoFontFamily: string;
  contentFontSize: number;
  monoFontSize: number;
  contentLineHeight: number;
  // 代码/纯文本行高
  monoLineHeight?: number;
  contentWidth: ContentWidth;
  // 文件树字体（留空跟随系统）
  explorerFontFamily?: string;
  // 文件树字号 (px)
  explorerFontSize?: number;
  // 文件树条目行高 (px)
  explorerLineHeight?: number;
  // 软件界面 UI 字体（留空跟随系统）
  uiFontFamily?: string;
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
  forceManualSave: boolean;
  showHiddenFiles: boolean;
  restoreSession: boolean;
  imageDirName: string;
  largeFileConfirmMb: number;
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
