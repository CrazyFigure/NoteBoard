// 本地文件搜索：正文提取
//
// 纯文本按扩展名白名单识别（含 NoteBoard 自有格式），自动识别 UTF-8 / UTF-16 / GBK 等编码；
// Word / PowerPoint / Excel（OOXML）从压缩包中的 XML 提取文字。
// 建立索引与查询核对使用同一套提取逻辑，保证命中判断一致。

use std::fs::File;
use std::io::Read;
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Text,
    Docx,
    Pptx,
    Xlsx,
}

const MB: u64 = 1024 * 1024;
/// 普通文本上限：更大的多为日志或数据导出，搜索意义不大且拖慢建索引
const TEXT_LIMIT: u64 = 4 * MB;
/// 画板、导图、表格等自有格式内嵌图片数据，体积较大但文字仍需可搜
const RICH_LIMIT: u64 = 32 * MB;
/// Office 文件上限与解压后单个 XML 上限（防止压缩炸弹）
const OFFICE_LIMIT: u64 = 32 * MB;
const XML_LIMIT: u64 = 64 * MB;

/// 纯文本扩展名白名单
const TEXT_EXTS: &[&str] = &[
    "md", "markdown", "mdx", "txt", "text", "log", "csv", "tsv", "json", "jsonc", "json5", "yaml", "yml", "toml",
    "ini", "cfg", "conf", "config", "properties", "env", "xml", "html", "htm", "xhtml", "css", "scss", "sass", "less",
    "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "vue", "svelte", "astro", "py", "pyw", "rs", "go", "java",
    "kt", "kts", "scala", "groovy", "gradle", "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx", "m", "cs", "fs",
    "swift", "rb", "php", "pl", "pm", "lua", "r", "dart", "sh", "bash", "zsh", "fish", "ps1", "psm1", "bat", "cmd",
    "sql", "graphql", "gql", "proto", "tex", "bib", "rst", "adoc", "asciidoc", "org", "wiki", "srt", "vtt", "nfo",
    "diff", "patch", "cmake", "mmd", "mermaid", "puml", "plantuml", "iuml", "uml", "infographic", "ig", "rtf",
];

/// NoteBoard 自有格式及同类画板/导图格式（JSON / XML 文本）
const RICH_EXTS: &[&str] = &["excalidraw", "board", "canvas", "mindmap", "mm", "drawio", "dio", "bitable", "table"];

/// 无扩展名但常见的文本文件
const TEXT_NAMES: &[&str] = &["readme", "license", "makefile", "dockerfile", "changelog", "authors", "todo"];

/// 按文件名与大小判断能否建立内容索引
pub fn kind_for(name: &str, size: u64) -> Option<Kind> {
    let lower = name.to_ascii_lowercase();
    let ext = match lower.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => ext,
        _ => {
            return (TEXT_NAMES.contains(&lower.as_str()) && size <= TEXT_LIMIT).then_some(Kind::Text);
        }
    };
    // Office 临时锁文件（~$开头）不是有效文档
    if lower.starts_with("~$") {
        return None;
    }
    if TEXT_EXTS.contains(&ext) {
        return (size <= TEXT_LIMIT).then_some(Kind::Text);
    }
    if RICH_EXTS.contains(&ext) {
        return (size <= RICH_LIMIT).then_some(Kind::Text);
    }
    let office = match ext {
        "docx" => Kind::Docx,
        "pptx" => Kind::Pptx,
        "xlsx" => Kind::Xlsx,
        _ => return None,
    };
    (size <= OFFICE_LIMIT).then_some(office)
}

/// 读取正文；二进制、超限或读取失败返回 None
pub fn read_text(path: &Path, kind: Kind) -> Option<String> {
    match kind {
        Kind::Text => read_plain(path),
        Kind::Docx | Kind::Pptx | Kind::Xlsx => read_office(path, kind),
    }
}

fn read_plain(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut bytes = Vec::new();
    // 多读一个字节用于判断是否超过上限
    file.take(RICH_LIMIT + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > RICH_LIMIT {
        return None;
    }
    decode(&bytes)
}

/// 解码文本：BOM（UTF-8 / UTF-16）→ 合法 UTF-8 → 编码探测（GBK 等）
pub fn decode(bytes: &[u8]) -> Option<String> {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (text, _, _) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        return Some(text.into_owned());
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (text, _, _) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
        return Some(text.into_owned());
    }
    // 含 NUL 字节视为二进制
    let head = &bytes[..bytes.len().min(8192)];
    if head.contains(&0) {
        return None;
    }
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Some(String::from_utf8_lossy(&bytes[3..]).into_owned());
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return Some(text.to_string());
    }
    Some(crate::fsio::read::decode_bytes(bytes).0)
}

