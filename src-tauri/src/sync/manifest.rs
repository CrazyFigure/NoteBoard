// NoteBoard 同步清单（远端 .noteboard-sync/manifest.json）
//
// 清单以「文件唯一 ID」为键记录每个文件当前的路径、内容哈希、内容修改时间与位置修改时间：
//   - 改名/移动只改变 path，ID 不变（其他设备据此执行重命名而不是删除+新建）
//   - 删除记录为墓碑（deleted = 删除时间），保留一段时间让离线设备也能得知删除
//   - 回收站中的文件带 trash 信息（原路径、删除时间），回收站本身也参与同步

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// 清单格式版本
pub const MANIFEST_FORMAT: u32 = 1;
/// 墓碑保留时长：180 天（超过后从清单移除）
pub const TOMBSTONE_TTL_MS: i64 = 180 * 24 * 3600 * 1000;

/// 回收站信息（逐文件记录）
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrashInfo {
    /// 文件删除前的相对路径
    pub orig: String,
    /// 移入回收站的时间（毫秒）
    pub at: i64,
}

/// 文件记录（清单条目与本地基线共用）
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileRec {
    pub path: String,
    pub hash: String,
    pub size: u64,
    /// 内容最后修改时间（编辑发生的设备时钟）
    pub mtime: i64,
    /// 位置（路径/回收站状态）最后变化时间
    pub ltime: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trash: Option<TrashInfo>,
}

impl FileRec {
    /// 位置是否相同（路径与回收站状态）
    pub fn same_location(&self, other: &FileRec) -> bool {
        super::util::pkey(&self.path) == super::util::pkey(&other.path) && self.trash == other.trash
    }
}

/// 清单条目：存活文件或墓碑
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    #[serde(flatten)]
    pub rec: FileRec,
    /// 墓碑：删除时间
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted: Option<i64>,
    /// 最后修改该条目的设备
    #[serde(default)]
    pub device: String,
}

impl Entry {
    pub fn is_live(&self) -> bool {
        self.deleted.is_none()
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub name: String,
    pub last_sync: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    #[serde(default)]
    pub format: u32,
    /// 每次写入递增（WebDAV/S3/Gitee 乐观锁依据）
    #[serde(default)]
    pub rev: u64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub updated_by: String,
    #[serde(default)]
    pub devices: BTreeMap<String, DeviceInfo>,
    #[serde(default)]
    pub entries: BTreeMap<String, Entry>,
}

impl Manifest {
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        let m: Manifest = serde_json::from_slice(bytes).map_err(|e| format!("远端同步清单已损坏：{}", e))?;
        if m.format > MANIFEST_FORMAT {
            return Err("远端同步数据由更新版本的 NoteBoard 创建，请先升级本机 NoteBoard".to_string());
        }
        Ok(m)
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec_pretty(self).unwrap_or_default()
    }

    /// 清除过期墓碑
    pub fn prune_tombstones(&mut self, now: i64) {
        self.entries
            .retain(|_, e| match e.deleted {
                Some(t) => now - t < TOMBSTONE_TTL_MS,
                None => true,
            });
    }
}

pub fn manifest_path() -> String {
    format!("{}/manifest.json", super::util::META_DIR)
}

pub fn lock_path() -> String {
    format!("{}/lock.json", super::util::META_DIR)
}
