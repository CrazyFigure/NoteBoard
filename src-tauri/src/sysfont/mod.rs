// NoteBoard 系统字体枚举 — IPC 接口
// 🔴 S06 改造（docs/启动性能与低内存根治计划.md §F）：
//   1. Windows 正常路径不再启动 PowerShell 子进程 / WPF / Add-Type；
//      使用进程内 GDI EnumFontFamiliesExW 原生枚举（与原 PowerShell 方案同一底层 API，
//      保持中文族名、同族去重与"纯 SYMBOL_CHARSET 字体不列出"行为一致）。
//   2. 枚举在 blocking worker 线程执行（async command），不再阻塞 UI。
//   3. 结果按进程缓存；force_refresh=true 提供设置页强制重新获取的内部路径。
//   4. GDI 失败时回退 font-kit（保持原有兜底）。

use crate::dto::FontFamily;
use std::collections::BTreeSet;
use std::sync::{Mutex, OnceLock};

/// 进程内枚举缓存（含 is_monospace/has_cjk 属性）
static SYSTEM_FONTS_CACHE: OnceLock<Mutex<Option<Vec<FontFamily>>>> = OnceLock::new();

fn system_fonts_cache() -> &'static Mutex<Option<Vec<FontFamily>>> {
    SYSTEM_FONTS_CACHE.get_or_init(|| Mutex::new(None))
}

pub mod commands {
    use super::*;

    /// 枚举本机真实安装的系统字体（不掺杂未安装的虚假推荐项）
    /// S06：async command，枚举移入 blocking worker；force_refresh 跳过进程缓存
    #[tauri::command]
    pub async fn list_system_fonts(force_refresh: Option<bool>) -> Result<Vec<FontFamily>, String> {
        let force = force_refresh.unwrap_or(false);
        if !force {
            let cached = system_fonts_cache().lock().unwrap().clone();
            if let Some(fonts) = cached {
                return Ok(fonts);
            }
        }
        let result = tauri::async_runtime::spawn_blocking(|| super::enumerate_and_classify())
            .await
            .map_err(|error| format!("system_font_error:{error}"))?
            .map_err(|error| format!("system_font_error:{error}"))?;
        *system_fonts_cache().lock().unwrap() = Some(result.clone());
        Ok(result)
    }
}

/// 枚举并按现有启发式分类（等宽/中文字体标识行为与改造前一致）
fn enumerate_and_classify() -> Result<Vec<FontFamily>, String> {
    let raw_names = enumerate_system_fonts();
    if raw_names.is_empty() {
        return Err("empty".to_string());
    }
    let mut font_names = BTreeSet::new();

    for name in raw_names {
        let trimmed = name.trim();
        if !trimmed.is_empty() && !trimmed.starts_with('@') {
            font_names.insert(trimmed.to_string());
        }
    }

    // 识别字体属性：等宽字体与中文字体
    Ok(font_names
        .into_iter()
        .map(|name| {
            let lower = name.to_lowercase();
            let is_monospace = lower.contains("mono")
                || lower.contains("code")
                || lower.contains("consolas")
                || lower.contains("courier")
                || lower.contains("typewriter")
                || lower.contains("terminal")
                || lower.contains("fixed")
                || lower.contains("source code pro")
                || lower.contains("fira code")
                || lower.contains("jetbrains mono")
                || lower.contains("maple mono")
                || lower.contains("cascadia");
            let has_cjk = name.chars().any(|c| (c as u32) >= 0x4E00 && (c as u32) <= 0x9FFF)
                || lower.contains("yahei")
                || lower.contains("simsun")
                || lower.contains("simhei")
                || lower.contains("kaiti")
                || lower.contains("fangsong")
                || lower.contains("dengxian")
                || lower.contains("noto sans sc")
                || lower.contains("noto serif sc")
                || lower.contains("source han")
                || lower.contains("pingfang")
                || lower.contains("songti")
                || lower.contains("heiti")
                || lower.contains("yu gothic")
                || lower.contains("meiryo")
                || lower.contains("malgun")
                || lower.contains("jhenghei")
                || lower.contains("mingliu")
                || lower.contains("lxgw")
                || lower.contains("xiawu")
                || lower.contains("sarasa")
                || lower.contains("maple")
                || lower.contains("wenquanyi");
            FontFamily {
                family: name,
                is_monospace,
                has_cjk,
            }
        })
        .collect())
}

#[cfg(windows)]
fn enumerate_system_fonts() -> Vec<String> {
    // 首选：进程内 GDI 原生枚举（消除 PowerShell/WPF/Add-Type 子进程）
    let native = enumerate_system_fonts_gdi();
    if !native.is_empty() {
        return native;
    }
    // 兜底：font-kit
    fallback_font_kit_enumeration()
}

