// 本地文件搜索：查询执行
//
// 文件名：多线程分片扫描整张文件表，每个线程保留前 N 名，最后合并排序。
// 内容：先用倒排索引求出候选文件（只持有读锁极短时间），再释放锁并行读取候选文件核对、
// 截取命中片段；候选按修改时间从新到旧核对，凑够数量或超出时间预算即停止，保证响应及时。

use super::content::NONE;
use super::extract;
use super::names::{FileTable, DEAD, DIR, HIDDEN, ROOT};
use super::text::{collapse_whitespace, find_ranges, fold_str, highlight, Part, Query};
use super::Index;
use memchr::memmem;
use serde::Serialize;
use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NameHit {
    pub path: String,
    pub name: String,
    pub name_parts: Vec<Part>,
    pub dir: String,
    pub is_dir: bool,
    pub size: u64,
    /// 修改时间（Unix 毫秒）
    pub mtime: u64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NameResult {
    pub hits: Vec<NameHit>,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    /// 行号（从 1 开始；Office 文档为段落序号）
    pub line: u32,
    pub parts: Vec<Part>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentHit {
    pub path: String,
    pub name: String,
    pub dir: String,
    pub size: u64,
    pub mtime: u64,
    pub snippets: Vec<Snippet>,
    /// 命中次数（上限 999）
    pub matches: u32,
    #[serde(skip)]
    pub score: i64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContentResult {
    pub hits: Vec<ContentHit>,
    /// 结果因数量或时间上限被截断
    pub truncated: bool,
}

fn worker_count() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 8)
}

/// 名字中词的起始位置是否位于单词边界
fn at_boundary(name: &[u8], pos: usize) -> bool {
    pos == 0 || matches!(name[pos - 1], b' ' | b'-' | b'_' | b'.' | b'(' | b'[' | b'#' | b'@' | b'+')
}

/// 计算名字匹配分；任一词不匹配返回 None
fn score_name(folded: &str, finders: &[memmem::Finder<'_>]) -> Option<i32> {
    let bytes = folded.as_bytes();
    let stem_len = folded.rfind('.').filter(|&p| p > 0).unwrap_or(folded.len());
    let mut score = 0i32;
    for f in finders {
        let pos = f.find(bytes)?;
        let len = f.needle().len();
        score += if len == bytes.len() {
            60
        } else if pos == 0 && len == stem_len {
            50
        } else if pos == 0 {
            30
        } else if at_boundary(bytes, pos) {
            15
        } else {
            5
        };
    }
    Some(score)
}

/// 文件名搜索
pub fn search_names(index: &Index, query: &Query, limit: usize, cancelled: &(dyn Fn() -> bool + Sync)) -> Option<NameResult> {
    let table = &index.table;
    let name_terms: Vec<&str> = query.terms.iter().filter(|t| !t.is_path).map(|t| t.folded.as_str()).collect();
    let path_terms: Vec<String> = query
        .terms
        .iter()
        .filter(|t| t.is_path)
        .map(|t| t.folded.replace(['/', '\\'], std::path::MAIN_SEPARATOR_STR))
        .collect();
    if name_terms.is_empty() && path_terms.is_empty() {
        return Some(NameResult::default());
    }
    let finders: Vec<memmem::Finder> = name_terms.iter().map(|t| memmem::Finder::new(t.as_bytes())).collect();
    let path_finders: Vec<memmem::Finder> = path_terms.iter().map(|t| memmem::Finder::new(t.as_bytes())).collect();
    let n = table.entries.len();
    let threads = worker_count().min(n / 4096 + 1);
    let chunk = n.div_ceil(threads.max(1)).max(1);
    let total = AtomicUsize::new(0);
    // 每个线程保留得分最高的 limit 个：(得分, 修改时间, 编号)
    let results: Vec<Option<Vec<(i32, u32, u32)>>> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..threads)
            .map(|t| {
                let (finders, path_finders, total) = (&finders, &path_finders, &total);
                scope.spawn(move || {
                    let mut heap: BinaryHeap<Reverse<(i32, u32, Reverse<u32>)>> = BinaryHeap::with_capacity(limit + 1);
                    let mut buf = String::new();
                    let mut count = 0usize;
                    let start = t * chunk;
                    let end = ((t + 1) * chunk).min(n);
                    for id in start..end {
                        if (id - start) % 8192 == 0 && cancelled() {
                            return None;
                        }
                        let e = &table.entries[id];
                        if e.flags & (DEAD | ROOT) != 0 {
                            continue;
                        }
                        let name = table.name(id as u32);
                        buf.clear();
                        if name.is_ascii() {
                            buf.push_str(name);
                            buf.make_ascii_lowercase();
                        } else {
                            buf.push_str(&fold_str(name));
                        }
                        let Some(mut score) = score_name(&buf, finders) else { continue };
                        if !path_finders.is_empty() {
                            let full = fold_str(&table.path(id as u32));
                            if !path_finders.iter().all(|f| f.find(full.as_bytes()).is_some()) {
                                continue;
                            }
                            score += 10;
                        }
                        // 名字越短、层级越浅越靠前；隐藏文件靠后
                        score -= (buf.len() / 8).min(10) as i32;
                        score -= (table.depth(id as u32) / 2).min(8) as i32;
                        if e.flags & DIR != 0 {
                            score += 2;
                        }
                        if e.flags & HIDDEN != 0 {
                            score -= 15;
                        }
                        count += 1;
                        let item = Reverse((score, e.mtime, Reverse(id as u32)));
                        if heap.len() < limit {
                            heap.push(item);
                        } else if let Some(top) = heap.peek() {
                            if item < *top {
                                heap.pop();
                                heap.push(item);
                            }
                        }
                    }
                    total.fetch_add(count, Ordering::Relaxed);
                    Some(heap.into_iter().map(|Reverse((s, m, Reverse(id)))| (s, m, id)).collect())
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap_or(None)).collect()
    });
    let mut all: Vec<(i32, u32, u32)> = Vec::new();
    for r in results {
        all.extend(r?);
    }
    all.sort_unstable_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)).then(a.2.cmp(&b.2)));
    all.truncate(limit);
    let hits = all
        .into_iter()
        .map(|(_, _, id)| {
            let e = &table.entries[id as usize];
            let name = table.name(id).to_string();
            let ranges = find_ranges(&name, &name_terms);
            NameHit {
                path: table.path(id),
                name_parts: highlight(&name, &ranges, 400),
                name,
                dir: table.parent_path(id),
                is_dir: e.flags & DIR != 0,
                size: e.size(),
                mtime: e.mtime as u64 * 1000,
            }
        })
        .collect();
    Some(NameResult { hits, total: total.load(Ordering::Relaxed) })
}

