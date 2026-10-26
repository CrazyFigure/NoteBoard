// Windows 标签拖动的启动调度；不替换系统目标命中，也不轮询鼠标或窗口坐标。
use std::{cell::RefCell, collections::HashMap};
use windows::Win32::{
    Foundation::HWND,
    UI::WindowsAndMessaging::{KillTimer, SetTimer, USER_TIMER_MINIMUM},
};

// 任务只在创建它的 UI 线程执行；计时器编号由系统分配，回调先移除再执行以保证只启动一次。
thread_local! {
    static PENDING_STARTS: RefCell<HashMap<usize, Box<dyn FnOnce()>>> = RefCell::new(HashMap::new());
}

/// 投递到下一次原生消息分发，先让当前 Tao 回调归还事件处理器。
/// 不能改成 run_on_main_thread 再嵌套：它仍在 Tao 回调内，DoDragDrop 期间的事件会被缓存到松手。
pub(super) fn defer_start(start: impl FnOnce() + 'static) -> Result<(), String> {
    // 使用系统允许的最短计时周期；目的是退出回调，不依靠固定等待猜测拖动何时完成。
    let timer = unsafe { SetTimer(None, 0, USER_TIMER_MINIMUM, Some(start_on_native_message)) };
    if timer == 0 {
        return Err("无法调度原生标签拖动".into());
    }
    PENDING_STARTS.with(|pending| pending.borrow_mut().insert(timer, Box::new(start)));
    Ok(())
}

/// DispatchMessage 直接调用此回调，OLE 内部继续泵送的 Tauri 悬停/IPC 消息因而可以即时处理。
unsafe extern "system" fn start_on_native_message(_: HWND, _: u32, timer: usize, _: u32) {
    let _ = KillTimer(None, timer);
    let start = PENDING_STARTS.with(|pending| pending.borrow_mut().remove(&timer));
    if let Some(start) = start {
        // Rust 异常不能跨 Win32 ABI；任务被释放时也会断开结果通道，让调用方按失败保留源标签。
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(start)).is_err() {
            log::error!("启动原生标签拖动时发生异常");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{
            atomic::{AtomicBool, Ordering},
            mpsc, Arc,
        },
        time::{Duration, Instant},
    };
    use tao::{
        event::{Event, StartCause},
        event_loop::{ControlFlow, EventLoopBuilder},
        platform::{run_return::EventLoopExtRunReturn, windows::EventLoopBuilderExtWindows},
    };
    use windows::Win32::UI::WindowsAndMessaging::{DispatchMessageW, PeekMessageW, MSG, PM_REMOVE};

    /// 真实 Tao 循环中模拟同步原生拖动，返回悬停代理事件是否在嵌套循环结束前送达。
    fn messages_during_native_loop(deferred: bool) -> bool {
        std::thread::spawn(move || {
            // 直接验证 Tauri 所用的 Tao 事件循环；不创建 WebView、不读取用户目录。
            let mut event_loop = EventLoopBuilder::<bool>::with_user_event()
                .with_any_thread(true)
                .build();
            let proxy = event_loop.create_proxy();
            let delivered = Arc::new(AtomicBool::new(false));
            let received = delivered.clone();
            let (result_tx, result_rx) = mpsc::channel();
            let mut result_tx = Some(result_tx);
            event_loop.run_return(move |event, _, flow| {
                *flow = ControlFlow::Wait;
                // false 模拟悬停代理事件，true 只在嵌套循环结束后退出测试。
                if let Event::UserEvent(finished) = event {
                    if finished {
                        *flow = ControlFlow::Exit;
                    } else {
                        received.store(true, Ordering::SeqCst);
                    }
                }
                if !matches!(event, Event::NewEvents(StartCause::Init)) {
                    return;
                }
                let delivered = delivered.clone();
                let proxy = proxy.clone();
                let result_tx = result_tx.take().unwrap();
                // Init 本身处于 Tao 回调内，与 start_tab_drag 的主线程任务有相同的重入约束。
                let start = move || {
                    let worker_proxy = proxy.clone();
                    let worker = std::thread::spawn(move || {
                        worker_proxy.send_event(false).unwrap();
                    });
                    let deadline = Instant::now() + Duration::from_secs(3);
                    // 与 OLE 一样持续分发原生消息；只用截止时间避免回归时测试永久挂起。
                    while !delivered.load(Ordering::SeqCst) && Instant::now() < deadline {
                        let mut message = MSG::default();
                        if unsafe { PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() } {
                            unsafe {
                                DispatchMessageW(&message);
                            }
                        }
                        std::thread::sleep(Duration::from_millis(1));
                    }
                    worker.join().unwrap();
                    let _ = result_tx.send(delivered.load(Ordering::SeqCst));
                    proxy.send_event(true).unwrap();
                };
                if deferred {
                    defer_start(start).unwrap();
                } else {
                    start();
                }
            });
            PENDING_STARTS.with(|pending| assert!(pending.borrow().is_empty()));
            result_rx.recv().unwrap()
        })
        .join()
        .unwrap()
    }

    /// 同一消息链路先复现旧启动方式的阻塞，再验证延后启动在松手前实时送达。
    #[test]
    fn framework_messages_arrive_before_the_native_loop_returns() {
        assert!(
            !messages_during_native_loop(false),
            "旧回调内启动应复现事件被缓存"
        );
        assert!(
            messages_during_native_loop(true),
            "原生循环结束前必须送达悬停使用的代理事件"
        );
    }
}