/// GDI EnumFontFamiliesExW 原生枚举。
/// 行为与原 PowerShell 方案一致：族内任一非 SYMBOL_CHARSET 字体即列出（纯符号字体剔除）。
#[cfg(windows)]
fn enumerate_system_fonts_gdi() -> Vec<String> {
    use std::collections::HashMap;
    use windows::Win32::Foundation::LPARAM;
    use windows::Win32::Graphics::Gdi::{FONT_CHARSET, LOGFONTW};

    const SYMBOL_CHARSET: u8 = 2; // wingdi.h
    const DEFAULT_CHARSET: u8 = 1; // wingdi.h

    /// 回调收集状态：族名 → 是否存在非符号字符集的字体
    struct EnumContext {
        has_text: HashMap<String, bool>,
    }

    // GDI 回调：每个已安装字体调用一次；同族多字重/斜体会多次回调
    unsafe extern "system" fn enum_font_proc(
        lpelfw: *const LOGFONTW,
        _lpntm: *const windows::Win32::Graphics::Gdi::TEXTMETRICW,
        _font_type: u32,
        lparam: LPARAM,
    ) -> i32 {
        if lpelfw.is_null() {
            return 1;
        }
        let face = &*lpelfw;
        let name_len = face.lfFaceName.iter().position(|&c| c == 0).unwrap_or(32);
        if name_len == 0 {
            return 1;
        }
        let name = String::from_utf16_lossy(&face.lfFaceName[..name_len]);
        if name.starts_with('@') {
            return 1;
        }
        let ctx = &mut *(lparam.0 as *mut EnumContext);
        let entry = ctx.has_text.entry(name).or_insert(false);
        if face.lfCharSet != FONT_CHARSET(SYMBOL_CHARSET) {
            *entry = true;
        }
        1
    }

    unsafe {
        use windows::Win32::Graphics::Gdi::{
            CreateCompatibleDC, DeleteDC, EnumFontFamiliesExW,
        };

        let hdc = CreateCompatibleDC(None);
        if hdc.is_invalid() {
            return Vec::new();
        }
        let mut logfont: LOGFONTW = std::mem::zeroed();
        logfont.lfCharSet = FONT_CHARSET(DEFAULT_CHARSET);

        let mut ctx = EnumContext {
            has_text: HashMap::new(),
        };
        let ctx_ptr = &mut ctx as *mut EnumContext;

        // EnumFontFamiliesExW 遍历所有字符集的字体族
        let _ = EnumFontFamiliesExW(
            hdc,
            &logfont,
            Some(enum_font_proc),
            LPARAM(ctx_ptr as isize),
            0,
        );
        let _ = DeleteDC(hdc);

        ctx.has_text
            .into_iter()
            .filter(|(_, has_text)| *has_text)
            .map(|(name, _)| name)
            .collect()
    }
}

#[cfg(not(windows))]
fn enumerate_system_fonts() -> Vec<String> {
    if let Ok(output) = std::process::Command::new("fc-list")
        .args([":", "family"])
        .output()
    {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            let mut set = std::collections::HashSet::new();
            for line in text.lines() {
                if let Some(first) = line.split(',').next() {
                    let trimmed = first.trim();
                    if !trimmed.is_empty() {
                        set.insert(trimmed.to_string());
                    }
                }
            }
            if !set.is_empty() {
                return set.into_iter().collect();
            }
        }
    }
    fallback_font_kit_enumeration()
}

/// font-kit 兜底枚举
fn fallback_font_kit_enumeration() -> Vec<String> {
    let mut list = Vec::new();
    let source = font_kit::source::SystemSource::new();
    if let Ok(handles) = source.all_fonts() {
        for handle in handles {
            if let Ok(font) = handle.load() {
                let name = font.family_name();
                if !name.is_empty() && !name.starts_with('@') {
                    list.push(name);
                }
            }
        }
    }
    list
}

#[cfg(test)]
mod tests {
    /// GDI 枚举在本机应返回非空列表且包含常见中文字体族
    #[test]
    #[cfg(windows)]
    fn gdi_enumeration_returns_common_families() {
        let fonts = super::enumerate_system_fonts_gdi();
        assert!(!fonts.is_empty(), "GDI 枚举不应为空");
        // Windows 一定存在 Segoe UI
        let has_segoe = fonts.iter().any(|f| f.eq_ignore_ascii_case("Segoe UI"));
        assert!(has_segoe, "应包含 Segoe UI，实际样例: {:?}", &fonts[..fonts.len().min(5)]);
    }
}
