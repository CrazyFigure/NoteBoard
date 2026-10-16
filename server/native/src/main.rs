// 网页同步工作进程：标准输入接收 JSON 行，标准输出仅返回响应和现有同步事件。
#![allow(dead_code)]
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

mod sync;
#[path = "../../../src-tauri/src/dto.rs"] mod dto;
#[path = "../../../src-tauri/src/app_dirs.rs"] mod app_dirs;

mod fsio {
    // 原子写入继续复用桌面实现；避免同步状态和备份恢复使用不同的落盘规则。
    pub mod write { include!("../../../src-tauri/src/fsio/write.rs"); }
    pub mod trash {
        use std::path::Path;
        /// 无桌面环境时移入服务数据目录，不能调用依赖 DBus / 桌面会话的回收站。
        pub fn move_to_trash(path: &Path) -> Result<(), String> {
            let root = crate::app_dirs::app_data_dir().join("deleted");
            std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
            std::fs::rename(path, root.join(uuid::Uuid::new_v4().to_string())).map_err(|error| error.to_string())
        }
    }
}

static WORKSPACE: OnceLock<PathBuf> = OnceLock::new();

/** 输出单行完整 JSON；stdout 锁防止调度事件与命令响应相互穿插。 */
fn output(value: Value) {
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{}", value);
}

struct Events;
impl sync::runtime::EventSink for Events {
    fn emit_json(&self, event: &str, payload: Value) { output(json!({ "event": event, "payload": payload })); }
}

/** 额外限制工作进程路径，Node 校验之外再防守一次，拒绝符号链接与越界恢复。 */
fn checked_path(value: &str) -> Result<PathBuf, String> {
    let root = WORKSPACE.get().ok_or("工作区未初始化")?;
    let target = PathBuf::from(value);
    if !target.starts_with(root) || target.components().any(|part| matches!(part, std::path::Component::ParentDir)) { return Err("路径必须位于服务器工作区".into()); }
    let mut current = root.clone();
    for segment in target.strip_prefix(root).map_err(|error| error.to_string())?.components() {
        current.push(segment);
        if std::fs::symlink_metadata(&current).is_ok_and(|stat| stat.file_type().is_symlink()) { return Err("同步目录不能包含符号链接".into()); }
    }
    Ok(target)
}

/** 配置校正与原生命令一致；设备 ID 固定于部署实例，路径必须在允许的数据目录内。 */
fn save_config(value: Value) -> Result<Value, String> {
    let mut cfg: sync::config::SyncConfigFile = serde_json::from_value(value).map_err(|error| error.to_string())?;
    cfg.device_id = sync::scheduler::current_config().device_id;
    cfg.sync.interval_minutes = cfg.sync.interval_minutes.clamp(1, 1440);
    cfg.sync.trash_days = cfg.sync.trash_days.min(3650);
    cfg.backup.interval_hours = cfg.backup.interval_hours.clamp(1, 720);
    cfg.backup.keep_count = cfg.backup.keep_count.min(1000);
    if !cfg.sync.root_dir.is_empty() { checked_path(&cfg.sync.root_dir)?; }
    let backups = app_dirs::app_data_dir().join("backups");
    if cfg.backup.local_dir.is_empty() { cfg.backup.local_dir = backups.to_string_lossy().into(); }
    if Path::new(&cfg.backup.local_dir) != backups { checked_path(&cfg.backup.local_dir)?; }
    if cfg.sync.device_name.trim().is_empty() { cfg.sync.device_name = "NoteBoard 网页服务".into(); }
    sync::config::save(&cfg)?;
    sync::scheduler::get().ok_or("同步服务未就绪")?.set_config(cfg.clone());
    serde_json::to_value(cfg).map_err(|error| error.to_string())
}

