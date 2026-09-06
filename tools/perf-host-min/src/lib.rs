// NoteBoard 性能对照：最小 Tauri 宿主核心逻辑
// 🔴 与主应用对齐的测量点：
//   - 窗口初始隐藏（visible: false），JS 就绪后由 show_and_report 显示
//   - Rust 时钟轴 process_entry 起算（Instant），web 轴 html_parse/js_ready 为 performance.now
//   - 两轴不做直接相减，落盘时分轴保存

use std::io::Write;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

/// 进程时间原点（main 第一行固定）
static T0: OnceLock<Instant> = OnceLock::new();

/// 采集的事件（名称 → 毫秒）
static EVENTS: OnceLock<Mutex<Vec<(String, f64)>>> = OnceLock::new();

fn record(name: &str, t_ms: f64) {
    let events = EVENTS.get_or_init(|| Mutex::new(Vec::new()));
    events
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push((name.to_string(), t_ms));
}

/// 把采集结果写入 %TEMP%\noteboard-perf\minimal-host.json（覆盖写，单进程对照够用）
fn flush(reason: &str) {
    let Some(t0) = T0.get() else { return };
    let events = EVENTS.get_or_init(|| Mutex::new(Vec::new()));
    let events = events.lock().unwrap_or_else(|e| e.into_inner());
    let payload = serde_json::json!({
        "version": 1,
        "pid": std::process::id(),
        "reason": reason,
        "processEntryRustMs": 0.0,
        "rustElapsedAtFlushMs": t0.elapsed().as_secs_f64() * 1000.0,
        "events": events.clone(),
    });
    let dir = std::env::temp_dir().join("noteboard-perf");
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::File::create(dir.join("minimal-host.json")).and_then(|mut f| {
        f.write_all(serde_json::to_string_pretty(&payload).unwrap_or_default().as_bytes())
    });
}

/// 应用入口
pub fn run() {
    let t0 = Instant::now();
    let _ = T0.set(t0);
    record("process_entry", 0.0);

    tauri::Builder::default()
        .setup(|_app| {
            // setup 钩子完成点：含主窗口（隐藏态）与 WebView 创建
            record("setup_end", t0.elapsed().as_secs_f64() * 1000.0);
            flush("setup-end");
            Ok(())
        })
        .on_window_event(|window, event| {
            // 对照窗口关闭即退出并落盘，保证单次对照数据完整
            if let tauri::WindowEvent::Destroyed = event {
                record("window_destroyed", t0.elapsed().as_secs_f64() * 1000.0);
                flush("window-destroyed");
                tauri::AppHandle::exit(window.app_handle(), 0);
            }
        })
        .invoke_handler(tauri::generate_handler![show_and_report])
        .run(tauri::generate_context!())
        .expect("minimal perf host crashed");
}

/// web 侧就绪上报：显示窗口并记录 web 轴时间戳（performance.now 原点）
#[tauri::command]
fn show_and_report(app: tauri::AppHandle, stage: String, t_web: f64) {
    let t_rust = T0
        .get()
        .map(|t| t.elapsed().as_secs_f64() * 1000.0)
        .unwrap_or(0.0);
    match stage.as_str() {
        "js-ready" => {
            // 与主应用一致：JS 就绪后才显示窗口
            record("js_ready_rust", t_rust);
            record("js_ready_web", t_web);
            if let Some(win) = app.get_webview_window("min-main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }
        "first-frame" => {
            // 双 rAF 后的可见代理点
            record("first_frame_rust", t_rust);
            record("first_frame_web", t_web);
            flush("first-frame");
        }
        _ => {}
    }
}
