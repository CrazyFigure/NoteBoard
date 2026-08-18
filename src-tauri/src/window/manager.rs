// NoteBoard 窗口管理 — 生命周期、label 分配、关闭拦截
//
// 🔴 实现红线：
// WebviewWindowBuilder::build() 在同步 command 或事件回调中调用
// 会在 Windows 上死锁（wry#583）。必须 async fn 或 std::thread::spawn。
// single-instance 回调尤其危险 —— 它运行在 WM_COPYDATA 同步窗口过程里。

use crate::state::AppState;
use std::sync::Mutex;
use tauri::{Emitter, Manager, State, Window, WindowEvent};
use std::time::{SystemTime, UNIX_EPOCH};

/// 窗口记录
#[derive(Clone, Debug)]
pub struct WindowRecord {
    pub label: String,
    pub seq: u32,
    pub is_ready: bool,
    pub last_active_at: i64,
}

impl WindowRecord {
    pub fn new(label: String, seq: u32) -> Self {
        Self {
            label,
            seq,
            is_ready: false,
            last_active_at: now_ms(),
        }
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// 创建新窗口
/// 🔴 必须切线程：在同步上下文中调 build() 会死锁
pub fn create_window(app: &tauri::AppHandle, label: String) -> Result<(), String> {
    let handle = app.clone();
    let l = label.clone();

    std::thread::spawn(move || {
        let _ = tauri::WebviewWindowBuilder::new(
            &handle,
            &l,
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("NoteBoard")
        .inner_size(1200.0, 800.0)
        .min_inner_size(680.0, 480.0)
        .decorations(false)
        .visible(false)
        .shadow(true)
        .build();
    });

    Ok(())
}

/// 注册窗口到 AppState
pub fn register_window(state: &State<'_, Mutex<AppState>>, label: String, seq: u32) {
    let mut s = state.lock().unwrap();
    let record = WindowRecord::new(label.clone(), seq);
    s.register_window(label, record);
}

/// 窗口 ready（前端已挂载）
pub fn set_window_ready(state: &State<'_, Mutex<AppState>>, label: &str) {
    let mut s = state.lock().unwrap();
    if let Some(w) = s.windows.get_mut(label) {
        w.is_ready = true;
        w.last_active_at = now_ms();
    }
}

/// 更新最后活跃时间
pub fn touch_window(state: &State<'_, Mutex<AppState>>, label: &str) {
    let mut s = state.lock().unwrap();
    if let Some(w) = s.windows.get_mut(label) {
        w.last_active_at = now_ms();
    }
}

/// 获取最后活跃窗口
pub fn last_active_window(state: &State<'_, Mutex<AppState>>) -> Option<String> {
    let s = state.lock().unwrap();
    s.last_active_window().cloned()
}

/// 注销窗口
pub fn unregister_window(state: &State<'_, Mutex<AppState>>, label: &str) {
    let mut s = state.lock().unwrap();
    s.unregister_window(label);
}

/// 窗口事件处理
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            // 阻止默认关闭，让前端处理未保存拦截
            api.prevent_close();
            let label = window.label().to_string();
            // 🔴 Tauri v2 陷阱：window.emit() 也是广播！
            // close-requested 只发给本窗口，必须用 emit_to
            let _ = window.app_handle().emit_to(&label, "nb://close-requested", &label);
        }
        WindowEvent::Focused(focused) => {
            if *focused {
                let label = window.label().to_string();
                let app = window.app_handle();
                let state = app.state::<Mutex<AppState>>();
                touch_window(&state, &label);
            }
        }
        _ => {}
    }
}
