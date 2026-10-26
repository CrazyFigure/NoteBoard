pub mod manager;
pub mod intent;
pub mod commands;
pub mod print_pdf;
pub mod render_recovery;
// 原生标签拖放只在桌面端装配，移动端继续使用窗口内排序。
#[cfg(desktop)]
pub mod tab_drag;
// 托盘与全局快捷键仅桌面端存在（移动端单窗口常驻前台）
#[cfg(desktop)]
pub mod tray;
#[cfg(desktop)]
pub mod global_shortcut;

/// 按设置同步系统集成（托盘 + 全局快捷键）；启动与每次保存设置时调用，失败只记录日志
#[cfg(desktop)]
pub fn apply_system_settings(app: &tauri::AppHandle, settings: &crate::settings::model::Settings) {
    if let Err(e) = tray::apply(app, settings.system.close_to_tray) {
        log::warn!("{}", e);
    }
    if let Err(e) = global_shortcut::apply(app, &settings.system.show_window_shortcut) {
        log::warn!("{}", e);
    }
}
