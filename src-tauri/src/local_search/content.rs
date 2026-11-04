// 本地文件搜索：内容倒排索引
//
// 结构：文档编号单调递增；新文档先进入可变的「活动段」，攒够一定数量后冻结为只读段
// （有序片段键 + 偏移 + 差分变长整数编码的文档编号）。文件修改或删除时旧编号记为失效，
// 查询时过滤，后台合并相邻段时一并清除，避免索引无限增长。
// 只读段以 Arc 共享：合并在索引线程中脱离写锁进行，查询期间仍可读取旧段。

use rustc_hash::FxHashMap;
use std::sync::Arc;

/// 无效编号
pub const NONE: u32 = u32::MAX;

/// 活动段达到该条目数后冻结
pub const LIVE_FREEZE_POSTINGS: usize = 1_000_000;

/// 只读段
#[derive(Debug, Default)]
pub struct Segment {
    /// 本段覆盖的文档编号范围 [first_doc, end_doc)
    pub first_doc: u32,
    pub end_doc: u32,
    pub keys: Vec<u32>,
    pub offs: Vec<u32>,
    pub data: Vec<u8>,
}

#[inline]
fn write_varint(out: &mut Vec<u8>, mut v: u32) {
    while v >= 0x80 {
        out.push((v as u8) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

/// 解码差分编码的文档编号并追加到 out
fn decode_into(bytes: &[u8], out: &mut Vec<u32>) {
    let mut prev: u32 = 0;
    let mut first = true;
    let mut i = 0;
    while i < bytes.len() {
        let mut v: u32 = 0;
        let mut shift = 0;
        loop {
            let b = bytes[i];
            i += 1;
            v |= ((b & 0x7F) as u32) << shift;
            if b & 0x80 == 0 || i >= bytes.len() {
                break;
            }
            shift += 7;
        }
        let doc = if first { v } else { prev.wrapping_add(v) };
        first = false;
        prev = doc;
        out.push(doc);
    }
}

impl Segment {
    /// 由「片段 → 升序文档编号」构建只读段；alive 用于过滤失效文档
    fn build(first_doc: u32, end_doc: u32, mut lists: Vec<(u32, Vec<u32>)>, alive: &dyn Fn(u32) -> bool) -> Segment {
        lists.sort_unstable_by_key(|(k, _)| *k);
        let mut keys = Vec::with_capacity(lists.len());
        let mut offs = Vec::with_capacity(lists.len() + 1);
        let mut data = Vec::new();
        for (key, docs) in lists {
            let start = data.len();
            let mut prev: Option<u32> = None;
            for doc in docs {
                if !alive(doc) {
                    continue;
                }
                match prev {
                    None => write_varint(&mut data, doc),
                    Some(p) => write_varint(&mut data, doc - p),
                }
                prev = Some(doc);
            }
            if data.len() > start {
                keys.push(key);
                offs.push(start as u32);
            }
        }
        offs.push(data.len() as u32);
        if keys.is_empty() {
            offs = vec![0];
        }
        Segment { first_doc, end_doc, keys, offs, data }
    }

    /// 查找片段对应的编码数据
    fn postings(&self, key: u32) -> Option<&[u8]> {
        let idx = self.keys.binary_search(&key).ok()?;
        let s = self.offs[idx] as usize;
        let e = self.offs[idx + 1] as usize;
        Some(&self.data[s..e])
    }

    /// 估算内存占用（字节）
    pub fn bytes(&self) -> usize {
        self.keys.len() * 4 + self.offs.len() * 4 + self.data.len()
    }

    /// 合并两个相邻段（a 的编号全部小于 b），丢弃失效文档
    fn merge(a: &Segment, b: &Segment, alive: &dyn Fn(u32) -> bool) -> Segment {
        let mut lists: Vec<(u32, Vec<u32>)> = Vec::with_capacity(a.keys.len().max(b.keys.len()));
        let (mut i, mut j) = (0usize, 0usize);
        let mut buf = Vec::new();
        while i < a.keys.len() || j < b.keys.len() {
            let key = match (a.keys.get(i), b.keys.get(j)) {
                (Some(&x), Some(&y)) => x.min(y),
                (Some(&x), None) => x,
                (None, Some(&y)) => y,
                (None, None) => break,
            };
            buf.clear();
            if a.keys.get(i) == Some(&key) {
                decode_into(&a.data[a.offs[i] as usize..a.offs[i + 1] as usize], &mut buf);
                i += 1;
            }
            if b.keys.get(j) == Some(&key) {
                decode_into(&b.data[b.offs[j] as usize..b.offs[j + 1] as usize], &mut buf);
                j += 1;
            }
            lists.push((key, buf.clone()));
        }
        Segment::build(a.first_doc, b.end_doc, lists, alive)
    }
}

/// 可变活动段
#[derive(Debug, Default)]
pub struct LiveSegment {
    pub first_doc: u32,
    pub map: FxHashMap<u32, Vec<u32>>,
    pub postings: usize,
}

/// 内容索引
#[derive(Debug, Default)]
pub struct ContentIndex {
    /// 文档编号 → 文件表条目编号（NONE 表示已失效）
    pub docs: Vec<u32>,
    pub segments: Vec<Arc<Segment>>,
    pub live: LiveSegment,
    /// 失效文档数（用于判断是否需要合并清理）
    pub dead: usize,
}

impl ContentIndex {
    /// 新增文档，返回文档编号；grams 须已升序去重
    pub fn add(&mut self, entry: u32, grams: &[u32]) -> u32 {
        let doc = self.docs.len() as u32;
        self.docs.push(entry);
        if self.live.map.is_empty() {
            self.live.first_doc = doc;
        }
        for &g in grams {
            self.live.map.entry(g).or_default().push(doc);
        }
        self.live.postings += grams.len();
        doc
    }

    /// 文档失效（文件被修改、删除或移出索引范围）
    pub fn remove(&mut self, doc: u32) {
        if let Some(slot) = self.docs.get_mut(doc as usize) {
            if *slot != NONE {
                *slot = NONE;
                self.dead += 1;
            }
        }
    }

    #[inline]
    pub fn entry_of(&self, doc: u32) -> u32 {
        self.docs.get(doc as usize).copied().unwrap_or(NONE)
    }

    pub fn live_docs(&self) -> usize {
        self.docs.len() - self.dead
    }

    /// 活动段是否需要冻结
    pub fn should_freeze(&self) -> bool {
        self.live.postings >= LIVE_FREEZE_POSTINGS
    }

    /// 冻结活动段（在写锁内调用；活动段上限较小，耗时可控）
    pub fn freeze(&mut self) {
        if self.live.map.is_empty() {
            return;
        }
        let live = std::mem::take(&mut self.live);
        let end = self.docs.len() as u32;
        let docs = &self.docs;
        let alive = |d: u32| docs.get(d as usize).is_some_and(|e| *e != NONE);
        let seg = Segment::build(live.first_doc, end, live.map.into_iter().collect(), &alive);
        self.segments.push(Arc::new(seg));
    }

    /// 选出下一次需要合并的相邻段（较旧段不超过较新段的 2 倍，类似二进制进位，段数保持对数级）
    pub fn merge_candidate(&self) -> Option<usize> {
        let n = self.segments.len();
        if n < 2 {
            return None;
        }
        for i in (1..n).rev() {
            let older = self.segments[i - 1].bytes();
            let newer = self.segments[i].bytes();
            if older <= newer.saturating_mul(2) {
                return Some(i - 1);
            }
        }
        None
    }

    /// 计算合并结果（不修改索引，可在锁外执行）
    pub fn merged(&self, idx: usize) -> Segment {
        let docs = &self.docs;
        let alive = |d: u32| docs.get(d as usize).is_some_and(|e| *e != NONE);
        Segment::merge(&self.segments[idx], &self.segments[idx + 1], &alive)
    }

    /// 用合并结果替换相邻两段
    pub fn replace_merged(&mut self, idx: usize, seg: Segment) {
        self.segments.splice(idx..idx + 2, [Arc::new(seg)]);
    }

    /// 取单个片段在所有段中的文档编号（升序）
    pub fn postings(&self, key: u32, out: &mut Vec<u32>) {
        out.clear();
        for seg in &self.segments {
            if let Some(bytes) = seg.postings(key) {
                decode_into(bytes, out);
            }
        }
        if let Some(list) = self.live.map.get(&key) {
            out.extend_from_slice(list);
        }
    }

    /// 估算片段的命中规模（编码字节数），用于挑选最有区分度的片段
    pub fn estimate(&self, key: u32) -> usize {
        let mut size = 0;
        for seg in &self.segments {
            if let Some(bytes) = seg.postings(key) {
                size += bytes.len();
            }
        }
        if let Some(list) = self.live.map.get(&key) {
            size += list.len() * 2;
        }
        size
    }

    /// 按片段求候选文档：取区分度最高的若干片段求交集，返回仍有效的文档编号
    pub fn candidates(&self, grams: &[u32], max_grams: usize) -> Vec<u32> {
        if grams.is_empty() {
            return Vec::new();
        }
        let mut ranked: Vec<(usize, u32)> = grams.iter().map(|&g| (self.estimate(g), g)).collect();
        ranked.sort_unstable();
        // 任一片段完全没有命中，交集必为空
        if ranked[0].0 == 0 {
            return Vec::new();
        }
        let mut result: Vec<u32> = Vec::new();
        let mut buf: Vec<u32> = Vec::new();
        for (n, &(_, gram)) in ranked.iter().take(max_grams).enumerate() {
            self.postings(gram, &mut buf);
            if n == 0 {
                result = buf.clone();
            } else {
                result = intersect(&result, &buf);
            }
            if result.is_empty() {
                break;
            }
        }
        result.retain(|d| self.entry_of(*d) != NONE);
        result
    }

    /// 估算内存占用（字节）
    pub fn bytes(&self) -> usize {
        self.docs.len() * 4 + self.segments.iter().map(|s| s.bytes()).sum::<usize>() + self.live.postings * 4
    }
}

/// 两个升序列表求交集
fn intersect(a: &[u32], b: &[u32]) -> Vec<u32> {
    let mut out = Vec::with_capacity(a.len().min(b.len()));
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        match a[i].cmp(&b[j]) {
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
            std::cmp::Ordering::Equal => {
                out.push(a[i]);
                i += 1;
                j += 1;
            }
        }
    }
    out
}

// ── 快照序列化 ──

impl Segment {
    pub fn write_to(&self, out: &mut Vec<u8>) {
        super::persist::put_u32(out, self.first_doc);
        super::persist::put_u32(out, self.end_doc);
        super::persist::put_u32s(out, &self.keys);
        super::persist::put_u32s(out, &self.offs);
        super::persist::put_bytes(out, &self.data);
    }

    pub fn read_from(r: &mut super::persist::Reader) -> Option<Segment> {
        let seg = Segment {
            first_doc: r.u32()?,
            end_doc: r.u32()?,
            keys: r.u32s()?,
            offs: r.u32s()?,
            data: r.bytes()?,
        };
        // 结构自检：偏移数必须比键多一个，且末尾偏移不超过数据长度
        if seg.offs.len() != seg.keys.len() + 1 || seg.offs.last().copied().unwrap_or(0) as usize > seg.data.len() {
            return None;
        }
        Some(seg)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index_with(docs: &[&[u32]]) -> ContentIndex {
        let mut idx = ContentIndex::default();
        for (i, grams) in docs.iter().enumerate() {
            idx.add(i as u32 + 100, grams);
        }
        idx
    }

    #[test]
    fn candidates_intersect_across_live_and_frozen_segments() {
        let mut idx = index_with(&[&[1, 2, 3], &[2, 3], &[3, 4]]);
        idx.freeze();
        idx.add(200, &[2, 3, 9]);
        assert_eq!(idx.candidates(&[2, 3], 8), vec![0, 1, 3]);
        assert_eq!(idx.candidates(&[3, 4], 8), vec![2]);
        assert!(idx.candidates(&[5], 8).is_empty());
    }

    #[test]
    fn removed_documents_are_filtered_and_dropped_on_merge() {
        let mut idx = index_with(&[&[1, 2], &[1, 2], &[1]]);
        idx.freeze();
        idx.add(300, &[1, 2]);
        idx.freeze();
        idx.remove(1);
        assert_eq!(idx.candidates(&[1, 2], 8), vec![0, 3]);
        let at = idx.merge_candidate().expect("两个小段应合并");
        let merged = idx.merged(at);
        idx.replace_merged(at, merged);
        assert_eq!(idx.segments.len(), 1);
        assert_eq!(idx.candidates(&[1, 2], 8), vec![0, 3]);
        assert_eq!(idx.candidates(&[1], 8), vec![0, 2, 3]);
    }

    #[test]
    fn varint_round_trip_handles_large_gaps() {
        let mut idx = ContentIndex::default();
        idx.docs = vec![0; 3_000_000];
        idx.docs.push(7);
        idx.live.first_doc = 3_000_000;
        idx.add(8, &[42]);
        idx.add(9, &[42]);
        idx.docs[5] = 1;
        idx.live.map.get_mut(&42).unwrap().insert(0, 5);
        idx.freeze();
        let mut out = Vec::new();
        idx.postings(42, &mut out);
        assert_eq!(out, vec![5, 3_000_001, 3_000_002]);
    }
}
