// NoteBoard 目录读取 — 自然排序
// FR-704: 目录在前、文件在后，各自按名称自然排序（数字按数值比较）

use crate::dto::{FileTreeNode, LanguageId};
use crate::dto::{ext_from_path, kind_by_ext};
use std::fs;
use std::path::Path;

/// 读取目录
pub fn read_directory(path: &Path, show_hidden: bool) -> Result<Vec<FileTreeNode>, String> {
    let entries = fs::read_dir(path).map_err(|e| format!("无法读取目录: {}", e))?;

    let mut nodes: Vec<FileTreeNode> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();

            // 隐藏文件过滤
            let is_hidden = name.starts_with('.') || is_hidden_attr(&e);
            if is_hidden && !show_hidden {
                return None;
            }

            let file_path = e.path();
            let path_str = file_path.to_string_lossy().to_string();

            // .git 目录过滤
            if name == ".git" && !show_hidden {
                return None;
            }

            let metadata = e.metadata().ok()?;
            let is_dir = metadata.is_dir();
            let is_symlink = metadata.file_type().is_symlink();

            let (kind, _lang) = if is_dir {
                (None, LanguageId::Plaintext)
            } else {
                let ext = ext_from_path(&path_str);
                let (k, l) = kind_by_ext(&ext);
                (Some(k), l)
            };

            Some(FileTreeNode {
                path: path_str,
                name,
                is_dir,
                kind,
                size: if is_dir { None } else { Some(metadata.len()) },
                mtime: metadata
                    .modified()
                    .ok()
                    .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64),
                is_hidden,
                is_symlink,
            })
        })
        .collect();

    // 自然排序：目录在前，文件在后
    nodes.sort_by(|a, b| {
        // 目录优先
        match (a.is_dir, b.is_dir) {
            (true, false) => return std::cmp::Ordering::Less,
            (false, true) => return std::cmp::Ordering::Greater,
            _ => {}
        }
        // 各自自然排序
        natural_compare(&a.name, &b.name)
    });

    Ok(nodes)
}

/// 自然排序比较：数字按数值比较
/// file2.md < file10.md
fn natural_compare(a: &str, b: &str) -> std::cmp::Ordering {
    let a_bytes = a.as_bytes();
    let b_bytes = b.as_bytes();
    let mut i = 0;
    let mut j = 0;

    while i < a_bytes.len() && j < b_bytes.len() {
        let ac = a_bytes[i] as char;
        let bc = b_bytes[j] as char;

        // 如果两边都是数字，提取数字段比较
        if ac.is_ascii_digit() && bc.is_ascii_digit() {
            let (a_num, a_end) = extract_number(a_bytes, i);
            let (b_num, b_end) = extract_number(b_bytes, j);

            match a_num.cmp(&b_num) {
                std::cmp::Ordering::Equal => {
                    i = a_end;
                    j = b_end;
                }
                ord => return ord,
            }
        } else {
            // 大小写不敏感比较
            match ac.to_ascii_lowercase().cmp(&bc.to_ascii_lowercase()) {
                std::cmp::Ordering::Equal => {
                    i += 1;
                    j += 1;
                }
                ord => return ord,
            }
        }
    }

    // 短的在前
    (a_bytes.len() - i).cmp(&(b_bytes.len() - j))
}

/// 从字节数组的指定位置提取数字
fn extract_number(bytes: &[u8], start: usize) -> (u64, usize) {
    let mut num: u64 = 0;
    let mut i = start;
    while i < bytes.len() && (bytes[i] as char).is_ascii_digit() {
        num = num * 10 + (bytes[i] - b'0') as u64;
        i += 1;
    }
    (num, i)
}

/// Windows 隐藏属性检测
#[cfg(windows)]
fn is_hidden_attr(entry: &fs::DirEntry) -> bool {
    use std::os::windows::fs::MetadataExt;
    entry
        .metadata()
        .ok()
        .map(|m| m.file_attributes() & 0x2 != 0) // FILE_ATTRIBUTE_HIDDEN
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn is_hidden_attr(_entry: &fs::DirEntry) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_natural_compare() {
        assert_eq!(natural_compare("file2.md", "file10.md"), std::cmp::Ordering::Less);
        assert_eq!(natural_compare("file10.md", "file2.md"), std::cmp::Ordering::Greater);
        assert_eq!(natural_compare("a.md", "b.md"), std::cmp::Ordering::Less);
        assert_eq!(natural_compare("A.md", "a.md"), std::cmp::Ordering::Equal);
    }
}
