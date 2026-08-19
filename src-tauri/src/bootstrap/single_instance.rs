// NoteBoard 单实例处理
// 🔴 实现红线：single-instance 回调运行在 WM_COPYDATA 同步窗口过程里
//    直接建窗会死锁（wry#583）。必须 std::thread::spawn。

use crate::state::AppState;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// 处理第二实例
pub fn handle_second_instance(app: &tauri::AppHandle, argv: Vec<String>) {
    // 过滤并收集命令行文件路径参数
    let paths: Vec<String> = argv
        .iter()
        .skip(1) // argv[0] 是 exe 自身
        .filter(|a| !a.starts_with('-'))
        .cloned()
        .collect();

    let state = app.state::<Mutex<AppState>>();

    // 查找当前有效可用的目标窗口
    let target_win = {
        let s = state.lock().unwrap();
        if let Some(lbl) = s.last_active_window() {
            app.get_webview_window(lbl).map(|w| (lbl.clone(), w))
        } else {
            None
        }
    };

    if !paths.is_empty() {
        if let Some((target_label, win)) = target_win {
            // 转发文件路径到最后活跃的目标窗口
            let _ = app.emit_to(
                &target_label,
                "nb://open-files",
                &serde_json::json!({ "paths": paths }),
            );
            let _ = win.set_focus();
        } else if let Some((first_label, win)) = app.webview_windows().into_iter().next() {
            // 兜底派发到当前任意存活的窗口
            let _ = app.emit_to(
                &first_label,
                "nb://open-files",
                &serde_json::json!({ "paths": paths }),
            );
            let _ = win.set_focus();
        } else {
            // 若当前无任何存活窗口，分配新窗口并暂存打开文件意图
            let label = {
                let mut s = state.lock().unwrap();
                let label = s.alloc_label();
                let seq = label.trim_start_matches("nb-").parse::<u32>().unwrap_or(0);
                s.intents.insert(label.clone(), crate::dto::WindowIntent::OpenFiles { paths });
                s.register_window(
                    label.clone(),
                    crate::window::manager::WindowRecord::new(label.clone(), seq),
                );
                label
            };
            let _ = crate::window::manager::create_window(app, label);
        }
    }
}