/// 内容候选：路径、名字与时间等（在读锁内收集）
struct Candidate {
    path: String,
    name: String,
    dir: String,
    size: u64,
    mtime: u32,
    kind: extract::Kind,
}

/// 候选数量上限：超过后只核对最近修改的部分
const MAX_CANDIDATES: usize = 20_000;
/// 核对阶段的时间预算
const VERIFY_BUDGET: Duration = Duration::from_millis(2500);
/// 每个文件最多展示的片段行数
const MAX_SNIPPETS: usize = 3;

fn collect_candidates(index: &Index, query: &Query) -> (Vec<Candidate>, bool) {
    let mut grams: Vec<u32> = query.terms.iter().flat_map(|t| t.grams.iter().copied()).collect();
    grams.sort_unstable();
    grams.dedup();
    let docs = index.content.candidates(&grams, 12);
    let table: &FileTable = &index.table;
    let mut list: Vec<(u32, u32)> = docs
        .into_iter()
        .filter_map(|d| {
            let id = index.content.entry_of(d);
            if id == NONE {
                return None;
            }
            let e = table.entries.get(id as usize)?;
            (e.alive() && e.doc == d).then_some((e.mtime, id))
        })
        .collect();
    // 最近修改的优先核对
    list.sort_unstable_by(|a, b| b.0.cmp(&a.0));
    let truncated = list.len() > MAX_CANDIDATES;
    list.truncate(MAX_CANDIDATES);
    let cands = list
        .into_iter()
        .filter_map(|(mtime, id)| {
            let e = &table.entries[id as usize];
            let name = table.name(id).to_string();
            let kind = extract::kind_for(&name, e.size())?;
            Some(Candidate { path: table.path(id), dir: table.parent_path(id), name, size: e.size(), mtime, kind })
        })
        .collect();
    (cands, truncated)
}

