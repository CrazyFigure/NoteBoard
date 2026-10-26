// 标签拖放只传递一次性随机票据，正文始终通过文档迁移协议交接。
// 系统负责命中实际窗口，避免全局坐标命中在 Wayland、混合 DPI 或遮挡窗口上失效。

use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{DragDropEvent, Emitter, Manager, WebviewWindow};

/// Linux 为每个 WebView 接入私有标签 MIME；其他桌面使用原生文件目标并限制投递进程。
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    let builder = tauri::plugin::Builder::new("tab-drag-targets");
    #[cfg(target_os = "linux")]
    let builder = builder.on_webview_ready(|webview| {
        let app = webview.app_handle().clone();
        let label = webview.window().label().to_string();
        let _ = webview.with_webview(move |platform| {
            linux::attach_target(&platform.inner(), move |event| {
                handle_linux_target_event(&app, &label, event)
            });
        });
    });
    builder.build()
}

/// 私有 GTK 拖放先核验票据并登记真实目标，然后转发既有前端拖放事件。
#[cfg(target_os = "linux")]
fn handle_linux_target_event(app: &tauri::AppHandle, label: &str, event: linux::TabTargetEvent) {
    use linux::TabTargetEvent;
    use std::os::unix::ffi::OsStrExt;
    let state = app.state::<TabDragState>();
    let active = state.0.lock().unwrap();
    let Some(session) = active.as_ref() else {
        return;
    };
    let path = session.ticket.path().to_path_buf();
    let (name, payload) = match event {
        TabTargetEvent::Enter(x, y) => (
            "tauri://drag-enter",
            serde_json::json!({"paths": [path], "position": {"x": x, "y": y}}),
        ),
        TabTargetEvent::Over(x, y) => (
            "tauri://drag-over",
            serde_json::json!({"position": {"x": x, "y": y}}),
        ),
        TabTargetEvent::Leave => ("tauri://drag-leave", serde_json::Value::Null),
        TabTargetEvent::Drop(ticket, x, y) => {
            if ticket != path.as_os_str().as_bytes() {
                return;
            }
            drop(active);
            record_drop(
                app,
                label,
                &DragDropEvent::Drop {
                    paths: vec![path.clone()],
                    position: tauri::PhysicalPosition::new(x, y),
                },
            );
            let _ = app.emit_to(
                label,
                "tauri://drag-drop",
                serde_json::json!({"paths": [path], "position": {"x": x, "y": y}}),
            );
            return;
        }
    };
    drop(active);
    // Linux 沿用 WebKitGTK 文件事件的投递顺序，防止线程并发让 leave 后又出现迟到 over。
    let _ = app.emit_to(label, name, payload);
}

/// 一个进程同一时刻只有一个系统鼠标拖放；临时票据随会话释放。
#[derive(Default)]
pub struct TabDragState(Mutex<Option<DragSession>>, Mutex<Vec<(PathBuf, Instant)>>);

struct DragSession {
    source: String,
    key: String,
    ticket: tempfile::NamedTempFile,
    target: Option<DropTarget>,
}

/// 所有窗口仅收到展示所需的标签摘要，不广播正文或编辑器快照。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TabDragInfo {
    source_label: String,
    key: String,
    display_name: String,
}

/// 落点只包含目标窗口、标签插入锚点及目标内坐标，不包含文档正文。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DropTarget {
    label: String,
    before_key: Option<String>,
    x: f64,
    y: f64,
}

/// cancelled 与松手在窗口外严格区分；外部应用接收票据也不会取得文档或删除源标签。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabDragResult {
    cancelled: bool,
    target: Option<DropTarget>,
    position: Option<(i32, i32)>,
}

/// 原生落点先登记，前端稍后补充插入锚点；避免异步 IPC 迟到导致误新建窗口。
pub fn record_drop(app: &tauri::AppHandle, label: &str, event: &DragDropEvent) {
    if let DragDropEvent::Drop { paths, position } = event {
        let state = app.state::<TabDragState>();
        let mut active = state.0.lock().unwrap();
        if let Some(session) = active.as_mut() {
            if matches_ticket(session, paths) {
                session.target = Some(DropTarget {
                    label: label.to_string(),
                    before_key: None,
                    x: position.x,
                    y: position.y,
                });
            }
        }
    }
}

