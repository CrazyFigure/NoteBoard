// NoteBoard 窗口意图与打开请求队列 — 暂存、握手与确认（拉取模型 + 可靠队列）
// 🔴 S04 协议（docs/启动性能与低内存根治计划.md §C）：
//   1. 事件（nb://open-requests-available）仅唤醒消费，不携带路径、不直接打开；
//      Rust 队列是窗口存活期间的权威来源。
//   2. 握手（window_listeners_ready）在前端成功订阅必要事件后调用，分配 consumer 代际；
//      旧 consumer 后续的 list/ack 一律拒绝。
//   3. ack_open_request 幂等：无效 requestId / 非所属窗口 / 旧 consumer 均不修改其它请求。
//   4. 消费是非破坏读取：先 list → 业务处理有结果 → ack；处理失败也要完成失败显示后 ACK，
//      不让坏文件永久阻塞队列。
// 核心逻辑均实现为操作 &mut AppState 的纯函数（*_inner），便于无 Tauri 运行时的单元测试。

use crate::dto::{
    OpenRequestDto, OpenRequestItemDto, OpenRequestSource, WindowBootDto, WindowIntent,
};
use crate::state::AppState;
use std::sync::Mutex;
use tauri::State;

/// 单次拉取的默认批量上限（防止一次唤醒处理无限多请求占用主线程）
pub const OPEN_REQUEST_BATCH_LIMIT: usize = 32;

// ── 意图（Empty/AdoptDocuments 等非队列意图） ──

/// 暂存意图
pub fn put_intent(state: &State<'_, Mutex<AppState>>, label: String, intent: WindowIntent) {
    let mut s = state.lock().unwrap();
    s.intents.insert(label, intent);
}

/// 取走意图（取走即删）
pub fn take_intent(state: &State<'_, Mutex<AppState>>, label: &str) -> Option<WindowIntent> {
    let mut s = state.lock().unwrap();
    s.intents.remove(label)
}

// ── 打开请求队列 ──

/// 为指定窗口入队一批打开请求；返回（batchId, 入队后的队列版本）。
/// 同批路径按输入顺序分配 sequence；请求 ID 为字符串（避免 u64 超出 JS 精度）。
pub fn enqueue_open_requests(
    state: &State<'_, Mutex<AppState>>,
    label: &str,
    paths: Vec<String>,
    cwd: Option<String>,
    source: OpenRequestSource,
) -> (String, u64) {
    let mut s = state.lock().unwrap();
    enqueue_open_requests_inner(&mut s, label, paths, cwd, source)
}

/// 入队核心逻辑（锁内执行，不做任何耗时工作）
pub fn enqueue_open_requests_inner(
    s: &mut AppState,
    label: &str,
    paths: Vec<String>,
    cwd: Option<String>,
    source: OpenRequestSource,
) -> (String, u64) {
    let batch_id = format!("b-{}", s.next_request_seq);
    let queue = s.open_requests.entry(label.to_string()).or_default();
    let mut sequence = 0u64;
    for path in paths {
        let request_id = format!("r-{}", s.next_request_seq);
        s.next_request_seq += 1;
        queue.push(OpenRequestDto {
            request_id,
            batch_id: batch_id.clone(),
            sequence,
            source: source.clone(),
            path,
            cwd: cwd.clone(),
        });
        sequence += 1;
    }
    s.open_queue_version += 1;
    (batch_id, s.open_queue_version)
}

/// 唤醒指定窗口消费队列（事件只携带队列版本，不含路径）
pub fn notify_open_requests(app: &tauri::AppHandle, label: &str, queue_version: u64) {
    use tauri::Emitter;
    let _ = app.emit_to(
        label,
        "nb://open-requests-available",
        &serde_json::json!({ "queueVersion": queue_version }),
    );
}

/// 前端监听就绪握手：标记窗口 ready、分配 consumer 代际并返回启动信息。
pub fn window_listeners_ready(state: &State<'_, Mutex<AppState>>, label: &str) -> WindowBootDto {
    let mut s = state.lock().unwrap();
    window_listeners_ready_inner(&mut s, label)
}

