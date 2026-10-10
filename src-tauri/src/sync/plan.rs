// NoteBoard 同步决策（纯函数，不做任何 I/O，便于单元测试）
//
// 输入：本地基线（上次同步成功时的状态）、本机扫描结果、远端清单
// 输出：每个文件 ID 的目标状态——存活（内容来自本机/远端/行级合并）、删除、或无需处理
//
// 决策规则：
//   1. 只有一方相对基线有变化 → 采用变化方
//   2. 双方都有变化（同时修改/删除）→ 字段级处理：
//        内容：一方未改则取另一方；双方都改 → 可行级合并的文本做三方合并（重叠处取较新），否则取较新一方
//        位置：一方未动则取另一方；双方都动 → 取较新一方
//        删除 vs 修改：比较删除时间与修改时间，较新者胜（删除胜出且启用回收站时，修改后的内容进入回收站）
//   3. 启用回收站时，本机在应用外被删除的文件同样移入同步回收站（内容从远端取回），其他端随之移入回收站
//   4. 恢复备份后的首次同步以本机为准（force_local）

use super::manifest::{Entry, FileRec, Manifest, TrashInfo};
use super::state::{BaseRec, LocalState, TrashItemMeta};
use super::util::{base_name, is_in_trash, join_rel, parent_rel, pkey, trash_top, unique_rel_path, TRASH_DIR};
use std::collections::{BTreeMap, HashMap, HashSet};

/// 扫描到的本地文件
#[derive(Debug, Clone)]
pub struct ScannedFile {
    pub rel: String,
    pub size: u64,
    pub mtime: i64,
}

/// 本地存活文件（含文件系统大小/时间，用于应用变更前的并发修改校验）
#[derive(Debug, Clone)]
pub struct LiveLocal {
    pub rec: FileRec,
    pub fsize: u64,
    pub fmtime: i64,
}

#[derive(Debug, Clone)]
pub enum LocalSide {
    Live(LiveLocal),
    /// 已删除（删除时间）
    Gone(i64),
}

/// 本机视图：已知 ID 的文件状态 + 尚未分配 ID 的新文件
#[derive(Debug, Default)]
pub struct LocalView {
    pub by_id: HashMap<String, LocalSide>,
    pub new_files: Vec<LiveLocal>,
    /// 扫描中为回收站内无记录的条目补充的元数据
    pub trash_added: Vec<(String, TrashItemMeta)>,
    pub errors: Vec<String>,
}

/// 计算回收站内文件的回收信息
fn trash_info_for(rel: &str, trash: &BTreeMap<String, TrashItemMeta>, added: &mut Vec<(String, TrashItemMeta)>, now: i64) -> Option<TrashInfo> {
    let (top, inner) = trash_top(rel)?;
    let meta = match trash.get(&top).or_else(|| added.iter().find(|(k, _)| *k == top).map(|(_, m)| m)) {
        Some(m) => m.clone(),
        None => {
            // 回收站里出现无记录的条目（例如用户手动放入）：按当前时间开始计算保留期
            let m = TrashItemMeta {
                orig: top.trim_start_matches(&format!("{}/", TRASH_DIR)).to_string(),
                at: now,
                is_dir: !inner.is_empty(),
            };
            added.push((top.clone(), m.clone()));
            m
        }
    };
    Some(TrashInfo {
        orig: if inner.is_empty() { meta.orig.clone() } else { join_rel(&meta.orig, &inner) },
        at: meta.at,
    })
}

