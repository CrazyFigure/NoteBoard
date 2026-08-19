// NoteBoard 系统字体枚举 — IPC 接口
// 从系统真实已安装字体中枚举，支持毫秒级快速索引

use crate::dto::FontFamily;
use std::collections::BTreeSet;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

pub mod commands {
    use super::*;

    /// 枚举本机真实安装的系统字体（不掺杂未安装的虚假推荐项）
    #[tauri::command]
    pub fn list_system_fonts() -> Result<Vec<FontFamily>, String> {
        let raw_names = enumerate_system_fonts();
        let mut font_names = BTreeSet::new();

        for name in raw_names {
            let trimmed = name.trim();
            if !trimmed.is_empty() && !trimmed.starts_with('@') {
                font_names.insert(trimmed.to_string());
            }
        }

        // 识别字体属性：等宽字体与中文字体
        let result = font_names
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
            .collect();

        Ok(result)
    }

    #[cfg(windows)]
    fn enumerate_system_fonts() -> Vec<String> {
        // Windows 平台：使用 WPF SystemFontFamilies（基于 DirectWrite）快速读取真实字体族名，
        // 并通过 GDI EnumFontFamiliesEx 剔除纯符号字符集（SYMBOL_CHARSET）图标字体
        const WINDOWS_CREATE_NO_WINDOW: u32 = 0x08000000;
        let script = r#"[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
Add-Type -AssemblyName PresentationCore
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class FontSym {
    const int SYMBOL_CHARSET = 2;
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    struct LOGFONT {
        public int lfHeight; public int lfWidth; public int lfEscapement; public int lfOrientation;
        public int lfWeight; public byte lfItalic; public byte lfUnderline; public byte lfStrikeOut;
        public byte lfCharSet; public byte lfOutPrecision; public byte lfClipPrecision; public byte lfQuality;
        public byte lfPitchAndFamily;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string lfFaceName;
    }
    [DllImport("gdi32.dll", CharSet=CharSet.Unicode)]
    static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);
    delegate int EnumProc(ref LOGFONT lf, IntPtr tm, uint type, IntPtr p);
    [DllImport("gdi32.dll", CharSet=CharSet.Unicode)]
    static extern int EnumFontFamiliesEx(IntPtr hdc, ref LOGFONT lf, EnumProc cb, IntPtr p, uint flags);
    static Dictionary<string, bool> hasText = new Dictionary<string, bool>();
    static int Callback(ref LOGFONT lf, IntPtr tm, uint type, IntPtr p) {
        string name = lf.lfFaceName;
        if (string.IsNullOrEmpty(name) || name[0] == '@') return 1;
        bool prev; hasText.TryGetValue(name, out prev);
        hasText[name] = prev || lf.lfCharSet != SYMBOL_CHARSET;
        return 1;
    }
    public static HashSet<string> SymbolOnly() {
        IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
        LOGFONT lf = new LOGFONT(); lf.lfCharSet = 1;
        EnumFontFamiliesEx(dc, ref lf, Callback, IntPtr.Zero, 0);
        DeleteDC(dc);
        var s = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var kv in hasText) if (!kv.Value) s.Add(kv.Key);
        return s;
    }
}
'@
$symbol = [FontSym]::SymbolOnly()
[System.Windows.Media.Fonts]::SystemFontFamilies | ForEach-Object { $_.Source } | Where-Object { -not $symbol.Contains($_) }"#;

        if let Ok(output) = Command::new("powershell")
            .creation_flags(WINDOWS_CREATE_NO_WINDOW)
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script])
            .output()
        {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                let list: Vec<String> = text
                    .lines()
                    .map(|l| l.trim().to_string())
                    .filter(|l| !l.is_empty())
                    .collect();
                if !list.is_empty() {
                    return list;
                }
            }
        }

        // 备用兜底方案：使用 font-kit
        fallback_font_kit_enumeration()
    }

    #[cfg(not(windows))]
    fn enumerate_system_fonts() -> Vec<String> {
        if let Ok(output) = Command::new("fc-list").args([":", "family"]).output() {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                let mut set = HashSet::new();
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
}
