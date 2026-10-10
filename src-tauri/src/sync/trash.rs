// NoteBoard 同步回收站（同步目录下的 .nb-trash）
//
// 启用多端同步与回收站后，应用内删除同步目录中的文件/文件夹会移入此处（保留原目录结构），
// 回收站内容同样参与同步：一端删除后其他端也移入回收站，任一端都可以恢复。
// 每个顶层条目记录原位置与删除时间，超过保留天数后自动彻底删除。

use super::state::{self, MoveHint, TrashItemMeta};
use super::types::TrashItem;
use super::util::{abs_to_rel, base_name, is_in_trash, join_rel, now_ms, pkey, rel_to_abs, unique_rel_path, TRASH_DIR};
use std::path::Path;

const DAY_MS: i64 = 24 * 3600 * 1000;

/// 为基线中位于 `from` 之下（含自身）的文件登记改名线索：新路径 → 原 ID
pub fn hint_moves(from_rel: &str, to_rel: &str, at: i64) {
    let from_key = pkey(from_rel);
    let prefix = format!("{}/", from_key);
    state::with_state(|s| {
        let mut new_hints = Vec::new();
        for (id, b) in s.entries.iter() {
            let key = pkey(&b.rec.path);
            if key == from_key || key.starts_with(&prefix) {
                // 按字节截取后缀（大小写折叠改变长度的极端情况直接跳过）
                if let Some(suffix) = b.rec.path.get(from_rel.len()..) {
                    new_hints.push((format!("{}{}", to_rel, suffix), MoveHint { id: id.clone(), at }));
                }
            }
        }
        // 已有线索（连续改名）跟随移动
        let moved: Vec<(String, MoveHint)> = s
            .hints
            .iter()
            .filter(|(p, _)| {
                let k = pkey(p);
                k == from_key || k.starts_with(&prefix)
            })
            .filter_map(|(p, h)| p.get(from_rel.len()..).map(|suffix| (format!("{}{}", to_rel, suffix), h.clone())))
            .collect();
        s.hints.retain(|p, _| {
            let k = pkey(p);
            !(k == from_key || k.starts_with(&prefix))
        });
        for (p, h) in moved {
            s.hints.insert(p, MoveHint { id: h.id, at });
        }
        for (p, h) in new_hints {
            s.hints.insert(p, h);
        }
        // 回收站元数据随条目改名
        if let Some(meta) = s.trash.remove(from_rel) {
            if is_in_trash(to_rel) {
                s.trash.insert(to_rel.to_string(), meta);
            }
        }
    });
}

/// 记录基线中位于 `rel` 之下文件的删除时间（未启用回收站时的应用内删除）
pub fn record_deletes(rel: &str, at: i64) {
    let key = pkey(rel);
    let prefix = format!("{}/", key);
    state::with_state(|s| {
        let paths: Vec<String> = s
            .entries
            .values()
            .map(|b| b.rec.path.clone())
            .filter(|p| {
                let k = pkey(p);
                k == key || k.starts_with(&prefix)
            })
            .collect();
        for p in paths {
            s.deletes.insert(p, at);
        }
    });
}

/// 把同步目录中的文件/文件夹移入同步回收站；返回回收站中的新位置
pub fn move_into_trash(root: &Path, target: &Path) -> Result<String, String> {
    let rel = abs_to_rel(root, target).ok_or("文件不在同步目录中")?;
    if rel.is_empty() || is_in_trash(&rel) {
        return Err("不能将同步目录本身或回收站内容移入回收站".to_string());
    }
    let is_dir = target.is_dir();
    let trash_root = root.join(TRASH_DIR);
    std::fs::create_dir_all(&trash_root).map_err(|e| format!("创建回收站目录失败：{}", e))?;
    let candidate = join_rel(TRASH_DIR, &base_name(&rel));
    let top = unique_rel_path(&candidate, |p| rel_to_abs(root, p).exists());
    std::fs::rename(target, rel_to_abs(root, &top)).map_err(|e| format!("移入回收站失败：{}", e))?;
    let at = now_ms();
    hint_moves(&rel, &top, at);
    state::with_state(|s| {
        s.trash.insert(top.clone(), TrashItemMeta { orig: rel.clone(), at, is_dir });
    });
    Ok(top)
}

