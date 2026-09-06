// NoteBoard AppState — 全局应用状态
// 权威所有者：文档注册表、窗口注册表、意图暂存
// 不持有：文档内容、撤销栈、光标位置（见 docs/03-领域模型.md §1.1）

use crate::dto::{OpenRequestDto, TransferredDocument, TransferState, WindowIntent};
use crate::registry::documents::DocumentRecord;
use crate::window::manager::WindowRecord;
use std::collections::{HashMap, HashSet};

/// 文档迁移记录（transferId 协议；payload 仅在迁移进行中短暂持有）
#[derive(Clone, Debug)]
pub struct TransferRecord {
    pub transfer_id: String,
    pub source_label: String,
    pub target_label: String,
    pub key: String,
    pub expected_revision: u64,
    pub state: TransferState,
    /// 完整迁移载荷（committed/aborted 后清空，避免 Rust 长期持有正文副本）
    pub payload: Option<TransferredDocument>,
}

/// 全局应用状态
pub struct AppState {
    /// 文档注册表：小写 key → DocumentRecord
    pub documents: HashMap<String, DocumentRecord>,

    /// 窗口注册表：label → WindowRecord
    pub windows: HashMap<String, WindowRecord>,

    /// 正在被主动关闭的窗口集合（避免 prevent_close 拦截导致的死循环与白屏）
    pub closing_windows: HashSet<String>,

    /// 待取意图：label → WindowIntent
    pub intents: HashMap<String, WindowIntent>,

    /// 窗口序号（单调递增，不复用）
    pub next_window_seq: u32,

    /// 设置 revision（单调递增，用于广播去重）
    pub settings_revision: u64,

    /// 🔴 S04 打开请求队列：label → 未确认请求（窗口存活期间的权威来源）
    pub open_requests: HashMap<String, Vec<OpenRequestDto>>,

    /// 全部窗口都销毁后的待分配请求（按原顺序保留，供新窗口承接）
    pub orphan_requests: Vec<OpenRequestDto>,

    /// 打开队列版本（每次入队/确认递增；用于唤醒事件去重）
    pub open_queue_version: u64,

    /// 每窗口当前 consumer 代际：label → consumerId
    /// listeners_ready 分配；旧 consumer 的 list/ack 请求被拒绝
    pub window_consumers: HashMap<String, String>,

    /// consumer 序号（单调递增）
    pub next_consumer_seq: u64,

    /// 请求序号（单调递增，用于 requestId 生成）
    pub next_request_seq: u64,

    /// 文档迁移记录：transferId → TransferRecord
    pub transfers: HashMap<String, TransferRecord>,

    /// 🔴 S07/N05 在途文件准备与注册预约：lower_key → 状态
    /// 在途（读盘期间去重标记）与预约（读盘完成、等待前端 register 兑现——
    /// 消除"prepare 返回到 register 之间"的归属空窗：并发第二请求仍按 AlreadyOpen 激活）。
    /// 预约带 TTL 惰性过期（前端崩溃不注册时由下次访问清理，不永久占用）。
    pub pending_prepares: HashMap<String, PendingPrepare>,
}

/// 🔴 N05 prepare 预约/在途记录
#[derive(Clone, Debug)]
pub struct PendingPrepare {
    /// 发起/预约窗口
    pub owner: String,
    /// true = 读盘完成后的注册预约（等待 register_document 兑现）；false = 读盘在途
    pub reserved: bool,
    /// 记录建立/刷新时间（预约 TTL 惰性过期基准）
    pub at: std::time::Instant,
}

impl AppState {
    /// 预约 TTL：前端 prepare 返回后正常会立即 register；超过该时限视为放弃
    /// （崩溃/异常），惰性清理（读取点检查，无需后台定时器）。
    pub const PREPARE_RESERVATION_TTL: std::time::Duration = std::time::Duration::from_secs(30);

    /// 读取在途/预约的存活发起者：过期预约视为无记录（惰性清理并返回 None）。
    /// 在途读盘（reserved=false）不过期（IO 完成会自我更新）。
    pub fn live_pending_prepare(&mut self, lower_key: &str) -> Option<String> {
        let expired = match self.pending_prepares.get(lower_key) {
            Some(p) => p.reserved && p.at.elapsed() > Self::PREPARE_RESERVATION_TTL,
            None => return None,
        };
        if expired {
            self.pending_prepares.remove(lower_key);
            return None;
        }
        self.pending_prepares.get(lower_key).map(|p| p.owner.clone())
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            documents: HashMap::new(),
            windows: HashMap::new(),
            closing_windows: HashSet::new(),
            intents: HashMap::new(),
            next_window_seq: 1, // nb-main 是 0，后续从 1 开始
            settings_revision: 0,
            open_requests: HashMap::new(),
            orphan_requests: Vec::new(),
            open_queue_version: 0,
            window_consumers: HashMap::new(),
            next_consumer_seq: 0,
            next_request_seq: 0,
            transfers: HashMap::new(),
            pending_prepares: HashMap::new(),
        }
    }
}

