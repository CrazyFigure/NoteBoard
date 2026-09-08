// NoteBoard window 命令 — IPC 接口（S04 打开队列 + 迁移协议）
//
// 🔴 协议要点（docs/启动性能与低内存根治计划.md §C）：
//   - window_listeners_ready：前端订阅完成后的握手；分配 consumer 代际
//   - window_shell_ready：只负责基础 DOM/主题已应用后的 show/focus，不等待隐藏窗口 paint
//   - list_open_requests / ack_open_request：非破坏读取 + 幂等确认
//   - begin_document_transfer / take_transfer_payload / prepare_transfer_complete /
//     abort_transfer / query_transfer：迁移状态机 preparing → target-prepared → committed/aborted

use crate::dto::{
    BeginTransferResponse, CreateWindowResponse, OpenOutcome, OpenRequestItemDto,
    OpenRequestSource, TransferredDocument, TransferState, TransferStatusDto, WindowBootDto,
    WindowIntent,
};
use crate::state::{AppState, TransferRecord};
use crate::window::{intent, manager};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

/// 监听就绪握手：分配 consumer 并返回启动信息（不显示窗口、不消费请求、不确认迁移）
#[tauri::command]
pub fn window_listeners_ready(
    state: State<'_, Mutex<AppState>>,
    label: String,
) -> Result<WindowBootDto, String> {
    Ok(intent::window_listeners_ready(&state, &label))
}

/// 壳就绪：只负责窗口 show/focus（基础 DOM/主题已应用后调用）
#[tauri::command]
pub fn window_shell_ready(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    label: String,
) -> Result<(), String> {
    manager::touch_window(&state, &label);
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.show();
        let _ = win.set_focus();
    }
    Ok(())
}

/// 非破坏读取本窗口未确认请求（批量上限默认 32）
#[tauri::command]
pub fn list_open_requests(
    state: State<'_, Mutex<AppState>>,
    label: String,
    consumer_id: String,
    limit: Option<usize>,
) -> Result<Option<Vec<OpenRequestItemDto>>, String> {
    Ok(intent::list_open_requests(&state, &label, &consumer_id, limit))
}

/// 幂等确认：业务处理有明确结果才确认；failed 必须已有用户可见错误与重试入口
#[tauri::command]
pub fn ack_open_request(
    state: State<'_, Mutex<AppState>>,
    label: String,
    consumer_id: String,
    request_id: String,
    outcome: OpenOutcome,
) -> Result<bool, String> {
    let _ = outcome; // 结果枚举当前仅用于日志口径；移除逻辑与结果无关
    Ok(intent::ack_open_request(&state, &label, &consumer_id, &request_id))
}

/// 前端入队打开请求（拖拽 / 文件对话框来源）；返回（batchId, 队列版本）供调用方自行 drain
#[tauri::command]
pub fn enqueue_open_requests(
    state: State<'_, Mutex<AppState>>,
    label: String,
    paths: Vec<String>,
    cwd: Option<String>,
    source: OpenRequestSource,
) -> Result<(String, u64), String> {
    if paths.is_empty() {
        return Ok((String::new(), 0));
    }
    let result = intent::enqueue_open_requests(&state, &label, paths, cwd, source);
    Ok(result)
}

/// 创建窗口（async fn 避免死锁）
#[tauri::command]
pub async fn create_window(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    intent: WindowIntent,
) -> Result<CreateWindowResponse, String> {
    let label = {
        let mut s = state.lock().unwrap();
        let label = s.alloc_label();
        let seq = label.trim_start_matches("nb-").parse::<u32>().unwrap_or(0);
        s.intents.insert(label.clone(), intent);
        s.register_window(label.clone(), manager::WindowRecord::new(label.clone(), seq));
        label
    };

    // 🔴 切线程建窗
    // 🔴 诊断 span：建窗区间（含 WebView 创建与显示）
    let create_start = crate::perf::now_instant();
    manager::create_window(&app, label.clone())?;
    crate::perf::span_with("create_window", create_start, Some(&label), &[]);

    Ok(CreateWindowResponse { label })
}

// ── 文档迁移（transferId 协议） ──

