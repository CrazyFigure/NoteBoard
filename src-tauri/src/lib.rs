// NoteBoard — Rust 核心层
// 模块装配入口
// 分层见 docs/04-技术架构设计.md §1.1

pub mod dto;
pub mod state;
pub mod path;
pub mod fsio;
pub mod registry;
pub mod window;
pub mod settings;
pub mod session;
pub mod sysfont;
pub mod font_pack;
pub mod bootstrap;
pub mod updater;
pub mod staging;

use state::AppState;
use std::sync::Mutex;

/// 应用入口
pub fn run() {
    tauri::Builder::default()
        // 🔴 single-instance 必须第一个注册
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            bootstrap::single_instance::handle_second_instance(app, argv);
        }))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .manage(Mutex::new(AppState::default()))
        .setup(|app| {
            bootstrap::setup(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // window
            window::commands::window_ready,
            window::commands::create_window,
            window::commands::open_in_new_window,
            window::commands::confirm_handoff,
            window::commands::focus_window,
            window::commands::notify_window_active,
            window::commands::close_window,
            // registry
            registry::commands::register_document,
            registry::commands::unregister_document,
            registry::commands::reconcile_documents,
            registry::commands::set_document_dirty,
            registry::commands::find_document_owner,
            // fsio
            fsio::commands::read_document,
            fsio::commands::probe_document,
            fsio::commands::write_document,
            fsio::commands::save_binary_file,
            fsio::commands::read_dir,
            fsio::commands::create_file,
            fsio::commands::create_dir,
            fsio::commands::rename_path,
            fsio::commands::move_to_trash,
            fsio::commands::path_exists,
            fsio::commands::reveal_in_explorer,
            fsio::commands::open_with_default_app,
            // watcher
            fsio::commands::watch_dir,
            fsio::commands::unwatch_dir,
            // settings
            settings::commands::load_settings,
            settings::commands::save_settings,
            // staging
            staging::commands::get_default_staging_directory,
            staging::commands::ensure_staging_directory,
            staging::commands::open_staging_directory,
            staging::commands::stash_documents,
            staging::commands::delete_staged_file,
            // session
            session::commands::load_session,
            session::commands::save_session,
            session::commands::clear_session,
            session::commands::list_recent,
            session::commands::push_recent,
            session::commands::write_draft,
            session::commands::delete_draft,
            session::commands::list_drafts,
            // sysfont
            sysfont::commands::list_system_fonts,
            // 应用内字体资源包
            font_pack::get_font_pack_status,
            font_pack::download_font_pack,
            font_pack::import_font_pack,
            font_pack::remove_font_pack,
            // updater
            updater::commands::check_for_updates,
            updater::commands::download_and_install_update,
            updater::commands::open_external_url,
        ])
        .on_window_event(|window, event| {
            window::manager::on_window_event(window, event)
        })
        .run(tauri::generate_context!())
        .expect("error while running NoteBoard application");
}