/// 由扫描结果构建本机视图：识别应用内改名线索、按内容哈希识别应用外改名、计算删除时间
pub fn build_local_view(
    scanned: &[ScannedFile],
    state: &LocalState,
    now: i64,
    mut hash_of: impl FnMut(&str) -> Result<String, String>,
) -> LocalView {
    let mut view = LocalView::default();
    let base_by_path: HashMap<String, &String> = state.entries.iter().map(|(id, b)| (pkey(&b.rec.path), id)).collect();
    let hints_by_path: HashMap<String, &super::state::MoveHint> = state.hints.iter().map(|(p, h)| (pkey(p), h)).collect();
    let mut claimed: HashSet<String> = HashSet::new();
    let mut assignments: Vec<(usize, Option<String>, Option<i64>)> = Vec::with_capacity(scanned.len());

    // 第一轮：应用内改名线索优先认领 ID
    for (i, f) in scanned.iter().enumerate() {
        let key = pkey(&f.rel);
        if let Some(h) = hints_by_path.get(&key) {
            if state.entries.contains_key(&h.id) && !claimed.contains(&h.id) {
                claimed.insert(h.id.clone());
                assignments.push((i, Some(h.id.clone()), Some(h.at)));
                continue;
            }
        }
        assignments.push((i, None, None));
    }
    // 第二轮：路径未变的文件沿用基线 ID
    for a in assignments.iter_mut() {
        if a.1.is_some() {
            continue;
        }
        if let Some(id) = base_by_path.get(&pkey(&scanned[a.0].rel)) {
            if !claimed.contains(*id) {
                claimed.insert((*id).clone());
                a.1 = Some((*id).clone());
            }
        }
    }

    let mut unknown: Vec<LiveLocal> = Vec::new();
    for (i, id, hint_at) in assignments {
        let f = &scanned[i];
        let base = id.as_ref().and_then(|id| state.entries.get(id));
        // 大小与修改时间均未变 → 沿用基线哈希，避免重复读取大文件
        let hash = match base {
            Some(b) if b.fsize == f.size && b.fmtime == f.mtime => b.rec.hash.clone(),
            _ => match hash_of(&f.rel) {
                Ok(h) => h,
                Err(e) => {
                    view.errors.push(format!("{}：{}", f.rel, e));
                    // 读不到的文件本轮不参与同步（保持基线不动）
                    if let Some(id) = &id {
                        if let Some(b) = state.entries.get(id) {
                            view.by_id.insert(
                                id.clone(),
                                LocalSide::Live(LiveLocal { rec: b.rec.clone(), fsize: b.fsize, fmtime: b.fmtime }),
                            );
                        }
                    }
                    continue;
                }
            },
        };
        let trash = trash_info_for(&f.rel, &state.trash, &mut view.trash_added, now);
        let mut rec = FileRec { path: f.rel.clone(), hash, size: f.size, mtime: f.mtime, ltime: hint_at.unwrap_or(now), trash };
        if let Some(b) = base {
            if b.rec.hash == rec.hash {
                rec.mtime = b.rec.mtime;
            }
            if b.rec.same_location(&rec) {
                rec.ltime = b.rec.ltime;
            }
        }
        let live = LiveLocal { rec, fsize: f.size, fmtime: f.mtime };
        match id {
            Some(id) => {
                view.by_id.insert(id, LocalSide::Live(live));
            }
            None => unknown.push(live),
        }
    }

    // 基线中未被认领的 ID：可能是应用外改名（内容相同）或删除
    let mut missing: Vec<&String> = state.entries.keys().filter(|id| !claimed.contains(*id) && !view.by_id.contains_key(*id)).collect();
    missing.sort();
    for live in unknown {
        let candidate = missing
            .iter()
            .enumerate()
            .filter(|(_, id)| state.entries[**id].rec.hash == live.rec.hash)
            // 同名优先（移动目录），其次任意同内容文件
            .max_by_key(|(_, id)| base_name(&state.entries[**id].rec.path) == base_name(&live.rec.path))
            .map(|(i, _)| i);
        match candidate {
            Some(i) => {
                let id = missing.remove(i).clone();
                let b = &state.entries[&id];
                let mut rec = live.rec.clone();
                rec.mtime = b.rec.mtime;
                view.by_id.insert(id, LocalSide::Live(LiveLocal { rec, ..live }));
            }
            None => view.new_files.push(live),
        }
    }
    for id in missing {
        let b = &state.entries[id];
        // 应用内删除记录了确切时间；应用外删除只能确定发生在上次扫描之后，取最早可能时间（更倾向保留修改）
        let at = state
            .deletes
            .iter()
            .find(|(p, _)| pkey(p) == pkey(&b.rec.path))
            .map(|(_, t)| *t)
            .unwrap_or_else(|| state.last_scan_at.max(b.rec.ltime).min(now));
        view.by_id.insert(id.clone(), LocalSide::Gone(at));
    }
    view
}

