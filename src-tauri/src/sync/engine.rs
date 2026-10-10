// NoteBoard 同步引擎：执行一次完整的双向同步
//
// 流程：
//   1. 绑定目录/远端、清理过期回收站条目
//   2. 读取远端清单（WebDAV/S3 先获取锁文件）→ 扫描本机 → 生成计划（plan.rs）
//   3. 准备内容：下载远端新内容、对双方都改过的文本做行级合并
//   4. 本机落盘：两阶段（先把要移动的文件挪进同盘临时目录，再统一放到目标位置），
//      每个文件动手前都核对大小/修改时间与扫描时一致——用户在同步期间刚保存的文件本轮跳过，不会被覆盖
//   5. 远端提交：上传新内容、写入新清单（乐观锁冲突时整体重试）、删除旧文件
//   6. 更新本地基线、回收站元数据，汇总增删改统计

use super::backend::{max_file_size, Backend, CommitBatch};
use super::config::{ProviderKind, SyncSettings};
use super::diff3::merge_text;
use super::error::{SyncError, SyncErrorKind, SyncResult};
use super::manifest::{lock_path, manifest_path, DeviceInfo, Entry, FileRec, Manifest, MANIFEST_FORMAT};
use super::plan::{build_local_view, plan, LiveLocal, LocalSide, PlanItem, PlanOptions, ScannedFile, Source, Target};
use super::state::{self, BaseRec, TrashItemMeta};
use super::trash;
use super::types::{Counts, LocalChange, SyncReport};
use super::util::{
    is_ignored_name, is_in_trash, is_line_mergeable, mtime_ms, now_ms, parent_rel, pkey, rel_to_abs, sha256_hex,
    trash_top, unique_rel_path, TMP_DIR, TRASH_DIR,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};

/// 行级合并基线只保存不超过 2MB 的文本
const BASE_CONTENT_LIMIT: u64 = 2 * 1024 * 1024;
/// 锁文件有效期
const LOCK_TTL_MS: i64 = 10 * 60 * 1000;

#[derive(Serialize, Deserialize)]
struct LockFile {
    device: String,
    name: String,
    expires: i64,
}

/// 一次同步的输出
pub struct SyncOutcome {
    pub report: SyncReport,
    pub changes: Vec<LocalChange>,
    /// 失败原因是否为临时性（网络、限流、其他设备占用），调度器据此退避重试
    pub transient: bool,
}

/// 执行同步（不会返回错误：失败信息写入报告）
pub async fn run_sync(cfg: &SyncSettings, device_id: &str, trigger: &str) -> SyncOutcome {
    run_sync_with(cfg, device_id, trigger, Backend::new(&cfg.provider)).await
}

/// 使用指定后端执行同步（测试注入内存后端）
pub async fn run_sync_with(cfg: &SyncSettings, device_id: &str, trigger: &str, backend: SyncResult<Backend>) -> SyncOutcome {
    let started = now_ms();
    let mut report = SyncReport { trigger: trigger.to_string(), ..Default::default() };
    let mut changes = Vec::new();
    let mut transient = false;
    let result = match backend {
        Ok(b) => run_with_retry(cfg, device_id, b, &mut report, &mut changes).await,
        Err(e) => Err(e),
    };
    match result {
        Ok(()) => {
            report.ok = true;
            report.message = summarize(&report);
        }
        Err(e) => {
            transient = e.is_transient() || e.kind == SyncErrorKind::Conflict;
            report.ok = false;
            report.message = format!("同步失败：{}", e.message);
            report.errors.insert(0, e.message);
        }
    }
    report.at = now_ms();
    report.duration_ms = report.at - started;
    SyncOutcome { report, changes, transient }
}

/// 生成结果摘要（区分方向）
pub fn summarize(r: &SyncReport) -> String {
    fn part(c: &Counts) -> String {
        let mut v = Vec::new();
        if c.added > 0 {
            v.push(format!("新增 {}", c.added));
        }
        if c.modified > 0 {
            v.push(format!("修改 {}", c.modified));
        }
        if c.deleted > 0 {
            v.push(format!("删除 {}", c.deleted));
        }
        v.join("、")
    }
    let mut segs = Vec::new();
    if r.upload.total() > 0 {
        segs.push(format!("本机→云端：{}", part(&r.upload)));
    }
    if r.download.total() > 0 {
        segs.push(format!("云端→本机：{}", part(&r.download)));
    }
    if r.merged > 0 {
        segs.push(format!("按行合并 {} 个", r.merged));
    }
    if r.conflicts > 0 {
        segs.push(format!("同时修改取最新 {} 个", r.conflicts));
    }
    let mut msg = if segs.is_empty() { "同步完成，没有变化".to_string() } else { format!("同步完成 · {}", segs.join(" · ")) };
    if !r.errors.is_empty() {
        msg.push_str(&format!("（{} 个文件失败）", r.errors.len()));
    }
    msg
}

