// NoteBoard 文档历史记录：设备目录（catalog）与上传 / 下载计划（纯函数）
//
// 远端布局（以同步远端根目录为基准）：
//   .nb-history/<设备ID>/catalog.json        —— 该设备全部文档索引与正文的清单（rev 每次提交递增）
//   .nb-history/<设备ID>/docs/<文件ID>.json  —— 文档索引（只含已封口的版本）
//   .nb-history/<设备ID>/blobs/<aa>/<sha>.gz —— 版本正文（不可变）
// 只有设备本身会写自己的目录，其他设备只读，因此不存在合并冲突。

use super::model::DocIndex;
use super::space::HISTORY_DIR;
use super::store::Store;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashSet};

pub const CATALOG_FORMAT: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct CatalogDoc {
    /// 索引文件内容的 SHA-256（变化即需要重新下载）
    pub idx: String,
    /// 引用的正文
    pub blobs: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Catalog {
    pub format: u32,
    pub rev: u64,
    pub device_id: String,
    pub device_name: String,
    pub updated_at: i64,
    pub docs: BTreeMap<String, CatalogDoc>,
    /// 已不再引用、尚待删除的远端正文（受单轮提交数量限制时延后删除）
    pub garbage: Vec<String>,
}

impl Catalog {
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        serde_json::from_slice(bytes).ok()
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap_or_default()
    }

    /// 全部引用的正文
    pub fn all_blobs(&self) -> BTreeSet<String> {
        self.docs.values().flat_map(|d| d.blobs.iter().cloned()).collect()
    }
}

// ── 远端路径 ──

pub fn catalog_path(device: &str) -> String {
    format!("{}/{}/catalog.json", HISTORY_DIR, device)
}

pub fn index_path(device: &str, doc_id: &str) -> String {
    format!("{}/{}/docs/{}.json", HISTORY_DIR, device, doc_id)
}

pub fn blob_path(device: &str, sha: &str) -> String {
    format!("{}/{}/blobs/{}/{}.gz", HISTORY_DIR, device, &sha[..2.min(sha.len())], sha)
}

/// 上传用的索引内容：只保留已封口的版本，去掉本机专用字段
pub fn upload_index(idx: &DocIndex) -> Option<Vec<u8>> {
    let mut sealed = idx.clone();
    sealed.entries.retain(|e| !e.open);
    if sealed.entries.is_empty() {
        return None;
    }
    serde_json::to_vec(&sealed).ok()
}

/// 本机命名空间期望的目录（临时标识的文档尚未同步，不上传）
pub fn desired_catalog(store: &Store, device_id: &str, device_name: &str) -> (Catalog, BTreeMap<String, Vec<u8>>) {
    let mut cat = Catalog { format: CATALOG_FORMAT, device_id: device_id.into(), device_name: device_name.into(), ..Default::default() };
    let mut bodies = BTreeMap::new();
    for id in store.list_doc_ids() {
        if super::space::is_temp_id(&id) {
            continue;
        }
        let Some(idx) = store.read_index(&id) else { continue };
        let Some(bytes) = upload_index(&idx) else { continue };
        let mut blobs: Vec<String> = idx.entries.iter().filter(|e| !e.open).map(|e| e.hash.clone()).collect();
        blobs.sort();
        blobs.dedup();
        cat.docs.insert(id.clone(), CatalogDoc { idx: crate::sync::util::sha256_hex(&bytes), blobs });
        bodies.insert(id, bytes);
    }
    (cat, bodies)
}

/// 一轮上传计划
#[derive(Debug, Default, PartialEq, Eq)]
pub struct UploadPlan {
    /// 需要上传的索引（文档 ID）
    pub put_docs: Vec<String>,
    /// 需要上传的正文
    pub put_blobs: Vec<String>,
    /// 需要删除的远端索引（文档 ID）
    pub delete_docs: Vec<String>,
    /// 需要删除的远端正文
    pub delete_blobs: Vec<String>,
    /// 提交后的远端目录
    pub next: Catalog,
}

impl UploadPlan {
    pub fn is_empty(&self) -> bool {
        self.put_docs.is_empty() && self.put_blobs.is_empty() && self.delete_docs.is_empty() && self.delete_blobs.is_empty()
    }
}

