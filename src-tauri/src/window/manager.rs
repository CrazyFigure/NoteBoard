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

/// 恢复、显示并激活已有窗口。
/// Windows 会限制后台进程直接抢占焦点，因此在常规 Tauri 聚焦失败时，短暂调整窗口层级，
/// 确保用户从资源管理器打开文件后能立即看到 NoteBoard，同时不会让窗口永久保持置顶。
pub fn bring_to_front(window: &tauri::WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();

    #[cfg(target_os = "windows")]
    if bring_to_front_on_windows(window).is_ok() {
        return;
    }

    // 非 Windows 平台或原生句柄暂不可用时，回退到 Tauri 的标准聚焦流程。
    let _ = window.set_focus();
}

/// 使用 Windows 原生窗口 API 激活后台窗口，并在前台权限受限时修正 Z 序。
#[cfg(target_os = "windows")]
fn bring_to_front_on_windows(window: &tauri::WebviewWindow) -> Result<(), String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow,
        SetWindowPos, ShowWindow, HWND_NOTOPMOST, HWND_TOPMOST, SWP_NOMOVE, SWP_NOOWNERZORDER,
        SWP_NOSIZE, SWP_SHOWWINDOW, SW_RESTORE,
    };

    // Tauri 与当前项目依赖的 windows crate 版本不同，原生句柄指针需要显式转换。
    let tauri_hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let hwnd = HWND(tauri_hwnd.0);

    unsafe {
        let _ = ShowWindow(hwnd, SW_RESTORE);

        // 临时关联当前工作线程与前台线程的输入队列，提高 SetForegroundWindow 的成功率。
        let current_thread_id = GetCurrentThreadId();
        let foreground_window = GetForegroundWindow();
        let foreground_thread_id = if foreground_window.0.is_null() {
            0
        } else {
            GetWindowThreadProcessId(foreground_window, None)
        };
        let should_attach = foreground_thread_id != 0 && foreground_thread_id != current_thread_id;
        let is_attached = should_attach
            && AttachThreadInput(current_thread_id, foreground_thread_id, true).as_bool();

        let _ = BringWindowToTop(hwnd);
        let is_foreground = SetForegroundWindow(hwnd).as_bool();

        if !is_foreground {
            // Windows 拒绝后台抢焦点时，短暂进入 topmost 层再立刻退出，窗口仍回归普通层级。
            let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOOWNERZORDER | SWP_SHOWWINDOW;
            let _ = SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, flags);
            let _ = SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, flags);
            let _ = BringWindowToTop(hwnd);
            let _ = SetForegroundWindow(hwnd);
        }

        // 无论激活是否被系统接受，都必须解除输入队列关联，避免影响后续键盘和鼠标消息。
        if is_attached {
            let _ = AttachThreadInput(current_thread_id, foreground_thread_id, false);
        }
    }

    // 让 Tauri/Wry 同步内部焦点状态，并将键盘输入交给 WebView。
    let _ = window.set_focus();
    Ok(())
}

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
        // 启用窗口拖拽文件接收能力
        .drag_and_drop(true)
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
            let label = window.label().to_string();
            let app = window.app_handle();
            let state = app.state::<Mutex<AppState>>();

            // 检查窗口是否已被标记为主动关闭状态
            let is_closing = {
                let s = state.lock().unwrap();
                s.is_closing(&label)
            };

            // 若已由前端确认或系统流程触发关闭，放行系统默认关闭流程
            if is_closing {
                return;
            }

            // 阻止默认关闭，让前端处理未保存拦截
            api.prevent_close();
            // 🔴 Tauri v2 陷阱：window.emit() 也是广播！
            // close-requested 只发给本窗口，必须用 emit_to
            let _ = window.app_handle().emit_to(&label, "nb://close-requested", &label);
        }
        // 窗口获得焦点时更新活跃时间戳
        WindowEvent::Focused(focused) if *focused => {
            let label = window.label().to_string();
            let app = window.app_handle();
            let state = app.state::<Mutex<AppState>>();
            touch_window(&state, &label);
        }
        // 窗口被销毁时统一注销窗口记录与状态
        WindowEvent::Destroyed => {
            let label = window.label().to_string();
            let app = window.app_handle();
            let state = app.state::<Mutex<AppState>>();
            unregister_window(&state, &label);
        }
        _ => {}
    }
}
