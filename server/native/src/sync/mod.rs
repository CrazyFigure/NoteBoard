// 直接编译原项目模块，保持同步协议、远端适配、三方合并和备份算法唯一实现。
#[path = "../../../../src-tauri/src/sync/backend/mod.rs"] pub mod backend;
#[path = "../../../../src-tauri/src/sync/backup.rs"] pub mod backup;
#[path = "../../../../src-tauri/src/sync/config.rs"] pub mod config;
#[path = "../../../../src-tauri/src/sync/diff3.rs"] pub mod diff3;
#[path = "../../../../src-tauri/src/sync/engine.rs"] pub mod engine;
#[path = "../../../../src-tauri/src/sync/error.rs"] pub mod error;
#[path = "../../../../src-tauri/src/sync/hooks.rs"] pub mod hooks;
#[path = "../../../../src-tauri/src/sync/manifest.rs"] pub mod manifest;
#[path = "../../../../src-tauri/src/sync/plan.rs"] pub mod plan;
#[path = "../../../../src-tauri/src/sync/scheduler.rs"] pub mod scheduler;
#[path = "../../../../src-tauri/src/sync/state.rs"] pub mod state;
#[path = "../../../../src-tauri/src/sync/trash.rs"] pub mod trash;
#[path = "../../../../src-tauri/src/sync/types.rs"] pub mod types;
#[path = "../../../../src-tauri/src/sync/util.rs"] pub mod util;

// 容器配置通过仅当前服务用户可读的文件保护，不使用 Windows DPAPI。
pub mod secret {
    use base64::{engine::general_purpose::STANDARD, Engine};
    pub fn protect(value: &str) -> String { if value.is_empty() { String::new() } else { format!("b64:{}", STANDARD.encode(value)) } }
    pub fn unprotect(value: &str) -> String { value.strip_prefix("b64:").map(|encoded| STANDARD.decode(encoded).ok().and_then(|bytes| String::from_utf8(bytes).ok()).unwrap_or_default()).unwrap_or_else(|| value.to_owned()) }
}

pub mod runtime {
    use std::future::Future;
    use std::sync::OnceLock;
    pub trait EventSink: Send + Sync + 'static { fn emit_json(&self, event: &str, payload: serde_json::Value); }
    // 同一个 Tokio 运行时供主命令线程和原调度线程复用，避免每次请求重建连接池执行器。
    pub fn block_on<F: Future>(future: F) -> F::Output {
        static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
        RUNTIME.get_or_init(|| tokio::runtime::Runtime::new().expect("创建同步运行时失败")).block_on(future)
    }
}

#[cfg(test)]
#[path = "../../../../src-tauri/src/sync/tests_e2e.rs"] mod tests_e2e;
