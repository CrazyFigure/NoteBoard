// NoteBoard 同步目录备份
//
// 备份 = 同步目录（不含回收站与临时文件）打包为 ZIP，保存到本地其他文件夹或任一远端服务；
// 文件名包含时间、设备名与设备 ID 前缀：NoteBoard-backup-20261010-153000-设备名-1a2b3c4d.zip
// 保留策略只清理本机产生的备份，多台设备备份到同一位置时互不影响。
//
// 恢复到同步目录：备份中的文件覆盖写回，备份中没有的现有文件移入回收站（未启用回收站时删除），
// 并标记「下次同步以本机为准」——否则其他设备较新的改动会按时间规则把恢复结果覆盖回去。

use super::backend::{Backend, RemoteFile};
use super::config::{BackupTarget, SyncConfigFile};
use super::engine::scan_tree;
use super::error::{SyncError, SyncResult};
use super::state::{self, TrashItemMeta};
use super::trash::{hint_moves, record_deletes};
use super::types::{BackupInfo, BackupReport, LocalChange};
use super::util::{is_in_trash, join_rel, now_ms, rel_to_abs, sha256_hex, unique_rel_path, TRASH_DIR};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// 远端备份子目录（位于备份服务配置的远端目录下）
pub const REMOTE_BACKUP_DIR: &str = "NoteBoard-Backups";
const PREFIX: &str = "NoteBoard-backup-";
const META_NAME: &str = ".noteboard-backup.json";

/// 设备名中不适合放进文件名的字符替换为下划线
fn sanitize(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if c.is_control() || "\\/:*?\"<>|-. ".contains(c) { '_' } else { c })
        .take(32)
        .collect();
    if s.is_empty() { "device".to_string() } else { s }
}

fn short_id(device_id: &str) -> String {
    device_id.chars().take(8).collect()
}

pub fn backup_name(device_name: &str, device_id: &str) -> String {
    let ts = chrono::Local::now().format("%Y%m%d-%H%M%S");
    format!("{}{}-{}-{}.zip", PREFIX, ts, sanitize(device_name), short_id(device_id))
}

/// 解析备份文件名 → (创建时间, 设备名, 设备 ID 前缀)
pub fn parse_name(name: &str) -> Option<(i64, String, String)> {
    let core = name.strip_prefix(PREFIX)?.strip_suffix(".zip")?;
    let (rest, id) = core.rsplit_once('-')?;
    // rest = YYYYMMDD-HHMMSS-设备名
    if rest.len() < 16 {
        return None;
    }
    let (ts, device) = rest.split_at(15);
    let device = device.trim_start_matches('-').to_string();
    let dt = chrono::NaiveDateTime::parse_from_str(ts, "%Y%m%d-%H%M%S").ok()?;
    let local = dt.and_local_timezone(chrono::Local).single()?;
    Some((local.timestamp_millis(), device, id.to_string()))
}

/// 打包同步目录到临时 ZIP；返回（临时文件, 文件数）
fn create_zip(root: &Path, device_name: &str) -> SyncResult<(PathBuf, u32)> {
    let files = scan_tree(root)?;
    let tmp = crate::app_dirs::cache_dir().join(format!("noteboard-backup-{}.zip", uuid::Uuid::new_v4().simple()));
    let file = std::fs::File::create(&tmp)?;
    let mut zip = zip::ZipWriter::new(std::io::BufWriter::new(file));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .large_file(true);
    let mut count = 0u32;
    let mut buf = vec![0u8; 256 * 1024];
    for f in files.iter().filter(|f| !is_in_trash(&f.rel)) {
        let abs = rel_to_abs(root, &f.rel);
        let mut src = match std::fs::File::open(&abs) {
            Ok(s) => s,
            Err(e) => {
                log::warn!("[backup] 跳过无法读取的文件 {}: {}", f.rel, e);
                continue;
            }
        };
        zip.start_file(f.rel.as_str(), options).map_err(|e| SyncError::local(format!("写入备份失败：{}", e)))?;
        loop {
            let n = src.read(&mut buf)?;
            if n == 0 {
                break;
            }
            zip.write_all(&buf[..n])?;
        }
        count += 1;
    }
    let meta = serde_json::json!({
        "app": "NoteBoard",
        "createdAt": now_ms(),
        "device": device_name,
        "root": root.to_string_lossy(),
        "fileCount": count,
    });
    zip.start_file(META_NAME, options).map_err(|e| SyncError::local(e.to_string()))?;
    zip.write_all(meta.to_string().as_bytes())?;
    let mut inner = zip.finish().map_err(|e| SyncError::local(format!("写入备份失败：{}", e)))?;
    inner.flush()?;
    Ok((tmp, count))
}

