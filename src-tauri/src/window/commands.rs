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
/// 1. 标记窗口为 closing，使 on_window_event 放行 CloseRequested
/// 2. 使用 win.close() 走系统标准关闭管线（触发 window-state 保存并安全销毁 HWND 与 WebView2）
/// 3. 若为最后一个窗口或主窗口，执行应用安全退出
#[tauri::command]
pub fn close_window(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    label: String,
) -> Result<(), String> {
    // 1. 标记本窗口为主动关闭状态
    {
        let mut s = state.lock().unwrap();
        s.mark_closing(&label);
    }

    let remaining = app.webview_windows();
    let has_other_windows = remaining.iter().any(|(k, _)| k.as_str() != label);

    // 2. 如果还有其他独立窗口且关闭的不是主窗口，仅关闭本窗口
    if has_other_windows && label != "nb-main" {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.hide();
            let _ = win.close();
        }
        // 从 AppState 注销窗口
        manager::unregister_window(&state, &label);
        return Ok(());
    }

    // 3. 若无其他窗口或为主窗口关闭，标记所有窗口并优雅退出应用
    {
        let mut s = state.lock().unwrap();
        for (k, _) in &remaining {
            s.mark_closing(k);
        }
    }

    // 先隐藏窗口避免视觉残留，再执行标准关闭与状态保存，最后退出应用
    for (_, win) in remaining {
        let _ = win.hide();
        let _ = win.close();
    }
    app.exit(0);
    Ok(())
}