/// 统计目录大小与文件数
fn dir_stats(p: &Path) -> (u64, u32) {
    if p.is_file() {
        return (std::fs::metadata(p).map(|m| m.len()).unwrap_or(0), 1);
    }
    let mut size = 0;
    let mut count = 0;
    let mut stack = vec![p.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let Ok(meta) = e.metadata() else { continue };
            if meta.is_dir() {
                stack.push(e.path());
            } else {
                size += meta.len();
                count += 1;
            }
        }
    }
    (size, count)
}

/// 列出回收站顶层条目（按删除时间倒序）
pub fn list_items(root: &Path, days: u32, trash_enabled: bool) -> Vec<TrashItem> {
    let trash_root = root.join(TRASH_DIR);
    let Ok(rd) = std::fs::read_dir(&trash_root) else { return Vec::new() };
    let snapshot = state::snapshot();
    let mut items = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let id = join_rel(TRASH_DIR, &name);
        let path = e.path();
        let meta = snapshot.trash.get(&id).cloned().unwrap_or_else(|| TrashItemMeta {
            orig: name.clone(),
            at: e.metadata().map(|m| super::util::mtime_ms(&m)).unwrap_or_else(|_| now_ms()),
            is_dir: path.is_dir(),
        });
        let (size, file_count) = dir_stats(&path);
        items.push(TrashItem {
            id,
            name,
            is_dir: path.is_dir(),
            orig_path: meta.orig,
            trashed_at: meta.at,
            expires_at: if days > 0 && trash_enabled { meta.at + days as i64 * DAY_MS } else { 0 },
            size,
            file_count,
        });
    }
    items.sort_by_key(|item| std::cmp::Reverse(item.trashed_at));
    items
}

/// 校验并解析回收站条目 ID（只接受 .nb-trash/<名称> 形式，防止越界访问）
fn item_path(root: &Path, id: &str) -> Result<std::path::PathBuf, String> {
    let name = id.strip_prefix(&format!("{}/", TRASH_DIR)).ok_or("无效的回收站条目")?;
    if name.is_empty() || name.contains('/') || name.contains('\\') || name == ".." || name == "." {
        return Err("无效的回收站条目".to_string());
    }
    let p = rel_to_abs(root, id);
    if !p.exists() {
        return Err("回收站中已不存在该条目（可能已被其他设备恢复或清理）".to_string());
    }
    Ok(p)
}

/// 恢复条目到原位置；原位置已有同名文件时自动追加序号。返回恢复后的绝对路径
pub fn restore(root: &Path, id: &str) -> Result<String, String> {
    let src = item_path(root, id)?;
    let meta = state::snapshot().trash.get(id).cloned();
    let orig = meta
        .map(|m| m.orig)
        .filter(|o| !o.is_empty() && !is_in_trash(o))
        .unwrap_or_else(|| base_name(id));
    let dest_rel = unique_rel_path(&orig, |p| rel_to_abs(root, p).exists());
    let dest = rel_to_abs(root, &dest_rel);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建原目录失败：{}", e))?;
    }
    std::fs::rename(&src, &dest).map_err(|e| format!("恢复失败：{}", e))?;
    hint_moves(id, &dest_rel, now_ms());
    state::with_state(|s| {
        s.trash.remove(id);
    });
    Ok(dest.to_string_lossy().to_string())
}

/// 彻底删除单个条目
pub fn delete_item(root: &Path, id: &str) -> Result<(), String> {
    let p = item_path(root, id)?;
    record_deletes(id, now_ms());
    let result = if p.is_dir() { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
    result.map_err(|e| format!("彻底删除失败：{}", e))?;
    state::with_state(|s| {
        s.trash.remove(id);
    });
    Ok(())
}

/// 清空回收站
pub fn empty(root: &Path) -> Result<u32, String> {
    let items = list_items(root, 0, false);
    let mut n = 0;
    for item in items {
        delete_item(root, &item.id)?;
        n += 1;
    }
    Ok(n)
}

/// 清理超过保留天数的条目；返回清理数量
pub fn purge_expired(root: &Path, days: u32) -> u32 {
    if days == 0 {
        return 0;
    }
    let now = now_ms();
    let expired: Vec<String> = state::snapshot()
        .trash
        .iter()
        .filter(|(_, m)| m.at + days as i64 * DAY_MS < now)
        .map(|(k, _)| k.clone())
        .collect();
    let mut n = 0;
    for id in expired {
        let p = rel_to_abs(root, &id);
        if !p.exists() {
            state::with_state(|s| {
                s.trash.remove(&id);
            });
            continue;
        }
        if delete_item(root, &id).is_ok() {
            n += 1;
        }
    }
    n
}
