// NoteBoard 当前窗口导出 PDF
// Windows 走 WebView2 PrintToPdf，macOS 走 WKWebView + NSPrintOperation（NSPrintSaveJob），
// Linux 走 WebKitGTK PrintOperation（Print to File + output-uri）：
// 均按页面 @media print 样式直接写入分页 A4 PDF 到用户选择的路径，不弹打印对话框；
// 其他平台返回错误，由前端回退到系统打印（window.print）。

/// 把调用方 Webview 的打印版式写成 PDF 文件
#[tauri::command]
pub async fn print_window_to_pdf(webview: tauri::Webview, path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        windows_impl::print_to_pdf(webview, path).await
    }
    #[cfg(target_os = "macos")]
    {
        macos_impl::print_to_pdf(webview, path).await
    }
    #[cfg(target_os = "linux")]
    {
        linux_impl::print_to_pdf(webview, path).await
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = (webview, path);
        Err("当前平台不支持直接导出 PDF".into())
    }
}

/// 校验导出目标路径有效且父目录存在，避免把无效路径直接交给系统打印接口
#[cfg(any(target_os = "macos", target_os = "linux", test))]
fn validate_output_path(path: &str) -> Result<std::path::PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("导出路径不能为空".to_string());
    }
    let path_buf = std::path::PathBuf::from(trimmed);
    if let Some(parent) = path_buf.parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            return Err(format!("目标目录不存在：{}", parent.display()));
        }
    }
    Ok(path_buf)
}

/// 校验磁盘上实际生成的 PDF 文件存在、非空且带有合法 PDF 文件头
#[cfg(any(target_os = "macos", target_os = "linux", test))]
fn verify_written_pdf(path: &std::path::Path) -> Result<(), String> {
    use std::io::Read;

    let metadata = std::fs::metadata(path)
        .map_err(|_| "写入 PDF 失败，请确认目标位置可写".to_string())?;
    if !metadata.is_file() || metadata.len() < 5 {
        return Err("生成的 PDF 文件为空，请重试".to_string());
    }
    let mut header = [0u8; 5];
    let mut file = std::fs::File::open(path)
        .map_err(|e| format!("无法校验生成的 PDF 文件：{e}"))?;
    file.read_exact(&mut header)
        .map_err(|_| "生成的 PDF 文件不完整，请重试".to_string())?;
    if &header != b"%PDF-" {
        return Err("生成的 PDF 文件格式异常，请重试".to_string());
    }
    Ok(())
}

/// 把本地路径转成标准 percent-encoded `file://` URI（供 Linux GTK 打印输出路径使用）
#[cfg(any(target_os = "linux", test))]
fn path_to_file_uri(path: &std::path::Path) -> Result<(std::path::PathBuf, String), String> {
    let abs_path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| format!("无法解析当前目录：{e}"))?
            .join(path)
    };
    let uri = url::Url::from_file_path(&abs_path)
        .map_err(|_| "导出路径无效".to_string())?
        .to_string();
    Ok((abs_path, uri))
}

#[cfg(target_os = "linux")]
mod linux_impl {
    use std::cell::RefCell;
    use std::path::PathBuf;
    use std::rc::Rc;

    use tokio::sync::oneshot;
    use webkit2gtk::{PrintOperation, PrintOperationExt, Settings, SettingsExt, WebViewExt};

    use super::{path_to_file_uri, validate_output_path, verify_written_pdf};

    /// 页边距（英寸）：上下约 15mm、左右约 14mm，与 Windows / macOS 保持一致
    const MARGIN_VERTICAL_IN: f64 = 0.6;
    const MARGIN_HORIZONTAL_IN: f64 = 0.55;

    struct CompletionState {
        reply: oneshot::Sender<Result<(), String>>,
        path: PathBuf,
        // 异步打印期间持有 PrintOperation，结束后释放以打破信号闭包的循环引用
        operation: Option<PrintOperation>,
        // 临时开启背景色打印时记录原设置，完成后恢复
        restore_backgrounds: Option<Settings>,
    }

    impl CompletionState {
        fn restore_and_release(&mut self) {
            if let Some(settings) = self.restore_backgrounds.take() {
                settings.set_print_backgrounds(false);
            }
            let _ = self.operation.take();
        }
    }

