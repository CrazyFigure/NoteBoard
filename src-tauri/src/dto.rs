// NoteBoard DTO — 前后端共享数据类型
// 与前端 src/core/ipc/types.ts 手工同步
// 序列化约定：结构体字段 camelCase，枚举变体 kebab-case

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// ── 基础枚举 ──

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Hash, Default)]
#[serde(rename_all = "kebab-case")]
pub enum DocumentKind {
    #[default]
    Markdown,
    Code,
    Board,
    Unsupported,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum LanguageId {
    Markdown,
    Sql,
    Json,
    Yaml,
    Xml,
    Plaintext,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum SavePolicy {
    Auto,
    Manual,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum ViewMode {
    Visual,
    Source,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum Encoding {
    Utf8,
    Utf8Bom,
    Gbk,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum Eol {
    Crlf,
    Lf,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum ContentWidth {
    Narrow,
    Standard,
    Wide,
    Full,
}

// ── 文档载荷 ──

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPayload {
    pub key: String,
    pub display_name: String,
    pub dir_path: String,
    pub kind: DocumentKind,
    pub language: LanguageId,
    pub content: Option<String>,
    pub encoding: Encoding,
    pub eol: Eol,
    pub size: u64,
    pub mtime: i64,
    pub readonly: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub ok: bool,
    pub mtime: i64,
    pub size: u64,
    pub error: Option<WriteError>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum WriteError {
    #[serde(rename_all = "camelCase")]
    PermissionDenied { path: String },
    DiskFull,
    #[serde(rename_all = "camelCase")]
    FileLocked { path: String },
    #[serde(rename_all = "camelCase")]
    Readonly { path: String },
    #[serde(rename_all = "camelCase")]
    PathNotFound { path: String },
    #[serde(rename_all = "camelCase")]
    Io { message: String },
}

impl std::fmt::Display for WriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PermissionDenied { path } => write!(f, "权限不足: {}", path),
            Self::DiskFull => write!(f, "磁盘空间不足"),
            Self::FileLocked { path } => write!(f, "文件被占用: {}", path),
            Self::Readonly { path } => write!(f, "文件是只读的: {}", path),
            Self::PathNotFound { path } => write!(f, "路径不存在: {}", path),
            Self::Io { message } => write!(f, "IO 错误: {}", message),
        }
    }
}

// ── 文件树节点 ──

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileTreeNode {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub kind: Option<DocumentKind>,
    pub size: Option<u64>,
    pub mtime: Option<i64>,
    pub is_hidden: bool,
    pub is_symlink: bool,
}

// ── 窗口意图 ──

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum WindowIntent {
    Empty,
    #[serde(rename_all = "camelCase")]
    OpenFiles { paths: Vec<String> },
    #[serde(rename_all = "camelCase")]
    AdoptDocuments { docs: Vec<TransferredDocument> },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TransferredDocument {
    pub key: String,
    pub content: Option<String>,
    pub board_scene: Option<serde_json::Value>,
    pub is_dirty: bool,
    pub view_mode: Option<ViewMode>,
    pub view_state: serde_json::Value,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ViewStateDto {
    pub selection: Option<Selection>,
    pub scroll_top: f64,
    pub board_viewport: Option<BoardViewport>,
    pub folded_ranges: Vec<FoldedRange>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub anchor: usize,
    pub head: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BoardViewport {
    pub scroll_x: f64,
    pub scroll_y: f64,
    pub zoom: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FoldedRange {
    pub from: usize,
    pub to: usize,
}

// ── 注册结果 ──

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum RegisterResult {
    Ok,
    #[serde(rename_all = "camelCase")]
    AlreadyOpen { owner_label: String },
}

// ── 字体 ──

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FontFamily {
    pub family: String,
    pub is_monospace: bool,
    pub has_cjk: bool,
}

// ── 扩展名映射（单一真相源）──

pub fn kind_by_ext(ext: &str) -> (DocumentKind, LanguageId) {
    match ext.to_lowercase().as_str() {
        "md" | "markdown" => (DocumentKind::Markdown, LanguageId::Markdown),
        "excalidraw" => (DocumentKind::Board, LanguageId::Plaintext),
        "sql" => (DocumentKind::Code, LanguageId::Sql),
        "json" => (DocumentKind::Code, LanguageId::Json),
        "yaml" | "yml" => (DocumentKind::Code, LanguageId::Yaml),
        "xml" => (DocumentKind::Code, LanguageId::Xml),
        "txt" | "log" | "ini" | "conf" | "cfg" | "env" => {
            (DocumentKind::Code, LanguageId::Plaintext)
        }
        _ => (DocumentKind::Code, LanguageId::Plaintext),
    }
}

pub fn ext_from_path(path: &str) -> String {
    std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
}

pub fn kind_from_path(path: &str) -> (DocumentKind, LanguageId) {
    let ext = ext_from_path(path);
    if ext.is_empty() {
        return (DocumentKind::Code, LanguageId::Plaintext);
    }
    kind_by_ext(&ext)
}

pub fn save_policy_of(kind: DocumentKind) -> SavePolicy {
    match kind {
        DocumentKind::Markdown | DocumentKind::Board => SavePolicy::Auto,
        DocumentKind::Code | DocumentKind::Unsupported => SavePolicy::Manual,
    }
}

// ── 响应类型 ──

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CreateWindowResponse {
    pub label: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub size: u64,
    pub kind: DocumentKind,
    pub is_text: bool,
    pub exists: bool,
    pub is_dir: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PathExistsResult {
    pub exists: bool,
    pub is_dir: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileResult {
    pub removed: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmHandoffResult {
    pub done: bool,
}

// PathBuf helper
impl From<PathBuf> for FileTreeNode {
    fn from(_p: PathBuf) -> Self {
        Self {
            path: String::new(),
            name: String::new(),
            is_dir: false,
            kind: None,
            size: None,
            mtime: None,
            is_hidden: false,
            is_symlink: false,
        }
    }
}
