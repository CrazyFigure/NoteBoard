// 本地文件搜索：文件表
//
// 整盘索引可能有上百万条目，因此每个条目只记录父目录编号与名字在名字池中的位置，
// 完整路径按父链临时拼接；每条 24 字节，加上名字本身。
// 子目录列表只为目录建立，用于增量更新时按名字定位。

use super::content::{ContentIndex, NONE};
use rustc_hash::FxHashMap;
use std::path::{Component, Path, MAIN_SEPARATOR};

/// 条目标记
pub const DIR: u8 = 1;
pub const DEAD: u8 = 2;
/// 可建立内容索引的文本或 Office 文件
pub const TEXT: u8 = 4;
pub const ROOT: u8 = 8;
pub const HIDDEN: u8 = 16;
/// 不再深入的目录（缓存目录、软件包等）
pub const NO_DESCEND: u8 = 32;
/// 符号链接或目录联接（不跟随）
pub const LINK: u8 = 64;
/// 目录内（含子孙）不建立内容索引：软件安装目录等，只收录文件名
pub const NO_CONTENT: u8 = 128;

/// 内容已尝试但无可索引文字（二进制、过大、读取失败）
pub const DOC_SKIP: u32 = u32::MAX - 1;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Entry {
    pub parent: u32,
    pub name_off: u32,
    pub mtime: u32,
    /// 内容文档编号：NONE 未索引，DOC_SKIP 无可索引文字
    pub doc: u32,
    pub size_lo: u32,
    pub name_len: u16,
    pub flags: u8,
    pub size_hi: u8,
}

impl Entry {
    #[inline]
    pub fn size(&self) -> u64 {
        (self.size_lo as u64) | ((self.size_hi as u64) << 32)
    }

    #[inline]
    pub fn set_size(&mut self, size: u64) {
        let size = size.min((1u64 << 40) - 1);
        self.size_lo = size as u32;
        self.size_hi = (size >> 32) as u8;
    }

    #[inline]
    pub fn is(&self, flag: u8) -> bool {
        self.flags & flag != 0
    }

    #[inline]
    pub fn alive(&self) -> bool {
        self.flags & DEAD == 0
    }

    /// 是否已有有效的内容文档
    #[inline]
    pub fn has_doc(&self) -> bool {
        self.doc != NONE && self.doc != DOC_SKIP
    }
}

#[derive(Debug, Default)]
pub struct FileTable {
    pub entries: Vec<Entry>,
    pub names: Vec<u8>,
    pub children: FxHashMap<u32, Vec<u32>>,
    /// 索引根目录条目（条目名字为根目录完整路径）
    pub roots: Vec<u32>,
    pub dead: usize,
}

/// 平台路径比较：Windows 与 macOS 默认不区分大小写
#[inline]
pub fn same_name(a: &str, b: &str) -> bool {
    if cfg!(any(windows, target_os = "macos")) {
        a == b || a.to_lowercase() == b.to_lowercase()
    } else {
        a == b
    }
}

impl FileTable {
    #[inline]
    pub fn name(&self, id: u32) -> &str {
        let e = &self.entries[id as usize];
        let s = e.name_off as usize;
        // 名字写入时均为合法 UTF-8
        std::str::from_utf8(&self.names[s..s + e.name_len as usize]).unwrap_or("")
    }

    pub fn live_count(&self) -> usize {
        self.entries.len() - self.dead
    }

    fn push_name(&mut self, name: &str) -> (u32, u16) {
        let off = self.names.len() as u32;
        let bytes = &name.as_bytes()[..name.len().min(u16::MAX as usize)];
        self.names.extend_from_slice(bytes);
        (off, bytes.len() as u16)
    }

    /// 新增根目录条目
    pub fn add_root(&mut self, path: &str) -> u32 {
        let (name_off, name_len) = self.push_name(path);
        let id = self.entries.len() as u32;
        self.entries.push(Entry { parent: NONE, name_off, name_len, flags: DIR | ROOT, doc: NONE, ..Default::default() });
        self.roots.push(id);
        id
    }

