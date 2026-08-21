// NoteBoard 单实例处理
// 🔴 实现红线：single-instance 回调运行在 WM_COPYDATA 同步窗口过程里。
//    任何窗口查询、显示或建窗都必须切换到工作线程，避免卡死 Windows 消息循环（wry#583）。

use crate::dto::WindowIntent;
use crate::state::AppState;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// 接收第二实例参数并立即切出 Windows 同步消息回调
pub fn handle_second_instance(app: &tauri::AppHandle, argv: Vec<String>) {
    let app_handle = app.clone();
    std::thread::spawn(move || handle_second_instance_on_worker(&app_handle, argv));
}

/// 在工作线程中转发打开文件意图，并恢复、显示和聚焦已有窗口
fn handle_second_instance_on_worker(app: &tauri::AppHandle, argv: Vec<String>) {
    // 过滤并收集命令行文件路径参数
    let paths: Vec<String> = argv
        .iter()
        .skip(1) // argv[0] 是 exe 自身
        .filter(|a| !a.starts_with('-'))
        .cloned()
        .collect();

    let state = app.state::<Mutex<AppState>>();

    // 优先选择已就绪的最后活跃窗口，再回退到任意仍存活的窗口
    let active_label = {
        let s = state.lock().unwrap();
        s.last_active_window().cloned()
    };
    let target_label = active_label.or_else(|| {
        app.webview_windows()
            .into_iter()
            .next()
            .map(|(label, _)| label)
    });

    if let Some(target_label) = target_label {
        if !paths.is_empty() {
            // 将文件路径转发到已有实例；无参数的普通重复启动也会继续执行窗口恢复逻辑
            let _ = app.emit_to(
                &target_label,
                "nb://open-files",
                &serde_json::json!({ "paths": paths }),
            );
        }

        if let Some(win) = app.get_webview_window(&target_label) {
            // 安装器或快捷方式重复启动时，确保隐藏/最小化的首实例能重新出现在前台
            let _ = win.unminimize();
            let _ = win.show();
            let _ = win.set_focus();
        }
        return;
    }

    // 极端情况下首实例仍存活但已经没有窗口，重新创建窗口而不是留下后台空进程
    let label = {
        let mut s = state.lock().unwrap();
        let label = s.alloc_label();
        let seq = label.trim_start_matches("nb-").parse::<u32>().unwrap_or(0);
        let intent = if paths.is_empty() {
            WindowIntent::Empty
        } else {
            WindowIntent::OpenFiles { paths }
        };
        s.intents.insert(label.clone(), intent);
        s.register_window(
            label.clone(),
            crate::window::manager::WindowRecord::new(label.clone(), seq),
        );
        label
    };
    let _ = crate::window::manager::create_window(app, label);
}
