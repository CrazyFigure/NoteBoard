// NoteBoard 同步本地状态（<应用数据目录>/sync/state.json）
//
// 记录「上次同步成功时」每个文件的基线（ID → 路径/哈希/时间），用于判断本地与远端各自改了什么；
// 另外记录应用内操作留下的线索：
//   hints   —— 应用内重命名/移动/恢复：新路径 → 文件 ID（改名后仍是同一文件，不会变成删除+新建）
//   deletes —— 应用内删除（未启用回收站时）：路径 → 删除时间（用于「删除 vs 修改」谁更新的判断）
//   trash   —— 回收站顶层条目：原位置与删除时间
// 状态常驻内存（全局互斥），文件命令钩子与同步线程共享，修改后立即落盘。

use super::config::sync_data_dir;
use super::manifest::FileRec;
use super::types::{BackupReport, SyncReport};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

/// 本地基线记录（额外保存文件系统大小/修改时间，用于快速判断文件是否变动、免重复计算哈希）
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BaseRec {
    #[serde(flatten)]
    pub rec: FileRec,
    pub fsize: u64,
    pub fmtime: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrashItemMeta {
    /// 原位置（相对同步目录）
    pub orig: String,
    pub at: i64,
    pub is_dir: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MoveHint {
    pub id: String,
    pub at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LocalState {
    /// 绑定的同步目录（变化后基线作废）
    pub root: String,
    /// 绑定的远端身份（变化后基线作废）
    pub remote: String,
    pub entries: BTreeMap<String, BaseRec>,
    pub trash: BTreeMap<String, TrashItemMeta>,
    pub hints: BTreeMap<String, MoveHint>,
    pub deletes: BTreeMap<String, i64>,
    /// 上次扫描时间（外部删除/改名无法得知确切时间时，以此作为最早可能时间）
    pub last_scan_at: i64,
    /// 恢复备份后置位：下一次同步以本机为准
    pub force_local: bool,
    pub last_sync: Option<SyncReport>,
    pub last_backup: Option<BackupReport>,
    /// 上次自动备份时间
    pub last_auto_backup_at: i64,
}

static STATE: Mutex<Option<LocalState>> = Mutex::new(None);

fn state_path() -> PathBuf {
    sync_data_dir().join("state.json")
}

/// 三方合并基线内容根目录
fn base_root() -> PathBuf {
    sync_data_dir().join("base")
}

/// 某个同步目录的三方合并基线内容目录（按目录区分，切换目录后互不干扰）
fn base_dir(root: &str) -> PathBuf {
    let digest = super::util::sha256_hex(super::util::pkey(root.trim()).as_bytes());
    base_root().join(&digest[..12])
}

fn load_from_disk() -> LocalState {
    std::fs::read_to_string(state_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn persist(state: &LocalState) {
    let dir = sync_data_dir();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(json) = serde_json::to_vec(state) {
        if let Err(e) = crate::fsio::write::atomic_write(&state_path(), &json) {
            log::warn!("[sync] 保存同步状态失败: {}", e);
        }
    }
}

/// 在全局锁内读写状态，返回闭包结果；闭包返回后立即落盘
pub fn with_state<R>(f: impl FnOnce(&mut LocalState) -> R) -> R {
    let mut guard = STATE.lock().unwrap_or_else(|p| p.into_inner());
    if guard.is_none() {
        *guard = Some(load_from_disk());
    }
    let state = guard.as_mut().expect("state loaded");
    let result = f(state);
    persist(state);
    result
}

/// 只读快照
pub fn snapshot() -> LocalState {
    let mut guard = STATE.lock().unwrap_or_else(|p| p.into_inner());
    if guard.is_none() {
        *guard = Some(load_from_disk());
    }
    guard.as_ref().expect("state loaded").clone()
}

/// 绑定同步目录与远端；任一变化时清空基线（下次同步按路径与内容重新配对）
pub fn bind(root: &str, remote: &str) {
    with_state(|s| {
        let root_changed = super::util::pkey(&s.root) != super::util::pkey(root);
        if root_changed || s.remote != remote {
            s.entries.clear();
            s.hints.clear();
            s.deletes.clear();
            s.force_local = false;
            if root_changed {
                s.trash.clear();
                s.last_scan_at = 0;
            }
            // 旧绑定的合并基线已无意义
            let _ = std::fs::remove_dir_all(base_dir(&s.root));
            let _ = std::fs::remove_dir_all(base_dir(root));
            s.root = root.to_string();
            s.remote = remote.to_string();
        }
    });
}

/// 读取三方合并基线内容
pub fn read_base_content(root: &str, id: &str) -> Option<Vec<u8>> {
    std::fs::read(base_dir(root).join(id)).ok()
}

/// 写入/删除三方合并基线内容（仅可行级合并的小文本保存基线）
pub fn write_base_content(root: &str, id: &str, data: Option<&[u8]>) {
    let dir = base_dir(root);
    let path = dir.join(id);
    match data {
        Some(bytes) => {
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(path, bytes);
        }
        None => {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// 仅测试：整体替换内存中的状态（模拟多台设备轮流同步），返回旧状态
#[cfg(test)]
pub fn swap_for_test(next: LocalState) -> LocalState {
    let mut guard = STATE.lock().unwrap_or_else(|p| p.into_inner());
    let prev = guard.take().unwrap_or_default();
    *guard = Some(next);
    prev
}