/// 握手核心逻辑
pub fn window_listeners_ready_inner(s: &mut AppState, label: &str) -> WindowBootDto {
    // 标记窗口 ready（沿用 WindowRecord 语义）
    if let Some(w) = s.windows.get_mut(label) {
        w.is_ready = true;
        w.last_active_at = crate::window::manager::now_ms();
    }

    // 分配新 consumer 代际（真正 WebView 重载才应再次调用；旧 consumer 随即失效）
    s.next_consumer_seq += 1;
    let consumer_id = format!("c-{label}-{}", s.next_consumer_seq);
    s.window_consumers.insert(label.to_string(), consumer_id.clone());

    // 启动模式判定：迁移意图 → handoff；队列已有请求 → explicit-open；否则 empty。
    // 队列暂空不等于普通空启动（来源由后端在入队时记录）。
    let has_pending = s
        .open_requests
        .get(label)
        .map(|q| !q.is_empty())
        .unwrap_or(false);
    let is_handoff = matches!(
        s.intents.get(label),
        Some(WindowIntent::AdoptDocuments { .. })
    );
    let startup_mode = if is_handoff {
        "handoff"
    } else if has_pending {
        "explicit-open"
    } else {
        "empty"
    };

    // 迁移场景：交接意图的 transferId 由迁移协议单独注册；此处透出以便目标窗口核对
    let transfer_id = s
        .transfers
        .values()
        .find(|t| t.target_label == label && t.state == crate::dto::TransferState::Preparing)
        .map(|t| t.transfer_id.clone());

    WindowBootDto {
        protocol_version: 1,
        consumer_id,
        startup_mode: startup_mode.to_string(),
        transfer_id,
        queue_version: s.open_queue_version,
    }
}

/// 非破坏读取本窗口未确认请求（默认批量上限 32，处理完继续拉取）。
/// 旧 consumer 或未握手窗口返回 None；这里不返回正文。
pub fn list_open_requests(
    state: &State<'_, Mutex<AppState>>,
    label: &str,
    consumer_id: &str,
    limit: Option<usize>,
) -> Option<Vec<OpenRequestItemDto>> {
    let s = state.lock().unwrap();
    list_open_requests_inner(&s, label, consumer_id, limit)
}

/// 读取核心逻辑
pub fn list_open_requests_inner(
    s: &AppState,
    label: &str,
    consumer_id: &str,
    limit: Option<usize>,
) -> Option<Vec<OpenRequestItemDto>> {
    // 🔴 consumer 校验：旧 consumer（WebView 重载前）无权消费
    if s.window_consumers.get(label).map(String::as_str) != Some(consumer_id) {
        return None;
    }
    let queue = s.open_requests.get(label)?;
    let limit = limit.unwrap_or(OPEN_REQUEST_BATCH_LIMIT).min(OPEN_REQUEST_BATCH_LIMIT * 2);
    Some(
        queue
            .iter()
            .take(limit)
            .map(|request| OpenRequestItemDto {
                request: request.clone(),
                queue_version: s.open_queue_version,
            })
            .collect(),
    )
}

/// 幂等确认并从 pending 移除。
/// 拒绝旧 consumer 与非所属窗口确认；无效 ID 不修改其它请求。
pub fn ack_open_request(
    state: &State<'_, Mutex<AppState>>,
    label: &str,
    consumer_id: &str,
    request_id: &str,
) -> bool {
    let mut s = state.lock().unwrap();
    ack_open_request_inner(&mut s, label, consumer_id, request_id)
}

/// 确认核心逻辑
pub fn ack_open_request_inner(
    s: &mut AppState,
    label: &str,
    consumer_id: &str,
    request_id: &str,
) -> bool {
    if s.window_consumers.get(label).map(String::as_str) != Some(consumer_id) {
        return false;
    }
    let Some(queue) = s.open_requests.get_mut(label) else {
        return false;
    };
    let before = queue.len();
    queue.retain(|r| r.request_id != request_id);
    let removed = queue.len() < before;
    if removed {
        s.open_queue_version += 1;
    }
    removed
}

