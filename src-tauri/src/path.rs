// NoteBoard 路径工具
// 规范化规则见 docs/03-领域模型.md §2.1
// 1. 转为绝对路径
// 2. 分隔符统一为 \
// 3. 解析 . 与 ..
// 4. 盘符大写（c:\ → C:\）
// 5. 其余部分保留原始大小写（用于显示），但比较时不区分大小写

use dunce::canonicalize as canonicalized;
use std::path::Path;

/// 规范化路径
pub fn normalize_key(p: &str) -> String {
    let path = Path::new(p);

    // 尝试 canonicalize，失败时手动处理
    let canonical = canonicalized(path).unwrap_or_else(|_| {
        // 无法 canonicalize（文件不存在等），手动绝对化
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .unwrap_or_default()
                .join(path)
        }
    });

    let mut result = canonical.to_string_lossy().to_string();

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

/// 解析 . 与 .. 段
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

/// 大小写不敏感比较（Windows 语义）
pub fn same_key(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// 获取小写键（用于 Map 索引）
pub fn lower_key(key: &str) -> String {
    key.to_lowercase()
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

    #[test]
    fn test_same_key_case_insensitive() {
        assert!(same_key("C:\\Notes\\A.md", "c:\\notes\\a.md"));
        assert!(same_key("D:\\Test.TXT", "d:\\test.txt"));
    }

    #[test]
    fn test_normalize_drive_uppercase() {
        let n = normalize_key("c:\\users\\test");
        assert!(n.starts_with("C:\\"));
    }

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

    #[test]
    fn test_parent_dir() {
        assert_eq!(parent_dir("D:\\notes\\a.md"), Some("D:\\notes".to_string()));
    }
}