/// 核对单个文件：全部词都出现才算命中，并截取命中最集中的几行
pub fn verify_text(text: &str, query: &Query, name: &str) -> Option<(i64, u32, Vec<Snippet>)> {
    let folded = fold_str(text);
    let terms: Vec<&str> = query.terms.iter().map(|t| t.folded.as_str()).collect();
    for t in &terms {
        memmem::find(folded.as_bytes(), t.as_bytes())?;
    }
    let mut score: i64 = 0;
    if let Some(phrase) = &query.phrase {
        if collapse_whitespace(&folded).contains(phrase.as_str()) {
            score += 100;
        }
    }
    let folded_name = fold_str(name);
    for t in &terms {
        if folded_name.contains(t) {
            score += 15;
        }
    }
    // 逐行统计：折叠为逐字符映射，原文与折叠文的行一一对应
    let mut lines: Vec<(usize, usize, usize)> = Vec::new(); // (行号, 命中词数, 命中次数)
    let mut matches = 0usize;
    for (no, line) in folded.split('\n').enumerate() {
        let mut distinct = 0;
        let mut occ = 0;
        for t in &terms {
            let n = memmem::find_iter(line.as_bytes(), t.as_bytes()).count();
            if n > 0 {
                distinct += 1;
                occ += n;
            }
        }
        if distinct > 0 {
            matches += occ;
            lines.push((no, distinct, occ));
            if lines.len() >= 2000 {
                break;
            }
        }
    }
    score += matches.min(20) as i64;
    lines.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    lines.truncate(MAX_SNIPPETS);
    lines.sort_by_key(|l| l.0);
    let originals: Vec<&str> = text.split('\n').collect();
    let snippets = lines
        .into_iter()
        .filter_map(|(no, _, _)| {
            let line = originals.get(no)?.trim();
            let ranges = find_ranges(line, &terms);
            Some(Snippet { line: no as u32 + 1, parts: highlight(line, &ranges, 160) })
        })
        .collect();
    Some((score, matches.min(999) as u32, snippets))
}

/// 内容搜索
pub fn search_content(index: &RwLock<Index>, query: &Query, limit: usize, cancelled: &(dyn Fn() -> bool + Sync)) -> Option<ContentResult> {
    if !query.has_content_grams() {
        return Some(ContentResult::default());
    }
    let (cands, mut truncated) = {
        let guard = index.read().unwrap_or_else(|e| e.into_inner());
        collect_candidates(&guard, query)
    };
    if cancelled() {
        return None;
    }
    let started = Instant::now();
    let next = AtomicUsize::new(0);
    let found = AtomicUsize::new(0);
    let hits: Mutex<Vec<ContentHit>> = Mutex::new(Vec::new());
    let stopped_early = std::sync::atomic::AtomicBool::new(false);
    std::thread::scope(|scope| {
        for _ in 0..worker_count().min(cands.len().max(1)) {
            scope.spawn(|| loop {
                if found.load(Ordering::Relaxed) >= limit || cancelled() || started.elapsed() > VERIFY_BUDGET {
                    if next.load(Ordering::Relaxed) < cands.len() {
                        stopped_early.store(true, Ordering::Relaxed);
                    }
                    return;
                }
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(c) = cands.get(i) else { return };
                let Some(text) = extract::read_text(std::path::Path::new(&c.path), c.kind) else { continue };
                let Some((score, matches, snippets)) = verify_text(&text, query, &c.name) else { continue };
                found.fetch_add(1, Ordering::Relaxed);
                hits.lock().unwrap().push(ContentHit {
                    path: c.path.clone(),
                    name: c.name.clone(),
                    dir: c.dir.clone(),
                    size: c.size,
                    mtime: c.mtime as u64 * 1000,
                    snippets,
                    matches,
                    score,
                });
            });
        }
    });
    if cancelled() {
        return None;
    }
    let mut hits = hits.into_inner().unwrap_or_default();
    hits.sort_by(|a, b| b.score.cmp(&a.score).then(b.mtime.cmp(&a.mtime)));
    if hits.len() > limit {
        hits.truncate(limit);
        truncated = true;
    }
    truncated |= stopped_early.load(Ordering::Relaxed);
    Some(ContentResult { hits, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verify_requires_all_terms_and_rewards_phrase() {
        let text = "第一行无关\n这里讨论 本地 搜索 方案\n\n本地文件搜索方案定稿";
        let q = Query::parse("本地 搜索");
        let (score, matches, snippets) = verify_text(text, &q, "方案.md").unwrap();
        assert!(score >= 100, "整句命中应加分");
        assert!(matches >= 4);
        assert_eq!(snippets[0].line, 2);
        assert!(snippets[0].parts.iter().any(|p| p.hit && p.text == "本地"));
        assert!(verify_text(text, &Query::parse("本地 不存在"), "a.md").is_none());
    }

    #[test]
    fn verify_is_case_insensitive_and_keeps_original_case() {
        let (_, _, snippets) = verify_text("Hello NoteBoard World", &Query::parse("noteboard"), "x.txt").unwrap();
        assert!(snippets[0].parts.iter().any(|p| p.hit && p.text == "NoteBoard"));
    }

    #[test]
    fn name_score_prefers_exact_and_prefix_matches() {
        let exact = score_name("readme.md", &[memmem::Finder::new("readme.md")]).unwrap();
        let stem = score_name("readme.md", &[memmem::Finder::new("readme")]).unwrap();
        let inner = score_name("myreadme.md", &[memmem::Finder::new("readme")]).unwrap();
        assert!(exact > stem && stem > inner);
        assert!(score_name("a.md", &[memmem::Finder::new("b")]).is_none());
    }
}
