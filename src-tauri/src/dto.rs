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
    Image,
    Mindmap,
    Drawio,
    // 多维表格格式 (.bitable / .table)
    Bitable,
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
    Mermaid,
    Plantuml,
    /// NoteBoard 自研信息图声明式源码（YAML/JSON），与 mermaid / plantuml 同为可独立成文件的图表脚本
    Infographic,
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
    #[serde(default)]
    pub board_scene: Option<serde_json::Value>,
    pub is_dirty: bool,
    pub view_mode: Option<ViewMode>,
    pub view_state: serde_json::Value,
    // ── S04 迁移协议扩充字段（旧字段保留兼容读入；缺省策略集中在 adopt 侧实现） ──
    /// 文档类型（code/markdown/board/...；缺省按 key 扩展名推断）
    #[serde(default)]
    pub kind: Option<DocumentKind>,
    /// 语言 ID（缺省按 key 推断）
    #[serde(default)]
    pub language: Option<String>,
    /// 编码与 EOL（缺省 utf8/lf）
    #[serde(default)]
    pub encoding: Option<String>,
    #[serde(default)]
    pub eol: Option<String>,
    /// 只读标记（缺省 false）
    #[serde(default)]
    pub readonly: bool,
    /// 磁盘元信息（缺省 0）
    #[serde(default)]
    pub mtime: i64,
    #[serde(default)]
    pub size: u64,
    /// 保存基线内容（脏文档必须携带，用于脏态判定）
    #[serde(default)]
    pub baseline: Option<String>,
    /// 迁移时内容版本（源实例 flush 时捕获）
    #[serde(default)]
    pub revision: u64,
    /// 可序列化统一历史（按类型 JSON 表示）
    #[serde(default)]
    pub history: Option<serde_json::Value>,
}

// ── 打开请求队列（C 节协议） ──

/// 打开请求来源
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum OpenRequestSource {
    Cli,
    SecondInstance,
    Drop,
    Dialog,
    Restore,
}

/// 单个文件的打开请求；同批路径按输入顺序分配 sequence
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequestDto {
    pub request_id: String,
    pub batch_id: String,
    pub sequence: u64,
    pub source: OpenRequestSource,
    pub path: String,
    pub cwd: Option<String>,
}

/// list_open_requests 返回的条目（非破坏读取，携带读取时队列版本）
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequestItemDto {
    pub request: OpenRequestDto,
    pub queue_version: u64,
}

/// 打开请求处理结果
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum OpenOutcome {
    Opened,
    Focused,
    Cancelled,
    Failed,
}

/// 窗口启动握手结果
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WindowBootDto {
    pub protocol_version: u32,
    pub consumer_id: String,
    /// empty | explicit-open | handoff
    pub startup_mode: String,
    pub transfer_id: Option<String>,
    pub queue_version: u64,
}

// ── 文档迁移（transferId 协议） ──

/// 迁移状态机：preparing → target-prepared → committed / aborted
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TransferState {
    Preparing,
    TargetPrepared,
    Committed,
    Aborted,
}

/// 迁移发起响应
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BeginTransferResponse {
    pub transfer_id: String,
    pub target_label: String,
}

/// 迁移状态查询结果
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TransferStatusDto {
    pub transfer_id: String,
    pub state: TransferState,
    pub key: Option<String>,
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

/// 应用内字体资源包中的单个可注册字形；path 只指向校验通过的应用数据目录文件。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FontPackFace {
    pub family: String,
    pub weight: String,
    pub style: String,
    pub path: String,
}

/// 字体资源包状态由 Rust 统一校验，前端只按描述注册到当前 WebView。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FontPackStatus {
    pub id: String,
    pub version: String,
    /// missing=从未安装；ready=文件完整；invalid=目录存在但文件缺失或校验失败。
    pub state: String,
    pub installed_size_bytes: u64,
    pub download_size_bytes: u64,
    pub download_url: String,
    pub faces: Vec<FontPackFace>,
}

// ── 扩展名映射（单一真相源）──

