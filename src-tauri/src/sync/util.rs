// NoteBoard 同步通用工具：时间、哈希、相对路径换算与忽略规则
//
// 同步内部统一使用以 `/` 分隔的相对路径（与远端存储一致），只在落盘时换算成本地绝对路径。

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// 同步区域内的回收站目录名（隐藏目录，文件树中以特殊节点「回收站」呈现）
pub const TRASH_DIR: &str = ".nb-trash";
/// 远端元数据目录（清单 manifest、锁文件）
pub const META_DIR: &str = ".noteboard-sync";
/// 本地应用远端变更时使用的同盘临时目录（保证 rename 原子且不跨卷）
pub const TMP_DIR: &str = ".nb-sync-tmp";

/// 当前 Unix 毫秒时间戳
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 计算内容 SHA-256（十六进制小写）
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// 读取文件元数据中的修改时间（毫秒）
pub fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 路径比较键：Windows 文件系统大小写不敏感，Android 等平台大小写敏感
pub fn pkey(rel: &str) -> String {
    if cfg!(windows) {
        rel.to_lowercase()
    } else {
        rel.to_string()
    }
}

/// 相对路径（`/` 分隔）→ 本地绝对路径
pub fn rel_to_abs(root: &Path, rel: &str) -> PathBuf {
    let mut p = root.to_path_buf();
    for seg in rel.split('/') {
        if !seg.is_empty() {
            p.push(seg);
        }
    }
    p
}

/// 单个路径分段的比较键（Windows 大小写不敏感）
fn component_key(c: std::path::Component<'_>) -> String {
    let s = c.as_os_str().to_string_lossy().to_string();
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

/// 本地绝对路径 → 同步根目录下的相对路径；不在根目录内返回 None，根目录自身返回 Some("")
/// 按路径分段逐段比较（不做字符串前缀截取，避免大小写折叠改变字符长度导致错位）
pub fn abs_to_rel(root: &Path, abs: &Path) -> Option<String> {
    let root_parts: Vec<_> = root
        .components()
        .filter(|c| !matches!(c, std::path::Component::CurDir))
        .collect();
    if root_parts.is_empty() {
        return None;
    }
    let abs_parts: Vec<_> = abs
        .components()
        .filter(|c| !matches!(c, std::path::Component::CurDir))
        .collect();
    if abs_parts.len() < root_parts.len() {
        return None;
    }
    for (a, b) in root_parts.iter().zip(abs_parts.iter()) {
        if component_key(*a) != component_key(*b) {
            return None;
        }
    }
    let rest: Vec<String> = abs_parts[root_parts.len()..]
        .iter()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect();
    Some(rest.join("/"))
}

/// 是否属于同步忽略的文件/目录名（系统垃圾文件、临时文件、版本库目录）
pub fn is_ignored_name(name: &str, is_dir: bool) -> bool {
    let lower = name.to_lowercase();
    if is_dir {
        return matches!(lower.as_str(), ".git" | ".svn" | ".hg" | TMP_DIR | META_DIR);
    }
    matches!(lower.as_str(), ".ds_store" | "thumbs.db" | "desktop.ini")
        || lower.starts_with("~$")
        || lower.starts_with(".~lock.")
        // fsio::write::atomic_write 的同目录临时文件
        || lower.starts_with(".nb-tmp-")
        || lower.ends_with(".tmp")
        || lower.ends_with(".swp")
        || lower.ends_with(".crdownload")
        || lower.ends_with(".part")
}

/// 相对路径是否位于回收站内
pub fn is_in_trash(rel: &str) -> bool {
    rel == TRASH_DIR || rel.starts_with(&format!("{}/", TRASH_DIR))
}

/// 回收站内文件的顶层条目路径（`.nb-trash/<条目名>`）与条目内剩余路径
pub fn trash_top(rel: &str) -> Option<(String, String)> {
    let rest = rel.strip_prefix(&format!("{}/", TRASH_DIR))?;
    let mut parts = rest.splitn(2, '/');
    let top = parts.next()?.to_string();
    if top.is_empty() {
        return None;
    }
    let inner = parts.next().unwrap_or("").to_string();
    Some((format!("{}/{}", TRASH_DIR, top), inner))
}

/// 拆分文件名为（主名, 扩展名含点）；目录或无扩展名时扩展名为空
pub fn split_name(name: &str) -> (String, String) {
    match name.rfind('.') {
        Some(i) if i > 0 => (name[..i].to_string(), name[i..].to_string()),
        _ => (name.to_string(), String::new()),
    }
}

/// 父目录相对路径（根目录下为空串）
pub fn parent_rel(rel: &str) -> String {
    match rel.rfind('/') {
        Some(i) => rel[..i].to_string(),
        None => String::new(),
    }
}

/// 文件名部分
pub fn base_name(rel: &str) -> String {
    match rel.rfind('/') {
        Some(i) => rel[i + 1..].to_string(),
        None => rel.to_string(),
    }
}

/// 拼接相对路径
pub fn join_rel(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", dir, name)
    }
}

