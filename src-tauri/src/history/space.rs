// NoteBoard 文档历史记录：跨设备同步空间
//
// 跨设备同步模式下，同步目录内文档的历史保存在 <同步目录>/.nb-history/<设备ID>/：
//   - 每台设备只写自己的子目录（无冲突），其他设备的子目录是从远端下载的只读缓存
//   - 文档标识直接使用同步清单的文件 ID（改名、移动后不变）；尚未同步过的新文件先用 p-<uuid> 临时标识，
//     同步分配正式 ID 后合并过去
// .nb-history 不参与主同步的整文件扫描，由同步流程中的独立「历史阶段」上传与下载。

use super::store::{valid_doc_id, Store};
use crate::sync::util::{abs_to_rel, pkey};
use std::path::{Path, PathBuf};

/// 同步目录中的历史目录名
pub const HISTORY_DIR: &str = crate::sync::util::HISTORY_DIR;
/// 尚未同步过的文件使用的临时标识前缀
pub const TEMP_PREFIX: &str = "p-";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncCtx {
    /// 同步目录（本地文件夹）
    pub root: PathBuf,
    /// 本机设备 ID
    pub me: String,
    /// 远端身份（换了远端后上传状态作废）
    pub remote: String,
    pub device_name: String,
}

impl SyncCtx {
    /// <同步目录>/.nb-history
    pub fn ns(&self) -> PathBuf {
        self.root.join(HISTORY_DIR)
    }

    /// 本机命名空间（可写）
    pub fn own(&self) -> Store {
        Store::new(self.ns().join(&self.me))
    }

    /// 临时标识映射（仅本机，不上传）
    pub fn identity_path(&self) -> PathBuf {
        self.ns().join(&self.me).join("identity.json")
    }

    /// 其他设备的只读缓存
    pub fn others(&self) -> Vec<(String, Store)> {
        let Ok(rd) = std::fs::read_dir(self.ns()) else { return Vec::new() };
        let mut out: Vec<(String, Store)> = rd
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                (valid_doc_id(&name) && name != self.me).then(|| (name, Store::new(e.path())))
            })
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    /// 某设备在本地的缓存命名空间
    pub fn device_store(&self, device: &str) -> Option<Store> {
        valid_doc_id(device).then(|| Store::new(self.ns().join(device)))
    }

    /// 同步目录内的相对路径（目录本身或目录外返回 None）
    pub fn rel(&self, abs: &Path) -> Option<String> {
        abs_to_rel(&self.root, abs).filter(|r| !r.is_empty())
    }

    pub fn abs(&self, rel: &str) -> PathBuf {
        crate::sync::util::rel_to_abs(&self.root, rel)
    }
}

/// 当前生效的同步空间：已开启多端同步且同步目录存在
pub fn current_ctx() -> Option<SyncCtx> {
    let cfg = crate::sync::scheduler::current_config();
    let root = cfg.sync.root_dir.trim();
    if !cfg.sync.enabled || root.is_empty() || cfg.device_id.is_empty() {
        return None;
    }
    let root = PathBuf::from(root);
    if !root.is_dir() {
        return None;
    }
    Some(SyncCtx {
        root,
        me: cfg.device_id.clone(),
        remote: cfg.sync.provider.identity(),
        device_name: cfg.sync.device_name.clone(),
    })
}

pub fn is_temp_id(id: &str) -> bool {
    id.starts_with(TEMP_PREFIX)
}

/// 同步基线属于此同步目录时才可用（切换目录后基线作废）
fn state_for(ctx: &SyncCtx) -> Option<crate::sync::state::LocalState> {
    let st = crate::sync::state::snapshot();
    (pkey(st.root.trim()) == pkey(&ctx.root.to_string_lossy())).then_some(st)
}

/// 相对路径对应的同步文件 ID：应用内改名线索优先，其次上次同步的基线
pub fn file_id_of(ctx: &SyncCtx, rel: &str) -> Option<String> {
    let st = state_for(ctx)?;
    let key = pkey(rel);
    if let Some((_, h)) = st.hints.iter().find(|(p, _)| pkey(p) == key) {
        return Some(h.id.clone());
    }
    st.entries.iter().find(|(_, b)| pkey(&b.rec.path) == key).map(|(id, _)| id.clone())
}

/// 文件 ID 当前所在的相对路径
pub fn rel_of_id(ctx: &SyncCtx, id: &str) -> Option<String> {
    let st = state_for(ctx)?;
    if let Some((p, _)) = st.hints.iter().filter(|(_, h)| h.id == id).max_by_key(|(_, h)| h.at) {
        return Some(p.clone());
    }
    st.entries.get(id).map(|b| b.rec.path.clone())
}
