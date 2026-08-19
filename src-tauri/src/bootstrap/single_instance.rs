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

    // 查找最后活跃的窗口
    let target_label = {
        let s = state.lock().unwrap();
        s.last_active_window().cloned().unwrap_or_else(|| "nb-main".to_string())
    };

    if !paths.is_empty() {
        // 转发文件路径到目标窗口
        let _ = app.emit_to(
            &target_label,
            "nb://open-files",
            &serde_json::json!({ "paths": paths }),
        );

        // 聚焦目标窗口
        if let Some(win) = app.get_webview_window(&target_label) {
            let _ = win.set_focus();
        }
    }
}