/// 只认本次会话持有的完整路径，不按文件名前缀读取任意外部文件。
fn matches_ticket(session: &DragSession, paths: &[PathBuf]) -> bool {
    paths.len() == 1 && paths[0] == session.ticket.path()
}

/// 前端文件拖放监听先识别内部票据；票据不得进入普通文件打开队列。
#[tauri::command]
pub fn claim_tab_drop(
    window: WebviewWindow,
    paths: Vec<PathBuf>,
    before_key: Option<String>,
) -> bool {
    let state = window.state::<TabDragState>();
    let mut active = state.0.lock().unwrap();
    let Some(session) = active.as_mut().filter(|s| matches_ticket(s, &paths)) else {
        // 慢 WebView 可能在源拖放结束后才处理 drop；已发出的票据也不能当普通文件打开。
        let mut retired = state.1.lock().unwrap();
        retired.retain(|(_, at)| at.elapsed() < Duration::from_secs(60));
        return paths.len() == 1 && retired.iter().any(|(path, _)| path == &paths[0]);
    };
    // 只有系统登记的真实目标窗口可以补充位置，其他窗口不能抢走拖放。
    if let Some(target) = session
        .target
        .as_mut()
        .filter(|t| t.label == window.label())
    {
        target.before_key = before_key;
    }
    true
}

/// 开始系统拖放：保留源数据，等待原生结果和落点登记后才返回迁移意图。
#[tauri::command]
pub async fn start_tab_drag(
    window: WebviewWindow,
    key: String,
    image: String,
    display_name: String,
) -> Result<TabDragResult, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(
            image
                .strip_prefix("data:image/png;base64,")
                .ok_or("无效拖放预览")?,
        )
        .map_err(|e| e.to_string())?;
    if bytes.len() > 512 * 1024 {
        return Err("拖放预览过大".into());
    }
    if key.is_empty() {
        return Err("缺少拖动标签".into());
    }
    let source = window.label().to_string();
    let ticket = tempfile::Builder::new()
        .prefix("noteboard-tab-")
        .tempfile()
        .map_err(|e| e.to_string())?;
    let path = ticket.path().to_path_buf();
    let app = window.app_handle().clone();
    {
        let state = app.state::<TabDragState>();
        let mut active = state.0.lock().unwrap();
        if active.is_some() {
            return Err("另一个标签正在拖动".into());
        }
        *active = Some(DragSession {
            source: source.clone(),
            key: key.clone(),
            ticket,
            target: None,
        });
    }
    let _ = app.emit(
        "nb://tab-drag-state",
        Some(TabDragInfo {
            source_label: source.clone(),
            key: key.clone(),
            display_name,
        }),
    );
    let (tx, rx) = mpsc::channel();
    let sender = Arc::new(Mutex::new(Some(tx)));
    let callback_sender = sender.clone();
    let completion_app = app.clone();
    // 原生拖放必须在 UI 线程；Windows 还要退出当前 Tao 回调，避免 OLE 嵌套循环缓存悬停事件。
    #[cfg(target_os = "windows")]
    let scheduling_error_sender = sender.clone();
    let start = move || {
        let result = start_native(&window, path, bytes, move |cancelled, position| {
            // 从工作线程排回 UI 队列：先处理先前的原生 Drop，再结算落点，不靠固定等待时长猜测。
            if let Some(tx) = callback_sender.lock().unwrap().take() {
                let completion_app = completion_app.clone();
                std::thread::spawn(move || {
                    let fallback = tx.clone();
                    if let Err(error) = completion_app.run_on_main_thread(move || {
                        let _ = tx.send(Ok((cancelled, position)));
                    }) {
                        let _ = fallback.send(Err(error.to_string()));
                    }
                });
            }
        });
        if let Err(error) = result {
            if let Some(tx) = sender.lock().unwrap().take() {
                let _ = tx.send(Err(error));
            }
        }
    };
    let scheduled = app.run_on_main_thread(move || {
        #[cfg(target_os = "windows")]
        if let Err(error) = windows_dispatch::defer_start(start) {
            if let Some(tx) = scheduling_error_sender.lock().unwrap().take() {
                let _ = tx.send(Err(error));
            }
        }
        // AppKit 创建异步拖放会话后立即返回；GTK 已延后到真实鼠标事件，不需要 Windows 调度。
        #[cfg(not(target_os = "windows"))]
        start();
    });
    let result = match scheduled {
        Ok(()) => {
            tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|e| e.to_string()))
                .await
                .map_err(|e| e.to_string())
                .and_then(|r| r)
                .and_then(|r| r)
        }
        Err(error) => Err(error.to_string()),
    };
    let drag_state = app.state::<TabDragState>();
    let mut active = drag_state.0.lock().unwrap();
    let session = active.take();
    if let Some(session) = session.as_ref() {
        let mut retired = drag_state.1.lock().unwrap();
        retired.retain(|(_, at)| at.elapsed() < Duration::from_secs(60));
        // 仅保留少量已知路径用于迟到事件去重，不保存正文或临时文件句柄。
        if retired.len() >= 16 {
            retired.remove(0);
        }
        retired.push((session.ticket.path().into(), Instant::now()));
    }
    drop(active);
    let _ = app.emit("nb://tab-drag-state", Option::<TabDragInfo>::None);
    let (cancelled, position) = result?;
    Ok(TabDragResult {
        cancelled,
        target: session
            .filter(|s| s.source == source && s.key == key)
            .and_then(|s| s.target),
        position,
    })
}

