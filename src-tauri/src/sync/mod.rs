// NoteBoard 多端同步与备份
//
// 模块分层：
//   config / secret      —— 配置与密钥本机加密
//   backend/*            —— WebDAV、S3、GitHub、Gitee、GitLab 远端适配
//   manifest / state     —— 远端同步清单与本机同步基线
//   plan / diff3         —— 合并决策（纯函数）与行级三方合并
//   engine               —— 一次完整同步的执行
//   trash / backup       —— 同步回收站、备份与恢复
//   scheduler / hooks    —— 后台调度线程、文件命令钩子
//   commands             —— IPC 命令

pub mod backend;
pub mod backup;
pub mod commands;
pub mod config;
pub mod diff3;
pub mod engine;
pub mod error;
pub mod hooks;
pub mod manifest;
pub mod plan;
pub mod scheduler;
pub mod secret;
pub mod state;
pub mod trash;
pub mod types;
pub mod util;

#[cfg(test)]
mod tests_e2e;