async fn run_with_retry(
    cfg: &SyncSettings,
    device_id: &str,
    mut backend: Backend,
    report: &mut SyncReport,
    changes: &mut Vec<LocalChange>,
) -> SyncResult<()> {
    if cfg.root_dir.trim().is_empty() {
        return Err(SyncError::config("尚未设置同步文件夹"));
    }
    let root = PathBuf::from(cfg.root_dir.trim());
    if !root.is_dir() {
        return Err(SyncError::config(format!("同步文件夹不存在：{}", root.display())));
    }
    state::bind(cfg.root_dir.trim(), &cfg.provider.identity());
    trash::purge_expired(&root, cfg.trash_days);

    let mut attempt = 0;
    loop {
        attempt += 1;
        // 每次尝试重置统计（上次尝试已落盘的本机改动会在重试中被识别为一致，不重复计数）
        let mut r = SyncReport { trigger: report.trigger.clone(), ..Default::default() };
        let mut ch = Vec::new();
        let locked = if backend.needs_lock() { acquire_lock(&mut backend, device_id, &cfg.device_name).await? ; true } else { false };
        let result = sync_once(cfg, &root, device_id, &mut backend, &mut r, &mut ch).await;
        if locked {
            let _ = backend.delete(&lock_path(), "NoteBoard 同步").await;
        }
        // 合并多次尝试的本机改动通知（前端据此刷新）
        changes.extend(ch);
        match result {
            Ok(()) => {
                merge_report(report, r);
                return Ok(());
            }
            Err(e) if e.kind == SyncErrorKind::Conflict && attempt < 4 => {
                merge_report(report, r);
                log::info!("[sync] 远端在同步期间被更新，第 {} 次重试", attempt);
                continue;
            }
            Err(e) => {
                merge_report(report, r);
                return Err(e);
            }
        }
    }
}

fn merge_report(into: &mut SyncReport, from: SyncReport) {
    into.download.added += from.download.added;
    into.download.modified += from.download.modified;
    into.download.deleted += from.download.deleted;
    into.upload.added += from.upload.added;
    into.upload.modified += from.upload.modified;
    into.upload.deleted += from.upload.deleted;
    into.merged += from.merged;
    into.conflicts += from.conflicts;
    into.errors.extend(from.errors);
}

/// 获取远端锁（WebDAV/S3）：其他设备持有未过期的锁时返回 Busy
async fn acquire_lock(backend: &mut Backend, device_id: &str, name: &str) -> SyncResult<()> {
    let now = now_ms();
    if let Some(bytes) = backend.read(&lock_path()).await? {
        if let Ok(lock) = serde_json::from_slice::<LockFile>(&bytes) {
            if lock.device != device_id && lock.expires > now {
                return Err(SyncError::busy(format!("设备「{}」正在同步，稍后自动重试", lock.name)));
            }
        }
    }
    let lock = LockFile { device: device_id.to_string(), name: name.to_string(), expires: now + LOCK_TTL_MS };
    backend.put(&lock_path(), serde_json::to_vec(&lock).unwrap_or_default(), "NoteBoard 同步锁").await?;
    // 回读确认（两台设备几乎同时写锁时，后写者获胜，先写者放弃）
    if let Some(bytes) = backend.read(&lock_path()).await? {
        if let Ok(lock) = serde_json::from_slice::<LockFile>(&bytes) {
            if lock.device != device_id {
                return Err(SyncError::busy(format!("设备「{}」正在同步，稍后自动重试", lock.name)));
            }
        }
    }
    Ok(())
}

