// 单实例插件仅桌面端存在（Android 由系统保证单 Activity）
#[cfg(desktop)]
pub mod single_instance;
pub mod cli_args;

use crate::dto::WindowIntent;
use crate::state::AppState;
use crate::window::{intent, manager};
use std::sync::Mutex;
use tauri::Manager;

/// setup 钩子
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // 移动端：应用数据与缓存目录必须来自系统分配的应用私有目录（必须先于任何设置/会话读写）
    #[cfg(mobile)]
    {
        if let Ok(data_dir) = app.path().app_data_dir() {
            crate::app_dirs::set_data_root(data_dir);
        }
        if let Ok(cache_dir) = app.path().app_cache_dir() {
            crate::app_dirs::set_cache_root(cache_dir);
        }
    }

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
        // 🔴 S04：冷启动带参数 → 打开请求入队（前端 listeners-ready 握手后拉取），
        //    不再用一次性 intent，未订阅窗口不会丢请求
        intent::enqueue_open_requests(
            &state,
            "nb-main",
            paths.iter().map(|p| p.to_string_lossy().to_string()).collect(),
            std::env::current_dir().ok().map(|d| d.to_string_lossy().to_string()),
            crate::dto::OpenRequestSource::Cli,
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
