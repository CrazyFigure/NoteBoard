// NoteBoard registry 命令 — IPC 接口

use crate::dto::{DocumentKind, RegisterResult, ReconcileResult};
use crate::registry::documents::DocumentRegistry;
use crate::state::AppState;
use std::sync::Mutex;
use tauri::State;

/// 注册文档
/// 🔴 N05：成功注册时兑现 prepare 预约（在途读盘/等待注册的 pending 标记随之释放）
#[tauri::command]
pub fn register_document(
    state: State<'_, Mutex<AppState>>,
    label: String,
    key: String,
    kind: DocumentKind,
) -> Result<RegisterResult, String> {
    let mut s = state.lock().unwrap();
    let result = DocumentRegistry::register(&mut s.documents, &label, &key, kind);
    // 兑现预约：注册已落地（无论新注册还是本窗口幂等），pending 标记不再需要
    let lower_key = crate::path::lower_key(&key);
    if let Some(p) = s.pending_prepares.get(&lower_key) {
        if p.owner == label {
            s.pending_prepares.remove(&lower_key);
        }
    }
    Ok(result)
}

/// 注销文档
/// 🔴 N05：注销成功同时释放该 key 的本窗口 prepare 预约（文档真正关闭）
#[tauri::command]
pub fn unregister_document(
    state: State<'_, Mutex<AppState>>,
    label: String,
    key: String,
) -> Result<(), String> {
    let mut s = state.lock().unwrap();
    DocumentRegistry::unregister(&mut s.documents, &label, &key);
    let lower_key = crate::path::lower_key(&key);
    if let Some(p) = s.pending_prepares.get(&lower_key) {
        if p.owner == label {
            s.pending_prepares.remove(&lower_key);
        }
    }
    Ok(())
}

/// 对账
#[tauri::command]
pub fn reconcile_documents(
    state: State<'_, Mutex<AppState>>,
    label: String,
    keys: Vec<String>,
) -> Result<ReconcileResult, String> {
    let mut s = state.lock().unwrap();
    let removed = DocumentRegistry::reconcile(&mut s.documents, &label, &keys);
    Ok(ReconcileResult { removed })
}

/// 设置脏标记
#[tauri::command]
pub fn set_document_dirty(
    state: State<'_, Mutex<AppState>>,
    key: String,
    is_dirty: bool,
) -> Result<(), String> {
    let mut s = state.lock().unwrap();
    DocumentRegistry::set_dirty(&mut s.documents, &key, is_dirty);
    Ok(())
}

/// 查找文档归属
#[tauri::command]
pub fn find_document_owner(
    state: State<'_, Mutex<AppState>>,
    key: String,
) -> Result<Option<String>, String> {
    let s = state.lock().unwrap();
    Ok(DocumentRegistry::find_owner(&s.documents, &key))
}
