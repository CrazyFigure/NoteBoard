// 本地文件搜索：索引快照
//
// 重启后先读取快照即可立即搜索，再在后台与磁盘对账，只重新读取有变化的文件。
// 格式为小端二进制，末尾附 CRC32 校验；格式或切分规则变化时提升版本号，旧快照直接丢弃重建。

use super::content::{ContentIndex, Segment};
use super::names::{Entry, FileTable};
use std::path::Path;
use std::sync::Arc;

const MAGIC: &[u8; 8] = b"NBLSIDX\0";
/// 快照格式版本（片段规则、条目结构变化时递增）
const VERSION: u32 = 1;

pub fn put_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}

pub fn put_u64(out: &mut Vec<u8>, v: u64) {
    out.extend_from_slice(&v.to_le_bytes());
}

pub fn put_u32s(out: &mut Vec<u8>, values: &[u32]) {
    put_u64(out, values.len() as u64);
    out.reserve(values.len() * 4);
    for v in values {
        out.extend_from_slice(&v.to_le_bytes());
    }
}

pub fn put_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
    put_u64(out, bytes.len() as u64);
    out.extend_from_slice(bytes);
}

/// 顺序读取器：越界返回 None，损坏的快照不会导致崩溃
pub struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Reader { buf, pos: 0 }
    }

    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.pos.checked_add(n)?;
        let s = self.buf.get(self.pos..end)?;
        self.pos = end;
        Some(s)
    }

    pub fn u32(&mut self) -> Option<u32> {
        Some(u32::from_le_bytes(self.take(4)?.try_into().ok()?))
    }

    pub fn u64(&mut self) -> Option<u64> {
        Some(u64::from_le_bytes(self.take(8)?.try_into().ok()?))
    }

    pub fn u32s(&mut self) -> Option<Vec<u32>> {
        let n = usize::try_from(self.u64()?).ok()?;
        let raw = self.take(n.checked_mul(4)?)?;
        Some(raw.chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
    }

    pub fn bytes(&mut self) -> Option<Vec<u8>> {
        let n = usize::try_from(self.u64()?).ok()?;
        Some(self.take(n)?.to_vec())
    }
}

/// 序列化索引（调用方需先冻结活动段，并持有读锁）
pub fn encode(table: &FileTable, content: &ContentIndex) -> Vec<u8> {
    let mut out = Vec::with_capacity(table.entries.len() * 24 + table.names.len() + content.bytes() + 64);
    out.extend_from_slice(MAGIC);
    put_u32(&mut out, VERSION);
    put_u64(&mut out, table.entries.len() as u64);
    for e in &table.entries {
        put_u32(&mut out, e.parent);
        put_u32(&mut out, e.name_off);
        put_u32(&mut out, e.mtime);
        put_u32(&mut out, e.doc);
        put_u32(&mut out, e.size_lo);
        out.extend_from_slice(&e.name_len.to_le_bytes());
        out.push(e.flags);
        out.push(e.size_hi);
    }
    put_bytes(&mut out, &table.names);
    put_u32s(&mut out, &content.docs);
    put_u64(&mut out, content.segments.len() as u64);
    for seg in &content.segments {
        seg.write_to(&mut out);
    }
    let crc = crc32fast::hash(&out);
    put_u32(&mut out, crc);
    out
}

/// 解析快照；格式不符、版本不同或校验失败返回 None
pub fn decode(buf: &[u8]) -> Option<(FileTable, ContentIndex)> {
    if buf.len() < MAGIC.len() + 8 || &buf[..MAGIC.len()] != MAGIC {
        return None;
    }
    let (body, tail) = buf.split_at(buf.len() - 4);
    if crc32fast::hash(body) != u32::from_le_bytes(tail.try_into().ok()?) {
        return None;
    }
    let mut r = Reader::new(&body[MAGIC.len()..]);
    if r.u32()? != VERSION {
        return None;
    }
    let count = usize::try_from(r.u64()?).ok()?;
    let mut table = FileTable::default();
    table.entries.reserve(count.min(body.len() / 24));
    for _ in 0..count {
        let raw = r.take(24)?;
        let u = |i: usize| u32::from_le_bytes([raw[i], raw[i + 1], raw[i + 2], raw[i + 3]]);
        table.entries.push(Entry {
            parent: u(0),
            name_off: u(4),
            mtime: u(8),
            doc: u(12),
            size_lo: u(16),
            name_len: u16::from_le_bytes([raw[20], raw[21]]),
            flags: raw[22],
            size_hi: raw[23],
        });
    }
    table.names = r.bytes()?;
    let mut content = ContentIndex { docs: r.u32s()?, ..Default::default() };
    let segs = usize::try_from(r.u64()?).ok()?;
    for _ in 0..segs {
        content.segments.push(Arc::new(Segment::read_from(&mut r)?));
    }
    // 结构自检：名字位置与父目录编号都必须在范围内（父目录编号总小于子条目）
    for (id, e) in table.entries.iter().enumerate() {
        if e.name_off as usize + e.name_len as usize > table.names.len() {
            return None;
        }
        if e.parent != u32::MAX && e.parent >= id as u32 {
            return None;
        }
        if e.has_doc() && e.doc as usize >= content.docs.len() {
            return None;
        }
    }
    if std::str::from_utf8(&table.names).is_err() {
        return None;
    }
    content.dead = content.docs.iter().filter(|&&d| d == u32::MAX).count();
    table.rebuild_children();
    Some((table, content))
}

/// 原子写入快照文件
pub fn save(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    crate::fsio::write::atomic_write(path, bytes).map_err(|e| e.to_string())
}

/// 读取快照文件
pub fn load(path: &Path) -> Option<(FileTable, ContentIndex)> {
    let bytes = std::fs::read(path).ok()?;
    decode(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_search::names::{DIR, TEXT};

    #[test]
    fn snapshot_round_trip_and_corruption_detection() {
        let mut table = FileTable::default();
        let mut content = ContentIndex::default();
        let root = table.add_root(&std::env::temp_dir().join("nb-snap").to_string_lossy());
        let dir = table.add(root, "文档", DIR, 0, 5);
        let file = table.add(dir, "a.md", TEXT, 12, 6);
        let doc = content.add(file, &[3, 7, 9]);
        table.entries[file as usize].doc = doc;
        content.freeze();
        let bytes = encode(&table, &content);
        let (t2, c2) = decode(&bytes).expect("快照应能读回");
        assert_eq!(t2.entries, table.entries);
        assert_eq!(t2.path(file), table.path(file));
        assert_eq!(c2.candidates(&[3, 9], 8), vec![doc]);
        let mut broken = bytes.clone();
        let mid = broken.len() / 2;
        broken[mid] ^= 0xFF;
        assert!(decode(&broken).is_none());
        assert!(decode(&bytes[..bytes.len() - 10]).is_none());
    }
}