/// 生成不重名的相对路径：`笔记.md` → `笔记 (1).md` → `笔记 (2).md`
pub fn unique_rel_path(rel: &str, taken: impl Fn(&str) -> bool) -> String {
    if !taken(rel) {
        return rel.to_string();
    }
    let dir = parent_rel(rel);
    let (stem, ext) = split_name(&base_name(rel));
    for n in 1..10_000 {
        let candidate = join_rel(&dir, &format!("{} ({}){}", stem, n, ext));
        if !taken(&candidate) {
            return candidate;
        }
    }
    join_rel(&dir, &format!("{} ({}){}", stem, uuid::Uuid::new_v4().simple(), ext))
}

/// 可做行级三方合并的纯文本扩展名（结构化 JSON/XML 文档逐行合并可能破坏语法，只做文档级覆盖）
pub fn is_line_mergeable(rel: &str) -> bool {
    let ext = split_name(&base_name(rel)).1.trim_start_matches('.').to_lowercase();
    matches!(
        ext.as_str(),
        "md" | "markdown" | "mdx" | "txt" | "text" | "log" | "csv" | "tsv" | "ini" | "conf" | "cfg"
            | "properties" | "toml" | "yaml" | "yml" | "sql" | "mmd" | "mermaid" | "puml"
            | "plantuml" | "pu" | "iuml" | "env" | "rst" | "adoc" | "org" | "tex"
    )
}

/// 将字节数格式化为易读文本
pub fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut v = bytes as f64;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{} {}", bytes, UNITS[0])
    } else {
        format!("{:.1} {}", v, UNITS[i])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unique_path_appends_counter_before_extension() {
        let taken = ["a/笔记.md", "a/笔记 (1).md"];
        let got = unique_rel_path("a/笔记.md", |p| taken.contains(&p));
        assert_eq!(got, "a/笔记 (2).md");
        assert_eq!(unique_rel_path("x", |_| false), "x");
    }

    #[test]
    fn trash_top_splits_item_and_inner_path() {
        assert_eq!(
            trash_top(".nb-trash/项目/a/b.md"),
            Some((".nb-trash/项目".to_string(), "a/b.md".to_string()))
        );
        assert_eq!(trash_top(".nb-trash/x.md"), Some((".nb-trash/x.md".to_string(), String::new())));
        assert_eq!(trash_top("docs/x.md"), None);
    }

    #[test]
    fn abs_to_rel_handles_root_and_children() {
        let root = if cfg!(windows) { Path::new("C:\\Notes") } else { Path::new("/notes") };
        let child = if cfg!(windows) { Path::new("c:\\notes\\子目录\\A.md") } else { Path::new("/notes/子目录/A.md") };
        assert_eq!(abs_to_rel(root, root), Some(String::new()));
        assert_eq!(abs_to_rel(root, child), Some("子目录/A.md".to_string()));
        let other = if cfg!(windows) { Path::new("C:\\NotesX\\a.md") } else { Path::new("/notesx/a.md") };
        assert_eq!(abs_to_rel(root, other), None);
    }
}
