// 本地文件搜索 IPC 命令
//
// 查询在阻塞线程池执行，不占用异步运行时；同一窗口连续输入时，新查询让旧查询尽快放弃，
// 被放弃的查询返回 None，前端直接忽略。

use super::query::{self, ContentResult, NameResult};
use super::text::Query;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// 每个窗口、每类查询最新的序号
fn latest(key: String) -> Arc<AtomicU64> {
    static MAP: OnceLock<Mutex<HashMap<String, Arc<AtomicU64>>>> = OnceLock::new();
    MAP.get_or_init(Default::default).lock().unwrap().entry(key).or_default().clone()
}

/// 登记本次查询；返回「是否已被更新的查询取代」的判断函数
fn ticket(window: &tauri::Window, kind: &str, seq: u64) -> impl Fn() -> bool + Send + Sync + 'static {
    let slot = latest(format!("{}:{}", window.label(), kind));
    slot.fetch_max(seq, Ordering::Relaxed);
    move || slot.load(Ordering::Relaxed) != seq
}

/// 文件名搜索
#[tauri::command]
pub async fn local_search_names(window: tauri::Window, query: String, seq: u64, limit: Option<u32>) -> Result<Option<NameResult>, String> {
    let cancelled = ticket(&window, "names", seq);
    let limit = limit.unwrap_or(200).clamp(1, 1000) as usize;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(handle) = super::handle() else { return Some(NameResult::default()) };
        let q = Query::parse(&query);
        if q.is_empty() || cancelled() {
            return if cancelled() { None } else { Some(NameResult::default()) };
        }
        let index = handle.shared.index.read().unwrap_or_else(|e| e.into_inner());
        query::search_names(&index, &q, limit, &cancelled)
    })
    .await
    .map_err(|e| e.to_string())
}

/// 内容搜索
#[tauri::command]
pub async fn local_search_content(window: tauri::Window, query: String, seq: u64, limit: Option<u32>) -> Result<Option<ContentResult>, String> {
    let cancelled = ticket(&window, "content", seq);
    let limit = limit.unwrap_or(100).clamp(1, 500) as usize;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(handle) = super::handle() else { return Some(ContentResult::default()) };
        let q = Query::parse(&query);
        if q.is_empty() || cancelled() {
            return if cancelled() { None } else { Some(ContentResult::default()) };
        }
        query::search_content(&handle.shared.index, &q, limit, &cancelled)
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveInfo {
    pub path: String,
    pub label: String,
}

/// 列出可添加为索引位置的磁盘
#[tauri::command]
pub fn local_search_drives() -> Vec<DriveInfo> {
    list_drives()
}

#[cfg(windows)]
fn list_drives() -> Vec<DriveInfo> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW};
    // 固定磁盘、可移动磁盘与网络驱动器（光驱等跳过）
    const REMOVABLE: u32 = 2;
    const FIXED: u32 = 3;
    const REMOTE: u32 = 4;
    let mask = unsafe { GetLogicalDrives() };
    let mut out = Vec::new();
    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let letter = char::from(b'A' + i as u8);
        let root = format!("{}:\\", letter);
        let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
        let kind = unsafe { GetDriveTypeW(PCWSTR(wide.as_ptr())) };
        if kind != FIXED && kind != REMOVABLE && kind != REMOTE {
            continue;
        }
        let mut name = [0u16; 261];
        let ok = unsafe { GetVolumeInformationW(PCWSTR(wide.as_ptr()), Some(&mut name), None, None, None, None) }.is_ok();
        let volume = if ok {
            let len = name.iter().position(|&c| c == 0).unwrap_or(0);
            String::from_utf16_lossy(&name[..len])
        } else {
            String::new()
        };
        // 可移动磁盘未插入介质时读取卷信息失败，不列出
        if !ok && kind == REMOVABLE {
            continue;
        }
        let label = if volume.trim().is_empty() {
            format!("{} ({}:)", if kind == REMOTE { "网络驱动器" } else { "本地磁盘" }, letter)
        } else {
            format!("{} ({}:)", volume.trim(), letter)
        };
        out.push(DriveInfo { path: root, label });
    }
    out
}

#[cfg(target_os = "macos")]
fn list_drives() -> Vec<DriveInfo> {
    let mut out = vec![DriveInfo { path: "/".into(), label: "系统磁盘".into() }];
    if let Ok(read) = std::fs::read_dir("/Volumes") {
        for item in read.flatten() {
            let path = item.path();
            // /Volumes 中指向根目录的系统卷链接跳过
            if std::fs::read_link(&path).is_ok_and(|t| t == std::path::Path::new("/")) {
                continue;
            }
            if path.is_dir() {
                let label = item.file_name().to_string_lossy().to_string();
                out.push(DriveInfo { path: path.to_string_lossy().to_string(), label });
            }
        }
    }
    out
}

#[cfg(all(unix, not(target_os = "macos")))]
fn list_drives() -> Vec<DriveInfo> {
    let mut out = vec![DriveInfo { path: "/".into(), label: "根目录 /".into() }];
    // 外接磁盘一般挂载在 /media、/run/media 或 /mnt 下
    if let Ok(mounts) = std::fs::read_to_string("/proc/mounts") {
        for line in mounts.lines() {
            let mut parts = line.split_whitespace();
            let (Some(dev), Some(point)) = (parts.next(), parts.next()) else { continue };
            let point = point.replace("\\040", " ");
            let external = point.starts_with("/media/") || point.starts_with("/run/media/") || point.starts_with("/mnt/");
            if dev.starts_with("/dev/") && external && !out.iter().any(|d| d.path == point) {
                let label = std::path::Path::new(&point).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| point.clone());
                out.push(DriveInfo { path: point, label });
            }
        }
    }
    out
}
