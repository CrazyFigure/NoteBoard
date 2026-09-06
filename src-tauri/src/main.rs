// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 🔴 性能诊断原点：必须位于 main 第一行，process_entry 不含 Windows 进程创建到 main 的开销
    noteboard_lib::perf::init();
    noteboard_lib::run()
}