/// 本地备份目录
fn local_dir(cfg: &SyncConfigFile) -> SyncResult<PathBuf> {
    let dir = cfg.backup.local_dir.trim();
    if dir.is_empty() {
        return Err(SyncError::config("请先选择本地备份文件夹"));
    }
    let p = PathBuf::from(dir);
    if let Ok(root) = std::fs::canonicalize(cfg.sync.root_dir.trim()) {
        if let Ok(target) = std::fs::canonicalize(&p) {
            if target.starts_with(&root) {
                return Err(SyncError::config("备份文件夹不能位于同步文件夹内部"));
            }
        }
    }
    std::fs::create_dir_all(&p).map_err(|e| SyncError::local(format!("创建备份文件夹失败：{}", e)))?;
    Ok(p)
}

async fn list_raw(cfg: &SyncConfigFile) -> SyncResult<Vec<RemoteFile>> {
    match cfg.backup.target {
        BackupTarget::Local => {
            let dir = local_dir(cfg)?;
            let mut out = Vec::new();
            for e in std::fs::read_dir(&dir)?.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if let Ok(m) = e.metadata() {
                    if m.is_file() {
                        out.push(RemoteFile { name, size: m.len() });
                    }
                }
            }
            Ok(out)
        }
        BackupTarget::Remote => {
            let mut backend = Backend::new(&cfg.backup.provider)?;
            backend.list(REMOTE_BACKUP_DIR).await
        }
    }
}

/// 列出备份（新 → 旧）
pub async fn list_backups(cfg: &SyncConfigFile) -> SyncResult<Vec<BackupInfo>> {
    let own = short_id(&cfg.device_id);
    let mut out: Vec<BackupInfo> = list_raw(cfg)
        .await?
        .into_iter()
        .filter_map(|f| {
            let (created_at, device, id) = parse_name(&f.name)?;
            Some(BackupInfo { name: f.name, size: f.size, created_at, device, is_own: id == own })
        })
        .collect();
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.name.cmp(&a.name)));
    Ok(out)
}

/// 执行一次备份并按保留策略清理旧备份
pub async fn run_backup(cfg: &SyncConfigFile, trigger: &str) -> BackupReport {
    let mut report = BackupReport { trigger: trigger.to_string(), ..Default::default() };
    match run_backup_inner(cfg, &mut report).await {
        Ok(()) => {
            report.ok = true;
            report.message = if report.removed_old > 0 {
                format!("备份完成：{} 个文件（{}），已清理 {} 份旧备份", report.file_count, super::util::human_size(report.size), report.removed_old)
            } else {
                format!("备份完成：{} 个文件（{}）", report.file_count, super::util::human_size(report.size))
            };
        }
        Err(e) => {
            report.ok = false;
            report.message = format!("备份失败：{}", e.message);
        }
    }
    report.at = now_ms();
    report
}

async fn run_backup_inner(cfg: &SyncConfigFile, report: &mut BackupReport) -> SyncResult<()> {
    let root = PathBuf::from(cfg.sync.root_dir.trim());
    if cfg.sync.root_dir.trim().is_empty() || !root.is_dir() {
        return Err(SyncError::config("同步文件夹未设置或不存在，无法备份"));
    }
    let name = backup_name(&cfg.sync.device_name, &cfg.device_id);
    let (tmp, count) = create_zip(&root, &cfg.sync.device_name)?;
    report.file_count = count;
    report.size = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
    report.name = name.clone();
    let result: SyncResult<()> = async {
        match cfg.backup.target {
            BackupTarget::Local => {
                let dir = local_dir(cfg)?;
                std::fs::copy(&tmp, dir.join(&name)).map_err(|e| SyncError::local(format!("保存备份失败：{}", e)))?;
            }
            BackupTarget::Remote => {
                let limit = super::backend::max_file_size(cfg.backup.provider.kind);
                if report.size > limit {
                    return Err(SyncError::config(format!(
                        "备份文件 {} 超出 {} 单文件上限，请改用本地、WebDAV 或 S3 备份",
                        super::util::human_size(report.size),
                        cfg.backup.provider.kind.label()
                    )));
                }
                let bytes = std::fs::read(&tmp)?;
                let mut backend = Backend::new(&cfg.backup.provider)?;
                backend.put(&format!("{}/{}", REMOTE_BACKUP_DIR, name), bytes, "NoteBoard 备份").await?;
            }
        }
        Ok(())
    }
    .await;
    let _ = std::fs::remove_file(&tmp);
    result?;
    // 保留策略：只清理本机备份
    if cfg.backup.keep_count > 0 {
        let own: Vec<BackupInfo> = list_backups(cfg).await?.into_iter().filter(|b| b.is_own).collect();
        for old in own.iter().skip(cfg.backup.keep_count as usize) {
            if delete_backup(cfg, &old.name).await.is_ok() {
                report.removed_old += 1;
            }
        }
    }
    Ok(())
}

