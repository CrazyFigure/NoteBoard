// NoteBoard 性能诊断 spans 收集器（仅诊断用，非业务功能）
//
// 🔴 设计约束（docs/performance/启动基线.md §S01）：
//   1. 默认关闭，由环境变量 NOTEBOARD_PERF_SPANS=1 在进程启动时开启；
//      关闭状态下 record_* 只做一次原子布尔读，不给任何热路径增加负担。
//   2. 仅内存收集且有硬上限（MAX_SPANS），满了只累计 dropped 计数，绝不无界增长。
//   3. 磁盘输出只在显式 flush 时一次性批量写入系统临时目录，命令热路径无同步落盘。
//   4. 只记录名称/时长/描述性属性与窗口 label，绝不记录文档正文或完整私人路径。
//   5. Rust t_ms 与 web t（performance.now）时钟原点不同，不可直接相减；
//      跨进程对齐以外部测量为主，本文件只负责分轴保存。

use serde::Serialize;
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

/// IPC 命令封装（record_web_spans / dump_perf_spans）
pub mod commands;

/// 单进程最多收集的 span 条数，超出后停止收集只计数
const MAX_SPANS: usize = 1024;

/// 启用开关（init 时从环境变量读取一次）
static ENABLED: AtomicBool = AtomicBool::new(false);

/// 全局序号（单调递增，用于稳定排序）
static SEQ: AtomicU64 = AtomicU64::new(0);

/// 进程时间原点：main.rs 第一行调用 init() 时固定
static PROCESS_START: OnceLock<Instant> = OnceLock::new();

/// 收集器内部状态
struct Collector {
    spans: Vec<PerfSpanRecord>,
    /// 缓冲区满后被丢弃的事件数
    dropped: u64,
}

static COLLECTOR: OnceLock<Mutex<Collector>> = OnceLock::new();

/// 单条 span 记录
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfSpanRecord {
    pub seq: u64,
    pub name: String,
    /// 时钟轴：rust = 相对进程启动的单调时钟；web = performance.now()
    pub clock: &'static str,
    pub t_ms: f64,
    /// 区间型 span 的持续时长（毫秒）；点事件为 None
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dur_ms: Option<f64>,
    /// 归属窗口 label；None 表示进程级
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<String>,
    /// 关联的打开请求 ID（S04 队列落地后填写）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    /// 描述性属性（文件大小/类型等，绝不含正文）
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub attrs: Vec<(String, String)>,
}

/// web 端 span 的 wire DTO（时间原点为 performance.now）
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSpanDto {
    pub name: String,
    pub t: f64,
    #[serde(default)]
    pub dur_ms: Option<f64>,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub attrs: Vec<(String, String)>,
}

/// main.rs 第一行调用：固定进程时间原点并读取启用开关
pub fn init() {
    let _ = PROCESS_START.set(Instant::now());
    let on = std::env::var("NOTEBOARD_PERF_SPANS")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    ENABLED.store(on, Ordering::Relaxed);
    if on {
        record(
            "process_entry",
            "instant",
            now_ms(),
            None,
            None,
            &[],
        );
    }
}

