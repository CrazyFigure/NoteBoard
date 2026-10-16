// 同步调度只依赖事件出口和异步执行器；桌面与网页进程复用相同业务流程。
use serde_json::Value;
use tauri::Emitter;

/// 事件出口必须能跨线程使用；业务层只传递 JSON，不依赖窗口或 HTTP 实现。
pub trait EventSink: Send + Sync + 'static {
    fn emit_json(&self, event: &str, payload: Value);
}

impl EventSink for tauri::AppHandle {
    fn emit_json(&self, event: &str, payload: Value) {
        let _ = self.emit(event, payload);
    }
}

// 原生端继续使用 Tauri 已有运行时，避免改变其线程与网络行为。
pub use tauri::async_runtime::block_on;
