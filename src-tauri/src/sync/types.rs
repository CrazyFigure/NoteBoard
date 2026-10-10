// NoteBoard 同步对外数据结构（IPC 与事件载荷）

use serde::{Deserialize, Serialize};

/// 单方向的增删改计数
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub added: u32,
    pub modified: u32,
    pub deleted: u32,
}

impl Counts {
    pub fn total(&self) -> u32 {
        self.added + self.modified + self.deleted
    }
}

/// 一次同步的结果
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    /// 完成时间（毫秒）
    pub at: i64,
    pub duration_ms: i64,
    /// 触发来源：startup / save / interval / manual / restore / retry
    pub trigger: String,
    /// 整体成功（个别文件失败时为 true，但 errors 非空）
    pub ok: bool,
    /// 本机 → 云端
    pub upload: Counts,
    /// 云端 → 本机
    pub download: Counts,
    /// 双方同时修改、按行合并的文件数
    pub merged: u32,
    /// 双方同时修改、按最新结果覆盖的文件数
    pub conflicts: u32,
    /// 失败信息（整体失败时为一条；部分失败时逐文件列出）
    pub errors: Vec<String>,
    /// 简要描述
    pub message: String,
}

/// 一次备份的结果
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct BackupReport {
    pub at: i64,
    pub ok: bool,
    pub trigger: String,
    pub name: String,
    pub size: u64,
    pub file_count: u32,
    pub removed_old: u32,
    pub message: String,
}

/// 同步/备份运行状态（广播给所有窗口）
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub syncing: bool,
    pub backing_up: bool,
    pub last_sync: Option<SyncReport>,
    pub last_backup: Option<BackupReport>,
    /// 下次定时同步时间（毫秒，0 表示未安排）
    pub next_sync_at: i64,
    pub next_backup_at: i64,
}

/// 同步对本机文件的改动（前端据此刷新文件树与已打开文档）
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LocalChange {
    /// modified / added / deleted / moved
    pub kind: String,
    /// 改动后的绝对路径（deleted 为被删除的路径）
    pub path: String,
    /// moved 时的原绝对路径
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

/// 回收站顶层条目
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    /// 回收站内相对路径（.nb-trash/xxx），恢复/删除时使用
    pub id: String,
    pub name: String,
    pub is_dir: bool,
    /// 原位置（相对同步目录）
    pub orig_path: String,
    pub trashed_at: i64,
    /// 自动彻底删除时间（回收站关闭时为 0）
    pub expires_at: i64,
    pub size: u64,
    pub file_count: u32,
}

/// 备份文件信息
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub name: String,
    pub size: u64,
    pub created_at: i64,
    /// 备份来源设备名（从文件名解析）
    pub device: String,
    /// 是否本机创建（保留策略只清理本机备份）
    pub is_own: bool,
}
