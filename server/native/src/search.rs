// 网页全局搜索工作进程：复用桌面端索引引擎，一份索引覆盖数据目录中各用户的工作区。
// 每次查询都附带调用者可访问的位置（由 Node 按权限计算），引擎只返回这些位置中的结果。
// 查询各自在独立线程执行；同一浏览器连续输入时，新查询让旧查询尽快放弃。

use crate::local_search::engine::{self, Msg};
use crate::local_search::query;
use crate::local_search::text::Query;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// 每个浏览器、每类查询最新的序号
fn latest(key: String) -> Arc<AtomicU64> {
    static MAP: OnceLock<Mutex<HashMap<String, Arc<AtomicU64>>>> = OnceLock::new();
    MAP.get_or_init(Default::default).lock().unwrap().entry(key).or_default().clone()
}

/// 规范化后必须位于数据目录内，Node 校验之外再防守一次
fn inside(data: &Path, raw: &str) -> Option<PathBuf> {
    let path = PathBuf::from(raw);
    if !path.is_absolute() || path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return None;
    }
    let path = dunce::canonicalize(&path).unwrap_or(path);
    path.starts_with(data).then_some(path)
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().map(|items| items.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default()
}

/// 执行一次查询；被更新的查询取代时返回 null
fn search(handle: &engine::Handle, data: &Path, command: &str, args: &Value) -> Result<Value, String> {
    let kind = if command == "search_names" { "names" } else { "content" };
    let seq = args["seq"].as_u64().unwrap_or(0);
    let slot = latest(format!("{}:{}", args["client"].as_str().unwrap_or_default(), kind));
    slot.fetch_max(seq, Ordering::Relaxed);
    let cancelled = move || slot.load(Ordering::Relaxed) != seq;
    let q = Query::parse(args["query"].as_str().unwrap_or_default());
    // 范围为空表示无权访问任何位置，直接返回空结果（绝不退化为不限范围）
    let scope: Vec<PathBuf> = strings(&args["scopes"]).iter().filter_map(|p| inside(data, p)).collect();
    if kind == "names" {
        let limit = args["limit"].as_u64().unwrap_or(200).clamp(1, 1000) as usize;
        if q.is_empty() || scope.is_empty() {
            return Ok(json!(query::NameResult::default()));
        }
        let index = handle.shared.index.read().unwrap_or_else(|e| e.into_inner());
        Ok(json!(query::search_names_in(&index, &q, limit, Some(&scope), &cancelled)))
    } else {
        let limit = args["limit"].as_u64().unwrap_or(100).clamp(1, 500) as usize;
        if q.is_empty() || scope.is_empty() {
            return Ok(json!(query::ContentResult::default()));
        }
        Ok(json!(query::search_content_in(&handle.shared.index, &q, limit, Some(&scope), &cancelled)))
    }
}

/// 搜索模式主循环：配置命令在读取线程处理，查询派发到独立线程
pub fn run(data: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let data = dunce::canonicalize(data)?;
    let snapshot = crate::app_dirs::app_data_dir().join("local-search").join("index.bin");
    let handle = engine::Engine::spawn(
        Some(snapshot),
        // 索引内容变化（引擎已限频）时通知网页静默刷新当前结果
        Box::new(|| crate::output(json!({ "event": "nb://local-search-updated", "payload": Value::Null }))),
        true,
    );
    for line in std::io::stdin().lock().lines() {
        let request: Value = match serde_json::from_str(&line?) { Ok(value) => value, Err(_) => continue };
        let id = request["id"].clone();
        let command = request["command"].as_str().unwrap_or_default().to_owned();
        let args = request["args"].clone();
        match command.as_str() {
            "search_configure" => {
                let enabled = args["enabled"].as_bool().unwrap_or(false);
                let roots: Vec<String> = strings(&args["roots"]).iter().filter_map(|p| inside(&data, p)).map(|p| p.to_string_lossy().into_owned()).collect();
                handle.send(Msg::Configure { enabled, roots, delay: Duration::ZERO });
                crate::output(json!({ "id": id, "result": Value::Null }));
            }
            "search_names" | "search_content" => {
                let (handle, data) = (handle.clone(), data.clone());
                std::thread::spawn(move || {
                    let reply = match search(&handle, &data, &command, &args) {
                        Ok(value) => json!({ "id": id, "result": value }),
                        Err(error) => json!({ "id": id, "error": error }),
                    };
                    crate::output(reply);
                });
            }
            _ => crate::output(json!({ "id": id, "error": "未知搜索命令" })),
        }
    }
    handle.send(Msg::Shutdown);
    Ok(())
}