fn check_name(name: &str) -> SyncResult<()> {
    if !name.starts_with(PREFIX) || !name.ends_with(".zip") || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(SyncError::config("无效的备份文件名"));
    }
    Ok(())
}

pub async fn delete_backup(cfg: &SyncConfigFile, name: &str) -> SyncResult<()> {
    check_name(name)?;
    match cfg.backup.target {
        BackupTarget::Local => {
            let p = local_dir(cfg)?.join(name);
            if p.exists() {
                std::fs::remove_file(p)?;
            }
            Ok(())
        }
        BackupTarget::Remote => {
            let mut backend = Backend::new(&cfg.backup.provider)?;
            backend.delete(&format!("{}/{}", REMOTE_BACKUP_DIR, name), "NoteBoard 清理旧备份").await
        }
    }
}

async fn fetch_backup(cfg: &SyncConfigFile, name: &str) -> SyncResult<Vec<u8>> {
    check_name(name)?;
    match cfg.backup.target {
        BackupTarget::Local => Ok(std::fs::read(local_dir(cfg)?.join(name))?),
        BackupTarget::Remote => {
            let mut backend = Backend::new(&cfg.backup.provider)?;
            backend.begin().await?;
            backend
                .read(&format!("{}/{}", REMOTE_BACKUP_DIR, name))
                .await?
                .ok_or_else(|| SyncError::config("远端已不存在该备份"))
        }
    }
}

/// 读出备份内全部文件（相对路径, 内容）；拒绝越界路径
fn read_entries(bytes: Vec<u8>) -> SyncResult<Vec<(String, Vec<u8>)>> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| SyncError::local(format!("备份文件已损坏：{}", e)))?;
    let mut out = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| SyncError::local(format!("备份文件已损坏：{}", e)))?;
        if entry.is_dir() {
            continue;
        }
        let Some(path) = entry.enclosed_name() else { continue };
        let rel: Vec<String> = path.components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect();
        let rel = rel.join("/");
        if rel.is_empty() || rel == META_NAME || is_in_trash(&rel) {
            continue;
        }
        let mut data = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut data)?;
        out.push((rel, data));
    }
    Ok(out)
}

