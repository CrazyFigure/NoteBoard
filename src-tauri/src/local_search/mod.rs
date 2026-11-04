// NoteBoard 本地文件搜索
//
// 在设置中开启后，对选定的文件夹或整盘建立文件名与内容索引，Ctrl + Shift + F 打开搜索面板。
// 模块分层：
//   text     —— 大小写折叠、片段切分、查询解析与命中高亮（纯函数）
//   names    —— 文件表（父指针树 + 名字池）
//   content  —— 内容倒排索引（只读段 + 活动段 + 失效标记）
//   extract  —— 正文提取（多编码文本、Office 文档）
//   scan     —— 并行目录遍历与排除规则
//   persist  —— 索引快照
//   engine   —— 后台索引线程（构建、对账、监听、合并、保存）
//   query    —— 文件名与内容查询
//   commands —— IPC 命令（仅桌面端）

pub mod content;
pub mod engine;
pub mod extract;
pub mod names;
pub mod persist;
pub mod query;
pub mod scan;
pub mod text;
#[cfg(desktop)]
pub mod commands;

#[cfg(test)]
mod tests;

use std::path::PathBuf;
use std::sync::OnceLock;

/// 索引数据：文件表与内容索引（由引擎线程写入，查询持读锁读取）
#[derive(Debug, Default)]
pub struct Index {
    pub table: names::FileTable,
    pub content: content::ContentIndex,
}

static ENGINE: OnceLock<engine::Handle> = OnceLock::new();

/// 索引快照位置
pub fn snapshot_path() -> PathBuf {
    crate::app_dirs::app_data_dir().join("local-search").join("index.bin")
}

/// 当前引擎（未开启过本地搜索时为 None）
pub fn handle() -> Option<&'static engine::Handle> {
    ENGINE.get()
}

/// 启动时应用设置：开启时延迟数秒再开始，避免与窗口启动争抢资源
#[cfg(desktop)]
pub fn init(app: &tauri::AppHandle, settings: &crate::settings::model::LocalSearchSettings) {
    if settings.enabled {
        configure(app, settings, std::time::Duration::from_secs(3));
    } else {
        // 已关闭：清理可能残留的快照
        let _ = std::fs::remove_file(snapshot_path());
    }
}

/// 设置变化时调用
#[cfg(desktop)]
pub fn apply_settings(app: &tauri::AppHandle, settings: &crate::settings::model::LocalSearchSettings) {
    if settings.enabled || ENGINE.get().is_some() {
        configure(app, settings, std::time::Duration::ZERO);
    }
}

#[cfg(desktop)]
fn configure(app: &tauri::AppHandle, settings: &crate::settings::model::LocalSearchSettings, delay: std::time::Duration) {
    use tauri::Emitter;
    let handle = ENGINE.get_or_init(|| {
        let app = app.clone();
        engine::Engine::spawn(
            Some(snapshot_path()),
            Box::new(move || {
                let _ = app.emit("nb://local-search-updated", ());
            }),
            true,
        )
    });
    handle.send(engine::Msg::Configure { enabled: settings.enabled, roots: settings.roots.clone(), delay });
}
