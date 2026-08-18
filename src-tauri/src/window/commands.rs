// NoteBoard window 命令 — IPC 接口

use crate::dto::{ConfirmHandoffResult, CreateWindowResponse, WindowIntent};
use crate::state::AppState;
use crate::window::{intent, manager};
use std::sync::Mutex;
use tauri::{Manager, State};

/// 窗口握手 + 取意图（合并为一次调用）
#[tauri::command]
pub fn window_ready(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    label: String,
) -> Result<WindowIntent, String> {
    // 标记窗口为 ready
    manager::set_window_ready(&state, &label);

    // 取走意图
    let intent = intent::take_intent(&state, &label).unwrap_or(WindowIntent::Empty);

    // 显示窗口
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.show();
        let _ = win.set_focus();
    }

    Ok(intent)
}

/// 创建窗口（async fn 避免死锁）
#[tauri::command]
pub async fn create_window(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    intent: WindowIntent,
) -> Result<CreateWindowResponse, String> {
    let label = {
        let mut s = state.lock().unwrap();
        let label = s.alloc_label();
        let seq = label.trim_start_matches("nb-").parse::<u32>().unwrap_or(0);
        s.intents.insert(label.clone(), intent);
        s.register_window(label.clone(), manager::WindowRecord::new(label.clone(), seq));
        label
    };

    // 🔴 切线程建窗
    manager::create_window(&app, label.clone())?;

    Ok(CreateWindowResponse { label })
}

/// 在新窗口中打开文档（FR-606 迁移）
#[tauri::command]
pub async fn open_in_new_window(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    docs: Vec<crate::dto::TransferredDocument>,
) -> Result<CreateWindowResponse, String> {
    let intent = WindowIntent::AdoptDocuments { docs };
    create_window(app, state, intent).await
}

/// 确认交接完成
#[tauri::command]
pub fn confirm_handoff(
    state: State<'_, Mutex<AppState>>,
    label: String,
) -> Result<ConfirmHandoffResult, String> {
    let s = state.lock().unwrap();
    let ready = s.windows.get(&label).map(|w| w.is_ready).unwrap_or(false);
    Ok(ConfirmHandoffResult { done: ready })
}

/// 聚焦窗口
#[tauri::command]
pub fn focus_window(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.set_focus();
    }
    Ok(())
}

/// 通知窗口活跃
#[tauri::command]
pub fn notify_window_active(
    state: State<'_, Mutex<AppState>>,
    label: String,
) -> Result<(), String> {
    manager::touch_window(&state, &label);
    Ok(())
}

/// 关闭窗口
/// 使用 destroy() 销毁窗口实例
/// 若关闭的是最后一个窗口或主窗口，执行 std::process::exit(0) 彻底安全退出应用进程，杜绝 Win32 宿主窗口白屏残留
#[tauri::command]
pub fn close_window(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    label: String,
) -> Result<(), String> {
    // 1. 从 AppState 中注销窗口
    manager::unregister_window(&state, &label);

    let remaining = app.webview_windows();
    let has_other_windows = remaining.iter().any(|(k, _)| k.as_str() != label);

    // 2. 如果还有其他独立窗口且关闭的不是主窗口，仅销毁本窗口
    if has_other_windows && label != "nb-main" {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.destroy();
        }
        return Ok(());
    }

    // 3. 若无其他窗口或为主窗口关闭，先隐藏并销毁所有窗口，然后立即彻底退出进程
    for (_, win) in remaining {
        let _ = win.hide();
        let _ = win.destroy();
    }
    app.exit(0);
    std::process::exit(0);
}
