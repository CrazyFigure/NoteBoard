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

    /// 注销文档
    pub fn unregister(
        documents: &mut HashMap<String, DocumentRecord>,
        _label: &str,
        key: &str,
    ) {
        let lower_key = nbpath::lower_key(key);
        documents.remove(&lower_key);
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