/// 根据远端已有目录与本机期望目录生成一轮上传计划；单轮最多 budget 个文件操作，剩余留到下一轮
pub fn plan_upload(prev: &Catalog, desired: &Catalog, budget: usize) -> UploadPlan {
    let mut next = prev.clone();
    next.format = CATALOG_FORMAT;
    next.device_id = desired.device_id.clone();
    next.device_name = desired.device_name.clone();
    let mut plan = UploadPlan::default();
    let mut ops = 0usize;
    let mut present: HashSet<String> = prev.all_blobs().into_iter().collect();
    present.extend(prev.garbage.iter().cloned());
    // 1. 新增或变化的文档（索引 + 缺少的正文），保证提交后目录引用的正文都已存在
    for (id, doc) in &desired.docs {
        if prev.docs.get(id) == Some(doc) {
            continue;
        }
        let missing: Vec<String> = doc.blobs.iter().filter(|b| !present.contains(*b)).cloned().collect();
        let cost = 1 + missing.len();
        if ops > 0 && ops + cost > budget {
            continue;
        }
        ops += cost;
        for b in missing {
            present.insert(b.clone());
            plan.put_blobs.push(b);
        }
        plan.put_docs.push(id.clone());
        next.docs.insert(id.clone(), doc.clone());
    }
    // 2. 已不存在的文档
    let gone: Vec<String> = prev.docs.keys().filter(|id| !desired.docs.contains_key(*id)).cloned().collect();
    for id in gone {
        if ops >= budget {
            break;
        }
        ops += 1;
        next.docs.remove(&id);
        plan.delete_docs.push(id);
    }
    // 3. 不再被引用的正文：本轮删除一部分，其余记入待删除列表
    let referenced = next.all_blobs();
    let mut unreferenced: Vec<String> = present.into_iter().filter(|b| !referenced.contains(b)).collect();
    unreferenced.sort();
    let mut garbage = Vec::new();
    for b in unreferenced {
        if ops < budget {
            ops += 1;
            plan.delete_blobs.push(b);
        } else {
            garbage.push(b);
        }
    }
    next.garbage = garbage;
    if !plan.is_empty() || next.garbage != prev.garbage {
        next.rev = prev.rev + 1;
    }
    plan.next = next;
    plan
}

/// 下载计划：需要获取的索引与正文、需要移除的本地缓存
#[derive(Debug, Default, PartialEq, Eq)]
pub struct DownloadPlan {
    pub fetch_docs: Vec<String>,
    pub fetch_blobs: Vec<String>,
    pub drop_docs: Vec<String>,
}

pub fn plan_download(cached: &Catalog, remote: &Catalog, have_blob: impl Fn(&str) -> bool) -> DownloadPlan {
    let mut plan = DownloadPlan::default();
    let mut wanted: BTreeSet<String> = BTreeSet::new();
    for (id, doc) in &remote.docs {
        if cached.docs.get(id).map(|d| d.idx != doc.idx).unwrap_or(true) {
            plan.fetch_docs.push(id.clone());
        }
        for b in &doc.blobs {
            if !have_blob(b) {
                wanted.insert(b.clone());
            }
        }
    }
    plan.fetch_blobs = wanted.into_iter().collect();
    plan.drop_docs = cached.docs.keys().filter(|id| !remote.docs.contains_key(*id)).cloned().collect();
    plan
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(idx: &str, blobs: &[&str]) -> CatalogDoc {
        CatalogDoc { idx: idx.into(), blobs: blobs.iter().map(|s| s.to_string()).collect() }
    }

    fn cat(docs: &[(&str, CatalogDoc)]) -> Catalog {
        Catalog { docs: docs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect(), ..Default::default() }
    }

    #[test]
    fn upload_only_changed_docs_and_missing_blobs() {
        let prev = cat(&[("a", doc("1", &["x"])), ("gone", doc("9", &["z"]))]);
        let desired = cat(&[("a", doc("2", &["x", "y"])), ("b", doc("3", &["y"]))]);
        let plan = plan_upload(&prev, &desired, 100);
        assert_eq!(plan.put_docs, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(plan.put_blobs, vec!["y".to_string()]);
        assert_eq!(plan.delete_docs, vec!["gone".to_string()]);
        assert_eq!(plan.delete_blobs, vec!["z".to_string()]);
        assert_eq!(plan.next.docs, desired.docs);
        assert_eq!(plan.next.rev, 1);
    }

    #[test]
    fn budget_defers_work_and_keeps_catalog_consistent() {
        let prev = Catalog::default();
        let desired = cat(&[("a", doc("1", &["p", "q"])), ("b", doc("2", &["r"]))]);
        let first = plan_upload(&prev, &desired, 3);
        // a 需要 3 个操作，b 留到下一轮
        assert_eq!(first.put_docs, vec!["a".to_string()]);
        assert!(!first.next.docs.contains_key("b"));
        let second = plan_upload(&first.next, &desired, 3);
        assert_eq!(second.put_docs, vec!["b".to_string()]);
        assert_eq!(second.next.docs, desired.docs);
        // 无变化时不提交
        let third = plan_upload(&second.next, &desired, 3);
        assert!(third.is_empty());
        assert_eq!(third.next.rev, second.next.rev);
    }

    #[test]
    fn deferred_garbage_is_tracked_until_deleted() {
        let prev = cat(&[("a", doc("1", &["x", "y", "z"]))]);
        let desired = cat(&[("a", doc("2", &["x"]))]);
        let plan = plan_upload(&prev, &desired, 2);
        assert_eq!(plan.put_docs, vec!["a".to_string()]);
        assert_eq!(plan.delete_blobs.len(), 1);
        assert_eq!(plan.next.garbage.len(), 1);
        let again = plan_upload(&plan.next, &desired, 2);
        assert_eq!(again.delete_blobs.len(), 1);
        assert!(again.next.garbage.is_empty());
    }

    #[test]
    fn download_fetches_changed_and_drops_removed() {
        let cached = cat(&[("a", doc("1", &["x"])), ("old", doc("5", &["o"]))]);
        let remote = cat(&[("a", doc("2", &["x", "y"])), ("b", doc("3", &["y"]))]);
        let plan = plan_download(&cached, &remote, |b| b == "x");
        assert_eq!(plan.fetch_docs, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(plan.fetch_blobs, vec!["y".to_string()]);
        assert_eq!(plan.drop_docs, vec!["old".to_string()]);
    }
}
