// NoteBoard 暂存 IPC 命令
// 文件名规则：本地时间 + 三位序号 + 原文件名；同一编辑会话后续覆盖既有暂存副本。

use crate::dto::{Encoding, Eol};
use chrono::Local;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

// 多窗口可能同时触发暂存，进程级互斥保证序号分配与首次写入不会发生竞态覆盖。
static STAGING_WRITE_LOCK: Mutex<()> = Mutex::new(());

/// 前端提交的待暂存文档；target_path 存在时覆盖同一份副本，避免定时暂存产生大量文件。
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StagingDocument {
    pub key: String,
    pub display_name: String,
    pub content: String,
    pub encoding: Encoding,
    pub eol: Eol,
    pub target_path: Option<String>,
}

/// 返回每份文档的稳定暂存路径，供前端在后续增量写入与正常保存清理时复用。
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StagingResult {
    pub key: String,
    pub target_path: String,
}

/// 获取设置中的暂存目录；空字符串兼容早期或手工损坏的设置文件。
fn configured_staging_directory() -> PathBuf {
    let settings = crate::settings::model::load();
    let configured = settings.file.staging_directory.trim();
    if configured.is_empty() {
        PathBuf::from(crate::settings::model::default_staging_directory())
    } else {
        PathBuf::from(configured)
    }
}

/// 清理 Windows 不允许出现在文件名中的字符，并保留原扩展名以便直接重新打开。
fn sanitize_file_name(display_name: &str) -> String {
    let original = Path::new(display_name)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("未命名.txt");
    let mut sanitized: String = original
        .chars()
        .map(|ch| {
            if ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
            {
                '_'
            } else {
                ch
            }
        })
        .collect();
    // Windows 文件名不能以空格或句点结尾。
    while sanitized.ends_with([' ', '.']) {
        sanitized.pop();
    }
    if sanitized.is_empty() {
        "未命名.txt".to_string()
    } else {
        sanitized
    }
}

/// 判断前端回传的路径是否仍位于当前暂存目录；设置位置变化后会自动创建新副本。
fn reusable_target(staging_dir: &Path, target_path: Option<&str>) -> Option<PathBuf> {
    let target = PathBuf::from(target_path?);
    if target.parent() == Some(staging_dir) {
        Some(target)
    } else {
        None
    }
}