/// 发起迁移：源窗口 flush 权威内容后携带完整载荷调用。
/// 创建目标窗口并注册 Preparing 状态的迁移记录；所有权仍属于源窗口。
#[tauri::command]
pub async fn begin_document_transfer(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    source_label: String,
    doc: TransferredDocument,
    expected_revision: u64,
) -> Result<BeginTransferResponse, String> {
    let key = doc.key.clone();

    // 创建目标窗口并注册迁移记录（锁内只做短状态操作）
    let (transfer_id, target_label) = {
        let mut s = state.lock().unwrap();
        let target_label = s.alloc_label();
        let seq = target_label
            .trim_start_matches("nb-")
            .parse::<u32>()
            .unwrap_or(0);
        s.register_window(
            target_label.clone(),
            manager::WindowRecord::new(target_label.clone(), seq),
        );
        s.intents
            .insert(target_label.clone(), WindowIntent::AdoptDocuments { docs: vec![] });
        let transfer_id = format!("t-{}", s.next_request_seq);
        s.next_request_seq += 1;
        s.transfers.insert(
            transfer_id.clone(),
            TransferRecord {
                transfer_id: transfer_id.clone(),
                source_label: source_label.clone(),
                target_label: target_label.clone(),
                key: key.clone(),
                expected_revision,
                state: TransferState::Preparing,
                payload: Some(doc),
            },
        );
        (transfer_id, target_label)
    };

    // 🔴 切线程建窗（同步上下文调用 build() 会死锁）
    let create_start = crate::perf::now_instant();
    manager::create_window(&app, target_label.clone())?;
    crate::perf::span_with("create_window", create_start, Some(&target_label), &[]);

    Ok(BeginTransferResponse {
        transfer_id,
        target_label,
    })
}

/// 目标窗口读取迁移载荷（🔴 R06：非破坏 peek——接纳途中失败/重载可重新获取；
/// 终态 committed/aborted 时返回 None 并清空正文引用，避免长期持有副本）。
#[tauri::command]
pub fn take_transfer_payload(
    state: State<'_, Mutex<AppState>>,
    label: String,
    transfer_id: String,
) -> Result<Option<TransferredDocument>, String> {
    let mut s = state.lock().unwrap();
    let Some(record) = s.transfers.get_mut(&transfer_id) else {
        return Ok(None);
    };
    if record.target_label != label {
        return Ok(None);
    }
    if record.state == TransferState::Aborted || record.state == TransferState::Committed {
        // 终态：清空正文引用（载荷已在 committed 时被目标接管）
        record.payload = None;
        return Ok(None);
    }
    // 非终态：克隆返回（peek），接纳成功（committed）或 abort 时统一清空
    Ok(record.payload.clone())
}

/// 目标回报 prepared：后端原子校验 transfer 与双方存活状态，切换所有权并标 committed。
/// committed 后通知双方：目标解锁可编辑，源查询到 committed 后清理本地实例和标签。
/// 🔴 N01：actual_revision 为目标窗口从载荷读取的修订版本——与源捕获的
/// expected_revision 对账，不一致（载荷在接纳途中被替换/过期 peek）按中止处理。
#[tauri::command]
pub fn prepare_transfer_complete(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    label: String,
    transfer_id: String,
    actual_revision: Option<u64>,
) -> Result<TransferStatusDto, String> {
    let (source_label, key) = {
        let mut s = state.lock().unwrap();
        prepare_transfer_inner(&mut s, &label, &transfer_id, actual_revision)?
    };

    // 🔴 通知双方（定向，锁外）：目标解锁可编辑；源清理本地实例和标签
    let payload = serde_json::json!({ "transferId": transfer_id, "key": key });
    let _ = app.emit_to(&label, "nb://transfer-committed", &payload);
    let _ = app.emit_to(&source_label, "nb://transfer-committed", &payload);

    Ok(TransferStatusDto {
        transfer_id,
        state: TransferState::Committed,
        key: Some(key),
    })
}

