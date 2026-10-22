// NoteBoard 当前窗口导出 PDF
// Windows 走 WebView2 PrintToPdf：按页面 @media print 样式直接写入用户选择的路径，不弹打印对话框；
// 其他平台返回错误，由前端回退到系统打印（window.print）。

/// 把调用方 Webview 的打印版式写成 PDF 文件
#[tauri::command]
pub async fn print_window_to_pdf(webview: tauri::Webview, path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        windows_impl::print_to_pdf(webview, path).await
    }
    #[cfg(not(windows))]
    {
        let _ = (webview, path);
        Err("当前平台不支持直接导出 PDF".into())
    }
}

#[cfg(windows)]
mod windows_impl {
    use std::sync::{Arc, Mutex};

    use tokio::sync::oneshot;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment6, ICoreWebView2_2, ICoreWebView2_7,
        COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows_core::{Interface, HSTRING};

    type Reply = Arc<Mutex<Option<oneshot::Sender<Result<(), String>>>>>;

    /// A4 纸张尺寸（英寸），与 Chromium 默认一致
    const PAGE_WIDTH_IN: f64 = 8.27;
    const PAGE_HEIGHT_IN: f64 = 11.69;
    /// 页边距（英寸）：上下约 15mm、左右约 14mm
    const MARGIN_VERTICAL_IN: f64 = 0.6;
    const MARGIN_HORIZONTAL_IN: f64 = 0.55;

    pub async fn print_to_pdf(webview: tauri::Webview, path: String) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        let reply: Reply = Arc::new(Mutex::new(Some(tx)));
        let reply_for_start = reply.clone();

        // WebView2 接口只能在界面线程调用；完成回调同样回到界面线程，结果经 oneshot 交回本命令
        webview
            .with_webview(move |platform| {
                if let Err(e) = unsafe { start(platform.controller(), &path, reply_for_start.clone()) } {
                    send(&reply_for_start, Err(e));
                }
            })
            .map_err(|e| format!("无法访问窗口 WebView：{e}"))?;

        rx.await.map_err(|_| "导出 PDF 被中断".to_string())?
    }

    unsafe fn start(
        controller: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
        path: &str,
        reply: Reply,
    ) -> Result<(), String> {
        let core = controller.CoreWebView2().map_err(describe)?;
        // PrintToPdf 需要 WebView2 Runtime 1.0.1020 以上
        let core7 = core
            .cast::<ICoreWebView2_7>()
            .map_err(|_| "当前 WebView2 运行时版本过低，不支持导出 PDF".to_string())?;

        // 打印设置：A4 纵向、保留背景色（代码块、表格底色等），去掉浏览器默认页眉页脚
        let settings = core
            .cast::<ICoreWebView2_2>()
            .and_then(|c| c.Environment())
            .and_then(|env| env.cast::<ICoreWebView2Environment6>())
            .and_then(|env| env.CreatePrintSettings())
            .map_err(describe)?;
        settings.SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT).map_err(describe)?;
        settings.SetPageWidth(PAGE_WIDTH_IN).map_err(describe)?;
        settings.SetPageHeight(PAGE_HEIGHT_IN).map_err(describe)?;
        settings.SetMarginTop(MARGIN_VERTICAL_IN).map_err(describe)?;
        settings.SetMarginBottom(MARGIN_VERTICAL_IN).map_err(describe)?;
        settings.SetMarginLeft(MARGIN_HORIZONTAL_IN).map_err(describe)?;
        settings.SetMarginRight(MARGIN_HORIZONTAL_IN).map_err(describe)?;
        settings.SetShouldPrintBackgrounds(true).map_err(describe)?;
        settings.SetShouldPrintHeaderAndFooter(false).map_err(describe)?;

        let handler = PrintToPdfCompletedHandler::create(Box::new(move |result, ok| {
            let outcome = match result {
                Ok(()) if ok => Ok(()),
                // 返回 false 多为目标文件被占用或目录不可写
                Ok(()) => Err("写入 PDF 失败，请确认文件未被其他程序占用".to_string()),
                Err(e) => Err(describe(e)),
            };
            send(&reply, outcome);
            Ok(())
        }));

        core7
            .PrintToPdf(&HSTRING::from(path), &settings, &handler)
            .map_err(describe)
    }

    fn send(reply: &Reply, outcome: Result<(), String>) {
        if let Some(tx) = reply.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = tx.send(outcome);
        }
    }

    fn describe(e: windows_core::Error) -> String {
        format!("导出 PDF 失败：{}", e.message())
    }
}