/// 恢复到其他目录：解压到「目标目录/备份名」子文件夹，返回该文件夹
pub async fn restore_to_dir(cfg: &SyncConfigFile, name: &str, dir: &Path) -> SyncResult<String> {
    let entries = read_entries(fetch_backup(cfg, name).await?)?;
    let stem = name.trim_end_matches(".zip");
    let mut target = dir.join(stem);
    let mut n = 1;
    while target.exists() {
        target = dir.join(format!("{} ({})", stem, n));
        n += 1;
    }
    for (rel, data) in entries {
        let p = rel_to_abs(&target, &rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(p, data)?;
    }
    Ok(target.to_string_lossy().to_string())
}

/// 恢复到同步目录（调用方需保证期间没有同步在执行）；返回（摘要, 本机改动）
pub async fn restore_to_sync_root(cfg: &SyncConfigFile, name: &str) -> SyncResult<(String, Vec<LocalChange>)> {
    let root = PathBuf::from(cfg.sync.root_dir.trim());
    if cfg.sync.root_dir.trim().is_empty() || !root.is_dir() {
        return Err(SyncError::config("同步文件夹未设置或不存在"));
    }
    let entries = read_entries(fetch_backup(cfg, name).await?)?;
    let in_backup: std::collections::HashSet<String> = entries.iter().map(|(r, _)| super::util::pkey(r)).collect();
    let current = scan_tree(&root)?;
    let now = now_ms();
    let mut changes = Vec::new();

    // 1. 备份中没有的现有文件：移入回收站的同一个分组（可整体恢复），或删除
    let extra: Vec<String> = current
        .iter()
        .map(|f| f.rel.clone())
        .filter(|r| !is_in_trash(r) && !in_backup.contains(&super::util::pkey(r)))
        .collect();
    let mut trashed = 0;
    if !extra.is_empty() {
        if cfg.sync.trash_enabled {
            let label = format!("恢复备份前的文件 {}", chrono::Local::now().format("%Y-%m-%d %H%M%S"));
            let top = unique_rel_path(&join_rel(TRASH_DIR, &label), |p| rel_to_abs(&root, p).exists());
            for rel in &extra {
                let dest_rel = format!("{}/{}", top, rel);
                let dest = rel_to_abs(&root, &dest_rel);
                if let Some(parent) = dest.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                let src = rel_to_abs(&root, rel);
                if std::fs::rename(&src, &dest).is_ok() {
                    hint_moves(rel, &dest_rel, now);
                    changes.push(LocalChange { kind: "deleted".into(), path: src.to_string_lossy().to_string(), from: None });
                    trashed += 1;
                }
            }
            let orig = top.trim_start_matches(&format!("{}/", TRASH_DIR)).to_string();
            state::with_state(|s| {
                s.trash.insert(top.clone(), TrashItemMeta { orig, at: now, is_dir: true });
            });
        } else {
            for rel in &extra {
                let src = rel_to_abs(&root, rel);
                record_deletes(rel, now);
                #[cfg(desktop)]
                let removed = crate::fsio::trash::move_to_trash(&src).is_ok() || std::fs::remove_file(&src).is_ok();
                #[cfg(mobile)]
                let removed = std::fs::remove_file(&src).is_ok();
                if removed {
                    changes.push(LocalChange { kind: "deleted".into(), path: src.to_string_lossy().to_string(), from: None });
                    trashed += 1;
                }
            }
        }
    }

    // 2. 写回备份内容（内容相同的文件不动）
    let mut written = 0;
    for (rel, data) in &entries {
        let p = rel_to_abs(&root, rel);
        let existed = p.exists();
        if existed {
            if let Ok(cur) = std::fs::read(&p) {
                if sha256_hex(&cur) == sha256_hex(data) {
                    continue;
                }
            }
        }
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent)?;
        }
        crate::fsio::write::atomic_write(&p, data).map_err(|e| SyncError::local(format!("{}：{}", rel, e)))?;
        changes.push(LocalChange {
            kind: if existed { "modified".into() } else { "added".into() },
            path: p.to_string_lossy().to_string(),
            from: None,
        });
        written += 1;
    }

    // 3. 下次同步以本机为准，防止其他设备较新的改动把恢复结果覆盖回去
    state::with_state(|s| s.force_local = true);
    Ok((
        format!("已恢复备份：写回 {} 个文件，{} 个备份之外的文件已{}", written, trashed, if cfg.sync.trash_enabled { "移入回收站" } else { "删除" }),
        changes,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_name_round_trip() {
        let name = backup_name("我的-电脑 A", "1a2b3c4d5e6f");
        let (at, device, id) = parse_name(&name).unwrap();
        assert!(at > 0);
        assert_eq!(device, "我的_电脑_A");
        assert_eq!(id, "1a2b3c4d");
    }

    #[test]
    fn zip_round_trip_excludes_trash() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("子目录")).unwrap();
        std::fs::write(dir.path().join("子目录").join("笔记.md"), "内容").unwrap();
        std::fs::create_dir_all(dir.path().join(TRASH_DIR)).unwrap();
        std::fs::write(dir.path().join(TRASH_DIR).join("旧.md"), "x").unwrap();
        let (tmp, count) = create_zip(dir.path(), "测试").unwrap();
        assert_eq!(count, 1);
        let entries = read_entries(std::fs::read(&tmp).unwrap()).unwrap();
        let _ = std::fs::remove_file(tmp);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].0, "子目录/笔记.md");
        assert_eq!(entries[0].1, "内容".as_bytes());
    }
}