/// 窗口销毁时转移其未处理请求：
/// 有其它存活窗口 → 转交最后活跃/任意窗口并返回（目标, 版本）供调用方唤醒；
/// 无窗口 → 转入待分配队列（orphan），由后续建窗承接。
pub fn reassign_pending_requests(
    state: &State<'_, Mutex<AppState>>,
    from_label: &str,
    pending: Vec<OpenRequestDto>,
) -> Option<(String, u64)> {
    let mut s = state.lock().unwrap();
    reassign_pending_requests_inner(&mut s, from_label, pending)
}

/// 转移核心逻辑
pub fn reassign_pending_requests_inner(
    s: &mut AppState,
    from_label: &str,
    pending: Vec<OpenRequestDto>,
) -> Option<(String, u64)> {
    if pending.is_empty() {
        return None;
    }
    let target = s
        .windows
        .values()
        .filter(|w| w.label != from_label)
        .max_by_key(|w| (w.is_ready, w.last_active_at))
        .map(|w| w.label.clone());
    match target {
        Some(target_label) => {
            let queue = s.open_requests.entry(target_label.clone()).or_default();
            queue.extend(pending);
            s.open_queue_version += 1;
            Some((target_label, s.open_queue_version))
        }
        None => {
            s.orphan_requests.extend(pending);
            s.open_queue_version += 1;
            None
        }
    }
}