    pub async fn print_to_pdf(webview: tauri::Webview, path: String) -> Result<(), String> {
        let path_buf = validate_output_path(&path)?;
        let (abs_path, output_uri) = path_to_file_uri(&path_buf)?;
        let (tx, rx) = oneshot::channel();

        // GTK 与 WebKitGTK 打印接口必须在 GTK 主线程调用
        webview
            .with_webview(move |platform| {
                let wk_webview = platform.inner();

                let paper_size = gtk::PaperSize::new(Some(gtk::PAPER_NAME_A4.as_str()));
                let page_setup = gtk::PageSetup::new();
                page_setup.set_paper_size(&paper_size);
                page_setup.set_orientation(gtk::PageOrientation::Portrait);
                page_setup.set_top_margin(MARGIN_VERTICAL_IN, gtk::Unit::Inch);
                page_setup.set_bottom_margin(MARGIN_VERTICAL_IN, gtk::Unit::Inch);
                page_setup.set_left_margin(MARGIN_HORIZONTAL_IN, gtk::Unit::Inch);
                page_setup.set_right_margin(MARGIN_HORIZONTAL_IN, gtk::Unit::Inch);

                let print_settings = gtk::PrintSettings::new();
                // GTK 3 的文件虚拟打印机名称经 gtk30 翻译域本地化（中文环境为「打印到文件」），须与运行期语言一致
                let file_printer = gtk::glib::dgettext(Some("gtk30"), "Print to File");
                print_settings.set_printer(file_printer.as_str());
                print_settings.set_paper_size(&paper_size);
                print_settings.set_orientation(gtk::PageOrientation::Portrait);
                print_settings.set(gtk::PRINT_SETTINGS_OUTPUT_FILE_FORMAT.as_str(), Some("pdf"));
                print_settings.set(
                    gtk::PRINT_SETTINGS_OUTPUT_URI.as_str(),
                    Some(output_uri.as_str()),
                );

                // 导出期间开启背景色打印，保留代码块、表格底色，完成后恢复原状态
                let restore_backgrounds = wk_webview.settings().and_then(|settings| {
                    if !settings.is_print_backgrounds() {
                        settings.set_print_backgrounds(true);
                        Some(settings)
                    } else {
                        None
                    }
                });

                let print_op = PrintOperation::new(&wk_webview);
                print_op.set_page_setup(&page_setup);
                print_op.set_print_settings(&print_settings);

                // WebKitGTK 在 failed 之后仍可能再发 finished，通过一次性 take 保证只回报一次结果
                let state = Rc::new(RefCell::new(Some(CompletionState {
                    reply: tx,
                    path: abs_path,
                    operation: Some(print_op.clone()),
                    restore_backgrounds,
                })));

                let state_failed = state.clone();
                print_op.connect_failed(move |_op, error| {
                    if let Some(mut completion) = state_failed.borrow_mut().take() {
                        completion.restore_and_release();
                        let _ = completion.reply.send(Err(format!("导出 PDF 失败：{error}")));
                    }
                });

                let state_finished = state.clone();
                print_op.connect_finished(move |_op| {
                    if let Some(mut completion) = state_finished.borrow_mut().take() {
                        completion.restore_and_release();
                        let outcome = verify_written_pdf(&completion.path);
                        let _ = completion.reply.send(outcome);
                    }
                });

                print_op.print();
            })
            .map_err(|e| format!("无法访问窗口 WebView：{e}"))?;

        rx.await.map_err(|_| "导出 PDF 被中断".to_string())?
    }
}

