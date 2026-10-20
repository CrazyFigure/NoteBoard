// NoteBoard 全局唤起窗口快捷键
//
// 快捷键由用户在设置中录制（默认不注册）；按下时唤起最后活跃窗口，包括已隐藏到托盘的窗口。
// 注册在 Rust 侧完成，前端不直接调用插件，因此无需额外的前端权限。

use std::sync::Mutex;
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

// 当前已注册的快捷键（原始字符串 + 解析结果），用于幂等同步与替换时注销旧键
static REGISTERED: Mutex<Option<(String, Shortcut)>> = Mutex::new(None);

/// 构建全局快捷键插件：按下时唤起最新窗口
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            // 只响应按下，忽略松开事件
            if event.state() != ShortcutState::Pressed {
                return;
            }
            let handle = app.clone();
            std::thread::spawn(move || {
                if let Some(win) = crate::window::tray::latest_window(&handle) {
                    crate::window::manager::bring_to_front(&win);
                }
            });
        })
        .build()
}

/// 按设置同步全局快捷键（幂等）；新键注册失败时恢复旧键并返回错误
pub fn apply(app: &AppHandle, accelerator: &str) -> Result<(), String> {
    let desired = accelerator.trim();
    let mut current = REGISTERED.lock().unwrap();
    if current.as_ref().map(|(raw, _)| raw.as_str()).unwrap_or("") == desired {
        return Ok(());
    }

    let manager = app.global_shortcut();
    let previous = current.take();
    if let Some((_, old)) = &previous {
        let _ = manager.unregister(*old);
    }
    if desired.is_empty() {
        return Ok(());
    }

    let result = desired
        .parse::<Shortcut>()
        .map_err(|_| format!("无法识别的快捷键：{}", desired))
        .and_then(|shortcut| {
            manager
                .register(shortcut)
                .map(|_| shortcut)
                .map_err(|_| format!("快捷键 {} 已被其他程序占用", desired))
        });

    match result {
        Ok(shortcut) => {
            *current = Some((desired.to_string(), shortcut));
            Ok(())
        }
        Err(error) => {
            // 新键不可用时保留原有快捷键，避免用户一次失败的录制导致唤起功能失效
            if let Some((raw, old)) = previous {
                if manager.register(old).is_ok() {
                    *current = Some((raw, old));
                }
            }
            Err(error)
        }
    }
}