/// 目标内容来源
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    Local,
    Remote,
    /// 行级三方合并；合并失败时按 prefer_local 取整份
    Merge { prefer_local: bool },
}

#[derive(Debug, Clone, PartialEq)]
pub enum Target {
    /// 双方都未变化
    Keep,
    Live { rec: FileRec, src: Source },
    Deleted { at: i64 },
    /// 无需记录（例如双方都不存在）
    Forget,
}

#[derive(Debug, Clone)]
pub struct PlanItem {
    pub id: String,
    pub base: Option<FileRec>,
    pub local: Option<LocalSide>,
    pub remote: Option<Entry>,
    pub target: Target,
    /// 双方同时改动且无法同时保留（取较新一方）
    pub conflict: bool,
}

#[derive(Debug, Default)]
pub struct Plan {
    pub items: Vec<PlanItem>,
    /// 本次决策新增的回收站顶层条目
    pub trash_added: Vec<(String, TrashItemMeta)>,
}

pub struct PlanOptions<'a> {
    pub now: i64,
    pub trash_enabled: bool,
    pub force_local: bool,
    /// 本机目录是否存在（相对路径），用于把应用外删除的整个目录作为一个回收站条目
    pub dir_exists: &'a dyn Fn(&str) -> bool,
}

#[derive(Debug, Clone)]
enum Side {
    Live(FileRec),
    Gone(i64),
    Absent,
}

fn changed(side: &Side, base: &FileRec) -> bool {
    match side {
        Side::Live(r) => r.hash != base.hash || !r.same_location(base),
        _ => true,
    }
}

/// 相对基线最近一次变化的时间
fn change_time(r: &FileRec, base: &FileRec) -> i64 {
    let mut t = i64::MIN;
    if r.hash != base.hash {
        t = t.max(r.mtime);
    }
    if !r.same_location(base) {
        t = t.max(r.ltime);
    }
    t
}

/// 回收站命名与分组上下文
struct TrashCtx<'a> {
    taken: HashSet<String>,
    groups: HashMap<String, String>,
    added: Vec<(String, TrashItemMeta)>,
    opts: &'a PlanOptions<'a>,
}

impl TrashCtx<'_> {
    /// 计算把文件移入回收站后的记录：应用外删除整个目录时，以最高一级消失的目录作为一个条目
    fn trashed(&mut self, rec: &FileRec, at: i64) -> FileRec {
        let path = &rec.path;
        let mut group = path.clone();
        let mut dir = parent_rel(path);
        while !dir.is_empty() && !(self.opts.dir_exists)(&dir) {
            group = dir.clone();
            dir = parent_rel(&dir);
        }
        let is_dir = group != *path;
        let top = match self.groups.get(&pkey(&group)) {
            Some(t) => t.clone(),
            None => {
                let candidate = join_rel(TRASH_DIR, &base_name(&group));
                let taken = &self.taken;
                let top = unique_rel_path(&candidate, |p| taken.contains(&pkey(p)));
                self.taken.insert(pkey(&top));
                self.groups.insert(pkey(&group), top.clone());
                self.added.push((top.clone(), TrashItemMeta { orig: group.clone(), at, is_dir }));
                top
            }
        };
        let inner = if is_dir { path[group.len() + 1..].to_string() } else { String::new() };
        FileRec {
            path: if inner.is_empty() { top } else { join_rel(&top, &inner) },
            hash: rec.hash.clone(),
            size: rec.size,
            mtime: rec.mtime,
            ltime: at,
            trash: Some(TrashInfo { orig: path.clone(), at }),
        }
    }
}