/** 受控命令入口：业务行为委托原模块，不能执行任意 shell 或读取任意磁盘路径。 */
async fn dispatch(command: &str, args: &Value) -> Result<Value, String> {
    let cfg = sync::scheduler::current_config();
    let scheduler = sync::scheduler::get().ok_or("同步服务未就绪")?;
    let root = || checked_path(&cfg.sync.root_dir);
    let text = |key: &str| args[key].as_str().unwrap_or_default().to_owned();
    match command {
        "sync_get_config" => Ok(json!(cfg)),
        "sync_save_config" => save_config(args["config"].clone()),
        "sync_get_status" => Ok(json!(scheduler.status())),
        "sync_test_connection" => {
            let provider = serde_json::from_value(args["provider"].clone()).map_err(|error| error.to_string())?;
            let mut backend = sync::backend::Backend::new(&provider).map_err(|error| error.message)?;
            Ok(json!(backend.test().await.map_err(|error| error.message)?))
        }
        "sync_now" => { root()?; if !cfg.sync.enabled { return Err("请先开启多端同步".into()); } scheduler.request_sync("manual"); Ok(Value::Null) }
        "sync_trash_list" => Ok(json!(sync::trash::list_items(&root()?, cfg.sync.trash_days, cfg.sync.trash_enabled))),
        "sync_trash_restore" => { let restored = sync::trash::restore(&root()?, &text("id"))?; scheduler.notify_change(); Ok(json!(restored)) }
        "sync_trash_delete" => { sync::trash::delete_item(&root()?, &text("id"))?; scheduler.notify_change(); Ok(Value::Null) }
        "sync_trash_empty" => { let count = sync::trash::empty(&root()?)?; scheduler.notify_change(); Ok(json!(count)) }
        "backup_now" => { root()?; scheduler.request_backup("manual"); Ok(Value::Null) }
        "backup_list" => Ok(json!(sync::backup::list_backups(&cfg).await.map_err(|error| error.message)?)),
        "backup_delete" => { sync::backup::delete_backup(&cfg, &text("name")).await.map_err(|error| error.message)?; Ok(Value::Null) }
        "backup_restore" => {
            let target = text("targetDir");
            if !target.is_empty() { Ok(json!(sync::backup::restore_to_dir(&cfg, &text("name"), &checked_path(&target)?).await.map_err(|error| error.message)?)) }
            else {
                root()?;
                let (tx, rx) = std::sync::mpsc::channel();
                scheduler.push_job(sync::scheduler::Job::RestoreToRoot { name: text("name"), reply: tx });
                Ok(json!(rx.recv().map_err(|error| error.to_string())??))
            }
        }
        "prepare_write" => { sync::hooks::prepare_write(&checked_path(&text("path"))?); Ok(Value::Null) }
        "on_written" => { sync::hooks::on_written(&checked_path(&text("path"))?); Ok(Value::Null) }
        "on_renamed" => { sync::hooks::on_renamed(&checked_path(&text("from"))?, &checked_path(&text("to"))?); Ok(Value::Null) }
        "move_to_sync_trash" => Ok(json!(sync::hooks::try_move_to_sync_trash(&checked_path(&text("path"))?).transpose()?.is_some())),
        _ => Err("未知同步命令".into()),
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let data = PathBuf::from(std::env::var("NOTEBOARD_DATA_DIR")?);
    // Windows 测试宿主去除扩展路径前缀，确保与 Node 的 realpath 表示一致。
    let workspace = dunce::canonicalize(data.join("workspace"))?;
    WORKSPACE.set(workspace).ok();
    app_dirs::set_data_root(data.join("native"));
    let cache = data.join("native/cache");
    std::fs::create_dir_all(&cache)?;
    app_dirs::set_cache_root(cache);
    sync::scheduler::init(Events);
    for line in std::io::stdin().lock().lines() {
        let request: Value = match serde_json::from_str(&line?) { Ok(value) => value, Err(_) => continue };
        let result = sync::runtime::block_on(dispatch(request["command"].as_str().unwrap_or_default(), &request["args"]));
        match result { Ok(value) => output(json!({ "id": request["id"], "result": value })), Err(error) => output(json!({ "id": request["id"], "error": error })) }
    }
    Ok(())
}
