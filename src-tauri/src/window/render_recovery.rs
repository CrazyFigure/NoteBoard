// NoteBoard WebView2 渲染自愈（仅 Windows 生效）
//
// 长时间闲置、息屏或睡眠唤醒后，部分显卡驱动（AMD 居多）会重置图形设备，WebView2 的 GPU 进程随之退出。
// Chromium 会自动拉起新的 GPU 进程，但宿主窗口里的合成画面可能停留在黑屏/残块，直到控制器重新提交可见性。
// 这里监听 ProcessFailed：GPU 进程退出时切换一次控制器可见性强制重绘，并在窗口下次获得焦点时再补一次；
// 渲染进程崩溃时页面已不可用，直接重载（未保存内容由暂存机制兜底）。

use std::collections::HashSet;
use std::sync::Mutex;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};

/// GPU 进程退出后尚未在获得焦点时补刷的 Webview 标签
static PENDING_REPAINT: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// 为每个新建的 Webview 挂载进程异常监听
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("nb-render-recovery")
        .on_webview_ready(|webview| {
            #[cfg(windows)]
            windows_impl::attach(webview);
            #[cfg(not(windows))]
            let _ = webview;
        })
        .build()
}

/// 窗口重新获得焦点时调用：若该窗口的 Webview 在后台经历过 GPU 进程退出，再强制重绘一次
pub fn on_window_focused<R: Runtime>(window: &tauri::Window<R>) {
    let label = window.label().to_string();
    let pending = PENDING_REPAINT
        .lock()
        .map(|mut set| set.get_or_insert_with(HashSet::new).remove(&label))
        .unwrap_or(false);
    if !pending {
        return;
    }
    if let Some(window) = window.app_handle().get_webview_window(&label) {
        repaint(&window);
    }
}

/// 窗口销毁时清理待补刷标记，避免同名新窗口误触发
pub fn forget(label: &str) {
    if let Ok(mut set) = PENDING_REPAINT.lock() {
        if let Some(set) = set.as_mut() {
            set.remove(label);
        }
    }
}

fn mark_pending(label: &str) {
    if let Ok(mut set) = PENDING_REPAINT.lock() {
        set.get_or_insert_with(HashSet::new).insert(label.to_string());
    }
}

/// 强制 WebView2 控制器重新提交画面
fn repaint<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    #[cfg(windows)]
    windows_impl::repaint(window);
    #[cfg(not(windows))]
    let _ = window;
}

#[cfg(windows)]
mod windows_impl {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
    };
    use tauri::Manager;
    use webview2_com::ProcessFailedEventHandler;

    pub fn attach<R: tauri::Runtime>(webview: tauri::Webview<R>) {
        let label = webview.label().to_string();
        // 回调内持有 tauri::Webview 句柄而非 COM 控制器，避免 CoreWebView2 ↔ 控制器循环引用导致关窗后泄漏
        let handle = webview.clone();
        let result = webview.with_webview(move |platform| unsafe {
            let core = match platform.controller().CoreWebView2() {
                Ok(core) => core,
                Err(e) => {
                    log::warn!("[render-recovery] {label} 获取 CoreWebView2 失败：{e}");
                    return;
                }
            };
            let handler = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                args.ProcessFailedKind(&mut kind)?;
                on_process_failed(&handle, sender, kind);
                Ok(())
            }));
            let mut token = 0i64;
            if let Err(e) = core.add_ProcessFailed(&handler, &mut token) {
                log::warn!("[render-recovery] {label} 注册 ProcessFailed 失败：{e}");
            }
        });
        if let Err(e) = result {
            log::warn!("[render-recovery] 无法访问 WebView：{e}");
        }
    }

    fn on_process_failed<R: tauri::Runtime>(
        webview: &tauri::Webview<R>,
        core: Option<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2>,
        kind: COREWEBVIEW2_PROCESS_FAILED_KIND,
    ) {
        let label = webview.label();
        match kind {
            COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED => {
                log::warn!("[render-recovery] {label} GPU 进程退出，强制重绘");
                // 新 GPU 进程可能尚未就绪，此刻重绘未必生效；记下标记，用户切回窗口时再补一次
                super::mark_pending(label);
                if let Some(window) = webview.app_handle().get_webview_window(label) {
                    repaint(&window);
                }
            }
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => {
                log::warn!("[render-recovery] {label} 渲染进程退出，重载页面");
                if let Some(core) = core {
                    let _ = unsafe { core.Reload() };
                }
            }
            // 浏览器主进程退出后整个 WebView 已失效，无法原地恢复，只记录
            COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => {
                log::error!("[render-recovery] {label} WebView2 浏览器进程退出");
            }
            other => {
                log::warn!("[render-recovery] {label} 子进程异常：{}", other.0);
            }
        }
    }

    pub fn repaint<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
        let _ = window.with_webview(|platform| unsafe {
            let controller = platform.controller();
            let mut visible = windows_core::BOOL::default();
            // 已被隐藏（如最小化）的 WebView 不动，恢复显示时由焦点补刷
            if controller.IsVisible(&mut visible).is_err() || !visible.as_bool() {
                return;
            }
            // 可见性来回切换会让控制器丢弃旧合成层并向新 GPU 进程重新提交画面
            let _ = controller.SetIsVisible(false);
            let _ = controller.SetIsVisible(true);
            let _ = controller.NotifyParentWindowPositionChanged();
        });
    }
}
