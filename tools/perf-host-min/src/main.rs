// NoteBoard 性能对照：最小 Tauri 宿主
//
// 用途（docs/performance/启动基线.md §最小宿主对照）：
//   与主应用相同 tauri 版本、相同默认 release profile、相同「初始隐藏 → JS 就绪后显示」
//   窗口策略的最小实现，用于分离 WebView2 冷启动固定成本与应用自身增量。
//
// 输出：%TEMP%\noteboard-perf\minimal-host.json 记录以下毫秒级 spans：
//   process_entry → setup_end → html_parse（web）→ js_ready（web）→ shown
// 关闭对照窗口即退出进程，不写任何用户数据目录。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    noteboard_perf_host_min_lib::run()
}
