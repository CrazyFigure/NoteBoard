// NoteBoard 路径工具
// 规范化规则见 docs/03-领域模型.md §2.1
// Windows：
// 1. 转为绝对路径
// 2. 分隔符统一为 \
// 3. 解析 . 与 ..
// 4. 盘符大写（c:\ → C:\）
// 5. 其余部分保留原始大小写（用于显示），但比较时不区分大小写
// 其它平台（Android / Linux / macOS）：
// 1. 转为绝对路径，分隔符保持 /
// 2. 解析 . 与 ..
// 3. 文件系统大小写敏感，比较时严格相等（不能转小写，否则 /storage/emulated/0/A.md 与 a.md 会被视为同一文档）

use dunce::canonicalize as canonicalized;
use std::path::Path;

/// 绝对化路径：优先 canonicalize（解析符号链接），失败（文件不存在等）时手动拼接当前目录
fn absolutize(p: &str) -> String {
    let path = Path::new(p);
    let canonical = canonicalized(path).unwrap_or_else(|_| {
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .unwrap_or_default()
                .join(path)
        }
    });
    canonical.to_string_lossy().to_string()
}

/// 规范化路径
#[cfg(windows)]
pub fn normalize_key(p: &str) -> String {
    let mut result = absolutize(p);

    // 统一分隔符为 \
    result = result.replace('/', "\\");

    // 盘符大写
    if result.len() >= 2 && result.as_bytes()[1] == b':' {
        // 盘符小写转大写
        let mut bytes = result.into_bytes();
        let c = bytes[0];
        if c.is_ascii_lowercase() {
            bytes[0] = c.to_ascii_uppercase();
        }
        result = String::from_utf8(bytes).unwrap_or_default();
    }

    // 解析 . 与 ..
    result = resolve_dot_segments(&result);

    result
}

/// 规范化路径（POSIX 语义：保持 / 分隔符与原始大小写）
#[cfg(not(windows))]
pub fn normalize_key(p: &str) -> String {
    resolve_posix_dot_segments(&absolutize(p))
}

/// 解析 . 与 .. 段
#[cfg(windows)]
fn resolve_dot_segments(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    let prefix = if path.starts_with("\\\\") {
        "\\\\"
    } else if path.len() >= 2 && path.as_bytes()[1] == b':' {
        &path[..2]
    } else {
        ""
    };

    let rest = &path[prefix.len()..];
    for segment in rest.split('\\') {
        if segment.is_empty() || segment == "." {
            continue;
        } else if segment == ".." {
            if !parts.is_empty() && parts.last() != Some(&"..") {
                parts.pop();
            }
        } else {
            parts.push(segment);
        }
    }

    let mut result = String::with_capacity(path.len() + 2);
    result.push_str(prefix);
    if prefix.len() == 2 && prefix.ends_with(':') {
        result.push('\\');
    }
    if prefix == "\\\\" {
        // UNC: 第一个段是 server
        result.push_str(parts.first().unwrap_or(&""));
        for p in parts.iter().skip(1) {
            result.push('\\');
            result.push_str(p);
        }
    } else {
        result.push_str(&parts.join("\\"));
    }

    result
}

/// 解析 POSIX 路径中的 . 与 .. 段（绝对路径以 / 开头，根目录的 .. 保持在根）
#[cfg_attr(windows, allow(dead_code))]
fn resolve_posix_dot_segments(path: &str) -> String {
    let is_absolute = path.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        } else if segment == ".." {
            if !parts.is_empty() && parts.last() != Some(&"..") {
                parts.pop();
            } else if !is_absolute {
                parts.push(segment);
            }
        } else {
            parts.push(segment);
        }
    }
    let joined = parts.join("/");
    if is_absolute {
        format!("/{}", joined)
    } else {
        joined
    }
}

/// 路径键比较：Windows 大小写不敏感，其它平台严格相等
pub fn same_key(a: &str, b: &str) -> bool {
    lower_key(a) == lower_key(b)
}

/// 获取用于 Map 索引的比较键：Windows 转小写，其它平台保持原样
#[cfg(windows)]
pub fn lower_key(key: &str) -> String {
    key.to_lowercase()
}

/// 获取用于 Map 索引的比较键：大小写敏感文件系统保持原样
#[cfg(not(windows))]
pub fn lower_key(key: &str) -> String {
    key.to_string()
}

/// 获取父目录
pub fn parent_dir(path: &str) -> Option<String> {
    let p = Path::new(path);
    p.parent().map(|p| p.to_string_lossy().to_string())
}

/// 获取文件名
pub fn basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path)
        .to_string()
}

/// 获取扩展名
pub fn extension(path: &str) -> String {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn test_same_key_case_insensitive() {
        assert!(same_key("C:\\Notes\\A.md", "c:\\notes\\a.md"));
        assert!(same_key("D:\\Test.TXT", "d:\\test.txt"));
    }

    #[cfg(windows)]
    #[test]
    fn test_normalize_drive_uppercase() {
        let n = normalize_key("c:\\users\\test");
        assert!(n.starts_with("C:\\"));
    }

    #[cfg(windows)]
    #[test]
    fn test_basename() {
        assert_eq!(basename("D:\\notes\\a.md"), "a.md");
        assert_eq!(basename("C:\\test.txt"), "test.txt");
    }

    #[test]
    fn test_extension() {
        assert_eq!(extension("a.md"), "md");
        assert_eq!(extension("test.JSON"), "json");
        assert_eq!(extension("noext"), "");
    }

    #[cfg(windows)]
    #[test]
    fn test_parent_dir() {
        assert_eq!(parent_dir("D:\\notes\\a.md"), Some("D:\\notes".to_string()));
    }

    #[test]
    fn test_posix_dot_segments() {
        assert_eq!(
            resolve_posix_dot_segments("/storage/emulated/0/./notes/../Docs/a.md"),
            "/storage/emulated/0/Docs/a.md"
        );
        assert_eq!(resolve_posix_dot_segments("/../a"), "/a");
        assert_eq!(resolve_posix_dot_segments("/data/user//0/"), "/data/user/0");
    }

    #[cfg(not(windows))]
    #[test]
    fn test_posix_case_sensitive_keys() {
        assert!(!same_key("/storage/emulated/0/A.md", "/storage/emulated/0/a.md"));
        assert_eq!(lower_key("/data/Notes/A.md"), "/data/Notes/A.md");
        assert_eq!(basename("/data/notes/a.md"), "a.md");
        assert_eq!(parent_dir("/data/notes/a.md"), Some("/data/notes".to_string()));
    }
}