/// 生成同步计划
pub fn plan(state: &LocalState, view: LocalView, manifest: &Manifest, opts: &PlanOptions, new_id: &mut dyn FnMut() -> String) -> Plan {
    let base = &state.entries;
    let mut by_id = view.by_id;

    // 新文件：与远端「本机基线未知」的同路径文件配对（首次同步两端已有同名文件），否则分配新 ID
    let remote_unpaired: HashMap<String, &String> = manifest
        .entries
        .iter()
        .filter(|(id, e)| e.is_live() && !base.contains_key(*id) && !by_id.contains_key(*id))
        .map(|(id, e)| (pkey(&e.rec.path), id))
        .collect();
    let mut used: HashSet<String> = HashSet::new();
    for live in view.new_files {
        let id = match remote_unpaired.get(&pkey(&live.rec.path)) {
            Some(id) if !used.contains(*id) => (*id).clone(),
            _ => new_id(),
        };
        used.insert(id.clone());
        by_id.insert(id, LocalSide::Live(live));
    }

    let mut taken: HashSet<String> = HashSet::new();
    for k in state.trash.keys() {
        taken.insert(pkey(k));
    }
    for side in by_id.values() {
        if let LocalSide::Live(l) = side {
            if let Some((top, _)) = trash_top(&l.rec.path) {
                taken.insert(pkey(&top));
            }
        }
    }
    for e in manifest.entries.values().filter(|e| e.is_live()) {
        if let Some((top, _)) = trash_top(&e.rec.path) {
            taken.insert(pkey(&top));
        }
    }
    let mut tctx = TrashCtx { taken, groups: HashMap::new(), added: view.trash_added, opts };

    let mut ids: Vec<String> = base.keys().cloned().collect();
    ids.extend(by_id.keys().cloned());
    ids.extend(manifest.entries.keys().cloned());
    ids.sort();
    ids.dedup();

    let mut items = Vec::new();
    for id in ids {
        let b: Option<&BaseRec> = base.get(&id);
        let local = by_id.get(&id).cloned();
        let remote = manifest.entries.get(&id).cloned();
        let l = match &local {
            Some(LocalSide::Live(x)) => Side::Live(x.rec.clone()),
            Some(LocalSide::Gone(t)) => Side::Gone(*t),
            None => Side::Absent,
        };
        let r = match &remote {
            Some(e) if e.is_live() => Side::Live(e.rec.clone()),
            Some(e) => Side::Gone(e.deleted.unwrap_or(0)),
            None => Side::Absent,
        };
        let (target, conflict) = decide(b.map(|x| &x.rec), l, r, opts, &mut tctx);
        items.push(PlanItem { id, base: b.map(|x| x.rec.clone()), local, remote, target, conflict });
    }

    resolve_path_collisions(&mut items, opts.now);
    Plan { items, trash_added: tctx.added }
}

fn decide(b: Option<&FileRec>, l: Side, r: Side, o: &PlanOptions, t: &mut TrashCtx) -> (Target, bool) {
    let Some(b) = b else {
        // 本机基线没有该文件
        return match (l, r) {
            (Side::Live(lr), Side::Live(rr)) => {
                if lr.hash == rr.hash {
                    let rec = if lr.same_location(&rr) || lr.ltime >= rr.ltime { lr } else { rr };
                    (Target::Live { rec, src: Source::Local }, false)
                } else if o.force_local || lr.mtime >= rr.mtime {
                    (Target::Live { rec: lr, src: Source::Local }, !o.force_local)
                } else {
                    (Target::Live { rec: rr, src: Source::Remote }, true)
                }
            }
            (Side::Live(lr), _) => (Target::Live { rec: lr, src: Source::Local }, false),
            (_, Side::Live(rr)) => {
                if o.force_local {
                    // 恢复备份后：本机快照之外的远端新文件移入回收站（可恢复），或直接删除
                    if o.trash_enabled && rr.trash.is_none() {
                        (Target::Live { rec: t.trashed(&rr, o.now), src: Source::Remote }, false)
                    } else {
                        (Target::Deleted { at: o.now }, false)
                    }
                } else {
                    (Target::Live { rec: rr, src: Source::Remote }, false)
                }
            }
            _ => (Target::Forget, false),
        };
    };

    // 远端清单中没有该 ID（远端数据被重建、或墓碑已过期）：无法确认远端删除过，
    // 为避免误删本机文件，以本机状态为准重新上传
    if matches!(r, Side::Absent) {
        return match l {
            Side::Live(lr) => (Target::Live { rec: lr, src: Source::Local }, false),
            _ => (Target::Forget, false),
        };
    }
    let l = match l {
        Side::Absent => Side::Gone(o.now),
        other => other,
    };

    // 本机删除：启用回收站且远端仍有内容时，改为移入回收站
    let local_delete = |at: i64, remote_live: Option<&FileRec>, t: &mut TrashCtx| -> Target {
        match remote_live {
            Some(rr) if o.trash_enabled && rr.trash.is_none() && b.trash.is_none() => {
                Target::Live { rec: t.trashed(rr, at), src: Source::Remote }
            }
            _ => Target::Deleted { at },
        }
    };

    if o.force_local {
        return match l {
            Side::Live(lr) => (Target::Live { rec: lr, src: Source::Local }, false),
            Side::Gone(at) => (Target::Deleted { at }, false),
            Side::Absent => unreachable!(),
        };
    }

    let lc = changed(&l, b);
    let rc = changed(&r, b);
    match (lc, rc) {
        (false, false) => (Target::Keep, false),
        (true, false) => match l {
            Side::Live(lr) => (Target::Live { rec: lr, src: Source::Local }, false),
            Side::Gone(at) => {
                let rl = match &r {
                    Side::Live(rr) => Some(rr.clone()),
                    _ => None,
                };
                (local_delete(at, rl.as_ref(), t), false)
            }
            Side::Absent => unreachable!(),
        },
        (false, true) => match r {
            Side::Live(rr) => (Target::Live { rec: rr, src: Source::Remote }, false),
            Side::Gone(at) => (Target::Deleted { at }, false),
            Side::Absent => unreachable!(),
        },
        (true, true) => match (l, r) {
            (Side::Gone(a), Side::Gone(c)) => (Target::Deleted { at: a.max(c) }, false),
            (Side::Gone(at), Side::Live(rr)) => {
                if change_time(&rr, b) > at {
                    (Target::Live { rec: rr, src: Source::Remote }, true)
                } else {
                    (local_delete(at, Some(&rr), t), true)
                }
            }
            (Side::Live(lr), Side::Gone(at)) => {
                if change_time(&lr, b) > at {
                    (Target::Live { rec: lr, src: Source::Local }, true)
                } else {
                    (Target::Deleted { at }, true)
                }
            }
            (Side::Live(lr), Side::Live(rr)) => both_live(b, lr, rr),
            _ => unreachable!(),
        },
    }
}

