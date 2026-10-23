// NoteBoard 文档历史记录：IPC 命令
//
// 读取历史正文、统计占用、清理等涉及磁盘与解压，全部放到阻塞线程池执行，不占用界面线程。

use super::config::Mode;
use super::service::{service, view, ConfigView, ListResult, ReadResult, Service, Usage};
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::Arc;

fn svc() -> Result<Arc<Service>, String> {
    service().cloned().ok_or_else(|| "历史记录服务未启动".to_string())
}

/// 在阻塞线程池中执行
async fn blocking<T: Send + 'static>(f: impl FnOnce(Arc<Service>) -> Result<T, String> + Send + 'static) -> Result<T, String> {
    let s = svc()?;
    tauri::async_runtime::spawn_blocking(move || f(s)).await.map_err(|e| format!("历史记录任务失败：{}", e))?
}

#[tauri::command]
pub async fn history_get_config() -> Result<ConfigView, String> {
    blocking(|s| Ok(view(&s.config()))).await
}

#[tauri::command]
pub async fn history_set_mode(mode: Mode) -> Result<ConfigView, String> {
    blocking(move |s| s.set_mode(mode).map(|c| view(&c))).await
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OptionsInput {
    pub retention_days: u32,
    pub merge_window_min: u32,
    pub max_total_mb: u32,
}

#[tauri::command]
pub async fn history_set_options(options: OptionsInput) -> Result<ConfigView, String> {
    blocking(move |s| s.set_options(options.retention_days, options.merge_window_min, options.max_total_mb).map(|c| view(&c))).await
}

#[tauri::command]
pub async fn history_list(path: String) -> Result<ListResult, String> {
    blocking(move |s| Ok(s.list(&PathBuf::from(path)))).await
}

#[tauri::command]
pub async fn history_read(path: String, entry_id: String) -> Result<ReadResult, String> {
    blocking(move |s| s.read(&PathBuf::from(path), &entry_id)).await
}

#[tauri::command]
pub async fn history_checkpoint(
    path: String,
    reason: String,
    content: Option<String>,
    restored_from: Option<String>,
) -> Result<(), String> {
    blocking(move |s| s.checkpoint(&PathBuf::from(path), &reason, content, restored_from)).await
}

#[tauri::command]
pub async fn history_pin(path: String, entry_id: String, pinned: bool) -> Result<(), String> {
    blocking(move |s| s.pin(&PathBuf::from(path), &entry_id, pinned)).await
}

#[tauri::command]
pub async fn history_delete_entry(path: String, entry_id: String) -> Result<(), String> {
    blocking(move |s| s.delete_entry(&PathBuf::from(path), &entry_id)).await
}

#[tauri::command]
pub async fn history_usage() -> Result<Usage, String> {
    blocking(|s| Ok(s.usage())).await
}

#[tauri::command]
pub async fn history_clear_all() -> Result<(), String> {
    blocking(|s| s.clear_all()).await
}