/// 取走全部待分配请求（orphan），供新窗口/最后窗口关闭前承接。
pub fn take_orphan_requests(state: &State<'_, Mutex<AppState>>) -> Vec<OpenRequestDto> {
    let mut s = state.lock().unwrap();
    std::mem::take(&mut s.orphan_requests)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 入队顺序与 sequence 分配：同批按输入顺序，批间独立
    #[test]
    fn enqueue_assigns_request_ids_and_sequence() {
        let mut s = AppState::default();
        let (b1, v1) = enqueue_open_requests_inner(
            &mut s,
            "nb-main",
            vec!["a.md".into(), "b.md".into()],
            None,
            OpenRequestSource::Cli,
        );
        let (b2, v2) = enqueue_open_requests_inner(
            &mut s,
            "nb-main",
            vec!["c.md".into()],
            Some("C:\\cwd".into()),
            OpenRequestSource::SecondInstance,
        );
        let queue = s.open_requests.get("nb-main").unwrap();
        assert_eq!(queue.len(), 3);
        assert_eq!(queue[0].batch_id, b1);
        assert_eq!(queue[0].sequence, 0);
        assert_eq!(queue[1].sequence, 1);
        assert_eq!(queue[2].batch_id, b2);
        assert_ne!(b1, b2);
        assert_eq!(queue[2].source, OpenRequestSource::SecondInstance);
        assert_eq!(queue[2].cwd.as_deref(), Some("C:\\cwd"));
        assert!(v2 > v1);
    }

    /// list 非破坏读取且有批量上限；consumer 不匹配返回 None
    #[test]
    fn list_is_non_destructive_limited_and_consumer_gated() {
        let mut s = AppState::default();
        let paths: Vec<String> = (0..40).map(|i| format!("f{i}.md")).collect();
        enqueue_open_requests_inner(&mut s, "nb-main", paths, None, OpenRequestSource::Drop);

        // 未握手（无 consumer）不可读取
        assert!(list_open_requests_inner(&s, "nb-main", "c-nb-main-1", None).is_none());

        window_listeners_ready_inner(&mut s, "nb-main");
        let consumer = s.window_consumers.get("nb-main").unwrap().clone();
        let items = list_open_requests_inner(&s, "nb-main", &consumer, None).unwrap();
        assert_eq!(items.len(), OPEN_REQUEST_BATCH_LIMIT);
        // 队列未被破坏
        assert_eq!(s.open_requests.get("nb-main").unwrap().len(), 40);
        // 旧 consumer 拒绝
        assert!(list_open_requests_inner(&s, "nb-main", "c-nb-main-0", None).is_none());
    }

    /// ack 幂等：确认一次成功、重复确认无效、无效 ID 不影响其它请求、旧 consumer 拒绝
    #[test]
    fn ack_is_idempotent_and_scoped() {
        let mut s = AppState::default();
        enqueue_open_requests_inner(
            &mut s,
            "nb-main",
            vec!["a.md".into(), "b.md".into()],
            None,
            OpenRequestSource::Cli,
        );
        window_listeners_ready_inner(&mut s, "nb-main");
        let consumer = s.window_consumers.get("nb-main").unwrap().clone();

        // 旧 consumer（从未分配的更低代际）拒绝
        assert!(!ack_open_request_inner(&mut s, "nb-main", "c-nb-main-0", "r-0"));
        // 正常确认第一条
        assert!(ack_open_request_inner(&mut s, "nb-main", &consumer, "r-0"));
        // 重复确认同一条 → false（已移除）
        assert!(!ack_open_request_inner(&mut s, "nb-main", &consumer, "r-0"));
        // 无效 ID 不影响剩余
        assert!(!ack_open_request_inner(&mut s, "nb-main", &consumer, "r-999"));
        assert_eq!(s.open_requests.get("nb-main").unwrap().len(), 1);
        assert_eq!(s.open_requests.get("nb-main").unwrap()[0].request_id, "r-1");
    }

    /// 握手分配新 consumer 代际并判定启动模式
    #[test]
    fn handshake_assigns_consumer_and_startup_mode() {
        let mut s = AppState::default();
        // 空启动
        let boot1 = window_listeners_ready_inner(&mut s, "nb-main");
        assert_eq!(boot1.startup_mode, "empty");
        assert_eq!(boot1.protocol_version, 1);

        // 显式打开：队列有请求
        enqueue_open_requests_inner(
            &mut s,
            "nb-main",
            vec!["x.md".into()],
            None,
            OpenRequestSource::Cli,
        );
        let boot2 = window_listeners_ready_inner(&mut s, "nb-main");
        assert_eq!(boot2.startup_mode, "explicit-open");
        assert_ne!(boot1.consumer_id, boot2.consumer_id);
        // 旧 consumer（boot1）被新握手取代
        assert!(list_open_requests_inner(&s, "nb-main", &boot1.consumer_id, None).is_none());
        assert!(list_open_requests_inner(&s, "nb-main", &boot2.consumer_id, None).is_some());
    }

    /// 窗口销毁转移：有其它窗口则转交；无窗口则进入 orphan
    #[test]
    fn reassign_moves_pending_or_orphans() {
        let mut s = AppState::default();
        s.register_window(
            "nb-1".into(),
            crate::window::manager::WindowRecord::new("nb-1".into(), 1),
        );
        s.register_window(
            "nb-2".into(),
            crate::window::manager::WindowRecord::new("nb-2".into(), 2),
        );
        enqueue_open_requests_inner(
            &mut s,
            "nb-1",
            vec!["x.md".into()],
            None,
            OpenRequestSource::Cli,
        );

        // nb-1 销毁：转交给仍存活的 nb-2
        let pending = s.open_requests.remove("nb-1").unwrap_or_default();
        let target = reassign_pending_requests_inner(&mut s, "nb-1", pending);
        assert_eq!(target.as_ref().map(|(l, _)| l.as_str()), Some("nb-2"));
        assert_eq!(s.open_requests.get("nb-2").unwrap().len(), 1);

        // nb-2 也销毁：进入 orphan
        let pending = s.open_requests.remove("nb-2").unwrap_or_default();
        s.windows.clear();
        assert!(reassign_pending_requests_inner(&mut s, "nb-2", pending).is_none());
        assert_eq!(s.orphan_requests.len(), 1);
    }
}