fn read_office(path: &Path, kind: Kind) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut zip = zip::ZipArchive::new(file).ok()?;
    let mut parts: Vec<String> = match kind {
        Kind::Docx => vec!["word/document.xml".to_string()],
        Kind::Xlsx => vec!["xl/sharedStrings.xml".to_string()],
        Kind::Pptx => {
            // 幻灯片按编号排序，保证提取顺序与演示顺序一致
            let mut slides: Vec<(u32, String)> = zip
                .file_names()
                .filter_map(|n| {
                    let num = n.strip_prefix("ppt/slides/slide")?.strip_suffix(".xml")?;
                    Some((num.parse().ok()?, n.to_string()))
                })
                .collect();
            slides.sort_unstable();
            slides.into_iter().map(|(_, n)| n).collect()
        }
        Kind::Text => return None,
    };
    let mut text = String::new();
    for name in parts.drain(..) {
        let Ok(entry) = zip.by_name(&name) else { continue };
        if entry.size() > XML_LIMIT {
            continue;
        }
        let mut xml = String::new();
        if entry.take(XML_LIMIT).read_to_string(&mut xml).is_err() {
            continue;
        }
        xml_text(&xml, &mut text);
        text.push('\n');
    }
    Some(text)
}

/// 从 OOXML 中提取文字：段落、表格行、共享字符串结束处换行，制表与换行标签转为空白
pub fn xml_text(xml: &str, out: &mut String) {
    let bytes = xml.as_bytes();
    let mut i = 0;
    let mut text_start = 0;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            if i > text_start {
                push_unescaped(&xml[text_start..i], out);
            }
            let end = match memchr::memchr(b'>', &bytes[i..]) {
                Some(off) => i + off,
                None => break,
            };
            let tag = &xml[i + 1..end];
            let closing = tag.starts_with('/');
            let self_closing = tag.ends_with('/');
            let name = tag.trim_start_matches('/').split(|c: char| c.is_whitespace() || c == '/').next().unwrap_or("");
            let local = name.rsplit(':').next().unwrap_or(name);
            match local {
                "p" | "si" | "tr" if closing => out.push('\n'),
                "br" | "cr" if self_closing || !closing => out.push('\n'),
                "tab" | "tc" if self_closing || closing => out.push(' '),
                _ => {}
            }
            i = end + 1;
            text_start = i;
        } else {
            i += 1;
        }
    }
    if text_start < bytes.len() {
        push_unescaped(&xml[text_start..], out);
    }
}

/// 还原 XML 实体
fn push_unescaped(text: &str, out: &mut String) {
    if !text.contains('&') {
        out.push_str(text);
        return;
    }
    let mut rest = text;
    while let Some(pos) = rest.find('&') {
        out.push_str(&rest[..pos]);
        rest = &rest[pos..];
        let Some(semi) = rest.find(';').filter(|&s| s <= 10) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..semi];
        let ch = match entity {
            "lt" => Some('<'),
            "gt" => Some('>'),
            "amp" => Some('&'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &rest[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn kind_detection_follows_extension_and_size() {
        assert_eq!(kind_for("笔记.MD", 10), Some(Kind::Text));
        assert_eq!(kind_for("画板.excalidraw", 20 * MB), Some(Kind::Text));
        assert_eq!(kind_for("big.log", 5 * MB), None);
        assert_eq!(kind_for("报告.docx", 1000), Some(Kind::Docx));
        assert_eq!(kind_for("~$报告.docx", 1000), None);
        assert_eq!(kind_for("photo.png", 10), None);
        assert_eq!(kind_for("README", 10), Some(Kind::Text));
        assert_eq!(kind_for(".gitignore", 10), None);
    }

    #[test]
    fn decode_handles_bom_utf16_gbk_and_binary() {
        assert_eq!(decode("你好".as_bytes()).as_deref(), Some("你好"));
        let mut utf16 = vec![0xFF, 0xFE];
        utf16.extend("中文 abc".encode_utf16().flat_map(|u| u.to_le_bytes()));
        assert_eq!(decode(&utf16).as_deref(), Some("中文 abc"));
        let (gbk, _, _) = encoding_rs::GBK.encode("会议纪要：本地搜索功能评审，参会人员与结论");
        assert_eq!(decode(&gbk).as_deref(), Some("会议纪要：本地搜索功能评审，参会人员与结论"));
        assert_eq!(decode(&[1, 2, 0, 3]), None);
    }

    #[test]
    fn xml_text_extracts_paragraphs_and_entities() {
        let mut out = String::new();
        xml_text(r#"<w:body><w:p><w:r><w:t>第一段</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve">A &amp; B</w:t></w:r></w:p><w:p><w:r><w:t>&#x4E8C;段</w:t></w:r></w:p></w:body>"#, &mut out);
        assert_eq!(out, "第一段 A & B\n二段\n");
    }

    #[test]
    fn docx_text_is_read_from_zip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("文档.docx");
        let file = File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file("word/document.xml", zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all("<w:document><w:body><w:p><w:r><w:t>季度复盘结论</w:t></w:r></w:p></w:body></w:document>".as_bytes()).unwrap();
        zip.finish().unwrap();
        let text = read_text(&path, Kind::Docx).unwrap();
        assert!(text.contains("季度复盘结论"));
    }
}
