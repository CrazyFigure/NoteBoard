// NoteBoard 文档历史记录：存储命名空间
//
// 一个命名空间目录的布局（本机模式为 <应用数据目录>/history/local）：
//   docs/<docId>.json        —— 文档索引
//   blobs/<aa>/<sha>.gz      —— 已封口版本的正文（原始字节 gzip，内容寻址、不可变、可跨文档去重）
//   pending/<docId>.gz       —— 合并窗口中最新一次保存的正文（每文档一份，反复覆盖，不产生垃圾 blob）
// 所有写入先写同目录临时文件再改名，进程中断不会留下半个文件。

use super::model::{DocIndex, Entry};
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct Store {
    pub dir: PathBuf,
}

/// 原子写入：同目录临时文件 + 改名
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().ok_or_else(|| std::io::Error::other("路径缺少父目录"))?;
    std::fs::create_dir_all(dir)?;
    let mut tmp = tempfile::Builder::new().prefix(".nb-hist-").tempfile_in(dir)?;
    tmp.write_all(bytes)?;
    tmp.as_file().sync_all()?;
    tmp.persist(path).map_err(|e| e.error)?;
    Ok(())
}

fn gzip(bytes: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut enc = GzEncoder::new(Vec::with_capacity(bytes.len() / 3 + 64), Compression::new(5));
    enc.write_all(bytes)?;
    enc.finish()
}

fn gunzip(bytes: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut out = Vec::with_capacity(bytes.len() * 3);
    GzDecoder::new(bytes).read_to_end(&mut out)?;
    Ok(out)
}

/// 文档标识只允许安全字符，防止索引文件名被构造成路径穿越
pub fn valid_doc_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn valid_sha(sha: &str) -> bool {
    sha.len() == 64 && sha.chars().all(|c| c.is_ascii_hexdigit())
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn index_path(&self, doc_id: &str) -> PathBuf {
        self.dir.join("docs").join(format!("{}.json", doc_id))
    }

    pub fn blob_path(&self, sha: &str) -> PathBuf {
        self.dir.join("blobs").join(&sha[..2]).join(format!("{}.gz", sha))
    }

    pub fn pending_path(&self, doc_id: &str) -> PathBuf {
        self.dir.join("pending").join(format!("{}.gz", doc_id))
    }

    pub fn has_blob(&self, sha: &str) -> bool {
        valid_sha(sha) && self.blob_path(sha).is_file()
    }

    /// 写入已封口正文（已存在则跳过）
    pub fn put_blob(&self, sha: &str, bytes: &[u8]) -> std::io::Result<()> {
        if !valid_sha(sha) {
            return Err(std::io::Error::other("无效的内容哈希"));
        }
        let path = self.blob_path(sha);
        if path.is_file() {
            return Ok(());
        }
        write_atomic(&path, &gzip(bytes)?)
    }

    /// 写入合并窗口中的正文（覆盖上一次）
    pub fn put_pending(&self, doc_id: &str, bytes: &[u8]) -> std::io::Result<()> {
        write_atomic(&self.pending_path(doc_id), &gzip(bytes)?)
    }

    /// 封口：把合并窗口正文转为内容寻址 blob
    pub fn seal_pending(&self, doc_id: &str, sha: &str) -> std::io::Result<()> {
        let pending = self.pending_path(doc_id);
        if !pending.is_file() {
            return Ok(());
        }
        let target = self.blob_path(sha);
        if target.is_file() {
            let _ = std::fs::remove_file(&pending);
            return Ok(());
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::rename(&pending, &target)
    }

    /// 已封口正文的压缩字节（上传远端用，原样传输）
    pub fn read_blob_gz(&self, sha: &str) -> std::io::Result<Vec<u8>> {
        if !valid_sha(sha) {
            return Err(std::io::Error::other("无效的内容哈希"));
        }
        std::fs::read(self.blob_path(sha))
    }

    /// 写入下载的压缩正文：解压校验哈希一致后才落盘，拒绝损坏或被篡改的内容
    pub fn write_blob_gz(&self, sha: &str, gz: &[u8]) -> std::io::Result<()> {
        if !valid_sha(sha) {
            return Err(std::io::Error::other("无效的内容哈希"));
        }
        let raw = gunzip(gz)?;
        if crate::sync::util::sha256_hex(&raw) != sha {
            return Err(std::io::Error::other("历史正文校验失败"));
        }
        let path = self.blob_path(sha);
        if path.is_file() {
            return Ok(());
        }
        write_atomic(&path, gz)
    }

    /// 从另一个命名空间复制已封口正文（迁移用）
    pub fn copy_blob_from(&self, other: &Store, sha: &str) -> std::io::Result<()> {
        if self.has_blob(sha) {
            return Ok(());
        }
        let gz = other.read_blob_gz(sha)?;
        write_atomic(&self.blob_path(sha), &gz)
    }

    /// 读取某个版本的原始字节
    pub fn read_entry(&self, doc_id: &str, entry: &Entry) -> std::io::Result<Vec<u8>> {
        let path = if entry.open {
            // 封口与读取可能交错：pending 已移走时回退到 blob
            let p = self.pending_path(doc_id);
            if p.is_file() { p } else { self.blob_path(&entry.hash) }
        } else {
            if !valid_sha(&entry.hash) {
                return Err(std::io::Error::other("无效的内容哈希"));
            }
            self.blob_path(&entry.hash)
        };
        gunzip(&std::fs::read(path)?)
    }

    pub fn read_index(&self, doc_id: &str) -> Option<DocIndex> {
        if !valid_doc_id(doc_id) {
            return None;
        }
        let bytes = std::fs::read(self.index_path(doc_id)).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    pub fn write_index(&self, index: &DocIndex) -> std::io::Result<()> {
        if !valid_doc_id(&index.doc_id) {
            return Err(std::io::Error::other("无效的文档标识"));
        }
        let json = serde_json::to_vec(index).map_err(std::io::Error::other)?;
        write_atomic(&self.index_path(&index.doc_id), &json)
    }

    /// 删除文档索引与其合并窗口正文（blob 由 GC 回收）
    pub fn delete_index(&self, doc_id: &str) {
        if !valid_doc_id(doc_id) {
            return;
        }
        let _ = std::fs::remove_file(self.index_path(doc_id));
        let _ = std::fs::remove_file(self.pending_path(doc_id));
    }

    /// 列出全部文档标识
    pub fn list_doc_ids(&self) -> Vec<String> {
        let Ok(rd) = std::fs::read_dir(self.dir.join("docs")) else { return Vec::new() };
        rd.flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                let id = name.strip_suffix(".json")?.to_string();
                valid_doc_id(&id).then_some(id)
            })
            .collect()
    }

    /// 标记清除：删除未被任何索引引用的 blob 与无主 pending，返回释放字节数
    pub fn gc(&self, referenced: &HashSet<String>, live_docs: &HashSet<String>) -> u64 {
        let mut freed = 0u64;
        if let Ok(shards) = std::fs::read_dir(self.dir.join("blobs")) {
            for shard in shards.flatten() {
                let Ok(files) = std::fs::read_dir(shard.path()) else { continue };
                let mut left = 0usize;
                for f in files.flatten() {
                    let name = f.file_name().to_string_lossy().to_string();
                    let sha = name.strip_suffix(".gz").unwrap_or("");
                    if valid_sha(sha) && referenced.contains(sha) {
                        left += 1;
                        continue;
                    }
                    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
                    if std::fs::remove_file(f.path()).is_ok() {
                        freed += size;
                    } else {
                        left += 1;
                    }
                }
                if left == 0 {
                    let _ = std::fs::remove_dir(shard.path());
                }
            }
        }
        if let Ok(files) = std::fs::read_dir(self.dir.join("pending")) {
            for f in files.flatten() {
                let name = f.file_name().to_string_lossy().to_string();
                let id = name.strip_suffix(".gz").unwrap_or("");
                if !live_docs.contains(id) {
                    freed += f.metadata().map(|m| m.len()).unwrap_or(0);
                    let _ = std::fs::remove_file(f.path());
                }
            }
        }
        freed
    }

    /// 命名空间占用的磁盘字节数
    pub fn usage(&self) -> u64 {
        dir_size(&self.dir)
    }

    /// 单个 blob 的压缩后大小（容量淘汰估算用）
    pub fn blob_size(&self, sha: &str) -> u64 {
        if !valid_sha(sha) {
            return 0;
        }
        std::fs::metadata(self.blob_path(sha)).map(|m| m.len()).unwrap_or(0)
    }
}

