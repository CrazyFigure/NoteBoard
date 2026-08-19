// NoteBoard 设置模型
// 持久化在 %APPDATA%\NoteBoard\settings.json
// 读取容错：任一字段缺失用默认值填充，不整体丢弃

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

fn app_data_dir() -> PathBuf {
    let base = std::env::var("APPDATA")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(base).join("NoteBoard")
}

fn settings_path() -> PathBuf {
    app_data_dir().join("settings.json")
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub revision: u64,

    #[serde(default)]
    pub appearance: AppearanceSettings,
    #[serde(default)]
    pub typography: TypographySettings,
    #[serde(default)]
    pub editor: EditorSettings,
    #[serde(default)]
    pub file: FileSettings,
    #[serde(default)]
    pub layout: LayoutSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            schema_version: 1,
            revision: 0,
            appearance: AppearanceSettings::default(),
            typography: TypographySettings::default(),
            editor: EditorSettings::default(),
            file: FileSettings::default(),
            layout: LayoutSettings::default(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceSettings {
    #[serde(default = "default_theme_mode")]
    pub theme_mode: String,
    #[serde(default = "default_light_theme")]
    pub system_light_theme: String,
    #[serde(default = "default_dark_theme")]
    pub system_dark_theme: String,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            theme_mode: "system".to_string(),
            system_light_theme: "chen-guang".to_string(),
            system_dark_theme: "mo-ye".to_string(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TypographySettings {
    // 正文西文字体（留空跟随系统）
    #[serde(default)]
    pub content_font_family: String,
    // 正文中文字体（留空跟随系统）
    #[serde(default)]
    pub content_font_family_zh: String,
    // 代码西文等宽字体
    #[serde(default = "default_mono_font")]
    pub mono_font_family: String,
    // 代码中文等宽/中文字体
    #[serde(default = "default_mono_font_zh")]
    pub mono_font_family_zh: String,
    #[serde(default = "default_content_font_size")]
    pub content_font_size: u32,
    #[serde(default = "default_mono_font_size")]
    pub mono_font_size: u32,
    #[serde(default = "default_line_height")]
    pub content_line_height: f64,
    // 代码/纯文本行高
    #[serde(default = "default_mono_line_height")]
    pub mono_line_height: f64,
    #[serde(default = "default_content_width")]
    pub content_width: String,
    // 文件树西文字体（留空跟随系统）
    #[serde(default)]
    pub explorer_font_family: String,
    // 文件树中文字体（留空跟随系统）
    #[serde(default)]
    pub explorer_font_family_zh: String,
    // 文件树字号
    #[serde(default = "default_explorer_font_size")]
    pub explorer_font_size: u32,
    // 文件树条目行高
    #[serde(default = "default_explorer_line_height")]
    pub explorer_line_height: u32,
    // 软件界面 UI 西文字体（留空跟随系统）
    #[serde(default)]
    pub ui_font_family: String,
    // 软件界面 UI 中文字体（留空跟随系统）
    #[serde(default)]
    pub ui_font_family_zh: String,
    // 软件界面 UI 字号
    #[serde(default = "default_ui_font_size")]
    pub ui_font_size: u32,
}

impl Default for TypographySettings {
    fn default() -> Self {
        Self {
            content_font_family: String::new(),
            content_font_family_zh: String::new(),
            // 默认代码西文字体：内置 JetBrains Mono
            mono_font_family: "JetBrains Mono".to_string(),
            // 默认代码中文字体：内置 Maple Mono Normal NF CN
            mono_font_family_zh: "Maple Mono Normal NF CN".to_string(),
            content_font_size: 16,
            mono_font_size: 14,
            content_line_height: 1.7,
            mono_line_height: 1.5,
            content_width: "standard".to_string(),
            explorer_font_family: String::new(),
            explorer_font_family_zh: String::new(),
            explorer_font_size: 13,
            explorer_line_height: 24,
            ui_font_family: String::new(),
            ui_font_family_zh: String::new(),
            ui_font_size: 13,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EditorSettings {
    #[serde(default = "default_view_mode")]
    pub default_view_mode: String,
    #[serde(default = "default_true")]
    pub soft_wrap: bool,
    #[serde(default = "default_true")]
    pub show_line_numbers: bool,
    #[serde(default = "default_true")]
    pub show_indent_guides: bool,
    #[serde(default = "default_tab_size")]
    pub tab_size: u32,
    #[serde(default = "default_true")]
    pub insert_spaces: bool,
    #[serde(default = "default_true")]
    pub enable_math: bool,
    #[serde(default = "default_true")]
    pub enable_mermaid: bool,
    #[serde(default = "default_true")]
    pub enable_alerts: bool,
    #[serde(default = "default_true")]
    pub enable_block_handle: bool,
    // 显示空格与空白字符（默认 false）
    #[serde(default)]
    pub show_whitespace: bool,
    // 显示换行符号（默认 false）
    #[serde(default)]
    pub show_line_endings: bool,
}

impl Default for EditorSettings {
    fn default() -> Self {
        Self {
            default_view_mode: "visual".to_string(),
            soft_wrap: true,
            show_line_numbers: true,
            show_indent_guides: true,
            tab_size: 2,
            insert_spaces: true,
            enable_math: true,
            enable_mermaid: true,
            enable_alerts: true,
            enable_block_handle: true,
            show_whitespace: false,
            show_line_endings: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileSettings {
    // 自动保存设置：Markdown / 画板 / 其他文本（默认均关闭，即手动保存）
    #[serde(default)]
    pub auto_save_markdown: bool,
    #[serde(default)]
    pub auto_save_board: bool,
    #[serde(default)]
    pub auto_save_other: bool,
    #[serde(default)]
    pub force_manual_save: bool,
    #[serde(default)]
    pub show_hidden_files: bool,
    #[serde(default = "default_true")]
    pub restore_session: bool,
    #[serde(default = "default_image_dir")]
    pub image_dir_name: String,
    #[serde(default = "default_large_file_mb")]
    pub large_file_confirm_mb: u32,
}

impl Default for FileSettings {
    fn default() -> Self {
        Self {
            auto_save_markdown: false,
            auto_save_board: false,
            auto_save_other: false,
            force_manual_save: false,
            show_hidden_files: false,
            restore_session: true,
            image_dir_name: "assets".to_string(),
            large_file_confirm_mb: 50,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LayoutSettings {
    #[serde(default = "default_true")]
    pub status_bar_visible: bool,
    #[serde(default = "default_ui_scale")]
    pub ui_scale: u32,
}

impl Default for LayoutSettings {
    fn default() -> Self {
        Self {
            status_bar_visible: true,
            ui_scale: 100,
        }
    }
}

// 默认值函数
fn default_schema_version() -> u32 { 1 }
fn default_theme_mode() -> String { "system".to_string() }
fn default_light_theme() -> String { "chen-guang".to_string() }
fn default_dark_theme() -> String { "mo-ye".to_string() }
// 默认代码西文字体：JetBrains Mono
fn default_mono_font() -> String { "JetBrains Mono".to_string() }
// 默认代码中文字体：Maple Mono Normal NF CN
fn default_mono_font_zh() -> String { "Maple Mono Normal NF CN".to_string() }
fn default_content_font_size() -> u32 { 16 }
fn default_mono_font_size() -> u32 { 14 }
fn default_line_height() -> f64 { 1.7 }
fn default_mono_line_height() -> f64 { 1.5 }
fn default_explorer_font_size() -> u32 { 13 }
fn default_explorer_line_height() -> u32 { 24 }
fn default_ui_font_size() -> u32 { 13 }
fn default_content_width() -> String { "standard".to_string() }
fn default_view_mode() -> String { "visual".to_string() }
fn default_true() -> bool { true }
fn default_tab_size() -> u32 { 2 }
fn default_image_dir() -> String { "assets".to_string() }
fn default_large_file_mb() -> u32 { 50 }
fn default_ui_scale() -> u32 { 100 }

/// 读取设置（容错：缺字段填默认，损坏文件不 panic）
pub fn load() -> Settings {
    let path = settings_path();
    if !path.exists() {
        return Settings::default();
    }

    let content = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Settings::default(),
    };

    // 尝试解析，失败则备份 + 返回默认
    match serde_json::from_str::<Settings>(&content) {
        Ok(s) => s,
        Err(_) => {
            // 损坏文件备份
            let backup = path.with_extension(format!("corrupt-{}.json",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs()));
            let _ = std::fs::rename(&path, &backup);
            Settings::default()
        }
    }
}

/// 保存设置（原子写 + revision 递增）
pub fn save(settings: &mut Settings) -> Result<u64, String> {
    // 确保 APPDATA 目录存在
    let dir = app_data_dir();
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败: {}", e))?;
    }

    // revision 递增
    settings.revision = settings.revision.max(0) + 1;

    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("序列化设置失败: {}", e))?;

    let path = settings_path();

    // 原子写
    crate::fsio::write::atomic_write(&path, json.as_bytes())
        .map_err(|e| e.to_string())?;

    Ok(settings.revision)
}
