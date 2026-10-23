// NoteBoard 文档历史记录：保留策略（纯函数）
//
//   - 近 7 天：全部保留（连续保存已由合并窗口压缩）
//   - 7 天以前：每台设备每天只保留当天最后一个版本
//   - 超过保留天数：删除（保留天数为 0 表示永久）
//   - 每个文档最多保留 MAX_ENTRIES 个版本
// 固定的版本、合并窗口中的版本与最新 KEEP_LATEST 个版本永远不会被自动清理。

use super::model::Entry;
use chrono::TimeZone;
use std::collections::HashSet;

pub const DAY_MS: i64 = 24 * 3_600_000;
pub const FULL_KEEP_DAYS: i64 = 7;
pub const MAX_ENTRIES: usize = 500;
pub const KEEP_LATEST: usize = 5;

/// 本地日期（用于「每天保留一个」）
fn local_day(ms: i64) -> String {
    match chrono::Local.timestamp_millis_opt(ms).single() {
        Some(t) => t.format("%Y-%m-%d").to_string(),
        None => (ms / DAY_MS).to_string(),
    }
}

/// 受保护（不会被自动清理）的条目下标
pub fn protected(entries: &[Entry]) -> HashSet<usize> {
    let n = entries.len();
    (0..n).filter(|&i| i + KEEP_LATEST >= n || entries[i].pinned || entries[i].open).collect()
}

/// 对单个文档应用保留策略，返回被移除的条目（entries 按时间升序）
pub fn apply(entries: &mut Vec<Entry>, now: i64, retention_days: u32) -> Vec<Entry> {
    let keep = protected(entries);
    let mut drop = vec![false; entries.len()];
    // 7 天以前：同设备同一天只保留最后一个（从新到旧扫描，第一次出现的保留）
    let mut seen_day: HashSet<(String, String)> = HashSet::new();
    for i in (0..entries.len()).rev() {
        let e = &entries[i];
        let age = now - e.at;
        if keep.contains(&i) {
            seen_day.insert((e.origin.device.clone(), local_day(e.at)));
            continue;
        }
        if retention_days > 0 && age > retention_days as i64 * DAY_MS {
            drop[i] = true;
            continue;
        }
        if age > FULL_KEEP_DAYS * DAY_MS && !seen_day.insert((e.origin.device.clone(), local_day(e.at))) {
            drop[i] = true;
        }
    }
    // 数量上限：从最旧的未保护条目开始移除
    let mut alive = drop.iter().filter(|d| !**d).count();
    for (i, d) in drop.iter_mut().enumerate() {
        if alive <= MAX_ENTRIES {
            break;
        }
        if !*d && !keep.contains(&i) {
            *d = true;
            alive -= 1;
        }
    }
    let mut removed = Vec::new();
    let mut kept = Vec::with_capacity(entries.len());
    for (e, d) in entries.drain(..).zip(drop) {
        if d { removed.push(e) } else { kept.push(e) }
    }
    *entries = kept;
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::model::{Origin, Reason};

    fn e(id: &str, at: i64) -> Entry {
        Entry {
            id: id.into(), start: at, at, hash: id.into(), size: 1, reason: Reason::Save,
            origin: Origin { device: "d".into(), name: "n".into() }, stats: None, restored_from: None, pinned: false, open: false,
        }
    }

    #[test]
    fn recent_entries_are_all_kept() {
        let now = 100 * DAY_MS;
        let mut v: Vec<Entry> = (0..20).map(|i| e(&i.to_string(), now - i * 3_600_000)).rev().collect();
        assert!(apply(&mut v, now, 90).is_empty());
        assert_eq!(v.len(), 20);
    }

    #[test]
    fn old_entries_thin_to_one_per_day_and_expire() {
        let now = 400 * DAY_MS;
        let mut v = vec![
            e("expired", now - 200 * DAY_MS),
            e("day-a1", now - 30 * DAY_MS),
            e("day-a2", now - 30 * DAY_MS + 60_000),
        ];
        for i in 0..KEEP_LATEST {
            v.push(e(&format!("new{}", i), now - i as i64));
        }
        let removed: Vec<String> = apply(&mut v, now, 90).into_iter().map(|x| x.id).collect();
        assert_eq!(removed, vec!["expired".to_string(), "day-a1".to_string()]);
        assert!(v.iter().any(|x| x.id == "day-a2"));
    }

    #[test]
    fn pinned_and_latest_survive_expiry() {
        let now = 400 * DAY_MS;
        let mut pinned = e("pinned", now - 300 * DAY_MS);
        pinned.pinned = true;
        let mut v = vec![pinned, e("old", now - 300 * DAY_MS + 1), e("last", now - 300 * DAY_MS + 2)];
        let removed = apply(&mut v, now, 30);
        // 不足 KEEP_LATEST 个时全部属于「最新」，都不会被移除
        assert!(removed.is_empty());
        assert_eq!(v.len(), 3);
    }
}
