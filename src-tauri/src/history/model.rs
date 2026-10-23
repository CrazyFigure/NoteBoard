// NoteBoard 文档历史记录：索引数据结构
//
// 每个文档一份索引 docs/<docId>.json，按时间升序记录版本条目；正文以内容寻址 blob 保存。
// 最后一条可能处于「合并窗口」中（open = true）：同一设备短时间内的连续保存只更新这一条，
// 其正文暂存在 pending/<docId>.gz，封口后才移入 blobs/（同步模式只上传已封口的条目）。

use serde::{Deserialize, Serialize};

/// 索引文件格式版本
pub const INDEX_FORMAT: u32 = 1;

/// 版本产生原因
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Reason {
    /// 首次记录：开启历史后第一次保存前的磁盘内容
    Initial,
    /// 应用内保存（手动或自动）
    Save,
    /// 应用外修改：保存前发现磁盘内容与上次记录不一致
    External,
    /// 同步覆盖本机前的本机内容
    BeforeSync,
    /// 从其他设备同步下来的内容
    SyncPull,
    /// 本机与其他设备的按行合并结果
    SyncMerge,
    /// 还原前未保存的编辑内容
    BeforeRestore,
    /// 还原历史版本后的保存
    Restore,
}

/// 版本来源设备
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Origin {
    pub device: String,
    pub name: String,
}

/// 相对上一版本的改动统计（unit：char 字符 / element 画板元素 / node 导图节点 / row 表格行 / cell 图形单元）
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Stats {
    pub ins: u64,
    pub del: u64,
    #[serde(skip_serializing_if = "is_zero")]
    pub modified: u64,
    pub unit: String,
}

fn is_zero(v: &u64) -> bool {
    *v == 0
}

fn is_false(v: &bool) -> bool {
    !*v
}

/// 一个历史版本
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// 时间有序标识（毫秒时间戳十六进制 + 随机后缀），同设备内单调
    pub id: String,
    /// 合并窗口起点
    pub start: i64,
    /// 最后一次写入时间
    pub at: i64,
    /// 原始字节 SHA-256
    pub hash: String,
    pub size: u64,
    pub reason: Reason,
    #[serde(default)]
    pub origin: Origin,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stats: Option<Stats>,
    /// 还原操作的来源版本
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restored_from: Option<String>,
    /// 固定的版本不参与自动清理
    #[serde(default, skip_serializing_if = "is_false")]
    pub pinned: bool,
    /// 合并窗口未封口（正文位于 pending/）
    #[serde(default, skip_serializing_if = "is_false")]
    pub open: bool,
}

/// 单个文档的历史索引
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DocIndex {
    pub format: u32,
    pub doc_id: String,
    /// 文档类型（markdown / code / board / mindmap / drawio / bitable）
    pub kind: String,
    /// 最近一次记录时的绝对路径（仅用于展示和孤立历史的重新关联）
    pub path: String,
    pub entries: Vec<Entry>,
}

impl DocIndex {
    pub fn new(doc_id: &str, kind: &str, path: &str) -> Self {
        Self { format: INDEX_FORMAT, doc_id: doc_id.to_string(), kind: kind.to_string(), path: path.to_string(), entries: Vec::new() }
    }

    pub fn last(&self) -> Option<&Entry> {
        self.entries.last()
    }

    pub fn find(&self, id: &str) -> Option<&Entry> {
        self.entries.iter().find(|e| e.id == id)
    }
}

/// 生成时间有序的条目标识：同一毫秒内由随机后缀区分
pub fn new_entry_id(now: i64) -> String {
    let rand = uuid::Uuid::new_v4().as_u128() as u32;
    format!("{:011x}{:08x}", now.max(0), rand)
}