/// 按“时间-序号-文件名”分配不冲突的新路径。
fn allocate_target(staging_dir: &Path, display_name: &str) -> PathBuf {
    let timestamp = Local::now().format("%Y%m%d-%H%M%S").to_string();
    let file_name = sanitize_file_name(display_name);
    // 序号在整个暂存目录的同一秒内递增，而非按文件名分别计数，便于用户按批次顺序查看。
    let largest_sequence = std::fs::read_dir(staging_dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter_map(|name| {
            let mut parts = name.splitn(4, '-');
            let date = parts.next()?;
            let time = parts.next()?;
            let sequence = parts.next()?;
            if format!("{}-{}", date, time) == timestamp {
                sequence.parse::<u32>().ok()
            } else {
                None
            }
        })
        .max()
        .unwrap_or(0);
    // 三位序号超过 999 后自然扩展，仍保证不覆盖旧副本。
    for sequence in largest_sequence.saturating_add(1).. {
        let candidate = staging_dir.join(format!("{}-{:03}-{}", timestamp, sequence, file_name));
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!("无限序号循环总能分配暂存文件名")
}

/// 校验待清理文件确实符合 NoteBoard 暂存命名规则，避免误删普通文件。
fn is_staging_file_name(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let mut parts = name.splitn(4, '-');
    let date = parts.next().unwrap_or_default();
    let time = parts.next().unwrap_or_default();
    let sequence = parts.next().unwrap_or_default();
    let original_name = parts.next().unwrap_or_default();
    date.len() == 8
        && date.bytes().all(|byte| byte.is_ascii_digit())
        && time.len() == 6
        && time.bytes().all(|byte| byte.is_ascii_digit())
        && sequence.len() >= 3
        && sequence.bytes().all(|byte| byte.is_ascii_digit())
        && !original_name.is_empty()
}

/// 返回默认暂存目录，供设置页“一键恢复默认”使用。
#[tauri::command]
pub fn get_default_staging_directory() -> String {
    crate::settings::model::default_staging_directory()
}

/// 确保暂存目录存在并返回实际路径，主页“打开暂存区”会将其载入文件树。
#[tauri::command]
pub fn ensure_staging_directory() -> Result<String, String> {
    let directory = configured_staging_directory();
    std::fs::create_dir_all(&directory).map_err(|error| format!("创建暂存目录失败：{}", error))?;
    Ok(directory.to_string_lossy().to_string())
}

/// 在系统文件管理器中打开暂存目录，供设置页快速核对位置与内容。
#[tauri::command]
pub fn open_staging_directory() -> Result<String, String> {
    let directory = PathBuf::from(ensure_staging_directory()?);
    #[cfg(windows)]
    std::process::Command::new("explorer")
        .arg(&directory)
        .spawn()
        .map_err(|error| format!("无法打开暂存目录：{}", error))?;
    #[cfg(not(windows))]
    std::process::Command::new("xdg-open")
        .arg(&directory)
        .spawn()
        .map_err(|error| format!("无法打开暂存目录：{}", error))?;
    Ok(directory.to_string_lossy().to_string())
}

/// 批量写入未保存文档；任一写入失败即返回错误，调用方据此阻止“暂存并关闭”。
#[tauri::command]
pub fn stash_documents(documents: Vec<StagingDocument>) -> Result<Vec<StagingResult>, String> {
    let _write_guard = STAGING_WRITE_LOCK
        .lock()
        .map_err(|_| "暂存写入锁已损坏，请重启 NoteBoard".to_string())?;
    let staging_dir = configured_staging_directory();
    std::fs::create_dir_all(&staging_dir)
        .map_err(|error| format!("创建暂存目录失败：{}", error))?;

    let mut results = Vec::with_capacity(documents.len());
    for document in documents {
        let target = reusable_target(&staging_dir, document.target_path.as_deref())
            .unwrap_or_else(|| allocate_target(&staging_dir, &document.display_name));
        crate::fsio::write::write_with_encoding(
            &target,
            &document.content,
            document.encoding,
            document.eol,
        )
        .map_err(|error| format!("暂存“{}”失败：{:?}", document.display_name, error))?;
        results.push(StagingResult {
            key: document.key,
            target_path: target.to_string_lossy().to_string(),
        });
    }
    Ok(results)
}

/// 正常保存或明确“不保存”后清理本次会话产生的临时副本；进程被强杀时不会执行，因此副本会保留。
#[tauri::command]
pub fn delete_staged_file(path: String) -> Result<(), String> {
    let target = PathBuf::from(path);
    if !is_staging_file_name(&target) {
        return Err("拒绝删除不符合暂存命名规则的文件".to_string());
    }
    if target.exists() {
        std::fs::remove_file(&target).map_err(|error| format!("清理暂存文件失败：{}", error))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 文件名清理必须保留扩展名，并替换 Windows 非法字符与尾部句点。
    #[test]
    fn sanitizes_windows_file_name_without_losing_extension() {
        assert_eq!(sanitize_file_name("计划:第一版?.md"), "计划_第一版_.md");
        assert_eq!(sanitize_file_name("报告. "), "报告");
    }

    /// 仅允许清理符合“时间-序号-文件名”结构的 NoteBoard 暂存文件。
    #[test]
    fn recognizes_only_staging_file_name_pattern() {
        assert!(is_staging_file_name(Path::new(
            "20260821-153045-001-未命名.md"
        )));
        assert!(!is_staging_file_name(Path::new("普通文件.md")));
        assert!(!is_staging_file_name(Path::new(
            "20260821-153045-01-序号过短.md"
        )));
    }
}