/// 双方都存活且都有变化：内容与位置分别处理
fn both_live(b: &FileRec, lr: FileRec, rr: FileRec) -> (Target, bool) {
    let mut conflict = false;
    // 内容
    let (content_rec, src) = if lr.hash == rr.hash {
        (&lr, Source::Local)
    } else if lr.hash == b.hash {
        (&rr, Source::Remote)
    } else if rr.hash == b.hash {
        (&lr, Source::Local)
    } else {
        let prefer_local = lr.mtime >= rr.mtime;
        (if prefer_local { &lr } else { &rr }, Source::Merge { prefer_local })
    };
    // 位置
    let mut loc = if lr.same_location(&rr) || rr.same_location(b) {
        &lr
    } else if lr.same_location(b) {
        &rr
    } else {
        conflict = true;
        if lr.ltime >= rr.ltime { &lr } else { &rr }
    };
    // 一端移入回收站、另一端在删除之后修改了内容 → 修改更新，文件留在（或回到）修改方的位置
    if let Some(tr) = &loc.trash {
        if b.trash.is_none() {
            let other = if std::ptr::eq(loc, &lr) { &rr } else { &lr };
            if other.hash != b.hash && other.mtime > tr.at && other.trash.is_none() {
                loc = other;
                conflict = true;
            }
        }
    }
    let rec = FileRec {
        path: loc.path.clone(),
        trash: loc.trash.clone(),
        ltime: loc.ltime,
        hash: content_rec.hash.clone(),
        size: content_rec.size,
        mtime: lr.mtime.max(rr.mtime).max(content_rec.mtime),
    };
    let rec = if matches!(src, Source::Merge { .. }) { rec } else { FileRec { mtime: content_rec.mtime, ..rec } };
    (Target::Live { rec, src }, conflict)
}

