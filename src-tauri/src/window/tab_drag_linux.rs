// GTK 3 原生标签拖放：使用窗口局部落点，X11/Wayland 共用，不查询全局鼠标坐标。
use gtk::{
    gdk,
    glib::{self, ObjectExt, Propagation, SignalHandlerId},
    prelude::*,
};
use std::{
    cell::{Cell, RefCell},
    path::PathBuf,
    rc::Rc,
    time::Duration,
};
use tauri::WebviewWindow;

// 私有 MIME 不向桌面公开文件 URI；info 取 NBTB，避开 Wry 文件拖放使用的 2。
const TAB_MIME: &str = "application/x-noteboard-tab";
const TAB_TARGET_INFO: u32 = 0x4e425442;

/// GTK 只传递局部物理坐标和一次性票据字节，父层负责核验当前拖动会话。
pub(super) enum TabTargetEvent {
    Enter(f64, f64),
    Over(f64, f64),
    Leave,
    Drop(Vec<u8>, f64, f64),
}

/// 每个 WebView 创建时装配一次私有目标；原有 URI 目标和文件拖放监听均保留。
pub(super) fn attach_target(
    view: &webkit2gtk::WebView,
    on_event: impl Fn(TabTargetEvent) + 'static,
) {
    let atom = gdk::Atom::intern(TAB_MIME);
    let targets = view
        .drag_dest_get_target_list()
        .unwrap_or_else(|| gtk::TargetList::new(&[]));
    targets.add(&atom, gtk::TargetFlags::SAME_APP.bits(), TAB_TARGET_INFO);
    view.drag_dest_set_target_list(Some(&targets));
    let on_event = Rc::new(on_event);
    let entered = Rc::new(Cell::new(false));
    let on_motion = on_event.clone();
    let motion_entered = entered.clone();
    view.connect_drag_motion(move |view, context, x, y, time| {
        if !context.list_targets().contains(&atom) {
            return false;
        }
        let scale = view.scale_factor() as f64;
        if motion_entered.replace(true) {
            on_motion(TabTargetEvent::Over(x as f64 * scale, y as f64 * scale));
        } else {
            on_motion(TabTargetEvent::Enter(x as f64 * scale, y as f64 * scale));
        }
        context.drag_status(gdk::DragAction::COPY, time);
        true
    });
    view.connect_drag_drop(move |view, context, _, _, time| {
        if !context.list_targets().contains(&atom) {
            return false;
        }
        view.drag_get_data(context, &atom, time);
        true
    });
    let on_drop = on_event.clone();
    view.connect_drag_data_received(move |view, context, x, y, data, info, time| {
        if info != TAB_TARGET_INFO {
            return;
        }
        let scale = view.scale_factor() as f64;
        on_drop(TabTargetEvent::Drop(
            data.data(),
            x as f64 * scale,
            y as f64 * scale,
        ));
        // 票据不移动文件；正文接管仍须等待迁移协议的 committed。
        context.drag_finish(true, false, time);
    });
    view.connect_drag_leave(move |_, _, _| {
        if entered.replace(false) {
            on_event(TabTargetEvent::Leave);
        }
    });
}

/// 为下一次真实鼠标移动准备拖放；不能在异步 IPC 回调中直接启动 Wayland 拖放。
pub(super) fn start_native(
    window: &WebviewWindow,
    path: PathBuf,
    image: Vec<u8>,
    done: impl Fn(bool, Option<(i32, i32)>) + Send + 'static,
) -> Result<(), String> {
    window
        .with_webview(move |platform| {
            let view = platform.inner();
            let done = Rc::new(done);
            let finished = Rc::new(Cell::new(false));
            let started = Rc::new(Cell::new(false));
            let handlers = Rc::new(RefCell::new(Vec::<SignalHandlerId>::new()));
            let finish = {
                let done = done.clone();
                let finished = finished.clone();
                let handlers = handlers.clone();
                let view = view.clone();
                Rc::new(move |cancelled: bool| {
                    // drag-failed 后仍可能收到 drag-end，回调只能执行一次。
                    if finished.replace(true) {
                        return;
                    }
                    done(cancelled, None);
                    let view = view.clone();
                    let handlers = handlers.clone();
                    glib::idle_add_local_once(move || {
                        for id in handlers.borrow_mut().drain(..) {
                            view.disconnect(id);
                        }
                    });
                })
            };
            use std::os::unix::ffi::OsStrExt;
            let ticket = path.as_os_str().as_bytes().to_vec();
            // 私有目标仅取得随机票据，不提供 text/uri-list，外部文件管理器不会生成临时文件。
            handlers
                .borrow_mut()
                .push(view.connect_drag_data_get(move |_, _, data, _, _| {
                    data.set(&gdk::Atom::intern(TAB_MIME), 8, &ticket);
                }));
            let on_failed = finish.clone();
            handlers
                .borrow_mut()
                .push(view.connect_drag_failed(move |_, _, reason| {
                    // NoTarget 是在窗口外松手，创建新窗；Escape、超时和协议错误均取消。
                    on_failed(reason != gtk::DragResult::NoTarget);
                    Propagation::Stop
                }));
            let on_end = finish.clone();
            handlers
                .borrow_mut()
                .push(view.connect_drag_end(move |_, _| on_end(false)));
            let on_motion = finish.clone();
            let motion_started = started.clone();
            let motion_finished = finished.clone();
            let targets = gtk::TargetList::new(&[gtk::TargetEntry::new(
                TAB_MIME,
                gtk::TargetFlags::SAME_APP,
                TAB_TARGET_INFO,
            )]);
            handlers
                .borrow_mut()
                .push(view.connect_motion_notify_event(move |view, event| {
                    if motion_finished.get() || motion_started.get() {
                        return Propagation::Proceed;
                    }
                    if !event.state().contains(gdk::ModifierType::BUTTON1_MASK) {
                        on_motion(true);
                        return Propagation::Proceed;
                    }
                    motion_started.set(true);
                    let context = view.drag_begin_with_coordinates(
                        &targets,
                        gdk::DragAction::COPY | gdk::DragAction::MOVE,
                        1,
                        Some(event),
                        -1,
                        -1,
                    );
                    if let Some(context) = context {
                        let loader = gtk::gdk_pixbuf::PixbufLoader::new();
                        if loader.write(&image).and_then(|_| loader.close()).is_ok() {
                            if let Some(pixbuf) = loader.pixbuf() {
                                context.drag_set_icon_pixbuf(&pixbuf, 0, 0);
                            }
                        }
                    } else {
                        on_motion(true);
                    }
                    Propagation::Stop
                }));
            // IPC 到达前已经松手时，不能把下次无关移动当作本次拖放；准备期最多 1.5 秒。
            glib::timeout_add_local_once(Duration::from_millis(1500), move || {
                if !started.get() {
                    finish(true);
                }
            });
        })
        .map_err(|e| e.to_string())
}