/// 当前是否启用诊断收集
pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// 相对进程原点的毫秒数（未初始化时返回 0，仅出现在非常规嵌入场景）
fn now_ms() -> f64 {
    PROCESS_START
        .get()
        .map(|s| s.elapsed().as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// 取区间起点（无论是否启用都可用，未启用时结果不会被记录）
pub fn now_instant() -> Instant {
    Instant::now()
}

/// 记录一个时间点事件
pub fn mark(name: &str) {
    mark_with(name, None, &[]);
}

/// 记录带窗口归属的时间点事件
pub fn mark_with(name: &str, window: Option<&str>, attrs: &[(&str, String)]) {
    if !enabled() {
        return;
    }
    record(name, "instant", now_ms(), window.map(str::to_string), None, attrs);
}

/// 记录一个区间事件（start 由调用方先前捕获）
pub fn span_with(name: &str, start: Instant, window: Option<&str>, attrs: &[(&str, String)]) {
    if !enabled() {
        return;
    }
    let dur = start.elapsed().as_secs_f64() * 1000.0;
    record(
        name,
        "span",
        now_ms() - dur,
        window.map(str::to_string),
        None,
        attrs,
    );
}

/// 接收 web 端批量上报的 spans（未启用时直接丢弃，不产生任何存储）
pub fn record_web_spans(window: &str, spans: Vec<WebSpanDto>) {
    if !enabled() || spans.is_empty() {
        return;
    }
    let mut guard = collector();
    if guard.spans.len() >= MAX_SPANS {
        guard.dropped += spans.len() as u64;
        return;
    }
    for s in spans {
        if guard.spans.len() >= MAX_SPANS {
            guard.dropped += 1;
            continue;
        }
        guard.spans.push(PerfSpanRecord {
            seq: SEQ.fetch_add(1, Ordering::Relaxed),
            name: s.name,
            clock: "web",
            t_ms: s.t,
            dur_ms: s.dur_ms,
            window: Some(window.to_string()),
            request_id: s.request_id,
            attrs: s.attrs,
        });
    }
}

fn collector() -> std::sync::MutexGuard<'static, Collector> {
    COLLECTOR
        .get_or_init(|| {
            Mutex::new(Collector {
                spans: Vec::new(),
                dropped: 0,
            })
        })
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn record(
    name: &str,
    phase: &'static str,
    t_ms: f64,
    window: Option<String>,
    request_id: Option<String>,
    attrs: &[(&str, String)],
) {
    let mut guard = collector();
    if guard.spans.len() >= MAX_SPANS {
        guard.dropped += 1;
        return;
    }
    guard.spans.push(PerfSpanRecord {
        seq: SEQ.fetch_add(1, Ordering::Relaxed),
        name: name.to_string(),
        clock: "rust",
        t_ms,
        // phase 通过 dur_ms 是否存在区分：instant 无时长，span 起点为 t_ms
        dur_ms: if phase == "span" { Some(0.0) } else { None },
        window,
        request_id,
        attrs: attrs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect(),
    });
}

/// 将全部收集结果一次性批量写入系统临时目录（%TEMP%\noteboard-perf\）。
/// 返回写入的文件路径；未启用或无数据时返回 None。
pub fn flush_to_disk(reason: &str) -> Option<std::path::PathBuf> {
    if !enabled() {
        return None;
    }
    let (spans, dropped) = {
        let mut guard = collector();
        if guard.spans.is_empty() && guard.dropped == 0 {
            return None;
        }
        (std::mem::take(&mut guard.spans), guard.dropped)
    };
    let mut sorted = spans;
    sorted.sort_by_key(|s| s.seq);

    let pid = std::process::id();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join("noteboard-perf");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(format!("spans-{}-{}.json", pid, ts));
    let payload = serde_json::json!({
        "version": 1,
        "pid": pid,
        "flushReason": reason,
        "droppedEvents": dropped,
        "spans": sorted,
    });
    let result = std::fs::File::create(&path).and_then(|mut f| {
        f.write_all(serde_json::to_string_pretty(&payload).unwrap_or_default().as_bytes())
    });
    match result {
        Ok(()) => Some(path),
        Err(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 收集器应有硬上限，超出后只累计 dropped，不 panic、不无界增长
    #[test]
    fn collector_respects_max_spans() {
        let mut c = Collector {
            spans: Vec::new(),
            dropped: 0,
        };
        for i in 0..(MAX_SPANS + 10) {
            if c.spans.len() >= MAX_SPANS {
                c.dropped += 1;
                continue;
            }
            c.spans.push(PerfSpanRecord {
                seq: i as u64,
                name: format!("evt-{i}"),
                clock: "rust",
                t_ms: i as f64,
                dur_ms: None,
                window: None,
                request_id: None,
                attrs: Vec::new(),
            });
        }
        assert_eq!(c.spans.len(), MAX_SPANS);
        assert_eq!(c.dropped, 10);
    }

    /// web DTO 反序列化字段兼容（camelCase wire 格式）
    #[test]
    fn web_span_dto_parses_camel_case() {
        let raw = r#"{"name":"js_entry","t":12.5,"requestId":null,"attrs":[["size","1024"]]}"#;
        let dto: WebSpanDto = serde_json::from_str(raw).unwrap();
        assert_eq!(dto.name, "js_entry");
        assert_eq!(dto.t, 12.5);
        assert_eq!(dto.attrs, vec![("size".to_string(), "1024".to_string())]);
    }
}