#[cfg(target_os = "macos")]
mod macos_impl {
    use std::cell::{Cell, RefCell};
    use std::ffi::c_void;
    use std::panic::AssertUnwindSafe;
    use std::path::PathBuf;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool, NSObject, NSObjectProtocol};
    use objc2::{
        define_class, exception, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly,
    };
    use objc2_app_kit::{
        NSPaperOrientation, NSPrintHeaderAndFooter, NSPrintInfo, NSPrintJobSavingURL,
        NSPrintOperation, NSPrintSaveJob, NSPrintingPaginationMode, NSWindow,
    };
    use objc2_foundation::{NSCopying, NSNumber, NSPoint, NSRect, NSSize, NSURL};
    use objc2_web_kit::{WKPreferences, WKWebView};
    use tokio::sync::oneshot;

    use super::{validate_output_path, verify_written_pdf};

    /// A4 纸张尺寸（点，72 pt/in），与 Windows 导出尺寸一致
    const PAGE_WIDTH_PT: f64 = 595.28;
    const PAGE_HEIGHT_PT: f64 = 841.89;
    /// 页边距（点）：上下 0.6 in（约 15mm）、左右 0.55 in（约 14mm），与 Windows 保持一致
    const MARGIN_VERTICAL_PT: f64 = 43.2;
    const MARGIN_HORIZONTAL_PT: f64 = 39.6;

    struct PrintPdfDelegateIvars {
        completed: Cell<bool>,
        reply: RefCell<Option<oneshot::Sender<Result<(), String>>>>,
        path: PathBuf,
        // 异步执行期间强持有 NSPrintOperation，防止在 didRunSelector 回调前提前释放
        operation: RefCell<Option<Retained<NSPrintOperation>>>,
        // 记录导出前临时开启背景色打印的 WKPreferences，结束后恢复原状
        restore_backgrounds: RefCell<Option<Retained<WKPreferences>>>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = PrintPdfDelegateIvars]
        struct PrintPdfDelegate;

        unsafe impl NSObjectProtocol for PrintPdfDelegate {}

        impl PrintPdfDelegate {
            #[unsafe(method(printOperationDidRun:success:contextInfo:))]
            fn print_operation_did_run(
                &self,
                _operation: *mut NSPrintOperation,
                success: Bool,
                context_info: *mut c_void,
            ) {
                if self.ivars().completed.replace(true) {
                    return;
                }
                self.cleanup();
                let outcome = if success.as_bool() {
                    verify_written_pdf(&self.ivars().path)
                } else {
                    Err("写入 PDF 失败，请确认目标位置可写".to_string())
                };
                if let Some(tx) = self.ivars().reply.borrow_mut().take() {
                    let _ = tx.send(outcome);
                }
                // 回收启动时移交的 +1 引用并放入自动释放池，确保回调返回前不会销毁 self
                if !context_info.is_null() {
                    if let Some(retained) =
                        unsafe { Retained::from_raw(context_info as *mut Self) }
                    {
                        let _ = Retained::autorelease_ptr(retained);
                    }
                }
            }
        }
    );

    impl PrintPdfDelegate {
        fn new(
            mtm: MainThreadMarker,
            reply: oneshot::Sender<Result<(), String>>,
            path: PathBuf,
            operation: Retained<NSPrintOperation>,
            restore_backgrounds: Option<Retained<WKPreferences>>,
        ) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(PrintPdfDelegateIvars {
                completed: Cell::new(false),
                reply: RefCell::new(Some(reply)),
                path,
                operation: RefCell::new(Some(operation)),
                restore_backgrounds: RefCell::new(restore_backgrounds),
            });
            unsafe { msg_send![super(this), init] }
        }

        /// 恢复临时修改的偏好设置，并把持有的 NSPrintOperation 交给当前自动释放池
        fn cleanup(&self) {
            if let Some(preferences) = self.ivars().restore_backgrounds.borrow_mut().take() {
                unsafe {
                    preferences.setShouldPrintBackgrounds(false);
                }
            }
            if let Some(operation) = self.ivars().operation.borrow_mut().take() {
                let _ = Retained::autorelease_ptr(operation);
            }
        }
    }

    pub async fn print_to_pdf(webview: tauri::Webview, path: String) -> Result<(), String> {
        let path_buf = validate_output_path(&path)?;
        let (tx, rx) = oneshot::channel();

        // WKWebView 与 AppKit 打印接口只能在主线程调用，完成回调同样回到主线程
        webview
            .with_webview(move |platform| {
                if let Err((tx, message)) = start(platform, path_buf, tx) {
                    let _ = tx.send(Err(message));
                }
            })
            .map_err(|e| format!("无法访问窗口 WebView：{e}"))?;

        rx.await.map_err(|_| "导出 PDF 被中断".to_string())?
    }

    fn start(
        platform: tauri::webview::PlatformWebview,
        path_buf: PathBuf,
        tx: oneshot::Sender<Result<(), String>>,
    ) -> Result<(), (oneshot::Sender<Result<(), String>>, String)> {
        let Some(mtm) = MainThreadMarker::new() else {
            return Err((tx, "导出 PDF 必须在主线程执行".to_string()));
        };
        if NSPrintOperation::currentOperation(mtm).is_some() {
            return Err((tx, "已有打印或导出任务正在进行，请稍后再试".to_string()));
        }

        let webview_ptr = platform.inner();
        if webview_ptr.is_null() {
            return Err((tx, "无法访问窗口 WebView".to_string()));
        }
        let wk_webview = unsafe { &*(webview_ptr as *const WKWebView) };
        if !wk_webview.respondsToSelector(sel!(printOperationWithPrintInfo:)) {
            return Err((tx, "当前系统 WebKit 版本不支持直接导出 PDF".to_string()));
        }

        // 优先取 WebView 挂接的 NSWindow，取不到时回退到 Tauri 提供的窗口句柄
        let owned_window = wk_webview.window();
        let fallback_window = if owned_window.is_none() {
            let ptr = platform.ns_window();
            if ptr.is_null() {
                None
            } else {
                Some(unsafe { &*(ptr as *const NSWindow) })
            }
        } else {
            None
        };
        let Some(window) = owned_window.as_deref().or(fallback_window) else {
            return Err((tx, "无法获取所属窗口，无法导出 PDF".to_string()));
        };

        let Some(file_url) = NSURL::from_file_path(&path_buf) else {
            return Err((tx, "导出路径无效".to_string()));
        };

        // 拷贝共享打印配置，避免污染应用全局打印状态；设置为 A4 纵向、直接保存为 PDF、无页眉页脚
        let print_info = NSPrintInfo::sharedPrintInfo().copy();
        print_info.setPaperSize(NSSize::new(PAGE_WIDTH_PT, PAGE_HEIGHT_PT));
        print_info.setOrientation(NSPaperOrientation::Portrait);
        print_info.setTopMargin(MARGIN_VERTICAL_PT);
        print_info.setBottomMargin(MARGIN_VERTICAL_PT);
        print_info.setLeftMargin(MARGIN_HORIZONTAL_PT);
        print_info.setRightMargin(MARGIN_HORIZONTAL_PT);
        print_info.setHorizontalPagination(NSPrintingPaginationMode::Fit);
        print_info.setVerticalPagination(NSPrintingPaginationMode::Automatic);
        print_info.setHorizontallyCentered(false);
        print_info.setVerticallyCentered(false);
        print_info.setJobDisposition(unsafe { NSPrintSaveJob });

        let dict = unsafe { print_info.dictionary() };
        let no_header = NSNumber::new_bool(false);
        let file_url_obj: &AnyObject = &file_url;
        let no_header_obj: &AnyObject = &no_header;
        dict.insert(unsafe { NSPrintJobSavingURL }, file_url_obj);
        dict.insert(unsafe { NSPrintHeaderAndFooter }, no_header_obj);

        // macOS 13.3+ 支持通过 WKPreferences 开启背景色打印，低版本跳过以免触发未识别 selector
        let restore_backgrounds = unsafe {
            let preferences = wk_webview.configuration().preferences();
            if preferences.respondsToSelector(sel!(shouldPrintBackgrounds))
                && preferences.respondsToSelector(sel!(setShouldPrintBackgrounds:))
                && !preferences.shouldPrintBackgrounds()
            {
                preferences.setShouldPrintBackgrounds(true);
                Some(preferences)
            } else {
                None
            }
        };

        let print_operation =
            match exception::catch(AssertUnwindSafe(|| unsafe {
                wk_webview.printOperationWithPrintInfo(&print_info)
            })) {
                Ok(op) => op,
                Err(exc) => {
                    if let Some(preferences) = restore_backgrounds {
                        unsafe {
                            preferences.setShouldPrintBackgrounds(false);
                        }
                    }
                    let detail = exc
                        .map(|e| format!("{e}"))
                        .unwrap_or_else(|| "未知系统异常".to_string());
                    return Err((tx, format!("创建 PDF 导出任务失败：{detail}")));
                }
            };

        // 静默直出 PDF：隐藏系统打印与进度面板，并固定在主线程运行循环执行（避免 WKPrintingView 跨线程异常）
        print_operation.setShowsPrintPanel(false);
        print_operation.setShowsProgressPanel(false);
        print_operation.setCanSpawnSeparateThread(false);

        // 显式初始化 WKPrintingView 的 frame 为纸张尺寸，防止 knowsPageRange 零尺寸报错与空白页
        if let Some(view) = print_operation.view() {
            view.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), print_info.paperSize()));
        }

        let delegate = PrintPdfDelegate::new(
            mtm,
            tx,
            path_buf,
            print_operation.clone(),
            restore_backgrounds,
        );
        // NSPrintOperation 对 delegate 仅弱引用，把额外 +1 所有权放入 contextInfo，待回调完成回收
        let context_info = Retained::into_raw(delegate.clone()) as *mut c_void;
        let delegate_obj: &AnyObject = &delegate;

        // 必须通过 runOperationModalForWindow 驱动异步运行循环，否则 WKWebView 同步 runOperation 会产出空白页
        let run_result = exception::catch(AssertUnwindSafe(|| unsafe {
            print_operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                window,
                Some(delegate_obj),
                Some(sel!(printOperationDidRun:success:contextInfo:)),
                context_info,
            );
        }));
        if let Err(exc) = run_result {
            if !delegate.ivars().completed.replace(true) {
                delegate.cleanup();
                let _ = unsafe { Retained::from_raw(context_info as *mut PrintPdfDelegate) };
                let detail = exc
                    .map(|e| format!("{e}"))
                    .unwrap_or_else(|| "未知系统异常".to_string());
                if let Some(tx) = delegate.ivars().reply.borrow_mut().take() {
                    let _ = tx.send(Err(format!("导出 PDF 失败：{detail}")));
                }
            }
        }
        Ok(())
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

