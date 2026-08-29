pub mod single_instance;
pub mod cli_args;

use crate::dto::WindowIntent;
use crate::state::AppState;
use crate::window::{intent, manager};
use std::sync::Mutex;
use tauri::Manager;

/// setup 钩子
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(debug_assertions)]
    if let Some(window) = app.get_webview_window("nb-main") {
        // 开发版可与安装版并行运行，标题必须明确区分，避免调试时误操作正式实例。
        let _ = window.set_title("NoteBoard Dev");
    }

    // 注册主窗口
    let state = app.state::<Mutex<AppState>>();
    {
        let mut s = state.lock().unwrap();
        s.register_window(
            "nb-main".to_string(),
            manager::WindowRecord::new("nb-main".to_string(), 0),
        );
    }

    // 解析命令行参数
    let paths = cli_args::parse_paths_from_args();

    if !paths.is_empty() {
        // 冷启动带参数 → 暂存意图
        intent::put_intent(
            &state,
            "nb-main".to_string(),
            WindowIntent::OpenFiles {
                paths: paths.iter().map(|p| p.to_string_lossy().to_string()).collect(),
            },
        );
    } else {
        intent::put_intent(
            &state,
            "nb-main".to_string(),
            WindowIntent::Empty,
        );
    }

    Ok(())
}