/// 迁移提交核心逻辑（锁内执行；无 Tauri 依赖，便于单元测试）
/// 三步：校验记录并取参（含 revision 对账）→ 原子校验存活与所有权切换 → 推进迁移状态
pub fn prepare_transfer_inner(
    s: &mut AppState,
    label: &str,
    transfer_id: &str,
    actual_revision: Option<u64>,
) -> Result<(String, String), String> {
    {
        // 第一步：校验迁移记录并取出参数（clone 后立即释放 transfers 借用）
        let (source_label, target_label, key) = {
            let Some(record) = s.transfers.get_mut(transfer_id) else {
                return Err(format!("迁移记录不存在: {transfer_id}"));
            };
            // 只有目标窗口才能确认 prepared
            if record.target_label != label {
                return Err("只有迁移目标窗口可以确认 prepared".into());
            }
            // 🔴 R3-08：终态先处理且不可逆——已 Committed 的幂等返回必须先于
            //    revision 对账（不同 revision 的迟到重复确认不得把已提交事务
            //    改回 Aborted——owner 已切给目标，回退将造成所有权与状态不一致）
            match record.state {
                TransferState::Committed => {
                    // 幂等：重复回报仍返回（源, key）；调用方重复通知双方是无害的
                    return Ok((record.source_label.clone(), record.key.clone()));
                }
                TransferState::Aborted => {
                    return Err("迁移已中止".into());
                }
                TransferState::Preparing | TransferState::TargetPrepared => {}
            }
            // 🔴 N01 revision 对账：目标读取的载荷版本必须与源捕获的期望版本一致。
            //    不一致说明载荷在接纳途中被替换（旧轮 peek / 篡改）——
            //    不能把过期内容提交成权威，按中止处理并清空载荷。
            //    （仅在未提交状态下执行——见上方终态先处理）
            if let Some(actual) = actual_revision {
                if actual != record.expected_revision {
                    let expected = record.expected_revision;
                    record.state = TransferState::Aborted;
                    record.payload = None;
                    return Err(format!(
                        "迁移载荷修订版本不一致（期望 {expected}，目标读取 {actual}），迁移已中止"
                    ));
                }
            }
            (
                record.source_label.clone(),
                record.target_label.clone(),
                record.key.clone(),
            )
        };

        // 第二步：原子校验双方存活 + 切换文档所有权
        let lower_key = crate::path::lower_key(&key);
        let (kind, _lang) = crate::dto::kind_from_path(&key);
        let ownership_error = {
            let source_alive = s.windows.contains_key(&source_label);
            let target_alive = s.windows.contains_key(&target_label);
            if !source_alive || !target_alive {
                Some(format!(
                    "迁移双方状态异常（源存活: {source_alive}，目标存活: {target_alive}）"
                ))
            } else {
                match s.documents.get_mut(&lower_key) {
                    // 已注册文档：owner 从源窗口直接改为目标窗口
                    Some(existing) if existing.owner_window == source_label => {
                        existing.owner_window = target_label.clone();
                        None
                    }
                    // 所有权既不在源窗口：拒绝（不能把别人的文档抢过来）
                    Some(_) => Some("文档所有权已不属于源窗口，迁移中止".to_string()),
                    // 源未注册（如未命名文档迁移）：注册给目标窗口
                    None => {
                        let _ = crate::registry::documents::DocumentRegistry::register(
                            &mut s.documents,
                            &target_label,
                            &key,
                            kind,
                        );
                        None
                    }
                }
            }
        };

        // 第三步：按所有权切换结果推进迁移状态
        if let Some(err) = ownership_error {
            if let Some(record) = s.transfers.get_mut(transfer_id) {
                record.state = TransferState::Aborted;
                record.payload = None;
            }
            return Err(err);
        }
        if let Some(record) = s.transfers.get_mut(transfer_id) {
            record.state = TransferState::Committed;
            record.payload = None;
        }
        Ok((source_label, key))
    }
}

/// 中止迁移：未提交失败（prepared 前目标失败 / 源主动取消）时调用。
/// committed 后拒绝（提交和超时竞态只有一个终态）。
#[tauri::command]
pub fn abort_transfer(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    label: String,
    transfer_id: String,
    reason: String,
) -> Result<TransferStatusDto, String> {
    let (aborted, counterpart) = {
        let mut s = state.lock().unwrap();
        let Some(record) = s.transfers.get_mut(&transfer_id) else {
            return Err(format!("迁移记录不存在: {transfer_id}"));
        };
        if record.source_label != label && record.target_label != label {
            return Err("只有迁移双方可以中止".into());
        }
        if record.state == TransferState::Committed {
            // 已提交则不能把所有权抢回
            return Err("迁移已提交，无法中止".into());
        }
        if record.state == TransferState::Aborted {
            // 幂等
            return Ok(TransferStatusDto {
                transfer_id: record.transfer_id.clone(),
                state: TransferState::Aborted,
                key: Some(record.key.clone()),
            });
        }
        record.state = TransferState::Aborted;
        record.payload = None;
        let counterpart = if label == record.source_label {
            record.target_label.clone()
        } else {
            record.source_label.clone()
        };
        (true, counterpart)
    };
    if aborted {
        let payload = serde_json::json!({ "transferId": transfer_id, "reason": reason });
        let _ = app.emit_to(&counterpart, "nb://transfer-aborted", &payload);
    }
    Ok(TransferStatusDto {
        transfer_id,
        state: TransferState::Aborted,
        key: None,
    })
}

