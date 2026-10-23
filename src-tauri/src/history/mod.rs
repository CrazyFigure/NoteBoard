// NoteBoard 文档历史记录（版本历史）
//
// 模块分层：
//   model / store        —— 索引结构与内容寻址存储（gzip blob + 每文档索引）
//   identity             —— 路径 → 文档标识（改名跟随、删除后清理与重新关联）
//   stats / retention    —— 改动摘要统计、保留策略（纯函数）
//   config               —— 模式（关闭 / 仅本机 / 跨设备同步）与保留设置
//   service              —— 后台记录线程、合并窗口、查询与维护
//   hooks                —— 文件命令（写入 / 改名 / 删除）调用的钩子
//   commands             —— IPC 命令（仅原生宿主）
// 本模块不依赖 Tauri（commands 除外），网页服务的原生工作进程可直接复用。

pub mod catalog;
pub mod config;
pub mod hooks;
pub mod identity;
pub mod model;
pub mod retention;
pub mod service;
pub mod space;
pub mod stats;
pub mod store;

// 网页服务的工作进程按文件引用上述模块，不包含依赖 Tauri 的命令层
pub mod commands;

pub use service::init;

/// 当前 Unix 毫秒时间戳
pub fn now_ms() -> i64 {
    crate::sync::util::now_ms()
}
