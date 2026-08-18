// NoteBoard AppState — 全局应用状态
// 权威所有者：文档注册表、窗口注册表、意图暂存
// 不持有：文档内容、撤销栈、光标位置（见 docs/03-领域模型.md §1.1）

use crate::dto::WindowIntent;
use crate::registry::documents::DocumentRecord;
use crate::window::manager::WindowRecord;
use std::collections::{HashMap, HashSet};

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

    /// 注销窗口及其名下所有文档
    pub fn unregister_window(&mut self, label: &str) {
        self.windows.remove(label);
        self.intents.remove(label);
        self.closing_windows.remove(label);
        // 清理该窗口名下的所有文档
        self.documents.retain(|_, doc| doc.owner_window != label);
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