/// 查询迁移状态（源窗口等待确认用；禁止盲目超时回滚）
#[tauri::command]
pub fn query_transfer(
    state: State<'_, Mutex<AppState>>,
    transfer_id: String,
) -> Result<Option<TransferStatusDto>, String> {
    let s = state.lock().unwrap();
    Ok(s.transfers.get(&transfer_id).map(|r| TransferStatusDto {
        transfer_id: r.transfer_id.clone(),
        state: r.state.clone(),
        key: Some(r.key.clone()),
    }))
}

/// 聚焦窗口
#[tauri::command]
pub fn focus_window(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.set_focus();
    }
    Ok(())
}

/// 关闭窗口
/// 1. 标记窗口为 closing，使 on_window_event 放行 CloseRequested
/// 2. 使用 win.close() 走系统标准关闭管线（触发 window-state 保存并安全销毁 HWND 与 WebView2）
/// 3. 所有窗口平等独立：若还有其他存活窗口，仅关闭本窗口；若为最后一个窗口，关闭后退出应用
/// 🔴 若存在待分配打开请求（orphan），最后窗口退出前先建新窗口承接，避免 app.exit(0) 丢请求
#[tauri::command]
pub fn close_window(
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
    label: String,
) -> Result<(), String> {
    // 1. 标记本窗口为主动关闭状态
    {
        let mut s = state.lock().unwrap();
        s.mark_closing(&label);
    }

    let remaining = app.webview_windows();
    let has_other_windows = remaining.iter().any(|(k, _)| k.as_str() != label);

    // 2. 如果还有其他独立窗口，仅关闭本窗口
    if has_other_windows {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.hide();
            let _ = win.close();
        }
        return Ok(());
    }

    // 3. 🔴 R07：最后一个窗口退出前，把本窗口尚未处理的打开请求一并转入待分配队列，
    //    避免 app.exit(0) 直接丢弃已接受的请求（窗口销毁时的转移不覆盖这里的主动关闭）
    let own_pending = {
        let mut s = state.lock().unwrap();
        s.open_requests.remove(&label).unwrap_or_default()
    };
    let mut orphan = intent::take_orphan_requests(&state);
    orphan.extend(own_pending);

    if !orphan.is_empty() {
        let new_label = {
            let mut s = state.lock().unwrap();
            let new_label = s.alloc_label();
            let seq = new_label
                .trim_start_matches("nb-")
                .parse::<u32>()
                .unwrap_or(0);
            s.register_window(
                new_label.clone(),
                manager::WindowRecord::new(new_label.clone(), seq),
            );
            s.intents.insert(new_label.clone(), WindowIntent::Empty);
            s.open_requests.insert(new_label.clone(), orphan);
            s.open_queue_version += 1;
            new_label
        };
        // 先建新窗，再关旧窗，保证请求有归属
        let _ = manager::create_window(&app, new_label);
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.hide();
            let _ = win.close();
        }
        return Ok(());
    }

    // 4. 正常退出：关闭并优雅退出应用
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.hide();
        let _ = win.close();
    }
    // 🔴 诊断 span：最后一个窗口退出前批量落盘，避免进程结束丢失采集数据
    let _ = crate::perf::flush_to_disk("last-window-close");
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::DocumentKind;
    use crate::state::TransferRecord;

    fn make_state_with_transfer() -> (AppState, String) {
        let mut s = AppState::default();
        // 注册源/目标窗口与源文档所有权
        s.register_window(
            "nb-1".into(),
            crate::window::manager::WindowRecord::new("nb-1".into(), 1),
        );
        s.register_window(
            "nb-2".into(),
            crate::window::manager::WindowRecord::new("nb-2".into(), 2),
        );
        let _ = crate::registry::documents::DocumentRegistry::register(
            &mut s.documents,
            "nb-1",
            r"C:\t\a.md",
            DocumentKind::Markdown,
        );
        let transfer_id = "t-1".to_string();
        s.transfers.insert(
            transfer_id.clone(),
            TransferRecord {
                transfer_id: transfer_id.clone(),
                source_label: "nb-1".into(),
                target_label: "nb-2".into(),
                key: r"C:\t\a.md".into(),
                expected_revision: 3,
                state: TransferState::Preparing,
                payload: Some(TransferredDocument {
                    key: r"C:\t\a.md".into(),
                    content: Some("正文".into()),
                    board_scene: None,
                    is_dirty: true,
                    view_mode: None,
                    view_state: serde_json::Value::Null,
                    kind: Some(DocumentKind::Markdown),
                    language: None,
                    encoding: None,
                    eol: None,
                    readonly: false,
                    mtime: 0,
                    size: 0,
                    baseline: Some("基线".into()),
                    revision: 3,
                    history: None,
                }),
            },
        );
        (s, transfer_id)
    }

    /// 正常迁移：目标 prepare → committed，文档所有权从源切换到目标，载荷清空
    #[test]
    fn prepare_transfers_ownership_and_commits() {
        let (mut s, transfer_id) = make_state_with_transfer();
        let result = prepare_transfer_inner(&mut s, "nb-2", &transfer_id, Some(3));
        assert!(result.is_ok());
        let (source, key) = result.unwrap();
        assert_eq!(source, "nb-1");
        assert_eq!(key, r"C:\t\a.md");

        let record = s.transfers.get(&transfer_id).unwrap();
        assert_eq!(record.state, TransferState::Committed);
        assert!(record.payload.is_none());

        // 所有权已切换到目标窗口
        assert_eq!(
            crate::registry::documents::DocumentRegistry::find_owner(
                &s.documents,
                r"C:\t\a.md"
            )
            .as_deref(),
            Some("nb-2")
        );
    }

    /// 🔴 R3-08：已 Committed 的迁移收到不同 revision 的迟到重复确认——
    ///    必须幂等返回成功（终态不可逆），不得被 revision 对账改回 Aborted
    #[test]
    fn prepare_committed_is_irreversible_despite_late_wrong_revision() {
        let (mut s, transfer_id) = make_state_with_transfer();
        // 先正常提交
        assert!(prepare_transfer_inner(&mut s, "nb-2", &transfer_id, Some(3)).is_ok());
        assert_eq!(
            s.transfers.get(&transfer_id).unwrap().state,
            TransferState::Committed
        );
        // 迟到的重复确认携带错误 revision——不得回退终态
        let result = prepare_transfer_inner(&mut s, "nb-2", &transfer_id, Some(99));
        assert!(result.is_ok(), "已提交的迁移对迟到错误 revision 的确认必须幂等成功");
        assert_eq!(
            s.transfers.get(&transfer_id).unwrap().state,
            TransferState::Committed
        );
        // 所有权保持目标窗口
        assert_eq!(
            crate::registry::documents::DocumentRegistry::find_owner(
                &s.documents,
                r"C:\t\a.md"
            )
            .as_deref(),
            Some("nb-2")
        );
    }

    /// 🔴 N01：目标读取的载荷修订版本与源捕获的期望版本不一致 → 迁移中止（载荷被替换保护）
    #[test]
    fn prepare_aborts_on_revision_mismatch() {
        let (mut s, transfer_id) = make_state_with_transfer();
        // 期望 3，目标读取 2（旧轮 peek / 接纳途中被替换）
        let result = prepare_transfer_inner(&mut s, "nb-2", &transfer_id, Some(2));
        assert!(result.is_err());
        assert_eq!(
            s.transfers.get(&transfer_id).unwrap().state,
            TransferState::Aborted
        );
        // 载荷清空，所有权不切换（仍在源）
        assert!(s.transfers.get(&transfer_id).unwrap().payload.is_none());
        assert_eq!(
            crate::registry::documents::DocumentRegistry::find_owner(
                &s.documents,
                r"C:\t\a.md"
            )
            .as_deref(),
            Some("nb-1")
        );
        // 匹配的版本照常提交
        let (mut s2, transfer_id2) = make_state_with_transfer();
        assert!(prepare_transfer_inner(&mut s2, "nb-2", &transfer_id2, Some(3)).is_ok());
    }

    /// 非目标窗口 prepare 被拒绝，状态不变
    #[test]
    fn prepare_rejects_non_target_window() {
        let (mut s, transfer_id) = make_state_with_transfer();
        let result = prepare_transfer_inner(&mut s, "nb-1", &transfer_id, None);
        assert!(result.is_err());
        assert_eq!(
            s.transfers.get(&transfer_id).unwrap().state,
            TransferState::Preparing
        );
    }

    /// aborted 后 prepare 被拒绝；committed 后 prepare 幂等成功
    #[test]
    fn prepare_rejects_aborted_and_idempotent_on_committed() {
        let (mut s, transfer_id) = make_state_with_transfer();
        // 先中止
        if let Some(record) = s.transfers.get_mut(&transfer_id) {
            record.state = TransferState::Aborted;
        }
        assert!(prepare_transfer_inner(&mut s, "nb-2", &transfer_id, None).is_err());

        // 重新构造 committed 记录验证幂等
        let (mut s2, transfer_id2) = make_state_with_transfer();
        assert!(prepare_transfer_inner(&mut s2, "nb-2", &transfer_id2, None).is_ok());
        // 第二次 prepare（幂等）仍成功返回
        assert!(prepare_transfer_inner(&mut s2, "nb-2", &transfer_id2, None).is_ok());
    }

    /// 源窗口已销毁：迁移中止，所有权不动
    #[test]
    fn prepare_aborts_when_source_window_gone() {
        let (mut s, transfer_id) = make_state_with_transfer();
        s.windows.remove("nb-1");
        assert!(prepare_transfer_inner(&mut s, "nb-2", &transfer_id, None).is_err());
        assert_eq!(
            s.transfers.get(&transfer_id).unwrap().state,
            TransferState::Aborted
        );
        // 所有权仍在源（虽然源窗口已销毁，由窗口销毁清理流程兜底）
        assert_eq!(
            crate::registry::documents::DocumentRegistry::find_owner(
                &s.documents,
                r"C:\t\a.md"
            )
            .as_deref(),
            Some("nb-1")
        );
    }

    /// 文档所有权已被第三方接管：拒绝迁移并中止
    #[test]
    fn prepare_aborts_when_ownership_moved_elsewhere() {
        let (mut s, transfer_id) = make_state_with_transfer();
        // 模拟所有权被改为第三个窗口
        let lower = crate::path::lower_key(r"C:\t\a.md");
        if let Some(doc) = s.documents.get_mut(&lower) {
            doc.owner_window = "nb-3".into();
        }
        assert!(prepare_transfer_inner(&mut s, "nb-2", &transfer_id, None).is_err());
        assert_eq!(
            s.transfers.get(&transfer_id).unwrap().state,
            TransferState::Aborted
        );
    }

    /// 未注册文档（未命名迁移）：prepare 直接注册给目标窗口
    #[test]
    fn prepare_registers_unnamed_document_to_target() {
        let mut s = AppState::default();
        s.register_window(
            "nb-1".into(),
            crate::window::manager::WindowRecord::new("nb-1".into(), 1),
        );
        s.register_window(
            "nb-2".into(),
            crate::window::manager::WindowRecord::new("nb-2".into(), 2),
        );
        let transfer_id = "t-9".to_string();
        s.transfers.insert(
            transfer_id.clone(),
            TransferRecord {
                transfer_id: transfer_id.clone(),
                source_label: "nb-1".into(),
                target_label: "nb-2".into(),
                key: "untitled:md-1".into(),
                expected_revision: 1,
                state: TransferState::Preparing,
                payload: Some(TransferredDocument {
                    key: "untitled:md-1".into(),
                    content: Some("未命名".into()),
                    board_scene: None,
                    is_dirty: true,
                    view_mode: None,
                    view_state: serde_json::Value::Null,
                    kind: Some(DocumentKind::Markdown),
                    language: None,
                    encoding: None,
                    eol: None,
                    readonly: false,
                    mtime: 0,
                    size: 0,
                    baseline: None,
                    revision: 1,
                    history: None,
                }),
            },
        );
        assert!(prepare_transfer_inner(&mut s, "nb-2", &transfer_id, None).is_ok());
        assert_eq!(
            crate::registry::documents::DocumentRegistry::find_owner(
                &s.documents,
                "untitled:md-1"
            )
            .as_deref(),
            Some("nb-2")
        );
    }
}