/// 两个文件的目标路径相同（例如两端各自新建了同名文件、改名撞名）：保留一个，其余追加序号
fn resolve_path_collisions(items: &mut [PlanItem], now: i64) {
    let mut owners: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (i, it) in items.iter().enumerate() {
        let path = match &it.target {
            Target::Live { rec, .. } => Some(rec.path.clone()),
            Target::Keep => it.base.as_ref().map(|b| b.path.clone()),
            _ => None,
        };
        if let Some(p) = path {
            owners.entry(pkey(&p)).or_default().push(i);
        }
    }
    let mut taken: HashSet<String> = owners.keys().cloned().collect();
    for (_, idxs) in owners.into_iter().filter(|(_, v)| v.len() > 1) {
        // 路径保持不变（未移动）的文件优先保留原名
        let keep = idxs
            .iter()
            .copied()
            .find(|&i| match (&items[i].target, &items[i].local) {
                (Target::Keep, _) => true,
                (Target::Live { rec, .. }, Some(LocalSide::Live(l))) => l.rec.path == rec.path,
                _ => false,
            })
            .unwrap_or(idxs[0]);
        for i in idxs.into_iter().filter(|&i| i != keep) {
            let item = &mut items[i];
            let current = match &item.target {
                Target::Live { rec, src } => (rec.clone(), src.clone()),
                Target::Keep => {
                    let b = item.base.clone().expect("keep has base");
                    let src = Source::Local;
                    (b, src)
                }
                _ => continue,
            };
            let (mut rec, src) = current;
            let new_path = unique_rel_path(&rec.path, |p| taken.contains(&pkey(p)));
            taken.insert(pkey(&new_path));
            rec.path = new_path;
            rec.ltime = now;
            item.target = Target::Live { rec, src };
        }
    }
}

