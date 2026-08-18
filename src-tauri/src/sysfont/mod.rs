// NoteBoard 系统字体枚举 — IPC 接口
// FR-1101: 从系统已安装字体中选择

use crate::dto::FontFamily;
use font_kit::source::SystemSource;
use std::collections::BTreeSet;

pub mod commands {
    use super::*;

    /// 枚举系统字体
    #[tauri::command]
    pub fn list_system_fonts() -> Result<Vec<FontFamily>, String> {
        let mut font_names = BTreeSet::new();

        // 尝试从系统底层获取已安装字体
        let source = SystemSource::new();
        if let Ok(handles) = source.all_fonts() {
            for handle in handles {
                if let Ok(font) = handle.load() {
                    let name = font.family_name();
                    if !name.is_empty() && !name.starts_with('@') {
                        font_names.insert(name);
                    }
                }
            }
        }

        // 基础默认保障列表
        let defaults = [
            "Microsoft YaHei UI",
            "Microsoft YaHei",
            "SimSun",
            "SimHei",
            "KaiTi",
            "FangSong",
            "Consolas",
            "Cascadia Code",
            "Cascadia Mono",
            "Source Code Pro",
            "Fira Code",
            "JetBrains Mono",
            "Courier New",
            "Segoe UI",
            "Times New Roman",
            "Arial",
            "Calibri",
        ];
        for d in defaults {
            font_names.insert(d.to_string());
        }

        let result = font_names
            .into_iter()
            .map(|name| {
                let lower = name.to_lowercase();
                let is_monospace = lower.contains("mono")
                    || lower.contains("code")
                    || lower.contains("consolas")
                    || lower.contains("courier")
                    || lower.contains("typewriter");
                let has_cjk = name.chars().any(|c| (c as u32) >= 0x4E00 && (c as u32) <= 0x9FFF);
                FontFamily {
                    family: name,
                    is_monospace,
                    has_cjk,
                }
            })
            .collect();

        Ok(result)
    }
}
