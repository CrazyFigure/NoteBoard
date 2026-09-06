// NoteBoard 文档注册表 — 跨窗口唯一性
// 不变式 X-1: 同一 DocumentKey 在所有窗口中最多存在一个 Document 实例
// 不变式 X-7: 窗口关闭后，Rust 中其名下 DocumentRecord 全部清理

use crate::dto::{DocumentKind, RegisterResult};
use crate::path as nbpath;
use crate::state::AppState;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::State;

/// 文档记录
#[derive(Clone, Debug)]
pub struct DocumentRecord {
    pub key: String,           // 规范化路径（原始大小写）
    pub lower_key: String,     // 小写键（用于索引）
    pub kind: DocumentKind,
    pub owner_window: String,  // 当前归属窗口
    pub is_dirty: bool,        // 前端上报
}

/// 文档注册表操作
pub struct DocumentRegistry;

impl DocumentRegistry {
    /// 注册文档，返回 RegisterResult
    pub fn register(
        documents: &mut HashMap<String, DocumentRecord>,
        label: &str,
        key: &str,
        kind: DocumentKind,
    ) -> RegisterResult {
        let lower_key = nbpath::lower_key(key);

        // 检查是否已在别的窗口打开
        if let Some(existing) = documents.get(&lower_key) {
            if existing.owner_window != label {
                return RegisterResult::AlreadyOpen {
                    owner_label: existing.owner_window.clone(),
                };
            }
            // 已在本窗口注册，返回 Ok
            return RegisterResult::Ok;
        }

        // 注册
        let record = DocumentRecord {
            key: key.to_string(),
            lower_key: lower_key.clone(),
            kind,
            owner_window: label.to_string(),
            is_dirty: false,
        };
        documents.insert(lower_key, record);
        RegisterResult::Ok
    }

    /// 注销文档：仅当当前所有者与调用窗口一致时才移除。
    /// 🔴 所有权保护：旧窗口迟到的清理不得注销新窗口接管的文档（B 节契约修正）。
    /// 返回是否实际移除；非所有者调用或未注册均幂等无操作。
    pub fn unregister(
        documents: &mut HashMap<String, DocumentRecord>,
        label: &str,
        key: &str,
    ) -> bool {
        let lower_key = nbpath::lower_key(key);
        match documents.get(&lower_key) {
            Some(doc) if doc.owner_window == label => {
                documents.remove(&lower_key);
                true
            }
            _ => false,
        }
    }

    /// 对账：移除本窗口名下不在 keys 列表中的文档
    pub fn reconcile(
        documents: &mut HashMap<String, DocumentRecord>,
        label: &str,
        keys: &[String],
    ) -> Vec<String> {
        let valid_lower: std::collections::HashSet<String> =
            keys.iter().map(|k| nbpath::lower_key(k)).collect();

        let mut removed = Vec::new();
        documents.retain(|lower_key, doc| {
            if doc.owner_window == label && !valid_lower.contains(lower_key) {
                removed.push(lower_key.clone());
                false
            } else {
                true
            }
        });

        removed
    }

    /// 设置脏标记
    pub fn set_dirty(
        documents: &mut HashMap<String, DocumentRecord>,
        key: &str,
        is_dirty: bool,
    ) {
        let lower_key = nbpath::lower_key(key);
        if let Some(doc) = documents.get_mut(&lower_key) {
            doc.is_dirty = is_dirty;
        }
    }

    /// 查找文档归属窗口
    pub fn find_owner(
        documents: &HashMap<String, DocumentRecord>,
        key: &str,
    ) -> Option<String> {
        let lower_key = nbpath::lower_key(key);
        documents.get(&lower_key).map(|d| d.owner_window.clone())
    }

    /// 清理窗口名下所有文档
    pub fn cleanup_window(
        documents: &mut HashMap<String, DocumentRecord>,
        label: &str,
    ) {
        documents.retain(|_, doc| doc.owner_window != label);
    }
}

