// 网页同步工作进程：标准输入接收 JSON 行，标准输出仅返回响应和现有同步事件。
#![allow(dead_code)]
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

mod sync;
#[path = "../../../src-tauri/src/dto.rs"] mod dto;
#[path = "../../../src-tauri/src/app_dirs.rs"] mod app_dirs;

// 文档历史记录：复用原生实现（不含依赖 Tauri 的命令层）
mod history {
    #[path = "../../../../src-tauri/src/history/catalog.rs"] pub mod catalog;
    #[path = "../../../../src-tauri/src/history/config.rs"] pub mod config;
    #[path = "../../../../src-tauri/src/history/hooks.rs"] pub mod hooks;
    #[path = "../../../../src-tauri/src/history/identity.rs"] pub mod identity;
    #[path = "../../../../src-tauri/src/history/model.rs"] pub mod model;
    #[path = "../../../../src-tauri/src/history/retention.rs"] pub mod retention;
    #[path = "../../../../src-tauri/src/history/service.rs"] pub mod service;
    #[path = "../../../../src-tauri/src/history/space.rs"] pub mod space;
    #[path = "../../../../src-tauri/src/history/stats.rs"] pub mod stats;
    #[path = "../../../../src-tauri/src/history/store.rs"] pub mod store;
    pub fn now_ms() -> i64 { crate::sync::util::now_ms() }
}

mod fsio {
    // 原子写入继续复用桌面实现；避免同步状态和备份恢复使用不同的落盘规则。
    pub mod write { include!("../../../src-tauri/src/fsio/write.rs"); }
    // 历史正文解码与桌面端一致（UTF-8 / BOM / GBK 探测）。
    pub mod read { include!("../../../src-tauri/src/fsio/read.rs"); }
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
/// 是否允许多端同步：部署未启用访问认证时只提供历史记录，不启动同步调度、不执行同步钩子
static SYNC_ALLOWED: OnceLock<bool> = OnceLock::new();

fn sync_allowed() -> bool {
    *SYNC_ALLOWED.get().unwrap_or(&true)
}

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

/** 历史记录命令：路径均须位于工作区内；耗时操作在命令线程同步执行。 */
fn dispatch_history(command: &str, args: &Value) -> Result<Value, String> {
    let svc = history::service::service().ok_or("历史记录服务未就绪")?;
    let text = |key: &str| args[key].as_str().unwrap_or_default().to_owned();
    let path = || checked_path(&text("path"));
    match command {
        "history_get_config" => Ok(json!(history::service::view(&svc.config()))),
        "history_set_mode" => {
            let mode: history::config::Mode = serde_json::from_value(args["mode"].clone()).map_err(|error| error.to_string())?;
            Ok(json!(history::service::view(&svc.set_mode(mode)?)))
        }
        "history_set_options" => {
            let o = &args["options"];
            let n = |key: &str| o[key].as_u64().unwrap_or(0) as u32;
            Ok(json!(history::service::view(&svc.set_options(n("retentionDays"), n("mergeWindowMin"), n("maxTotalMb"))?)))
        }
        "history_list" => Ok(json!(svc.list(&path()?))),
        "history_read" => Ok(json!(svc.read(&path()?, &text("entryId"))?)),
        "history_checkpoint" => {
            let content = args["content"].as_str().map(str::to_owned);
            let restored = args["restoredFrom"].as_str().map(str::to_owned);
            svc.checkpoint(&path()?, &text("reason"), content, restored)?;
            Ok(Value::Null)
        }
        "history_pin" => { svc.pin(&path()?, &text("entryId"), args["pinned"].as_bool().unwrap_or(false))?; Ok(Value::Null) }
        "history_delete_entry" => { svc.delete_entry(&path()?, &text("entryId"))?; Ok(Value::Null) }
        "history_usage" => Ok(json!(svc.usage())),
        "history_clear_all" => { svc.clear_all()?; Ok(Value::Null) }
        _ => Err("未知历史记录命令".into()),
    }
}

/** 文件钩子：历史记录始终执行；同步钩子仅在允许多端同步时执行。 */
fn dispatch_hook(command: &str, args: &Value) -> Result<Option<Value>, String> {
    let text = |key: &str| args[key].as_str().unwrap_or_default().to_owned();
    let allowed = sync_allowed();
    Ok(Some(match command {
        "prepare_write" => {
            let p = checked_path(&text("path"))?;
            if allowed { sync::hooks::prepare_write(&p); }
            history::hooks::prepare_write(&p);
            Value::Null
        }
        "on_written" => {
            let p = checked_path(&text("path"))?;
            if allowed { sync::hooks::on_written(&p); }
            history::hooks::on_written(&p);
            Value::Null
        }
        "on_renamed" => {
            let (from, to) = (checked_path(&text("from"))?, checked_path(&text("to"))?);
            if allowed { sync::hooks::on_renamed(&from, &to); }
            history::hooks::on_renamed(&from, &to);
            Value::Null
        }
        "move_to_sync_trash" => {
            let p = checked_path(&text("path"))?;
            let moved = if allowed { sync::hooks::try_move_to_sync_trash(&p).transpose()?.is_some() } else { false };
            if moved { history::hooks::on_deleted(&p); }
            json!(moved)
        }
        "on_deleted" => { history::hooks::on_deleted(&checked_path(&text("path"))?); Value::Null }
        _ => return Ok(None),
    }))
}

/** 受控命令入口：业务行为委托原模块，不能执行任意 shell 或读取任意磁盘路径。 */
async fn dispatch(command: &str, args: &Value) -> Result<Value, String> {
    if command.starts_with("history_") {
        return dispatch_history(command, args);
    }
    if let Some(result) = dispatch_hook(command, args)? {
        return Ok(result);
    }
    if !sync_allowed() {
        return Err("当前部署未启用多端同步".into());
    }
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
    // 未启用访问认证的部署：只提供历史记录，不启动同步调度（同步凭证不在无认证环境下使用）
    SYNC_ALLOWED.set(std::env::var("NOTEBOARD_SYNC_DISABLED").map(|v| v != "1").unwrap_or(true)).ok();
    if sync_allowed() { sync::scheduler::init(Events); }
    history::service::init(Events);
    for line in std::io::stdin().lock().lines() {
        let request: Value = match serde_json::from_str(&line?) { Ok(value) => value, Err(_) => continue };
        let result = sync::runtime::block_on(dispatch(request["command"].as_str().unwrap_or_default(), &request["args"]));
        match result { Ok(value) => output(json!({ "id": request["id"], "result": value })), Err(error) => output(json!({ "id": request["id"], "error": error })) }
    }
    Ok(())
}