/// 递归扫描同步目录（跳过符号链接、系统垃圾文件、临时目录）
pub fn scan_tree(root: &Path) -> SyncResult<Vec<ScannedFile>> {
    let mut out = Vec::new();
    let mut stack: Vec<(PathBuf, String)> = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, rel)) = stack.pop() {
        let rd = match std::fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(e) if rel.is_empty() => return Err(SyncError::local(format!("无法读取同步文件夹：{}", e))),
            Err(e) => {
                log::warn!("[sync] 跳过无法读取的目录 {}: {}", dir.display(), e);
                continue;
            }
        };
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else { continue };
            if meta.file_type().is_symlink() {
                continue;
            }
            let child_rel = if rel.is_empty() { name.clone() } else { format!("{}/{}", rel, name) };
            if meta.is_dir() {
                if !is_ignored_name(&name, true) {
                    stack.push((entry.path(), child_rel));
                }
            } else if meta.is_file() && !is_ignored_name(&name, false) {
                out.push(ScannedFile { rel: child_rel, size: meta.len(), mtime: mtime_ms(&meta) });
            }
        }
    }
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(out)
}

/// 流式计算文件哈希
fn hash_file(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// 本地文件是否仍与扫描时一致（同步期间用户可能刚保存过）
fn unchanged_since_scan(root: &Path, l: &LiveLocal) -> bool {
    match std::fs::metadata(rel_to_abs(root, &l.rec.path)) {
        Ok(m) => m.is_file() && m.len() == l.fsize && mtime_ms(&m) == l.fmtime,
        Err(_) => false,
    }
}

fn visible(rec: Option<&FileRec>) -> bool {
    rec.map(|r| !is_in_trash(&r.path)).unwrap_or(false)
}

/// 按「改动前/后是否为可见文件（不在回收站）」归类为新增/修改/删除
fn classify(before: Option<&FileRec>, after: Option<&FileRec>, counts: &mut Counts) {
    match (visible(before), visible(after)) {
        (false, true) => counts.added += 1,
        (true, false) => counts.deleted += 1,
        (true, true) => {
            let (b, a) = (before.unwrap(), after.unwrap());
            if b.hash != a.hash || b.path != a.path {
                counts.modified += 1;
            }
        }
        (false, false) => {}
    }
}

/// 删除本地文件：被其他设备删除的普通文件进入系统回收站（桌面端，多一层保险）；回收站内文件直接删除
fn remove_local(path: &Path, rel: &str) -> std::io::Result<()> {
    if !is_in_trash(rel) {
        #[cfg(all(desktop, not(test)))]
        {
            if crate::fsio::trash::move_to_trash(path).is_ok() {
                return Ok(());
            }
        }
    }
    std::fs::remove_file(path)
}

/// 把文件修改时间设为内容的真实修改时间（远端拉取的文件显示原始编辑时间）
fn set_mtime(path: &Path, ms: i64) {
    if ms <= 0 {
        return;
    }
    let t = std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms as u64);
    if let Ok(f) = std::fs::File::options().write(true).open(path) {
        let _ = f.set_modified(t);
    }
}

/// 删除后自下而上清理变空的目录（不越过同步根目录与回收站根目录）
fn prune_empty_dirs(root: &Path, rel_file: &str) {
    let mut dir = parent_rel(rel_file);
    while !dir.is_empty() && dir != TRASH_DIR {
        let abs = rel_to_abs(root, &dir);
        match std::fs::read_dir(&abs) {
            Ok(mut rd) => {
                if rd.next().is_some() {
                    break;
                }
            }
            Err(_) => break,
        }
        if std::fs::remove_dir(&abs).is_err() {
            break;
        }
        dir = parent_rel(&dir);
    }
}

/// 把本机文件复制一份到回收站：`.nb-trash/笔记 (本机冲突版本 2026-10-10 1530).md`
fn save_conflict_copy(root: &Path, rel: &str) -> std::io::Result<(String, TrashItemMeta)> {
    let name = super::util::base_name(rel);
    let (stem, ext) = super::util::split_name(&name);
    let label = chrono::Local::now().format("%Y-%m-%d %H%M");
    let candidate = format!("{}/{} (本机冲突版本 {}){}", TRASH_DIR, stem, label, ext);
    let top = unique_rel_path(&candidate, |p| rel_to_abs(root, p).exists());
    let dest = rel_to_abs(root, &top);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(rel_to_abs(root, rel), &dest)?;
    Ok((top, TrashItemMeta { orig: rel.to_string(), at: now_ms(), is_dir: false }))
}

/// 计划执行期间每个文件的工作状态
struct Work {
    item: PlanItem,
    /// 最终目标记录（可能因下载内容校验、合并、落盘让名而调整）
    rec: Option<FileRec>,
    /// 需要写到本机的新内容
    content: Option<Vec<u8>>,
    /// 本轮放弃处理（保持基线不变，下轮重试）
    skipped: bool,
    /// 本机已按目标状态落盘
    local_applied: bool,
    /// 双方冲突且本机内容被整体（或部分重叠段）覆盖：覆盖前把本机旧版本保留到回收站
    keep_local_copy: bool,
}