/// 递归统计目录大小
pub fn dir_size(dir: &Path) -> u64 {
    let mut total = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let Ok(meta) = e.metadata() else { continue };
            if meta.is_dir() {
                stack.push(e.path());
            } else {
                total += meta.len();
            }
        }
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::model::{Origin, Reason};

    fn entry(hash: &str, open: bool) -> Entry {
        Entry {
            id: "1".into(), start: 0, at: 0, hash: hash.into(), size: 0, reason: Reason::Save,
            origin: Origin::default(), stats: None, restored_from: None, pinned: false, open,
        }
    }

    #[test]
    fn blob_roundtrip_dedup_and_gc() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_path_buf());
        let data = "中文正文\r\n第二行".as_bytes();
        let sha = crate::sync::util::sha256_hex(data);
        store.put_blob(&sha, data).unwrap();
        store.put_blob(&sha, data).unwrap();
        assert_eq!(store.read_entry("d1", &entry(&sha, false)).unwrap(), data);

        // 合并窗口正文封口后可按哈希读取
        let other = b"pending body";
        let sha2 = crate::sync::util::sha256_hex(other);
        store.put_pending("d1", other).unwrap();
        assert_eq!(store.read_entry("d1", &entry(&sha2, true)).unwrap(), other);
        store.seal_pending("d1", &sha2).unwrap();
        assert!(!store.pending_path("d1").exists());
        assert_eq!(store.read_entry("d1", &entry(&sha2, false)).unwrap(), other);

        // 未被引用的 blob 被回收
        let referenced: HashSet<String> = [sha.clone()].into_iter().collect();
        let freed = store.gc(&referenced, &HashSet::new());
        assert!(freed > 0);
        assert!(store.has_blob(&sha));
        assert!(!store.has_blob(&sha2));
    }

    #[test]
    fn rejects_unsafe_doc_ids() {
        assert!(valid_doc_id("abc-123_x"));
        assert!(!valid_doc_id("../x"));
        assert!(!valid_doc_id(""));
    }
}
