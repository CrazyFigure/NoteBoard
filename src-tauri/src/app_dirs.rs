// NoteBoard 应用目录统一入口
// 桌面端：沿用 %APPDATA%\NoteBoard（兼容已安装版本的设置、会话、收藏与暂存数据，路径不可变更）。
// 移动端：Android 没有 APPDATA/HOME 可写目录，必须在 setup 中用 Tauri 路径 API 初始化为应用私有目录。

use std::path::PathBuf;
use std::sync::OnceLock;

// 移动端在 setup 时写入；桌面端保持未设置，走环境变量推导
static DATA_ROOT_OVERRIDE: OnceLock<PathBuf> = OnceLock::new();
static CACHE_ROOT_OVERRIDE: OnceLock<PathBuf> = OnceLock::new();

/// 设置应用数据根目录（仅首次调用生效）
#[cfg_attr(desktop, allow(dead_code))]
pub fn set_data_root(path: PathBuf) {
    let _ = DATA_ROOT_OVERRIDE.set(path);
}

/// 设置缓存根目录（仅首次调用生效）
#[cfg_attr(desktop, allow(dead_code))]
pub fn set_cache_root(path: PathBuf) {
    let _ = CACHE_ROOT_OVERRIDE.set(path);
}

/// 应用数据目录：settings.json、session.json、favorites.json、drafts、staging 等均位于此处
pub fn app_data_dir() -> PathBuf {
    if let Some(root) = DATA_ROOT_OVERRIDE.get() {
        return root.clone();
    }
    let base = std::env::var("APPDATA")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(base).join("NoteBoard")
}

/// 临时/缓存目录：桌面端使用系统临时目录，移动端使用应用缓存目录（/data/local/tmp 不可写）
pub fn cache_dir() -> PathBuf {
    if let Some(root) = CACHE_ROOT_OVERRIDE.get() {
        return root.clone();
    }
    std::env::temp_dir()
}

/// 移动端默认笔记工作区（应用私有目录，无需存储权限）
pub fn default_workspace_dir() -> PathBuf {
    app_data_dir().join("workspace")
}

/// 外部收件箱：系统分享/“用其他应用打开”传入的 content:// 文件复制到这里后再按普通路径打开
pub fn inbox_dir() -> PathBuf {
    app_data_dir().join("inbox")
}
