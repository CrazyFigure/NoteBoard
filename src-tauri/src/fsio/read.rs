// NoteBoard 文件读取 — 编码探测 + 行尾符探测
// FR-210: UTF-8（含 BOM）/ GBK 自动识别
// FR-211: CRLF / LF 自动识别

use crate::dto::{Encoding, Eol};
use std::fs;
use std::io::Read;
use std::path::Path;

/// 文件读取结果
pub struct FileReadResult {
    pub content: String,
    pub encoding: Encoding,
    pub eol: Eol,
    pub size: u64,
    pub mtime: i64,
    pub readonly: bool,
}

/// 读取文件并探测编码与行尾符
pub fn read_file(path: &Path) -> Result<FileReadResult, String> {
    let metadata = fs::metadata(path).map_err(|e| format!("无法读取文件信息: {}", e))?;

    let size = metadata.len();
    let mtime = metadata
        .modified()
        .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64)
        .unwrap_or(0);
    let readonly = metadata.permissions().readonly();

    // 读取原始字节
    let mut file = fs::File::open(path).map_err(|e| format!("无法打开文件: {}", e))?;
    let mut bytes = Vec::with_capacity(size as usize);
    file.read_to_end(&mut bytes).map_err(|e| format!("读取文件失败: {}", e))?;

    // 探测编码
    let (content, encoding) = decode_bytes(&bytes);

    // 探测行尾符
    let eol = detect_eol(&content);

    Ok(FileReadResult {
        content,
        encoding,
        eol,
        size,
        mtime,
        readonly,
    })
}

/// 解码字节数组：自动探测 UTF-8 BOM / UTF-8 / GBK
pub fn decode_bytes(bytes: &[u8]) -> (String, Encoding) {
    // 检查 BOM
    if bytes.len() >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF {
        // UTF-8 BOM
        let content = String::from_utf8_lossy(&bytes[3..]).to_string();
        return (content, Encoding::Utf8Bom);
    }

    // 尝试 UTF-8
    if let Ok(s) = std::str::from_utf8(bytes) {
        return (s.to_string(), Encoding::Utf8);
    }

    // 尝试 GBK（用 chardetng 探测）
    let mut detector = chardetng::EncodingDetector::new();
    detector.feed(bytes, true);
    let enc = detector.guess(None, true);

    // 如果探测到是 GBK 或类似中文编码
    if enc == encoding_rs::GBK || enc == encoding_rs::GB18030 {
        let (cow, _, _) = encoding_rs::GBK.decode(bytes);
        return (cow.to_string(), Encoding::Gbk);
    }

    // 兜底：用 chardetng 探测的编码
    let (cow, _, _) = enc.decode(bytes);
    (cow.to_string(), Encoding::Utf8)
}

/// 探测行尾符
fn detect_eol(content: &str) -> Eol {
    let has_crlf = content.contains("\r\n");
    let has_lf = content.contains('\n') && !has_crlf;
    let lf_count = content.matches('\n').count();
    let crlf_count = content.matches("\r\n").count();

    if crlf_count > 0 && crlf_count >= lf_count - crlf_count {
        Eol::Crlf
    } else if has_lf {
        Eol::Lf
    } else if has_crlf {
        Eol::Crlf
    } else {
        // 新建文件默认 CRLF（FR-211）
        Eol::Crlf
    }
}

/// 检查文件是否是文本（非二进制）
pub fn is_text_file(path: &Path) -> Result<bool, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("无法打开文件: {}", e))?;
    let mut buf = [0u8; 8192];
    let n = file.read(&mut buf).map_err(|e| format!("读取文件失败: {}", e))?;

    if n == 0 {
        return Ok(true); // 空文件视为文本
    }

    // 检查是否含 NUL 字节
    Ok(!buf[..n].contains(&0x00))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decode_utf8_bom() {
        let bytes = [0xEF, 0xBB, 0xBF, b'h', b'i'];
        let (s, enc) = decode_bytes(&bytes);
        assert_eq!(s, "hi");
        assert_eq!(enc, Encoding::Utf8Bom);
    }

    #[test]
    fn test_decode_utf8() {
        let bytes = b"hello world";
        let (s, enc) = decode_bytes(bytes);
        assert_eq!(s, "hello world");
        assert_eq!(enc, Encoding::Utf8);
    }

    #[test]
    fn test_detect_eol_crlf() {
        assert_eq!(detect_eol("line1\r\nline2\r\n"), Eol::Crlf);
    }

    #[test]
    fn test_detect_eol_lf() {
        assert_eq!(detect_eol("line1\nline2\n"), Eol::Lf);
    }
}
