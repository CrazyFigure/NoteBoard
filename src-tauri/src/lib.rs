// NoteBoard — Rust 核心层
// 模块装配入口
// 分层见 docs/04-技术架构设计.md §1.1

pub mod app_dirs;
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
// 可独立更新的官方查看器与工作台插件。
pub mod plugins;
pub mod bootstrap;
pub mod updater;
pub mod staging;
pub mod favorites;
pub mod perf;
pub mod mobile_bridge;
// 多端同步与备份（WebDAV / S3 / GitHub / Gitee / GitCode / GitLab）
pub mod sync;

use state::AppState;
use std::sync::Mutex;

/// 应用入口（桌面端由 main.rs 调用；移动端由 mobile_entry_point 宏生成的原生入口调用）
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 移动端没有 main()：性能诊断原点在此初始化（桌面端已在 main 第一行初始化，避免覆盖进程起点）
    #[cfg(mobile)]
    perf::init();

    let builder = tauri::Builder::default();

    // 🔴 single-instance 必须第一个注册（仅桌面端；Android 由系统保证单 Activity）
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        bootstrap::single_instance::handle_second_instance(app, argv);
    }));

    let builder = builder
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init());

    // 窗口尺寸/位置记忆仅桌面端有意义
    // 不记忆窗口装饰：装饰由各平台配置决定，避免旧版本保存的系统标题栏状态被恢复
    // 不记忆可见性：窗口统一在前端壳就绪后由 window_shell_ready 显示，避免插件提前显示出白屏
    #[cfg(desktop)]
    let builder = builder.plugin(
        tauri_plugin_window_state::Builder::new()
            .with_state_flags(
                tauri_plugin_window_state::StateFlags::all()
                    & !tauri_plugin_window_state::StateFlags::DECORATIONS
                    & !tauri_plugin_window_state::StateFlags::VISIBLE,
            )
            .build(),
    );

    // WebView2 GPU/渲染进程异常后的画面自愈（逻辑仅 Windows 生效，其他平台为空插件）
    let builder = builder.plugin(window::render_recovery::plugin());

    // 全局唤起窗口快捷键（仅桌面端；具体按键由设置决定，启动时在 bootstrap 中注册）
    #[cfg(desktop)]
    let builder = builder.plugin(window::global_shortcut::plugin());

    // Android 原生桥接（所有文件访问权限、外部文件收件、系统分享）
    #[cfg(target_os = "android")]
    let builder = builder.plugin(mobile_bridge::plugin());

    // macOS 页面进程被系统回收后默认停在白屏，交给渲染自愈模块重载
    #[cfg(target_os = "macos")]
    let builder = builder
        .on_web_content_process_terminate(window::render_recovery::on_web_content_process_terminate);

    builder
        .manage(Mutex::new(AppState::default()))
        .setup(|app| {
            // 🔴 诊断 span：setup 钩子的真实执行区间（不含 WebView 创建提前量）
            perf::mark("setup_start");
            let result = bootstrap::setup(app);
            perf::mark("setup_end");
            result?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // window（S04 打开队列 + 迁移协议）
            window::commands::window_listeners_ready,
            window::commands::window_shell_ready,
            window::commands::list_open_requests,
            window::commands::ack_open_request,
            window::commands::enqueue_open_requests,
            window::commands::create_window,
            window::commands::begin_document_transfer,
            window::commands::take_transfer_payload,
            window::commands::prepare_transfer_complete,
            window::commands::abort_transfer,
            window::commands::query_transfer,
            window::commands::focus_window,
            window::commands::close_window,
            window::commands::set_show_window_shortcut,
            window::print_pdf::print_window_to_pdf,
            // registry
            registry::commands::register_document,
            registry::commands::unregister_document,
            registry::commands::reconcile_documents,
            registry::commands::set_document_dirty,
            registry::commands::find_document_owner,
            // fsio
            fsio::commands::read_document,
            // XMind 直接打开保留二进制正文，不能走普通文本解码。
            fsio::commands::read_xmind_file,
            fsio::commands::read_preview_file,
            fsio::commands::probe_document,
            // 🔴 S07：统一文件准备（读盘前归属查询 + 在途去重 + blocking 读取）
            fsio::prepare::prepare_document,
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
            // favorites
            favorites::commands::load_favorites,
            favorites::commands::save_favorites,
            // sysfont
            sysfont::commands::list_system_fonts,
            // 应用内字体资源包
            font_pack::get_font_pack_status,
            font_pack::refresh_font_pack_status,
            font_pack::download_font_pack,
            font_pack::import_font_pack,
            font_pack::remove_font_pack,
            plugins::plugin_command,
            // updater
            updater::commands::check_for_updates,
            updater::commands::download_and_install_update,
            updater::commands::open_external_url,
            // 性能诊断（未启用时为 no-op）
            perf::commands::record_web_spans,
            perf::commands::dump_perf_spans,
            perf::commands::is_perf_spans_enabled,
            // 平台信息与移动端原生桥接
            mobile_bridge::commands::get_platform_info,
            mobile_bridge::commands::ensure_default_workspace,
            mobile_bridge::commands::request_all_files_access,
            mobile_bridge::commands::take_incoming_files,
            mobile_bridge::commands::share_file,
            mobile_bridge::commands::move_app_to_background,
            mobile_bridge::commands::set_system_bar_style,
            // 多端同步与备份
            sync::commands::sync_get_config,
            sync::commands::sync_save_config,
            sync::commands::sync_test_connection,
            sync::commands::sync_now,
            sync::commands::sync_get_status,
            sync::commands::sync_trash_list,
            sync::commands::sync_trash_restore,
            sync::commands::sync_trash_delete,
            sync::commands::sync_trash_empty,
            sync::commands::backup_now,
            sync::commands::backup_list,
            sync::commands::backup_delete,
            sync::commands::backup_restore,
        ])
        .on_window_event(|window, event| {
            window::manager::on_window_event(window, event)
        })
        .build(tauri::generate_context!())
        .expect("error while building NoteBoard application")
        .run(|_app, _event| {
            // Finder 的“打开方式”通过 Opened 事件传入文件，不能仅依赖命令行 argv。
            // 借用 URL 列表，保留事件供下方 Dock 恢复逻辑继续匹配，避免 macOS 编译时部分移动。
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { ref urls } = _event {
                let mut argv = vec!["NoteBoard".to_string()];
                argv.extend(urls.iter().filter_map(|url| url.to_file_path().ok()).map(|path| path.to_string_lossy().to_string()));
                if argv.len() > 1 { bootstrap::single_instance::handle_second_instance(_app, argv); }
            }
            // 窗口全部隐藏到托盘后点击 Dock 图标，恢复窗口
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { has_visible_windows: false, .. } = _event {
                let handle = _app.clone();
                std::thread::spawn(move || window::tray::restore_hidden_windows(&handle));
            }
        });
}