    /// 在目录下新增条目
    pub fn add(&mut self, parent: u32, name: &str, flags: u8, size: u64, mtime: u32) -> u32 {
        let (name_off, name_len) = self.push_name(name);
        let id = self.entries.len() as u32;
        let mut entry = Entry { parent, name_off, name_len, flags, mtime, doc: NONE, ..Default::default() };
        entry.set_size(size);
        self.entries.push(entry);
        self.children.entry(parent).or_default().push(id);
        id
    }

    /// 按名字查找子条目（先精确匹配，再按平台规则忽略大小写）
    pub fn child_by_name(&self, dir: u32, name: &str) -> Option<u32> {
        let list = self.children.get(&dir)?;
        list.iter().copied().find(|&c| self.name(c) == name)
            .or_else(|| list.iter().copied().find(|&c| same_name(self.name(c), name)))
    }

    /// 根目录条目编号与路径
    pub fn root_paths(&self) -> Vec<(u32, String)> {
        self.roots.iter().map(|&r| (r, self.name(r).to_string())).collect()
    }

    /// 拼接完整路径
    pub fn path(&self, id: u32) -> String {
        let mut chain: Vec<u32> = Vec::with_capacity(16);
        let mut cur = id;
        while cur != NONE {
            chain.push(cur);
            cur = self.entries[cur as usize].parent;
        }
        let mut out = String::with_capacity(chain.len() * 16);
        for &part in chain.iter().rev() {
            let name = self.name(part);
            if !out.is_empty() && !out.ends_with(['\\', '/']) {
                out.push(MAIN_SEPARATOR);
            }
            out.push_str(name);
        }
        out
    }

    /// 条目所在目录的完整路径
    pub fn parent_path(&self, id: u32) -> String {
        let parent = self.entries[id as usize].parent;
        if parent == NONE { String::new() } else { self.path(parent) }
    }

    /// 目录深度（根为 0）
    pub fn depth(&self, id: u32) -> u32 {
        let mut d = 0;
        let mut cur = self.entries[id as usize].parent;
        while cur != NONE {
            d += 1;
            cur = self.entries[cur as usize].parent;
        }
        d
    }

    /// 找到包含该路径的根目录：返回根条目编号与根目录之下的各级名字
    pub fn locate_root<'p>(&self, path: &'p Path) -> Option<(u32, Vec<&'p str>)> {
        let mut best: Option<(u32, usize, Vec<&'p str>)> = None;
        for &root in &self.roots {
            let root_path = Path::new(self.name(root));
            if let Some(rest) = strip_prefix_ci(path, root_path) {
                let depth = root_path.components().count();
                if best.as_ref().is_none_or(|b| depth > b.1) {
                    best = Some((root, depth, rest));
                }
            }
        }
        best.map(|(r, _, rest)| (r, rest))
    }

    /// 按完整路径查找条目
    pub fn find_path(&self, path: &Path) -> Option<u32> {
        let (mut cur, rest) = self.locate_root(path)?;
        for name in rest {
            cur = self.child_by_name(cur, name)?;
        }
        Some(cur)
    }

    /// 删除条目及其全部子孙，同时让对应内容文档失效
    pub fn remove_subtree(&mut self, id: u32, content: &mut ContentIndex) {
        let entry = self.entries[id as usize];
        if !entry.alive() {
            return;
        }
        if entry.parent != NONE {
            if let Some(list) = self.children.get_mut(&entry.parent) {
                list.retain(|&c| c != id);
            }
        }
        let mut stack = vec![id];
        while let Some(cur) = stack.pop() {
            let e = &mut self.entries[cur as usize];
            if !e.alive() {
                continue;
            }
            e.flags |= DEAD;
            if e.has_doc() {
                content.remove(e.doc);
            }
            e.doc = NONE;
            self.dead += 1;
            if let Some(kids) = self.children.remove(&cur) {
                stack.extend(kids);
            }
        }
        if entry.flags & ROOT != 0 {
            self.roots.retain(|&r| r != id);
        }
    }

    /// 清空目录下的全部子条目（目录本身保留）
    pub fn clear_children(&mut self, dir: u32, content: &mut ContentIndex) {
        let kids = self.children.get(&dir).cloned().unwrap_or_default();
        for kid in kids {
            self.remove_subtree(kid, content);
        }
    }

    /// 压缩：去除已删除条目并重新编号（父目录编号总小于子条目，按序映射即可）
    pub fn compact(&self, content: &mut ContentIndex) -> FileTable {
        let mut map = vec![NONE; self.entries.len()];
        let mut out = FileTable::default();
        out.entries.reserve(self.live_count());
        for (old, e) in self.entries.iter().enumerate() {
            if !e.alive() {
                continue;
            }
            let parent = if e.parent == NONE { NONE } else { map[e.parent as usize] };
            // 父目录已删除的孤立条目直接丢弃
            if e.parent != NONE && parent == NONE {
                if e.has_doc() {
                    content.remove(e.doc);
                }
                continue;
            }
            let name = self.name(old as u32).to_string();
            let (name_off, name_len) = out.push_name(&name);
            let id = out.entries.len() as u32;
            out.entries.push(Entry { parent, name_off, name_len, ..*e });
            map[old] = id;
            if parent != NONE {
                out.children.entry(parent).or_default().push(id);
            }
            if e.has_doc() {
                content.docs[e.doc as usize] = id;
            }
        }
        out.roots = self.roots.iter().filter_map(|&r| (map[r as usize] != NONE).then_some(map[r as usize])).collect();
        out
    }

    /// 由条目重建子目录列表（读取快照后调用）
    pub fn rebuild_children(&mut self) {
        self.children.clear();
        self.roots.clear();
        self.dead = 0;
        for (id, e) in self.entries.iter().enumerate() {
            if !e.alive() {
                self.dead += 1;
                continue;
            }
            if e.parent == NONE {
                if e.flags & ROOT != 0 {
                    self.roots.push(id as u32);
                }
            } else {
                self.children.entry(e.parent).or_default().push(id as u32);
            }
        }
    }
}

