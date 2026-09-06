// NoteBoard 性能诊断 IPC 命令 — 仅诊断用
// 前端低频批量上报 web spans；显式 flush 由前端在关键里程碑调用。
// 未启用诊断（NOTEBOARD_PERF_SPANS 未设置）时全部为 no-op，不产生磁盘写入。

use crate::perf::{self, WebSpanDto};

/// 前端诊断开关查询（与 NOTEBOARD_PERF_SPANS 对齐；前端缓存后未启用时零 IPC）
#[tauri::command]
pub fn is_perf_spans_enabled() -> Result<bool, String> {
    Ok(perf::enabled())
}

/// 接收前端批量上报的 web 端 spans（时间原点为 performance.now，与 Rust 时钟分轴保存）
#[tauri::command]
pub fn record_web_spans(label: String, spans: Vec<WebSpanDto>) -> Result<(), String> {
    perf::record_web_spans(&label, spans);
    Ok(())
}

/// 把当前进程已收集的全部 spans 批量写入 %TEMP%\noteboard-perf\
/// 返回写入的文件路径；未启用诊断或无数据时返回 null
#[tauri::command]
pub fn dump_perf_spans(reason: String) -> Result<Option<String>, String> {
    Ok(perf::flush_to_disk(&reason).map(|p| p.to_string_lossy().to_string()))
}