impl AppState {
    /// 分配新窗口 label
    pub fn alloc_label(&mut self) -> String {
        let seq = self.next_window_seq;
        self.next_window_seq += 1;
        format!("nb-{}", seq)
    }

    /// 注册窗口
    pub fn register_window(&mut self, label: String, record: WindowRecord) {
        self.windows.insert(label, record);
    }

    /// 标记窗口正在被主动关闭
    pub fn mark_closing(&mut self, label: &str) {
        self.closing_windows.insert(label.to_string());
    }

    /// 检查窗口是否正在被主动关闭
    pub fn is_closing(&self, label: &str) -> bool {
        self.closing_windows.contains(label)
    }

    /// 注销窗口及其名下所有文档；返回该窗口未处理的打开请求（由调用方转交或转入待分配队列）
    pub fn unregister_window(&mut self, label: &str) -> Vec<crate::dto::OpenRequestDto> {
        self.windows.remove(label);
        self.intents.remove(label);
        self.closing_windows.remove(label);
        self.window_consumers.remove(label);
        // 清理该窗口名下的所有文档
        self.documents.retain(|_, doc| doc.owner_window != label);
        // 🔴 N05：同时清理该窗口的在途读盘与 prepare 预约（窗口销毁后不再有 register 兑现）
        self.pending_prepares.retain(|_, p| p.owner != label);
        self.open_requests.remove(label).unwrap_or_default()
    }

    /// 获取最后活跃的窗口
    pub fn last_active_window(&self) -> Option<&String> {
        self.windows
            .values()
            .filter(|w| w.is_ready)
            .max_by_key(|w| w.last_active_at)
            .map(|w| &w.label)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 🔴 N05 prepare 预约：TTL 内的预约对并发查询存活（消除注册空窗双开）
    #[test]
    fn reservation_is_live_within_ttl() {
        let mut s = AppState::default();
        let lower = "c:\\t\\a.md";
        s.pending_prepares.insert(
            lower.into(),
            PendingPrepare { owner: "nb-1".into(), reserved: true, at: std::time::Instant::now() },
        );
        assert_eq!(s.live_pending_prepare(lower).as_deref(), Some("nb-1"));
    }

    /// 🔴 N05 预约过期：TTL 之外的预约惰性清理（前端崩溃不注册不永久占用）
    #[test]
    fn expired_reservation_is_lazily_cleared() {
        let mut s = AppState::default();
        let lower = "c:\\t\\b.md";
        s.pending_prepares.insert(
            lower.into(),
            PendingPrepare {
                owner: "nb-1".into(),
                reserved: true,
                at: std::time::Instant::now() - (AppState::PREPARE_RESERVATION_TTL + std::time::Duration::from_secs(1)),
            },
        );
        assert_eq!(s.live_pending_prepare(lower), None);
        assert!(!s.pending_prepares.contains_key(lower), "过期预约应被移除");
    }

    /// 🔴 N05 在途读盘标记不过期（IO 完成前不因 TTL 被误清）
    #[test]
    fn inflight_prepare_does_not_expire() {
        let mut s = AppState::default();
        let lower = "c:\\t\\c.md";
        s.pending_prepares.insert(
            lower.into(),
            PendingPrepare {
                owner: "nb-1".into(),
                reserved: false,
                at: std::time::Instant::now() - (AppState::PREPARE_RESERVATION_TTL + std::time::Duration::from_secs(1)),
            },
        );
        assert_eq!(s.live_pending_prepare(lower).as_deref(), Some("nb-1"));
    }

    /// 🔴 N05 窗口销毁清理其在途与预约标记
    #[test]
    fn unregister_window_clears_pending_prepares() {
        let mut s = AppState::default();
        s.register_window("nb-1".into(), crate::window::manager::WindowRecord::new("nb-1".into(), 1));
        s.pending_prepares.insert(
            "c:\\t\\a.md".into(),
            PendingPrepare { owner: "nb-1".into(), reserved: true, at: std::time::Instant::now() },
        );
        s.pending_prepares.insert(
            "c:\\t\\b.md".into(),
            PendingPrepare { owner: "nb-2".into(), reserved: false, at: std::time::Instant::now() },
        );
        let _ = s.unregister_window("nb-1");
        assert!(!s.pending_prepares.contains_key("c:\\t\\a.md"), "销毁窗口的预约应清理");
        assert!(s.pending_prepares.contains_key("c:\\t\\b.md"), "其它窗口的标记保留");
    }
}