#[cfg(test)]
mod tests {
    use super::{path_to_file_uri, validate_output_path, verify_written_pdf};

    #[test]
    fn validate_output_path_rejects_empty_and_missing_parent() {
        assert!(validate_output_path("   ").is_err());

        let temp_dir = tempfile::tempdir().unwrap();
        let missing = temp_dir.path().join("non-existent-sub").join("out.pdf");
        assert!(validate_output_path(missing.to_str().unwrap()).is_err());

        let valid = temp_dir.path().join("out.pdf");
        assert_eq!(validate_output_path(valid.to_str().unwrap()).unwrap(), valid);
    }

    #[test]
    fn verify_written_pdf_checks_existence_size_and_header() {
        let temp_dir = tempfile::tempdir().unwrap();
        let missing = temp_dir.path().join("missing.pdf");
        assert!(verify_written_pdf(&missing).is_err());

        let empty = temp_dir.path().join("empty.pdf");
        std::fs::write(&empty, b"").unwrap();
        assert!(verify_written_pdf(&empty).is_err());

        let invalid = temp_dir.path().join("invalid.pdf");
        std::fs::write(&invalid, b"not a pdf").unwrap();
        assert!(verify_written_pdf(&invalid).is_err());

        let valid = temp_dir.path().join("valid.pdf");
        std::fs::write(&valid, b"%PDF-1.4\n%%EOF\n").unwrap();
        assert!(verify_written_pdf(&valid).is_ok());
    }

    #[test]
    fn path_to_file_uri_encodes_spaces_and_unicode() {
        let temp_dir = tempfile::tempdir().unwrap();
        let target = temp_dir.path().join("测试 笔记.pdf");
        let (abs, uri) = path_to_file_uri(&target).unwrap();
        assert!(abs.is_absolute());
        assert!(uri.starts_with("file:///"));
        assert!(uri.contains("%20"));
        assert!(uri.ends_with(".pdf"));
    }
}