// 便捷函数：从 State 获取
pub fn with_registry<F, T>(state: &State<'_, Mutex<AppState>>, f: F) -> T
where
    F: FnOnce(&mut AppState) -> T,
{
    let state = state.lock().unwrap();
    let mut s = state;
    f(&mut s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_registry() -> HashMap<String, DocumentRecord> {
        HashMap::new()
    }

    /// 所有者注销自己的文档必须成功
    #[test]
    fn unregister_by_owner_removes_record() {
        let mut docs = empty_registry();
        let result = DocumentRegistry::register(&mut docs, "nb-main", r"C:\t\a.md", DocumentKind::Markdown);
        assert!(matches!(result, RegisterResult::Ok));
        assert!(DocumentRegistry::unregister(&mut docs, "nb-main", r"C:\t\a.md"));
        assert!(DocumentRegistry::find_owner(&docs, r"C:\t\a.md").is_none());
    }

    /// 🔴 所有权保护：非所有者（旧窗口迟到清理/其他窗口误调）不得移除他人注册
    #[test]
    fn unregister_by_non_owner_is_noop() {
        let mut docs = empty_registry();
        DocumentRegistry::register(&mut docs, "nb-1", r"C:\t\a.md", DocumentKind::Markdown);
        // 旧窗口 nb-0 迟到清理，不能注销 nb-1 的所有权
        assert!(!DocumentRegistry::unregister(&mut docs, "nb-0", r"C:\t\a.md"));
        // 大小写不同的同一路径同样受保护（lower_key 归一）
        assert!(!DocumentRegistry::unregister(&mut docs, "nb-0", r"c:\T\A.MD"));
        assert_eq!(
            DocumentRegistry::find_owner(&docs, r"C:\t\a.md").as_deref(),
            Some("nb-1")
        );
    }

    /// 未注册 key 的注销幂等无操作
    #[test]
    fn unregister_unknown_key_is_noop() {
        let mut docs = empty_registry();
        assert!(!DocumentRegistry::unregister(&mut docs, "nb-main", r"C:\t\missing.md"));
    }

    /// 跨窗口重复注册返回 AlreadyOpen 并携带所有者
    #[test]
    fn register_conflict_reports_owner() {
        let mut docs = empty_registry();
        DocumentRegistry::register(&mut docs, "nb-1", r"C:\t\a.md", DocumentKind::Markdown);
        match DocumentRegistry::register(&mut docs, "nb-2", r"C:\t\a.md", DocumentKind::Markdown) {
            RegisterResult::AlreadyOpen { owner_label } => assert_eq!(owner_label, "nb-1"),
            other => panic!("期望 AlreadyOpen，实际 {other:?}"),
        }
        // 同窗口重复注册幂等返回 Ok
        assert!(matches!(
            DocumentRegistry::register(&mut docs, "nb-1", r"C:\t\a.md", DocumentKind::Markdown),
            RegisterResult::Ok
        ));
    }

    /// 对账只清理本窗口名下的文档，不影响其他窗口
    #[test]
    fn reconcile_only_removes_own_window_records() {
        let mut docs = empty_registry();
        DocumentRegistry::register(&mut docs, "nb-1", r"C:\t\a.md", DocumentKind::Markdown);
        DocumentRegistry::register(&mut docs, "nb-2", r"C:\t\b.md", DocumentKind::Markdown);
        // nb-1 汇报只还有 b.md？不——b 属于 nb-2；nb-1 汇报空列表应只移除 a.md
        let removed = DocumentRegistry::reconcile(&mut docs, "nb-1", &[]);
        assert_eq!(removed, vec![nbpath::lower_key(r"C:\t\a.md")]);
        assert_eq!(
            DocumentRegistry::find_owner(&docs, r"C:\t\b.md").as_deref(),
            Some("nb-2")
        );
    }
}
