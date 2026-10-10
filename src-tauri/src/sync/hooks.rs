// NoteBoard 同步钩子：文件命令（写入/新建/改名/删除）执行后通知同步模块
//
// - 写入：保存触发同步（防抖）
// - 改名/移动：登记「新路径 → 原文件 ID」线索，改名后仍是同一个文件
// - 删除：启用回收站时移入同步回收站；未启用时记录确切删除时间

use super::scheduler;
use super::trash;
use super::util::{abs_to_rel, is_in_trash, now_ms};
use std::path::{Path, PathBuf};

/// 已启用同步时返回（同步目录, 是否启用回收站）
fn active_root() -> Option<(PathBuf, bool)> {
    let cfg = scheduler::current_config();
    if !cfg.sync.enabled || cfg.sync.root_dir.trim().is_empty() {
        return None;
    }
    Some((PathBuf::from(cfg.sync.root_dir.trim()), cfg.sync.trash_enabled))
}

fn notify() {
    if let Some(s) = scheduler::get() {
        s.notify_change();
    }
}

/// 是否为同步目录根下的回收站目录（不论同步开关，已设置同步目录即可，便于关闭同步后仍能恢复）
pub fn is_sync_trash_dir(path: &Path) -> bool {
    if path.file_name().map(|n| n != super::util::TRASH_DIR).unwrap_or(true) {
        return false;
    }
    let cfg = scheduler::current_config();
    let root = cfg.sync.root_dir.trim();
    if root.is_empty() {
        return false;
    }
    abs_to_rel(Path::new(root), path).as_deref() == Some(super::util::TRASH_DIR)
}

/// 写入前准备：同步目录内的文件所在目录已被其他设备删除时重新创建（保存时作为新文件重建）
pub fn prepare_write(path: &Path) {
    let Some((root, _)) = active_root() else { return };
    let Some(parent) = path.parent() else { return };
    if parent.exists() {
        return;
    }
    if let Some(rel) = abs_to_rel(&root, path) {
        if !rel.is_empty() && !is_in_trash(&rel) {
            let _ = std::fs::create_dir_all(parent);
        }
    }
}

/// 文件被写入/新建
pub fn on_written(path: &Path) {
    let Some((root, _)) = active_root() else { return };
    if let Some(rel) = abs_to_rel(&root, path) {
        if !rel.is_empty() && !is_in_trash(&rel) {
            notify();
        }
    }
}

/// 文件/目录被改名或移动
pub fn on_renamed(from: &Path, to: &Path) {
    let Some((root, _)) = active_root() else { return };
    let now = now_ms();
    match (abs_to_rel(&root, from), abs_to_rel(&root, to)) {
        (Some(a), Some(b)) if !a.is_empty() && !b.is_empty() => {
            trash::hint_moves(&a, &b, now);
            notify();
        }
        (Some(a), None) if !a.is_empty() => {
            // 移出同步目录：对其他设备而言等同删除
            trash::record_deletes(&a, now);
            notify();
        }
        (None, Some(_)) => notify(),
        _ => {}
    }
}

/// 删除前调用：位于同步目录且启用回收站时移入同步回收站并返回 Some(结果)；
/// 其余情况返回 None，由调用方走系统回收站
pub fn try_move_to_sync_trash(path: &Path) -> Option<Result<(), String>> {
    let (root, trash_enabled) = active_root()?;
    let rel = abs_to_rel(&root, path)?;
    if rel.is_empty() {
        return None;
    }
    if is_in_trash(&rel) {
        return None;
    }
    if trash_enabled {
        let result = trash::move_into_trash(&root, path).map(|_| ());
        notify();
        return Some(result);
    }
    trash::record_deletes(&rel, now_ms());
    notify();
    None
}