/// 某个 ID 是否位于回收站（显示统计用）
pub fn rec_visible(rec: &FileRec) -> bool {
    !is_in_trash(&rec.path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::manifest::Entry;

    fn rec(path: &str, hash: &str, mtime: i64) -> FileRec {
        FileRec { path: path.into(), hash: hash.into(), size: 1, mtime, ltime: 0, trash: None }
    }

    fn base_state(entries: &[(&str, FileRec)]) -> LocalState {
        let mut s = LocalState::default();
        for (id, r) in entries {
            s.entries.insert((*id).into(), BaseRec { rec: r.clone(), fsize: 1, fmtime: r.mtime });
        }
        s.last_scan_at = 100;
        s
    }

    fn manifest(entries: &[(&str, FileRec, Option<i64>)]) -> Manifest {
        let mut m = Manifest::default();
        for (id, r, del) in entries {
            m.entries.insert((*id).into(), Entry { rec: r.clone(), deleted: *del, device: "other".into() });
        }
        m
    }

    fn run(state: &LocalState, files: &[(&str, &str, i64)], m: &Manifest, trash: bool) -> Plan {
        let scanned: Vec<ScannedFile> = files.iter().map(|(p, _, t)| ScannedFile { rel: (*p).into(), size: 1, mtime: *t }).collect();
        let hashes: HashMap<String, String> = files.iter().map(|(p, h, _)| ((*p).to_string(), (*h).to_string())).collect();
        let view = build_local_view(&scanned, state, 1000, |p| Ok(hashes[p].clone()));
        let exists = |_: &str| true;
        let opts = PlanOptions { now: 1000, trash_enabled: trash, force_local: false, dir_exists: &exists };
        let mut n = 0;
        plan(state, view, m, &opts, &mut || {
            n += 1;
            format!("new{}", n)
        })
    }

    fn target_of<'a>(p: &'a Plan, id: &str) -> &'a Target {
        &p.items.iter().find(|i| i.id == id).unwrap().target
    }

    #[test]
    fn unchanged_files_are_kept() {
        let s = base_state(&[("a", rec("a.md", "h1", 10))]);
        let m = manifest(&[("a", rec("a.md", "h1", 10), None)]);
        let p = run(&s, &[("a.md", "h1", 10)], &m, true);
        assert_eq!(target_of(&p, "a"), &Target::Keep);
    }

    #[test]
    fn local_edit_is_uploaded() {
        let s = base_state(&[("a", rec("a.md", "h1", 10))]);
        let m = manifest(&[("a", rec("a.md", "h1", 10), None)]);
        let p = run(&s, &[("a.md", "h2", 50)], &m, true);
        match target_of(&p, "a") {
            Target::Live { rec, src } => {
                assert_eq!(rec.hash, "h2");
                assert_eq!(*src, Source::Local);
            }
            t => panic!("{:?}", t),
        }
    }

    #[test]
    fn remote_rename_keeps_identity() {
        let s = base_state(&[("a", rec("a.md", "h1", 10))]);
        let mut moved = rec("目录/b.md", "h1", 10);
        moved.ltime = 200;
        let m = manifest(&[("a", moved, None)]);
        let p = run(&s, &[("a.md", "h1", 10)], &m, true);
        match target_of(&p, "a") {
            Target::Live { rec, src } => {
                assert_eq!(rec.path, "目录/b.md");
                assert_eq!(*src, Source::Remote);
            }
            t => panic!("{:?}", t),
        }
    }

    #[test]
    fn external_local_rename_detected_by_hash() {
        let s = base_state(&[("a", rec("a.md", "h1", 10))]);
        let m = manifest(&[("a", rec("a.md", "h1", 10), None)]);
        let p = run(&s, &[("新名字.md", "h1", 10)], &m, true);
        assert_eq!(p.items.len(), 1);
        match target_of(&p, "a") {
            Target::Live { rec, src } => {
                assert_eq!(rec.path, "新名字.md");
                assert_eq!(*src, Source::Local);
            }
            t => panic!("{:?}", t),
        }
    }

    #[test]
    fn both_edited_text_is_merged_and_newer_preferred() {
        let s = base_state(&[("a", rec("a.md", "h1", 10))]);
        let m = manifest(&[("a", rec("a.md", "h3", 80), None)]);
        let p = run(&s, &[("a.md", "h2", 50)], &m, true);
        match target_of(&p, "a") {
            Target::Live { src, .. } => assert_eq!(*src, Source::Merge { prefer_local: false }),
            t => panic!("{:?}", t),
        }
    }

    #[test]
    fn local_delete_moves_to_trash_everywhere() {
        let s = base_state(&[("a", rec("docs/a.md", "h1", 10))]);
        let m = manifest(&[("a", rec("docs/a.md", "h1", 10), None)]);
        let p = run(&s, &[], &m, true);
        match target_of(&p, "a") {
            Target::Live { rec, src } => {
                assert_eq!(rec.path, ".nb-trash/a.md");
                assert_eq!(rec.trash.as_ref().unwrap().orig, "docs/a.md");
                assert_eq!(*src, Source::Remote);
            }
            t => panic!("{:?}", t),
        }
        assert_eq!(p.trash_added.len(), 1);
    }

    #[test]
    fn local_delete_without_trash_deletes_remote() {
        let s = base_state(&[("a", rec("a.md", "h1", 10))]);
        let m = manifest(&[("a", rec("a.md", "h1", 10), None)]);
        let p = run(&s, &[], &m, false);
        assert!(matches!(target_of(&p, "a"), Target::Deleted { .. }));
    }

    #[test]
    fn remote_edit_newer_than_local_delete_wins() {
        let s = base_state(&[("a", rec("a.md", "h1", 10))]);
        // 本机在扫描时间 100 之后删除（未知确切时间取 last_scan_at=100），远端在 500 修改
        let m = manifest(&[("a", rec("a.md", "h2", 500), None)]);
        let p = run(&s, &[], &m, false);
        match target_of(&p, "a") {
            Target::Live { rec, src } => {
                assert_eq!(rec.hash, "h2");
                assert_eq!(*src, Source::Remote);
            }
            t => panic!("{:?}", t),
        }
    }

    #[test]
    fn remote_delete_newer_than_local_edit_wins() {
        let s = base_state(&[("a", rec("a.md", "h1", 10))]);
        let m = manifest(&[("a", rec("a.md", "", 10), Some(900))]);
        let p = run(&s, &[("a.md", "h2", 50)], &m, false);
        assert!(matches!(target_of(&p, "a"), Target::Deleted { at: 900 }));
    }

    #[test]
    fn edit_after_remote_trash_restores_file() {
        let s = base_state(&[("a", rec("a.md", "h1", 10))]);
        let mut trashed = rec(".nb-trash/a.md", "h1", 10);
        trashed.trash = Some(TrashInfo { orig: "a.md".into(), at: 300 });
        trashed.ltime = 300;
        let m = manifest(&[("a", trashed, None)]);
        let p = run(&s, &[("a.md", "h2", 600)], &m, true);
        match target_of(&p, "a") {
            Target::Live { rec, .. } => {
                assert_eq!(rec.path, "a.md");
                assert!(rec.trash.is_none());
                assert_eq!(rec.hash, "h2");
            }
            t => panic!("{:?}", t),
        }
    }

    #[test]
    fn edit_before_remote_trash_goes_into_trash_with_edits() {
        let s = base_state(&[("a", rec("a.md", "h1", 10))]);
        let mut trashed = rec(".nb-trash/a.md", "h1", 10);
        trashed.trash = Some(TrashInfo { orig: "a.md".into(), at: 900 });
        trashed.ltime = 900;
        let m = manifest(&[("a", trashed, None)]);
        let p = run(&s, &[("a.md", "h2", 600)], &m, true);
        match target_of(&p, "a") {
            Target::Live { rec, src } => {
                assert_eq!(rec.path, ".nb-trash/a.md");
                assert_eq!(rec.hash, "h2");
                assert_eq!(*src, Source::Local);
            }
            t => panic!("{:?}", t),
        }
    }

    #[test]
    fn first_sync_pairs_same_path_and_renames_collisions() {
        let s = LocalState::default();
        let m = manifest(&[("r1", rec("同名.md", "hr", 10), None), ("r2", rec("远端.md", "hx", 10), None)]);
        let p = run(&s, &[("同名.md", "hl", 50), ("本机.md", "hy", 5)], &m, true);
        // 同名文件配对为同一 ID，本机较新胜出
        match target_of(&p, "r1") {
            Target::Live { rec, src } => {
                assert_eq!(rec.hash, "hl");
                assert_eq!(*src, Source::Local);
            }
            t => panic!("{:?}", t),
        }
        assert!(matches!(target_of(&p, "r2"), Target::Live { src: Source::Remote, .. }));
        assert!(matches!(target_of(&p, "new1"), Target::Live { src: Source::Local, .. }));
    }

    #[test]
    fn new_files_with_same_name_get_suffix() {
        let s = base_state(&[]);
        let m = manifest(&[("r1", rec("x.md", "h1", 10), None)]);
        // 本机已同步过（基线为空但不是首次配对场景）：远端新文件与本机新文件同名且远端 ID 已被配对后仍冲突
        let mut st = s.clone();
        st.entries.insert("b".into(), BaseRec { rec: rec("y.md", "hy", 1), fsize: 1, fmtime: 1 });
        let mut m2 = m.clone();
        m2.entries.insert("b".into(), Entry { rec: rec("x.md", "hy", 1), deleted: None, device: "o".into() });
        let p = run(&st, &[("y.md", "hy", 1)], &m2, true);
        let paths: Vec<String> = p
            .items
            .iter()
            .filter_map(|i| match &i.target {
                Target::Live { rec, .. } => Some(rec.path.clone()),
                _ => None,
            })
            .collect();
        assert!(paths.contains(&"x.md".to_string()));
        assert!(paths.contains(&"x (1).md".to_string()));
    }

    #[test]
    fn deleted_directory_becomes_single_trash_item() {
        let s = base_state(&[("a", rec("项目/子/a.md", "h1", 10)), ("b", rec("项目/b.md", "h2", 10))]);
        let m = manifest(&[("a", rec("项目/子/a.md", "h1", 10), None), ("b", rec("项目/b.md", "h2", 10), None)]);
        let view = build_local_view(&[], &s, 1000, |_| Ok(String::new()));
        let exists = |d: &str| d.is_empty();
        let opts = PlanOptions { now: 1000, trash_enabled: true, force_local: false, dir_exists: &exists };
        let p = plan(&s, view, &m, &opts, &mut || "n".into());
        let path_of = |id: &str| match target_of(&p, id) {
            Target::Live { rec, .. } => rec.path.clone(),
            t => panic!("{:?}", t),
        };
        assert_eq!(path_of("a"), ".nb-trash/项目/子/a.md");
        assert_eq!(path_of("b"), ".nb-trash/项目/b.md");
        assert_eq!(p.trash_added.len(), 1);
        assert_eq!(p.trash_added[0].1.orig, "项目");
        assert!(p.trash_added[0].1.is_dir);
    }
}