fn local_live(item: &PlanItem) -> Option<&LiveLocal> {
    match &item.local {
        Some(LocalSide::Live(l)) => Some(l),
        _ => None,
    }
}

fn remote_live(item: &PlanItem) -> Option<&FileRec> {
    match &item.remote {
        Some(e) if e.is_live() => Some(&e.rec),
        _ => None,
    }
}

async fn sync_once(
    cfg: &SyncSettings,
    root: &Path,
    device_id: &str,
    backend: &mut Backend,
    report: &mut SyncReport,
    changes: &mut Vec<LocalChange>,
) -> SyncResult<()> {
    backend.begin().await?;
    let remote_bytes = backend.read(&manifest_path()).await?;
    let (mut manifest, base_rev) = match remote_bytes {
        Some(b) => {
            let m = Manifest::parse(&b).map_err(SyncError::server)?;
            let rev = m.rev;
            (m, Some(rev))
        }
        None => (Manifest { format: MANIFEST_FORMAT, ..Default::default() }, None),
    };
    // 远端没有清单（首次使用或远端数据被清空）：本机基线作废，按路径与内容重新配对
    if base_rev.is_none() {
        state::with_state(|s| {
            if !s.entries.is_empty() {
                s.entries.clear();
                s.hints.clear();
                s.deletes.clear();
            }
        });
    }

    let scan_started = now_ms();
    let scanned = scan_tree(root)?;
    let snapshot = state::snapshot();
    let view = build_local_view(&scanned, &snapshot, scan_started, |rel| hash_file(&rel_to_abs(root, rel)));
    report.errors.extend(view.errors.iter().cloned());
    let dir_exists = |rel: &str| rel_to_abs(root, rel).is_dir();
    let opts = PlanOptions {
        now: scan_started,
        trash_enabled: cfg.trash_enabled,
        force_local: snapshot.force_local,
        dir_exists: &dir_exists,
    };
    let the_plan = plan(&snapshot, view, &manifest, &opts, &mut || uuid::Uuid::new_v4().simple().to_string());
    let trash_added = the_plan.trash_added;

    let mut works: Vec<Work> = the_plan
        .items
        .into_iter()
        .map(|item| {
            let rec = match &item.target {
                Target::Live { rec, .. } => Some(rec.clone()),
                _ => None,
            };
            Work { item, rec, content: None, skipped: false, local_applied: false, keep_local_copy: false }
        })
        .collect();

    // ── 3. 准备内容（下载 / 行级合并） ──
    for w in works.iter_mut() {
        let Target::Live { src, .. } = w.item.target.clone() else { continue };
        let rec = w.rec.clone().expect("live target has rec");
        let local = local_live(&w.item).cloned();
        let local_has = local.as_ref().map(|l| l.rec.hash == rec.hash).unwrap_or(false);
        match src {
            Source::Local => {}
            Source::Remote => {
                if local_has {
                    continue;
                }
                let Some(r) = remote_live(&w.item).cloned() else {
                    w.skipped = true;
                    continue;
                };
                match backend.read(&r.path).await {
                    Ok(Some(bytes)) => {
                        let actual = sha256_hex(&bytes);
                        let mut rec = rec;
                        // 远端文件被其他途径改过（与清单不符）：以实际内容为准
                        rec.hash = actual;
                        rec.size = bytes.len() as u64;
                        w.rec = Some(rec);
                        w.content = Some(bytes);
                    }
                    Ok(None) => {
                        // 清单记录存在但远端文件缺失：本机若有内容则重新上传，否则本轮跳过
                        if let Some(l) = &local {
                            let mut rec = rec;
                            rec.hash = l.rec.hash.clone();
                            rec.size = l.rec.size;
                            w.rec = Some(rec);
                        } else {
                            report.errors.push(format!("{}：远端文件缺失", r.path));
                            w.skipped = true;
                        }
                    }
                    Err(e) => {
                        if !e.is_transient() || e.kind == SyncErrorKind::Network {
                            return Err(e);
                        }
                        report.errors.push(format!("{}：{}", r.path, e));
                        w.skipped = true;
                    }
                }
            }
            Source::Merge { prefer_local } => {
                let (Some(l), Some(r)) = (local.clone(), remote_live(&w.item).cloned()) else {
                    w.skipped = true;
                    continue;
                };
                let local_bytes = match std::fs::read(rel_to_abs(root, &l.rec.path)) {
                    Ok(b) => b,
                    Err(e) => {
                        report.errors.push(format!("{}：{}", l.rec.path, e));
                        w.skipped = true;
                        continue;
                    }
                };
                let remote_bytes = match backend.read(&r.path).await? {
                    Some(b) => b,
                    None => {
                        // 远端内容缺失：保留本机
                        let mut rec = rec;
                        rec.hash = l.rec.hash.clone();
                        rec.size = l.rec.size;
                        w.rec = Some(rec);
                        continue;
                    }
                };
                let base = state::read_base_content(&cfg.root_dir, &w.item.id);
                let merged = match (is_line_mergeable(&rec.path), base) {
                    (true, Some(base)) => match (
                        std::str::from_utf8(&base),
                        std::str::from_utf8(&local_bytes),
                        std::str::from_utf8(&remote_bytes),
                    ) {
                        (Ok(b), Ok(lt), Ok(rt)) => merge_text(b, lt, rt, prefer_local),
                        _ => None,
                    },
                    _ => None,
                };
                let bytes = match merged {
                    Some(m) => {
                        report.merged += 1;
                        if m.conflicts > 0 {
                            report.conflicts += 1;
                            // 重叠段落采用了远端版本：本机被替换的段落保留在回收站的冲突版本中
                            w.keep_local_copy = !prefer_local;
                        }
                        m.text.into_bytes()
                    }
                    None => {
                        // 无法行级合并：整份采用较新一方
                        report.conflicts += 1;
                        w.keep_local_copy = !prefer_local;
                        if prefer_local {
                            local_bytes
                        } else {
                            remote_bytes
                        }
                    }
                };
                let mut rec = rec;
                rec.hash = sha256_hex(&bytes);
                rec.size = bytes.len() as u64;
                if rec.hash != l.rec.hash {
                    w.content = Some(bytes);
                }
                w.rec = Some(rec);
            }
        }
        if w.item.conflict && !matches!(src, Source::Merge { .. }) {
            report.conflicts += 1;
            // 冲突中远端版本胜出、本机内容将被覆盖
            if src == Source::Remote && w.content.is_some() {
                w.keep_local_copy = true;
            }
        }
    }

    // ── 4. 本机落盘 ──
    // 4.0 冲突保护：本机内容即将被较新的远端结果覆盖/删除时，先把本机旧版本保留到回收站（启用回收站时）
    let mut conflict_copies: Vec<(String, TrashItemMeta)> = Vec::new();
    if cfg.trash_enabled {
        for w in works.iter_mut() {
            if w.skipped {
                continue;
            }
            let deleting_conflict = w.item.conflict && matches!(w.item.target, Target::Deleted { .. });
            if !(w.keep_local_copy || deleting_conflict) {
                continue;
            }
            let Some(l) = local_live(&w.item).cloned() else { continue };
            if is_in_trash(&l.rec.path) || !unchanged_since_scan(root, &l) {
                continue;
            }
            match save_conflict_copy(root, &l.rec.path) {
                Ok(entry) => conflict_copies.push(entry),
                Err(e) => log::warn!("[sync] 保留冲突版本失败 {}: {}", l.rec.path, e),
            }
        }
    }
    let tmp_root = root.join(TMP_DIR);
    let mut relocations: Vec<usize> = Vec::new();
    let mut placements: Vec<usize> = Vec::new();
    for (i, w) in works.iter_mut().enumerate() {
        if w.skipped {
            continue;
        }
        let local = local_live(&w.item).cloned();
        match (&w.item.target, &w.rec) {
            (Target::Deleted { .. }, _) => {
                let Some(l) = local else { continue };
                if !unchanged_since_scan(root, &l) {
                    w.skipped = true;
                    continue;
                }
                let abs = rel_to_abs(root, &l.rec.path);
                match remove_local(&abs, &l.rec.path) {
                    Ok(()) => {
                        w.local_applied = true;
                        classify(Some(&l.rec), None, &mut report.download);
                        changes.push(LocalChange { kind: "deleted".into(), path: abs.to_string_lossy().to_string(), from: None });
                        prune_empty_dirs(root, &l.rec.path);
                    }
                    Err(e) => {
                        report.errors.push(format!("{}：删除失败 {}", l.rec.path, e));
                        w.skipped = true;
                    }
                }
            }
            (Target::Live { .. }, Some(rec)) => {
                let needs_move = local.as_ref().map(|l| l.rec.path != rec.path).unwrap_or(false);
                let needs_write = w.content.is_some();
                if !needs_move && !needs_write {
                    continue;
                }
                if let Some(l) = &local {
                    if !unchanged_since_scan(root, l) {
                        w.skipped = true;
                        continue;
                    }
                }
                if needs_move {
                    relocations.push(i);
                }
                placements.push(i);
            }
            _ => {}
        }
    }

    if !placements.is_empty() {
        std::fs::create_dir_all(&tmp_root)?;
    }
    // 阶段一：把需要移动的文件挪进临时目录（释放原路径，处理互换/链式改名）
    let mut parked: HashMap<usize, PathBuf> = HashMap::new();
    for &i in &relocations {
        let w = &mut works[i];
        let l = local_live(&w.item).cloned().expect("relocation has local");
        let src = rel_to_abs(root, &l.rec.path);
        let parked_path = tmp_root.join(format!("{}.move", w.item.id));
        match std::fs::rename(&src, &parked_path) {
            Ok(()) => {
                parked.insert(i, parked_path);
            }
            Err(e) => {
                report.errors.push(format!("{}：移动失败 {}", l.rec.path, e));
                w.skipped = true;
            }
        }
    }
    // 阶段二：放到目标位置（新内容先写临时文件再改名，保证原子）
    for &i in &placements {
        if works[i].skipped {
            continue;
        }
        let local = local_live(&works[i].item).cloned();
        let mut rec = works[i].rec.clone().expect("placement has rec");
        let mut dest = rel_to_abs(root, &rec.path);
        let own_path = local.as_ref().map(|l| pkey(&l.rec.path) == pkey(&rec.path)).unwrap_or(false);
        // 目标位置被同步期间新出现的文件占用：让名，避免覆盖用户文件
        if !own_path && dest.exists() {
            let new_rel = unique_rel_path(&rec.path, |p| rel_to_abs(root, p).exists());
            rec.path = new_rel;
            dest = rel_to_abs(root, &rec.path);
        }
        let result: std::io::Result<()> = (|| {
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)?;
            }
            if let Some(bytes) = &works[i].content {
                let staged = tmp_root.join(format!("{}.new", works[i].item.id));
                std::fs::write(&staged, bytes)?;
                set_mtime(&staged, if matches!(works[i].item.target, Target::Live { src: Source::Merge { .. }, .. }) { now_ms() } else { rec.mtime });
                std::fs::rename(&staged, &dest)?;
                if let Some(p) = parked.get(&i) {
                    let _ = std::fs::remove_file(p);
                }
            } else if let Some(p) = parked.get(&i) {
                std::fs::rename(p, &dest)?;
            }
            Ok(())
        })();
        match result {
            Ok(()) => {
                let w = &mut works[i];
                w.local_applied = true;
                let before = local.as_ref().map(|l| &l.rec);
                classify(before, Some(&rec), &mut report.download);
                let abs = dest.to_string_lossy().to_string();
                match &local {
                    Some(l) if l.rec.path != rec.path => {
                        changes.push(LocalChange {
                            kind: "moved".into(),
                            path: abs.clone(),
                            from: Some(rel_to_abs(root, &l.rec.path).to_string_lossy().to_string()),
                        });
                        if w.content.is_some() {
                            changes.push(LocalChange { kind: "modified".into(), path: abs, from: None });
                        }
                        prune_empty_dirs(root, &l.rec.path);
                    }
                    Some(_) => changes.push(LocalChange { kind: "modified".into(), path: abs, from: None }),
                    None => changes.push(LocalChange { kind: "added".into(), path: abs, from: None }),
                }
                w.rec = Some(rec);
            }
            Err(e) => {
                report.errors.push(format!("{}：写入失败 {}", rec.path, e));
                let w = &mut works[i];
                w.skipped = true;
                // 尽量把挪走的文件放回原处
                if let (Some(p), Some(l)) = (parked.get(&i), &local) {
                    let _ = std::fs::rename(p, rel_to_abs(root, &l.rec.path));
                }
            }
        }
    }
    let _ = std::fs::remove_dir_all(&tmp_root);

    // ── 5. 远端提交 ──
    let limit = max_file_size(cfg.provider.kind);
    let case_insensitive_remote = cfg.provider.kind == ProviderKind::Webdav;
    let mut puts: Vec<(String, Vec<u8>)> = Vec::new();
    let mut put_keys: HashSet<String> = HashSet::new();
    let mut deletes: Vec<String> = Vec::new();
    let mut manifest_changed = false;
    let mut upload_counts = Counts::default();
    let mut final_bytes: HashMap<usize, Vec<u8>> = HashMap::new();
    for (i, w) in works.iter_mut().enumerate() {
        if w.skipped {
            continue;
        }
        let remote = remote_live(&w.item).cloned();
        match (&w.item.target, w.rec.clone()) {
            (Target::Live { .. }, Some(mut rec)) => {
                let need_put = remote.as_ref().map(|r| r.hash != rec.hash || r.path != rec.path).unwrap_or(true);
                let entry_differs = match manifest.entries.get(&w.item.id) {
                    Some(e) => !e.is_live() || e.rec != rec,
                    None => true,
                };
                if need_put {
                    let abs = rel_to_abs(root, &rec.path);
                    let bytes = match std::fs::read(&abs) {
                        Ok(b) => b,
                        Err(e) => {
                            report.errors.push(format!("{}：读取失败 {}", rec.path, e));
                            w.skipped = true;
                            continue;
                        }
                    };
                    if bytes.len() as u64 > limit {
                        report.errors.push(format!(
                            "{}：文件过大（{}），超出 {} 单文件上限，未同步",
                            rec.path,
                            super::util::human_size(bytes.len() as u64),
                            cfg.provider.kind.label()
                        ));
                        w.skipped = true;
                        continue;
                    }
                    // 落盘后用户又改过：上传实际内容
                    let actual = sha256_hex(&bytes);
                    if actual != rec.hash {
                        rec.hash = actual;
                        rec.size = bytes.len() as u64;
                        w.rec = Some(rec.clone());
                    }
                    classify(remote.as_ref(), Some(&rec), &mut upload_counts);
                    put_keys.insert(rec.path.clone());
                    puts.push((rec.path.clone(), bytes.clone()));
                    final_bytes.insert(i, bytes);
                    if let Some(r) = &remote {
                        if r.path != rec.path {
                            deletes.push(r.path.clone());
                        }
                    }
                }
                if need_put || entry_differs {
                    manifest.entries.insert(w.item.id.clone(), Entry { rec, deleted: None, device: device_id.to_string() });
                    manifest_changed = true;
                }
            }
            (Target::Deleted { at }, _) => {
                if let Some(r) = &remote {
                    classify(Some(r), None, &mut upload_counts);
                    deletes.push(r.path.clone());
                }
                let already = manifest.entries.get(&w.item.id).map(|e| !e.is_live()).unwrap_or(false);
                if !already {
                    let last = remote.clone().or_else(|| w.item.base.clone());
                    if let Some(mut rec) = last {
                        rec.hash.clear();
                        manifest.entries.insert(w.item.id.clone(), Entry { rec, deleted: Some(*at), device: device_id.to_string() });
                        manifest_changed = true;
                    }
                }
            }
            _ => {}
        }
    }
    // 删除列表过滤：不删除本次仍在写入的路径（大小写不敏感的 WebDAV 上，仅大小写不同也视为同一文件）
    let put_pkeys: HashSet<String> = put_keys.iter().map(|p| pkey(p)).collect();
    deletes.retain(|p| !put_keys.contains(p) && !(case_insensitive_remote && put_pkeys.contains(&pkey(p))));
    deletes.sort();
    deletes.dedup();

    let now = now_ms();
    if manifest_changed || !puts.is_empty() || !deletes.is_empty() {
        manifest.format = MANIFEST_FORMAT;
        manifest.rev += 1;
        manifest.updated_at = now;
        manifest.updated_by = device_id.to_string();
        manifest.devices.insert(device_id.to_string(), DeviceInfo { name: cfg.device_name.clone(), last_sync: now });
        manifest.prune_tombstones(now);
        let batch = CommitBatch {
            puts,
            deletes,
            manifest_path: manifest_path(),
            manifest: manifest.to_bytes(),
            base_rev,
            message: format!("NoteBoard 同步（{}）", cfg.device_name),
        };
        backend.commit(batch).await?;
        report.upload = upload_counts;
    }

    // ── 6. 更新本地基线 ──
    let consumed_hints = snapshot.hints.clone();
    let consumed_deletes = snapshot.deletes.clone();
    let mut new_trash: Vec<(String, TrashItemMeta)> = trash_added;
    new_trash.extend(conflict_copies);
    let mut base_updates: Vec<(String, Option<BaseRec>)> = Vec::new();
    for (i, w) in works.iter().enumerate() {
        if w.skipped {
            continue;
        }
        match (&w.item.target, &w.rec) {
            (Target::Live { .. }, Some(rec)) | (Target::Keep, Some(rec)) => {
                let abs = rel_to_abs(root, &rec.path);
                let Ok(meta) = std::fs::metadata(&abs) else { continue };
                base_updates.push((w.item.id.clone(), Some(BaseRec { rec: rec.clone(), fsize: meta.len(), fmtime: mtime_ms(&meta) })));
                // 行级合并基线：只为可合并的小文本保存
                if is_line_mergeable(&rec.path) && rec.size <= BASE_CONTENT_LIMIT {
                    let need = state::read_base_content(&cfg.root_dir, &w.item.id).map(|b| sha256_hex(&b) != rec.hash).unwrap_or(true);
                    if need {
                        let bytes = final_bytes.get(&i).cloned().or_else(|| w.content.clone()).or_else(|| std::fs::read(&abs).ok());
                        if let Some(b) = bytes {
                            if sha256_hex(&b) == rec.hash {
                                state::write_base_content(&cfg.root_dir, &w.item.id, Some(&b));
                            }
                        }
                    }
                } else {
                    state::write_base_content(&cfg.root_dir, &w.item.id, None);
                }
                // 拉取到回收站的文件：补充回收站条目元数据
                if let (Some(t), Some((top, inner))) = (&rec.trash, trash_top(&rec.path)) {
                    let orig_top = if inner.is_empty() {
                        t.orig.clone()
                    } else {
                        t.orig.strip_suffix(&format!("/{}", inner)).unwrap_or(&t.orig).to_string()
                    };
                    new_trash.push((top, TrashItemMeta { orig: orig_top, at: t.at, is_dir: !inner.is_empty() }));
                }
            }
            (Target::Keep, None) => {
                // 双方未变：沿用基线，但刷新文件系统时间（例如仅触碰过修改时间）
                if let (Some(b), Some(l)) = (&w.item.base, local_live(&w.item)) {
                    base_updates.push((w.item.id.clone(), Some(BaseRec { rec: b.clone(), fsize: l.fsize, fmtime: l.fmtime })));
                }
            }
            (Target::Deleted { .. }, _) | (Target::Forget, _) => {
                base_updates.push((w.item.id.clone(), None));
                state::write_base_content(&cfg.root_dir, &w.item.id, None);
            }
            _ => {}
        }
    }
    state::with_state(|s| {
        for (id, rec) in base_updates {
            match rec {
                Some(r) => {
                    s.entries.insert(id, r);
                }
                None => {
                    s.entries.remove(&id);
                }
            }
        }
        // 只移除本轮已处理的线索（同步期间新产生的线索留给下一轮）
        for (p, h) in consumed_hints {
            if s.hints.get(&p) == Some(&h) {
                s.hints.remove(&p);
            }
        }
        for (p, t) in consumed_deletes {
            if s.deletes.get(&p) == Some(&t) {
                s.deletes.remove(&p);
            }
        }
        for (top, meta) in new_trash {
            s.trash.entry(top).or_insert(meta);
        }
        // 回收站中已不存在的条目元数据清理
        s.trash.retain(|top, _| rel_to_abs(root, top).exists());
        s.last_scan_at = scan_started;
        if snapshot.force_local {
            s.force_local = false;
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_lists_directions() {
        let r = SyncReport {
            upload: Counts { added: 1, modified: 2, deleted: 0 },
            download: Counts { added: 0, modified: 0, deleted: 3 },
            ..Default::default()
        };
        assert_eq!(summarize(&r), "同步完成 · 本机→云端：新增 1、修改 2 · 云端→本机：删除 3");
        assert_eq!(summarize(&SyncReport::default()), "同步完成，没有变化");
    }

    #[test]
    fn scan_skips_ignored_entries() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.md"), "x").unwrap();
        std::fs::write(dir.path().join("Thumbs.db"), "x").unwrap();
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        std::fs::write(dir.path().join(".git").join("HEAD"), "x").unwrap();
        std::fs::create_dir_all(dir.path().join(TRASH_DIR).join("old")).unwrap();
        std::fs::write(dir.path().join(TRASH_DIR).join("old").join("b.md"), "y").unwrap();
        let files: Vec<String> = scan_tree(dir.path()).unwrap().into_iter().map(|f| f.rel).collect();
        assert_eq!(files, vec![".nb-trash/old/b.md".to_string(), "a.md".to_string()]);
    }
}
