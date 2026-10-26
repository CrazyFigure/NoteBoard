// WebDAV 首次配对：发现远端已有文件，以实际内容建立清单，并在同名更新前取得一次性确认。
use super::backend::{max_file_size, Backend};
use super::config::ProviderKind;
use super::error::{SyncError, SyncErrorKind, SyncResult};
use super::manifest::{Entry, FileRec, Manifest};
use super::plan::ScannedFile;
use super::types::SyncFileUpdate;
use super::util::{is_ignored_name, parent_rel, pkey, portable_relative_path, sha256_hex};
use std::collections::{BTreeSet, HashMap, HashSet};

/// 只扫描首次配对或本机新文件可能占用的目录；有清单的常规同步继续复用已有协议。
/// 目录、深度和单文件均有上限；发现异常立即中止，不能靠遗漏远端文件来继续更新。
pub async fn prepare(
    backend: &mut Backend,
    manifest: &mut Manifest,
    first_sync: bool,
    local: &[ScannedFile],
    local_hash: impl Fn(&str) -> SyncResult<String>,
    approved: &[String],
    force_local: bool,
) -> SyncResult<bool> {
    let Backend::WebDav(dav) = backend else { return Ok(false) };
    const MAX_ENTRIES: usize = 20_000;
    const MAX_DEPTH: usize = 128;
    let tracked: HashSet<String> = manifest.entries.values().filter(|entry| entry.is_live()).map(|entry| pkey(&entry.rec.path)).collect();
    let local_by_path: HashMap<String, &ScannedFile> = local.iter().map(|file| (pkey(&file.rel), file)).collect();
    // 文件与文件夹重名无法按文件时间裁决；在任何更新前给出明确的改名提示。
    let local_dirs: HashSet<String> = local.iter().flat_map(|file| {
        let mut parents = Vec::new();
        let mut parent = parent_rel(&file.rel);
        while !parent.is_empty() { parents.push(pkey(&parent)); parent = parent_rel(&parent); }
        parents
    }).collect();
    // 首次扫描全树；已有清单时，只检查本机新增路径，防止后来出现的同名远端文件被静默更新。
    let mut dirs: Vec<String> = if first_sync {
        vec![String::new()]
    } else {
        local.iter().filter(|file| !tracked.contains(&pkey(&file.rel))).map(|file| parent_rel(&file.rel)).collect::<BTreeSet<_>>().into_iter().collect()
    };
    let mut seen = HashSet::new();
    let mut discovered = Vec::new();
    let mut count = 0usize;
    while let Some(dir) = dirs.pop() {
        if !seen.insert(dir.clone()) { continue; }
        for entry in dav.entries(&dir).await? {
            if is_ignored_name(&entry.name, entry.is_dir) { continue; }
            count += 1;
            if count > MAX_ENTRIES { return Err(SyncError::server("远端文件过多，请缩小首次同步的目录范围")); }
            let path = if dir.is_empty() { entry.name } else { format!("{}/{}", dir, entry.name) };
            if !portable_relative_path(&path) { return Err(SyncError::server(format!("远端文件名不兼容多端同步，请改名后重试：{}", path))); }
            if entry.is_dir {
                if first_sync {
                    if path.split('/').count() > MAX_DEPTH { return Err(SyncError::server("远端目录层级过深，无法首次配对")); }
                    dirs.push(path);
                }
                continue;
            }
            if tracked.contains(&pkey(&path)) || (!first_sync && !local_by_path.contains_key(&pkey(&path))) { continue; }
            if local_dirs.contains(&pkey(&path)) { return Err(SyncError::config(format!("远端文件与本机文件夹同名，请先改名后重试：{}", path))); }
            let mut parent = parent_rel(&path);
            while !parent.is_empty() {
                if local_by_path.contains_key(&pkey(&parent)) { return Err(SyncError::config(format!("本机文件与远端文件夹同名，请先改名后重试：{}", parent))); }
                parent = parent_rel(&parent);
            }
            if entry.size > max_file_size(ProviderKind::Webdav) { return Err(SyncError::server(format!("远端文件过大，无法首次配对：{}", path))); }
            let (hash, size) = dav.content_hash(&path, max_file_size(ProviderKind::Webdav)).await?;
            discovered.push(FileRec { path, hash, size, mtime: entry.mtime, ltime: 0, trash: None });
        }
    }
    let mut updates = Vec::new();
    for remote in &discovered {
        let Some(local) = local_by_path.get(&pkey(&remote.path)) else { continue };
        let hash = local_hash(&local.rel)?;
        if hash == remote.hash { continue; }
        // 显式恢复备份后的本机优先规则与实际同步计划一致，其余首次配对按时间取新。
        let direction = if force_local || local.mtime >= remote.mtime { "upload" } else { "download" };
        // 两端内容、时间或方向变化后必须重新确认，不能复用过期弹窗的决定。
        let snapshot = serde_json::to_vec(&(&remote.path, &hash, &remote.hash, local.mtime, remote.mtime, direction)).unwrap_or_default();
        let fingerprint = sha256_hex(&snapshot);
        updates.push(SyncFileUpdate {
            path: remote.path.clone(), direction: direction.into(), local_mtime: local.mtime,
            remote_mtime: remote.mtime, local_size: local.size, remote_size: remote.size, fingerprint,
        });
    }
    updates.sort_by(|a, b| a.path.cmp(&b.path));
    // 目录可含大量同名文件，使用集合避免逐条线性匹配形成平方级开销。
    let approved: HashSet<&str> = approved.iter().map(String::as_str).collect();
    if updates.iter().any(|update| !approved.contains(update.fingerprint.as_str())) {
        let mut error = SyncError::new(SyncErrorKind::ConfirmationRequired, "同步已暂停，请确认同名文件的更新");
        error.updates = updates;
        return Err(error);
    }
    let imported = !discovered.is_empty();
    for rec in discovered {
        manifest.entries.insert(uuid::Uuid::new_v4().simple().to_string(), Entry { rec, deleted: None, device: String::new() });
    }
    Ok(imported)
}
