// NoteBoard registry 命令 — IPC 接口

use crate::dto::{DocumentKind, RegisterResult, ReconcileResult};
use crate::registry::documents::DocumentRegistry;
use crate::state::AppState;
use std::sync::Mutex;
use tauri::State;

/// 注册文档
#[tauri::command]
pub fn register_document(
    state: State<'_, Mutex<AppState>>,
    label: String,
    key: String,
    kind: DocumentKind,
) -> Result<RegisterResult, String> {
    let mut s = state.lock().unwrap();
    let result = DocumentRegistry::register(&mut s.documents, &label, &key, kind);
    Ok(result)
}

/// 注销文档
#[tauri::command]
pub fn unregister_document(
    state: State<'_, Mutex<AppState>>,
    label: String,
    key: String,
) -> Result<(), String> {
    let mut s = state.lock().unwrap();
    DocumentRegistry::unregister(&mut s.documents, &label, &key);
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