/// 按路径分段去除前缀（Windows / macOS 忽略大小写），返回剩余各级名字
fn strip_prefix_ci<'p>(path: &'p Path, prefix: &Path) -> Option<Vec<&'p str>> {
    let mut it = path.components();
    for want in prefix.components() {
        let got = it.next()?;
        let equal = match (got, want) {
            (Component::Normal(a), Component::Normal(b)) => same_name(&a.to_string_lossy(), &b.to_string_lossy()),
            (Component::Prefix(a), Component::Prefix(b)) => same_name(&a.as_os_str().to_string_lossy(), &b.as_os_str().to_string_lossy()),
            (a, b) => a == b,
        };
        if !equal {
            return None;
        }
    }
    let mut rest = Vec::new();
    for c in it {
        match c {
            Component::Normal(n) => rest.push(n.to_str()?),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(rest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> (FileTable, u32, u32, u32) {
        let mut t = FileTable::default();
        let root_path = std::env::temp_dir().join("nb-root");
        let root = t.add_root(&root_path.to_string_lossy());
        let dir = t.add(root, "笔记", DIR, 0, 1);
        let file = t.add(dir, "Readme.md", TEXT, 2048, 2);
        (t, root, dir, file)
    }

    #[test]
    fn path_and_lookup_round_trip() {
        let (t, _, dir, file) = sample();
        let path = t.path(file);
        assert!(path.ends_with(&format!("笔记{}Readme.md", MAIN_SEPARATOR)));
        assert_eq!(t.find_path(Path::new(&path)), Some(file));
        assert_eq!(t.parent_path(file), t.path(dir));
        assert_eq!(t.depth(file), 2);
        assert_eq!(t.entries[file as usize].size(), 2048);
    }

    #[test]
    fn remove_and_compact_keep_tree_consistent() {
        let (mut t, root, dir, file) = sample();
        let mut content = ContentIndex::default();
        let other = t.add(root, "other.txt", TEXT, 1, 1);
        let doc = content.add(other, &[1, 2, 3]);
        t.entries[other as usize].doc = doc;
        t.remove_subtree(dir, &mut content);
        assert!(!t.entries[file as usize].alive());
        assert_eq!(t.dead, 2);
        let compacted = t.compact(&mut content);
        assert_eq!(compacted.live_count(), 2);
        let new_other = compacted.find_path(Path::new(&t.path(other))).unwrap();
        assert_eq!(content.entry_of(doc), new_other);
    }

    #[test]
    fn size_supports_large_files() {
        let mut e = Entry::default();
        e.set_size(5 * 1024 * 1024 * 1024);
        assert_eq!(e.size(), 5 * 1024 * 1024 * 1024);
    }
}