/// Windows/macOS 使用 OLE/AppKit；Escape 取消时鼠标仍按住，不能误当成拖出新建。
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn start_native(
    window: &WebviewWindow,
    path: PathBuf,
    image: Vec<u8>,
    done: impl Fn(bool, Option<(i32, i32)>) + Send + 'static,
) -> Result<(), String> {
    // 快速松手可能发生在 IPC 到达前，此时不应再开启一轮拖放。
    if !primary_button_pressed() {
        done(true, None);
        return Ok(());
    }
    drag::start_drag(
        window,
        drag::DragItem::Files(vec![path]),
        drag::Image::Raw(image),
        move |result, point| {
            let cancelled = matches!(result, drag::DragResult::Cancel) && primary_button_pressed();
            done(cancelled, Some((point.x, point.y)));
        },
        drag::Options {
            skip_animatation_on_cancel_or_failure: true,
            internal_only: true,
            ..Default::default()
        },
    )
    .map_err(|e| e.to_string())
}

#[cfg(target_os = "windows")]
fn primary_button_pressed() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    // 只读取按键状态，不安装全局鼠标/键盘钩子。
    unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) < 0 }
}

#[cfg(target_os = "macos")]
fn primary_button_pressed() -> bool {
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn CGEventSourceButtonState(state_id: i32, button: u32) -> bool;
    }
    // CombinedSessionState=0，Left=0；读取用户当前会话左键，无辅助功能控制权限要求。
    unsafe { CGEventSourceButtonState(0, 0) }
}

// GTK 必须从真实 motion-notify-event 发起，才能取得 Wayland 的输入 serial。
#[cfg(target_os = "linux")]
#[path = "tab_drag_linux.rs"]
mod linux;
#[cfg(target_os = "linux")]
use linux::start_native;

// Windows 的 DoDragDrop 会同步运行消息循环，必须在 Tao 事件回调之外启动。
#[cfg(target_os = "windows")]
#[path = "tab_drag_windows.rs"]
mod windows_dispatch;

#[cfg(test)]
mod tests {
    use super::*;

    /// 外部文件即使使用相同前缀，也不能冒充当前标签拖放票据。
    #[test]
    fn ticket_requires_exact_single_path() {
        let session = DragSession {
            source: "nb-main".into(),
            key: "untitled:1".into(),
            ticket: tempfile::NamedTempFile::new().unwrap(),
            target: None,
        };
        assert!(matches_ticket(&session, &[session.ticket.path().into()]));
        assert!(!matches_ticket(
            &session,
            &[PathBuf::from("noteboard-tab-fake")]
        ));
        assert!(!matches_ticket(
            &session,
            &[session.ticket.path().into(), PathBuf::from("a")]
        ));
    }
}