pub fn kind_by_ext(ext: &str) -> (DocumentKind, LanguageId) {
    match ext.to_lowercase().as_str() {
        "md" | "markdown" => (DocumentKind::Markdown, LanguageId::Markdown),
        "excalidraw" | "board" | "canvas" => (DocumentKind::Board, LanguageId::Plaintext),
        "mindmap" | "xmind" | "mm" => (DocumentKind::Mindmap, LanguageId::Json),
        "drawio" | "dio" => (DocumentKind::Drawio, LanguageId::Xml),
        "bitable" | "table" => (DocumentKind::Bitable, LanguageId::Json),
        "mmd" | "mermaid" => (DocumentKind::Code, LanguageId::Mermaid),
        "puml" | "plantuml" | "iuml" | "uml" => (DocumentKind::Code, LanguageId::Plantuml),
        "infographic" | "ig" => (DocumentKind::Code, LanguageId::Infographic),
        "sql" => (DocumentKind::Code, LanguageId::Sql),
        "json" => (DocumentKind::Code, LanguageId::Json),
        "yaml" | "yml" => (DocumentKind::Code, LanguageId::Yaml),
        "xml" => (DocumentKind::Code, LanguageId::Xml),
        "txt" | "log" | "ini" | "conf" | "cfg" | "env" => {
            (DocumentKind::Code, LanguageId::Plaintext)
        }
        // 常见与特殊图片格式（包括 gif、webp、ico、png、jpg、svg、bmp 等）
        "png" | "jpg" | "jpeg" | "jpe" | "jfif" | "gif" | "webp" | "ico" | "cur" | "svg"
        | "bmp" | "dib" | "avif" | "apng" | "tif" | "tiff" => {
            (DocumentKind::Image, LanguageId::Plaintext)
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
        DocumentKind::Markdown | DocumentKind::Board | DocumentKind::Mindmap | DocumentKind::Drawio | DocumentKind::Bitable => SavePolicy::Auto,
        DocumentKind::Code | DocumentKind::Image | DocumentKind::Unsupported => SavePolicy::Manual,
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

// ── S07 文件准备判别结果（G 节统一服务） ──

/// 统一文件准备的判别结果：
/// already-open 在读盘前返回（本窗口在途或已开、其他窗口已开）；
/// text 携带已读入的完整 payload；其余分支不读正文。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum PreparedDocument {
    #[serde(rename_all = "camelCase")]
    Directory { path: String },
    #[serde(rename_all = "camelCase")]
    Image {
        key: String,
        display_name: String,
        dir_path: String,
        language: String,
        size: u64,
        mtime: i64,
    },
    #[serde(rename_all = "camelCase")]
    Text { payload: DocumentPayload },
    #[serde(rename_all = "camelCase")]
    Unsupported {
        key: String,
        display_name: String,
        dir_path: String,
        language: String,
        size: u64,
    },
    #[serde(rename_all = "camelCase")]
    AlreadyOpen {
        key: String,
        owner_label: String,
        /// 归属为本窗口（含在途准备）：前端直接激活标签，不重复读盘
        owner_is_self: bool,
    },
    #[serde(rename_all = "camelCase")]
    Failed {
        message: String,
        /// 文件不存在（前端据此走缺失文件流程）
        missing: bool,
    },
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

// ── 应用更新检查结果 ──

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    // 当前运行程序版本号
    pub current_version: String,
    // 远程 GitHub 最新发布版本号
    pub latest_version: String,
    // Release 标题名称
    pub release_name: Option<String>,
    // Release 页面 URL
    pub release_url: String,
    // 发布时间 ISO8601 字符串
    pub published_at: Option<String>,
    // 是否检测到可用新版本
    pub update_available: bool,
    // 安装包文件名（如 NoteBoard_0.2.0_x64-setup.exe）
    pub installer_asset_name: Option<String>,
    // 安装包直接下载链接
    pub installer_download_url: Option<String>,
    // 安装包文件大小（字节数）
    pub installer_size: Option<u64>,
    // Release 更新日志正文说明
    pub release_body: Option<String>,
}
