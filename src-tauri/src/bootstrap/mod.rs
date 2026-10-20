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
    // 移动端与 Unix 桌面端使用系统标准数据/缓存目录；Windows 保留已有 APPDATA 位置。
    // 必须先于任何设置、会话、同步配置读写，不能依赖 GUI 进程的当前工作目录。
    #[cfg(any(mobile, target_os = "macos", target_os = "linux"))]
    {
        if let Ok(data_dir) = app.path().app_data_dir() {
            crate::app_dirs::set_data_root(data_dir);
        }
        if let Ok(cache_dir) = app.path().app_cache_dir() {
            crate::app_dirs::set_cache_root(cache_dir);
        }
    }

    // 后台清理已安装或过期的更新安装包（必须在缓存目录初始化之后；不阻塞启动）
    std::thread::spawn(crate::updater::commands::cleanup_installed_update_packages);

    #[cfg(debug_assertions)]
    if let Some(window) = app.get_webview_window("nb-main") {
        // 开发版可与安装版并行运行，标题必须明确区分，避免调试时误操作正式实例。
        let _ = window.set_title("NoteBoard Dev");
    }

    // 按设置启用关闭到托盘与全局唤起快捷键（数据目录已初始化，可读取设置）
    #[cfg(desktop)]
    crate::window::apply_system_settings(app.handle(), &crate::settings::model::load());

    // 多端同步后台调度线程（进程唯一；启动后延迟数秒在后台同步，不阻塞窗口显示）
    crate::sync::scheduler::init(app.handle().clone());

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
