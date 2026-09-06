// NoteBoard 统一文件准备服务（S07 G 节）
//
// 🔴 执行次序固定（G 节）：
//   1. 工作线程规范化 key（canonicalize 涉及文件系统，不在锁内）
//   2. 短锁查归属（documents + 在途 pending_prepares）→ 已打开/在途在读盘前返回，
//      不重复读盘、不覆盖脏内容
//   3. 短锁插入在途标记（并发第二请求按 AlreadyOpen(self) 激活）
//   4. blocking worker：metadata + 文本前缀检查 + 小文本复用同一流程读入解码
//   5. 短锁移除在途标记 → 返回判别结果
// 🔴 约束：全局 Mutex 只保护短状态操作，不跨 await 或读盘持有；
//    readDir/probe/exists 的工作不在 registry 锁内执行。

use crate::dto::{DocumentPayload, DocumentKind, PreparedDocument};
use crate::path as nbpath;
use crate::state::AppState;
use std::path::Path;
use std::sync::Mutex;
use tauri::State;

use super::read;

/// 统一文件准备（async command；全部 IO 在 blocking worker）
#[tauri::command]
pub async fn prepare_document(
    state: State<'_, Mutex<AppState>>,
    label: String,
    path: String,
) -> Result<PreparedDocument, String> {
    // 1. 工作线程规范化 key（canonicalize 访问文件系统）
    let raw_path = path.clone();
    let key = tauri::async_runtime::spawn_blocking(move || nbpath::normalize_key(&raw_path))
        .await
        .map_err(|e| format!("prepare_error:{e}"))?;
    let lower_key = nbpath::lower_key(&key);

    // 2. 短锁查归属：已注册文档或本窗口在途准备/注册预约 → 读盘前直接返回
    {
        let mut s = state.lock().unwrap();
        if let Some(record) = s.documents.get(&lower_key) {
            let owner_is_self = record.owner_window == label;
            return Ok(PreparedDocument::AlreadyOpen {
                key: key.clone(),
                owner_label: record.owner_window.clone(),
                owner_is_self,
            });
        }
        // 🔴 N05：在途读盘与注册预约（TTL 内）同样按 AlreadyOpen 激活——
        //    消除"prepare 返回到 register 之间"的归属空窗（并发第二请求不双开）
        if let Some(owner) = s.live_pending_prepare(&lower_key) {
            let owner_is_self = owner == label;
            return Ok(PreparedDocument::AlreadyOpen {
                key: key.clone(),
                owner_label: owner,
                owner_is_self,
            });
        }
    }

    // 3. 短锁插入在途标记（读盘期间的去重）
    {
        let mut s = state.lock().unwrap();
        // 双重检查：等待锁期间可能已被并发请求插入
        if let Some(record) = s.documents.get(&lower_key) {
            let owner_is_self = record.owner_window == label;
            return Ok(PreparedDocument::AlreadyOpen {
                key: key.clone(),
                owner_label: record.owner_window.clone(),
                owner_is_self,
            });
        }
        // 🔴 R04：读取真实在途发起者（不冒充当前请求者）——并发第二请求按真实 owner 激活/聚焦
        if let Some(inflight_owner) = s.live_pending_prepare(&lower_key) {
            let owner_is_self = inflight_owner == label;
            return Ok(PreparedDocument::AlreadyOpen {
                key: key.clone(),
                owner_label: inflight_owner,
                owner_is_self,
            });
        }
        s.pending_prepares.insert(
            lower_key.clone(),
            crate::state::PendingPrepare {
                owner: label.clone(),
                reserved: false,
                at: std::time::Instant::now(),
            },
        );
    }

    // 4. blocking worker：metadata + 前缀检查 + 读入
    let io_path = path.clone();
    let io_key = key.clone();
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        prepare_on_worker(&io_path, &io_key)
    })
    .await
    .map_err(|e| format!("prepare_error:{e}"));

    // 5. 🔴 N05 预约生命周期：读盘完成且结果将被前端注册（Text/Image/Unsupported）→
    //    在途标记转为注册预约（保留 pending，等待 register_document 兑现）；失败
    //    （Failed/Directory/系统错误）释放。预约期间并发第二请求仍按 AlreadyOpen 激活；
    //    前端崩溃不注册由 TTL 惰性清理。
    {
        let mut s = state.lock().unwrap();
        let keep_reservation = matches!(
            prepared,
            Ok(Ok(PreparedDocument::Text { .. }))
                | Ok(Ok(PreparedDocument::Image { .. }))
                | Ok(Ok(PreparedDocument::Unsupported { .. }))
        );
        if keep_reservation {
            if let Some(p) = s.pending_prepares.get_mut(&lower_key) {
                if p.owner == label {
                    p.reserved = true;
                    p.at = std::time::Instant::now();
                }
            }
        } else {
            // Failed/Directory/系统错误：释放自己的在途标记
            if let Some(p) = s.pending_prepares.get(&lower_key) {
                if p.owner == label {
                    s.pending_prepares.remove(&lower_key);
                }
            }
        }
    }

    // 双层 Result 摊平：worker 返回 Ok(判别结果) 或 Err(系统错误)
    match prepared {
        Ok(inner) => inner,
        Err(e) => Err(e),
    }
}

/// 工作线程判别与读取（无锁；复用既有 read::read_file 的编码检测与解码）
fn prepare_on_worker(path: &str, key: &str) -> Result<PreparedDocument, String> {
    let p = Path::new(path);

    let metadata = match std::fs::metadata(p) {
        Ok(meta) => meta,
        Err(error) => {
            let missing = error.kind() == std::io::ErrorKind::NotFound;
            return Ok(PreparedDocument::Failed {
                message: format!("文件不存在或无法访问: {path}"),
                missing,
            });
        }
    };

    if metadata.is_dir() {
        return Ok(PreparedDocument::Directory {
            path: path.to_string(),
        });
    }

    let (kind, language) = crate::dto::kind_from_path(path);
    let display_name = nbpath::basename(path);
    let dir_path = nbpath::parent_dir(path).unwrap_or_default();
    let size = metadata.len();
    let mtime = metadata
        .modified()
        .map(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64
        })
        .unwrap_or(0);

    match kind {
        // 图片走资源协议按路径解码，不读正文
        DocumentKind::Image => Ok(PreparedDocument::Image {
            key: key.to_string(),
            display_name,
            dir_path,
            language: "plaintext".to_string(),
            size,
            mtime,
        }),
        // 专有二进制（XMind/Excalidraw 场景文件等）走原 kind 映射：
        // board/drawio/bitable/mindmap 本身是文本或专有格式的按现有规则回退 unsupported
        _ => {
            let is_text = read::is_text_file(p).unwrap_or(false);
            if !is_text {
                return Ok(PreparedDocument::Unsupported {
                    key: key.to_string(),
                    display_name,
                    dir_path,
                    language: "plaintext".to_string(),
                    size,
                });
            }
            // 文本：读入并解码（编码检测/只读判定在 read_file 内完成）
            match read::read_file(p) {
                Ok(result) => Ok(PreparedDocument::Text {
                    payload: DocumentPayload {
                        key: key.to_string(),
                        display_name,
                        dir_path,
                        kind,
                        language,
                        content: Some(result.content),
                        encoding: result.encoding,
                        eol: result.eol,
                        size: result.size,
                        mtime: result.mtime,
                        readonly: result.readonly,
                    },
                }),
                Err(message) => Ok(PreparedDocument::Failed {
                    message,
                    missing: false,
                }),
            }
        }
    }
}
