// NoteBoard 命令行参数解析
// 不用 tauri-plugin-cli —— 它是 clap 封装，参数必须预声明
// 用 args_os() 而非 args()，避免非 UTF-8 路径被 lossy 替换

use std::path::PathBuf;

/// 从命令行参数解析文件路径
pub fn parse_paths_from_args() -> Vec<PathBuf> {
    std::env::args_os()
        .skip(1) // argv[0] 是 exe 自身
        .filter_map(|a| {
            let s = a.to_string_lossy();
            if s.starts_with('-') {
                return None; // 跳过开关
            }

            // 文件可能以 file:// 形式到达
            if let Ok(url) = url::Url::parse(&s) {
                if url.scheme() == "file" {
                    return url.to_file_path().ok();
                }
            }

            Some(PathBuf::from(a))
        })
        .collect()
}
