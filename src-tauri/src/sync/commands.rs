// NoteBoard 同步与备份 IPC 命令

use super::backend::Backend;
use super::backup;
use super::config::{self, ProviderConfig, SyncConfigFile};
use super::scheduler::{self, Job};
use super::trash;
use super::types::{BackupInfo, SyncStatus, TrashItem};
use std::path::PathBuf;

fn sched() -> Result<std::sync::Arc<scheduler::Scheduler>, String> {
    scheduler::get().ok_or_else(|| "同步服务尚未启动".to_string())
}

/// 已设置的同步目录（回收站与备份恢复需要）
fn root_of(cfg: &SyncConfigFile) -> Result<PathBuf, String> {
    let root = cfg.sync.root_dir.trim();
    if root.is_empty() {
        return Err("尚未设置同步文件夹".to_string());
    }
    let p = PathBuf::from(root);
    if !p.is_dir() {
        return Err(format!("同步文件夹不存在：{}", root));
    }
    Ok(p)
}

#[tauri::command]
pub fn sync_get_config() -> SyncConfigFile {
    scheduler::current_config()
}

/// 保存配置：数值做合理范围校正，设备 ID 以本机为准
#[tauri::command]
pub fn sync_save_config(config: SyncConfigFile) -> Result<SyncConfigFile, String> {
    let current = scheduler::current_config();
    let mut cfg = config;
    cfg.device_id = current.device_id;
    cfg.sync.interval_minutes = cfg.sync.interval_minutes.clamp(1, 24 * 60);
    cfg.sync.trash_days = cfg.sync.trash_days.min(3650);
    cfg.backup.interval_hours = cfg.backup.interval_hours.clamp(1, 24 * 30);
    cfg.backup.keep_count = cfg.backup.keep_count.min(1000);
    cfg.sync.root_dir = cfg.sync.root_dir.trim().to_string();
    if cfg.sync.device_name.trim().is_empty() {
        cfg.sync.device_name = config::default_device_name();
    }
    config::save(&cfg)?;
    if let Ok(s) = sched() {
        s.set_config(cfg.clone());
    }
    Ok(cfg)
}

/// 测试远端连接（不保存配置）
#[tauri::command]
pub async fn sync_test_connection(provider: ProviderConfig) -> Result<String, String> {
    let mut backend = Backend::new(&provider).map_err(|e| e.message)?;
    backend.test().await.map_err(|e| e.message)
}

/// 立即同步（结果通过事件返回）
#[tauri::command]
pub fn sync_now() -> Result<(), String> {
    let cfg = scheduler::current_config();
    if !cfg.sync.enabled {
        return Err("请先开启多端同步".to_string());
    }
    root_of(&cfg)?;
    sched()?.request_sync("manual");
    Ok(())
}

#[tauri::command]
pub fn sync_get_status() -> Result<SyncStatus, String> {
    Ok(sched()?.status())
}

#[tauri::command]
pub fn sync_trash_list() -> Result<Vec<TrashItem>, String> {
    let cfg = scheduler::current_config();
    let root = root_of(&cfg)?;
    Ok(trash::list_items(&root, cfg.sync.trash_days, cfg.sync.trash_enabled))
}

/// 恢复回收站条目，返回恢复后的绝对路径
#[tauri::command]
pub fn sync_trash_restore(id: String) -> Result<String, String> {
    let cfg = scheduler::current_config();
    let root = root_of(&cfg)?;
    let restored = trash::restore(&root, &id)?;
    if let Some(s) = scheduler::get() {
        s.notify_change();
    }
    Ok(restored)
}

#[tauri::command]
pub fn sync_trash_delete(id: String) -> Result<(), String> {
    let cfg = scheduler::current_config();
    let root = root_of(&cfg)?;
    trash::delete_item(&root, &id)?;
    if let Some(s) = scheduler::get() {
        s.notify_change();
    }
    Ok(())
}

#[tauri::command]
pub fn sync_trash_empty() -> Result<u32, String> {
    let cfg = scheduler::current_config();
    let root = root_of(&cfg)?;
    let n = trash::empty(&root)?;
    if let Some(s) = scheduler::get() {
        s.notify_change();
    }
    Ok(n)
}

/// 立即备份（结果通过事件返回）
#[tauri::command]
pub fn backup_now() -> Result<(), String> {
    let cfg = scheduler::current_config();
    root_of(&cfg)?;
    sched()?.request_backup("manual");
    Ok(())
}

#[tauri::command]
pub async fn backup_list() -> Result<Vec<BackupInfo>, String> {
    let cfg = scheduler::current_config();
    backup::list_backups(&cfg).await.map_err(|e| e.message)
}

#[tauri::command]
pub async fn backup_delete(name: String) -> Result<(), String> {
    let cfg = scheduler::current_config();
    backup::delete_backup(&cfg, &name).await.map_err(|e| e.message)
}

/// 恢复备份：target_dir 为空表示恢复到同步目录（在同步线程中串行执行，避免与同步交叉）
#[tauri::command]
pub async fn backup_restore(name: String, target_dir: Option<String>) -> Result<String, String> {
    let cfg = scheduler::current_config();
    match target_dir.filter(|d| !d.trim().is_empty()) {
        Some(dir) => {
            let p = PathBuf::from(dir.trim());
            if !p.is_dir() {
                return Err("目标文件夹不存在".to_string());
            }
            let out = backup::restore_to_dir(&cfg, &name, &p).await.map_err(|e| e.message)?;
            Ok(format!("已解压到：{}", out))
        }
        None => {
            root_of(&cfg)?;
            let (tx, rx) = std::sync::mpsc::channel();
            sched()?.push_job(Job::RestoreToRoot { name, reply: tx });
            tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|_| "恢复任务被中断".to_string())?)
                .await
                .map_err(|e| e.to_string())?
        }
    }
}
