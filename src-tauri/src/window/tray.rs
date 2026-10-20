// NoteBoard 系统托盘 — 关闭按钮最小化到托盘
//
// 开关开启时创建托盘图标，窗口关闭请求改为隐藏（不进入任务栏、不弹未保存确认）；
// 开关关闭时移除托盘并恢复所有已隐藏窗口，避免失去入口后窗口无法找回。
// 🔴 托盘/快捷键回调运行在事件循环线程，显示与聚焦窗口统一切到工作线程执行（同 single_instance）。

use crate::state::AppState;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

const TRAY_ID: &str = "nb-tray";
const MENU_SHOW: &str = "nb-tray-show";
const MENU_QUIT: &str = "nb-tray-quit";

// 当前是否启用关闭到托盘（CloseRequested 高频读取，避免每次读盘）
static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(false);

/// 关闭请求是否应改为隐藏到托盘
pub fn close_to_tray_enabled() -> bool {
    CLOSE_TO_TRAY.load(Ordering::SeqCst)
}

/// 按设置同步托盘状态（启动与每次保存设置时调用，幂等）
pub fn apply(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let was_enabled = CLOSE_TO_TRAY.swap(enabled, Ordering::SeqCst);
    if enabled {
        if app.tray_by_id(TRAY_ID).is_none() {
            build_tray(app).map_err(|e| format!("创建托盘图标失败: {}", e))?;
        }
    } else {
        let _ = app.remove_tray_by_id(TRAY_ID);
        // 关闭开关后托盘入口消失，已隐藏的窗口必须重新显示
        if was_enabled {
            let handle = app.clone();
            std::thread::spawn(move || restore_hidden_windows(&handle));
        }
    }
    Ok(())
}

/// 创建托盘图标：左键单击恢复窗口，菜单提供“显示窗口 / 退出”（Linux 托盘只支持菜单）
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItemBuilder::with_id(MENU_SHOW, "显示窗口").build(app)?;
    let quit = MenuItemBuilder::with_id(MENU_QUIT, "退出").build(app)?;
    let menu = MenuBuilder::new(app).item(&show).separator().item(&quit).build()?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("NoteBoard")
        .menu(&menu)
        // 左键直接恢复窗口，右键才弹菜单（macOS 默认左键弹菜单）
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_SHOW => {
                let handle = app.clone();
                std::thread::spawn(move || restore_hidden_windows(&handle));
            }
            MENU_QUIT => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let handle = tray.app_handle().clone();
                std::thread::spawn(move || restore_hidden_windows(&handle));
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// 最后活跃窗口（含已隐藏到托盘的窗口），无记录时回退到任意存活窗口
pub fn latest_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    let label = {
        let state = app.state::<Mutex<AppState>>();
        let s = state.lock().unwrap();
        s.last_active_window().cloned()
    };
    label
        .and_then(|label| app.get_webview_window(&label))
        .or_else(|| app.webview_windows().into_values().next())
}

/// 显示所有被隐藏的窗口，并把最后活跃窗口置前
pub fn restore_hidden_windows(app: &AppHandle) {
    for win in app.webview_windows().values() {
        if !win.is_visible().unwrap_or(true) {
            let _ = win.show();
        }
    }
    if let Some(win) = latest_window(app) {
        crate::window::manager::bring_to_front(&win);
    }
}

/// 托盘“退出”：逐窗口走前端关闭流程（未保存内容仍会弹确认，由前端在需要时显示窗口）
fn request_quit(app: &AppHandle) {
    for label in app.webview_windows().keys() {
        // 🔴 emit 是广播，关闭请求必须定向到各窗口
        let _ = app.emit_to(label.as_str(), "nb://close-requested", label);
    }
}
