// 本地文件搜索：后台索引引擎
//
// 线程模型：
//   - 引擎线程是唯一的写入者：批量应用目录列举、内容片段与文件变化，每批只持有一次写锁；
//   - 遍历线程与内容线程以后台优先级运行，只产出数据，通过通道交给引擎线程；
//   - 查询在调用方线程持有读锁执行，与写入互不阻塞太久（写入按批、合并在锁外进行）。
// 启动时先读快照立即可搜，再在后台与磁盘对账；监听文件变化做增量更新，监听不可用时定期重扫。

use super::content::NONE;
use super::extract;
use super::names::{DIR, DOC_SKIP, HIDDEN, LINK, NO_CONTENT, NO_DESCEND, ROOT, TEXT};
use super::persist;
use super::scan::{self, Listing, RawEntry, Rules};
use super::text::doc_grams;
use super::Index;
use crossbeam_channel::{Receiver, RecvTimeoutError, Sender};
use rustc_hash::{FxHashMap, FxHashSet};
use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::{Duration, Instant};

/// 引擎与查询共享的状态
#[derive(Default)]
pub struct Shared {
    pub index: RwLock<Index>,
    pub enabled: AtomicBool,
    /// 每次索引内容变化递增（界面据此静默刷新结果）
    pub version: AtomicU64,
}

pub struct IndexedDoc {
    entry: u32,
    epoch: u64,
    size: u64,
    mtime: u32,
    grams: Option<Vec<u32>>,
}

pub enum Msg {
    Configure { enabled: bool, roots: Vec<String>, delay: Duration },
    Listing(u64, Listing),
    ScanDone(u64),
    Indexed(IndexedDoc),
    Fs { paths: Vec<PathBuf>, rescan: Option<PathBuf> },
    Watch { root: PathBuf, watcher: Option<notify::RecommendedWatcher> },
    /// 查询引擎是否空闲（测试与诊断使用）
    Probe(Sender<bool>),
    /// 立即保存快照（测试与诊断使用）
    SaveNow,
    Shutdown,
}

// ── 内容任务队列：按优先级（文件变化 > 先添加的位置 > 后添加的位置）分发给内容线程 ──

#[derive(Default)]
struct JobState {
    heap: BinaryHeap<Reverse<(u16, u64, u32)>>,
    queued: FxHashSet<u32>,
    seq: u64,
    epoch: u64,
    busy: usize,
}

#[derive(Default)]
pub struct JobQueue {
    state: Mutex<JobState>,
    cv: Condvar,
}

impl JobQueue {
    fn push(&self, rank: u16, entry: u32) {
        let mut s = self.state.lock().unwrap();
        if !s.queued.insert(entry) {
            return;
        }
        s.seq += 1;
        let seq = s.seq;
        s.heap.push(Reverse((rank, seq, entry)));
        drop(s);
        self.cv.notify_one();
    }

    /// 取下一个任务（阻塞），返回条目编号与代次
    fn pop(&self) -> (u32, u64) {
        let mut s = self.state.lock().unwrap();
        loop {
            if let Some(Reverse((_, _, entry))) = s.heap.pop() {
                s.queued.remove(&entry);
                s.busy += 1;
                return (entry, s.epoch);
            }
            s = self.cv.wait(s).unwrap();
        }
    }

    fn done(&self) {
        self.state.lock().unwrap().busy -= 1;
    }

    /// 清空队列并进入新代次：之前取出的任务结果一律作废
    fn clear(&self) -> u64 {
        let mut s = self.state.lock().unwrap();
        s.heap.clear();
        s.queued.clear();
        s.epoch += 1;
        s.epoch
    }

    fn is_idle(&self) -> bool {
        let s = self.state.lock().unwrap();
        s.heap.is_empty() && s.busy == 0
    }
}

/// 内容线程：读取文件、提取文字、生成片段，交回引擎线程写入
fn content_worker(shared: Arc<Shared>, jobs: Arc<JobQueue>, tx: Sender<Msg>) {
    scan::lower_thread_priority();
    loop {
        let (entry, epoch) = jobs.pop();
        let info = {
            let idx = shared.index.read().unwrap_or_else(|e| e.into_inner());
            idx.table.entries.get(entry as usize).copied().filter(|e| e.alive() && e.is(TEXT)).map(|e| {
                (idx.table.path(entry), idx.table.name(entry).to_string(), e.size(), e.mtime)
            })
        };
        if let Some((path, name, size, mtime)) = info {
            let grams = extract::kind_for(&name, size)
                .and_then(|kind| extract::read_text(Path::new(&path), kind))
                .map(|text| doc_grams(&text));
            if tx.send(Msg::Indexed(IndexedDoc { entry, epoch, size, mtime, grams })).is_err() {
                jobs.done();
                return;
            }
        }
        jobs.done();
    }
}

/// 写入上下文：任务优先级，以及是否来自目录遍历（遍历会继续进入子目录）
#[derive(Clone, Copy)]
struct Ctx {
    rank: u16,
    from_scan: bool,
}

struct ActiveScan {
    id: u64,
    cancel: Arc<AtomicBool>,
}

/// 文件变化事件合并等待时间
const FS_QUIET: Duration = Duration::from_millis(400);
const FS_MAX_WAIT: Duration = Duration::from_secs(2);
/// 单批文件变化超过该数量时改为重扫所在根目录
const FS_MAX_PATHS: usize = 20_000;
/// 监听不可用的位置定期重扫
const POLL_INTERVAL: Duration = Duration::from_secs(15 * 60);
/// 首次保存后，空闲时最多每 10 分钟保存一次
const SAVE_INTERVAL: Duration = Duration::from_secs(10 * 60);
/// 界面刷新通知最小间隔
const EMIT_INTERVAL: Duration = Duration::from_millis(1500);

pub struct Engine {
    shared: Arc<Shared>,
    tx: Sender<Msg>,
    rx: Receiver<Msg>,
    emit: Box<dyn Fn() + Send>,
    snapshot: Option<PathBuf>,
    jobs: Arc<JobQueue>,
    epoch: u64,
    workers_started: bool,
    enabled: bool,
    loaded: bool,
    roots: Vec<PathBuf>,
    rules: Arc<Rules>,
    scan: Option<ActiveScan>,
    scan_seq: u64,
    scan_queue: Vec<PathBuf>,
    pending_dirs: FxHashMap<PathBuf, u32>,
    watchers: Vec<(PathBuf, notify::RecommendedWatcher)>,
    poll_roots: Vec<(PathBuf, Instant)>,
    fs_pending: FxHashSet<PathBuf>,
    fs_first: Option<Instant>,
    fs_last: Instant,
    batch_listings: Vec<Listing>,
    batch_docs: Vec<IndexedDoc>,
    dirty: bool,
    saved_once: bool,
    last_save: Instant,
    changed: bool,
    last_emit: Instant,
    /// 是否启用文件监听（测试中关闭，改为直接注入事件）
    watch: bool,
}

/// 引擎句柄：查询共享状态并向引擎线程发送消息
#[derive(Clone)]
pub struct Handle {
    pub tx: Sender<Msg>,
    pub shared: Arc<Shared>,
}

impl Handle {
    pub fn send(&self, msg: Msg) {
        let _ = self.tx.send(msg);
    }
}

/// 规范化索引位置：转为绝对路径、去重；位于其他位置之内的子位置合并（除非落在外层的排除范围内）
pub fn normalize_roots(roots: &[String]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for raw in roots {
        let raw = raw.trim();
        if raw.is_empty() || raw.len() > 4096 {
            continue;
        }
        let path = PathBuf::from(raw);
        if !path.is_absolute() {
            continue;
        }
        let path = dunce::canonicalize(&path).unwrap_or(path);
        let key = scan::fold_path(&path.to_string_lossy());
        if !out.iter().any(|p| scan::fold_path(&p.to_string_lossy()) == key) {
            out.push(path);
        }
    }
    let keep: Vec<bool> = out
        .iter()
        .map(|inner| {
            !out.iter().any(|outer| {
                outer != inner
                    && inner.starts_with(outer)
                    && !Rules::new(std::slice::from_ref(outer), &[]).path_excluded(inner, outer)
            })
        })
        .collect();
    out.into_iter().zip(keep).filter_map(|(p, k)| k.then_some(p)).collect()
}

impl Engine {
    /// 创建引擎线程；snapshot 为快照文件路径（None 表示不持久化）
    pub fn spawn(snapshot: Option<PathBuf>, emit: Box<dyn Fn() + Send>, watch: bool) -> Handle {
        let (tx, rx) = crossbeam_channel::unbounded();
        let shared = Arc::new(Shared::default());
        let engine = Engine {
            shared: shared.clone(),
            tx: tx.clone(),
            rx,
            emit,
            snapshot,
            jobs: Arc::new(JobQueue::default()),
            epoch: 0,
            workers_started: false,
            enabled: false,
            loaded: false,
            roots: Vec::new(),
            rules: Arc::new(Rules::default()),
            scan: None,
            scan_seq: 0,
            scan_queue: Vec::new(),
            pending_dirs: FxHashMap::default(),
            watchers: Vec::new(),
            poll_roots: Vec::new(),
            fs_pending: FxHashSet::default(),
            fs_first: None,
            fs_last: Instant::now(),
            batch_listings: Vec::new(),
            batch_docs: Vec::new(),
            dirty: false,
            saved_once: false,
            last_save: Instant::now(),
            changed: false,
            last_emit: Instant::now(),
            watch,
        };
        std::thread::Builder::new()
            .name("nb-local-search".into())
            .spawn(move || engine.run())
            .expect("无法启动本地搜索线程");
        Handle { tx, shared }
    }

    fn run(mut self) {
        loop {
            let timeout = self.next_timeout();
            match self.rx.recv_timeout(timeout) {
                Ok(Msg::Shutdown) | Err(RecvTimeoutError::Disconnected) => return,
                Ok(msg) => {
                    self.handle(msg);
                    // 一次处理完积压消息，合并为一批写入
                    for _ in 0..8192 {
                        match self.rx.try_recv() {
                            Ok(Msg::Shutdown) => return,
                            Ok(msg) => self.handle(msg),
                            Err(_) => break,
                        }
                        if self.batch_docs.len() >= 512 || self.batch_listings.len() >= 512 {
                            self.flush();
                        }
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
            }
            self.flush();
            self.maintain();
        }
    }

    fn next_timeout(&self) -> Duration {
        if !self.fs_pending.is_empty() {
            Duration::from_millis(100)
        } else if self.changed {
            Duration::from_millis(300)
        } else {
            Duration::from_secs(1)
        }
    }

    fn handle(&mut self, msg: Msg) {
        match msg {
            Msg::Configure { enabled, roots, delay } => {
                if !delay.is_zero() {
                    std::thread::sleep(delay);
                }
                self.flush();
                self.configure(enabled, roots);
            }
            Msg::Listing(id, listing) => {
                if self.scan.as_ref().is_some_and(|s| s.id == id) {
                    self.batch_listings.push(listing);
                }
            }
            Msg::ScanDone(id) => {
                if self.scan.as_ref().is_some_and(|s| s.id == id) {
                    self.flush();
                    self.scan = None;
                    self.pending_dirs.clear();
                    self.changed = true;
                }
            }
            Msg::Indexed(doc) => {
                if doc.epoch == self.epoch && self.enabled {
                    self.batch_docs.push(doc);
                }
            }
            Msg::Fs { paths, rescan } => {
                if !self.enabled {
                    return;
                }
                if let Some(root) = rescan {
                    self.queue_scan(root);
                }
                if !paths.is_empty() {
                    if self.fs_pending.is_empty() {
                        self.fs_first = Some(Instant::now());
                    }
                    self.fs_last = Instant::now();
                    self.fs_pending.extend(paths);
                }
            }
            Msg::Watch { root, watcher } => {
                if !self.enabled || !self.roots.contains(&root) {
                    return;
                }
                match watcher {
                    Some(w) => self.watchers.push((root, w)),
                    None => self.poll_roots.push((root, Instant::now())),
                }
            }
            Msg::Probe(reply) => {
                self.flush();
                let idle = self.scan.is_none()
                    && self.scan_queue.is_empty()
                    && self.fs_pending.is_empty()
                    && self.jobs.is_idle()
                    && self.rx.is_empty();
                let _ = reply.send(idle);
            }
            Msg::SaveNow => {
                self.flush();
                if self.enabled {
                    self.save_now();
                }
            }
            Msg::Shutdown => {}
        }
    }

    // ── 配置 ──

    fn configure(&mut self, enabled: bool, roots: Vec<String>) {
        let shared = self.shared.clone();
        if !enabled {
            if self.enabled || self.loaded {
                self.reset();
                *shared.index.write().unwrap_or_else(|e| e.into_inner()) = Index::default();
            }
            self.enabled = false;
            shared.enabled.store(false, Ordering::Relaxed);
            // 关闭后删除快照，不在磁盘上保留文件清单
            if let Some(path) = &self.snapshot {
                let _ = std::fs::remove_file(path);
            }
            self.dirty = false;
            self.changed = true;
            return;
        }
        let wanted = normalize_roots(&roots);
        self.enabled = true;
        shared.enabled.store(true, Ordering::Relaxed);
        self.start_workers();
        let mut first_load = false;
        if !self.loaded {
            self.loaded = true;
            first_load = true;
            if let Some(loaded) = self.snapshot.as_deref().and_then(persist::load) {
                let mut idx = shared.index.write().unwrap_or_else(|e| e.into_inner());
                idx.table = loaded.0;
                idx.content = loaded.1;
                self.saved_once = true;
                self.last_save = Instant::now();
            }
        }
        self.rules = Arc::new(Rules::new(&wanted, &[]));
        {
            let mut guard = shared.index.write().unwrap_or_else(|e| e.into_inner());
            let idx = &mut *guard;
            let current = idx.table.root_paths();
            let same = |a: &str, b: &Path| scan::fold_path(a) == scan::fold_path(&b.to_string_lossy());
            for (id, path) in &current {
                if !wanted.iter().any(|w| same(path, w)) {
                    idx.table.remove_subtree(*id, &mut idx.content);
                    self.dirty = true;
                } else if first_load {
                    // 启动对账：快照中的位置在后台重新核对一遍
                    self.scan_queue.push(PathBuf::from(path));
                }
            }
            for w in &wanted {
                if !current.iter().any(|(_, p)| same(p, w)) {
                    idx.table.add_root(&w.to_string_lossy());
                    self.scan_queue.push(w.clone());
                    self.dirty = true;
                }
            }
        }
        // 监听：移除不再需要的，新增新位置
        self.watchers.retain(|(root, _)| wanted.contains(root));
        self.poll_roots.retain(|(root, _)| wanted.contains(root));
        for root in &wanted {
            let watched = self.watchers.iter().any(|(r, _)| r == root) || self.poll_roots.iter().any(|(r, _)| r == root);
            if !watched && !self.roots.contains(root) {
                self.start_watch(root.clone());
            }
        }
        self.roots = wanted;
        self.changed = true;
    }

    /// 停止全部后台工作并清空状态
    fn reset(&mut self) {
        if let Some(scan) = self.scan.take() {
            scan.cancel.store(true, Ordering::Relaxed);
        }
        self.scan_queue.clear();
        self.pending_dirs.clear();
        self.watchers.clear();
        self.poll_roots.clear();
        self.fs_pending.clear();
        self.batch_docs.clear();
        self.batch_listings.clear();
        self.epoch = self.jobs.clear();
        self.roots.clear();
        self.loaded = false;
        self.saved_once = false;
    }

    fn start_workers(&mut self) {
        if self.workers_started {
            return;
        }
        self.workers_started = true;
        let count = (std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4) / 2).clamp(1, 4);
        for i in 0..count {
            let (shared, jobs, tx) = (self.shared.clone(), self.jobs.clone(), self.tx.clone());
            let _ = std::thread::Builder::new()
                .name(format!("nb-local-search-content-{i}"))
                .spawn(move || content_worker(shared, jobs, tx));
        }
    }

    /// 在独立线程创建监听（Linux 递归监听需要逐目录注册，可能耗时）
    fn start_watch(&mut self, root: PathBuf) {
        if !self.watch {
            return;
        }
        let tx = self.tx.clone();
        let rules = self.rules.clone();
        let _ = std::thread::Builder::new().name("nb-local-search-watch".into()).spawn(move || {
            use notify::Watcher;
            let event_tx = tx.clone();
            let event_root = root.clone();
            let handler = move |res: notify::Result<notify::Event>| {
                let Ok(event) = res else { return };
                // 读取事件（Linux inotify 会上报打开与读取）不影响索引，也避免自身读文件形成循环
                if matches!(event.kind, notify::EventKind::Access(_)) {
                    return;
                }
                if event.need_rescan() {
                    let _ = event_tx.send(Msg::Fs { paths: Vec::new(), rescan: Some(event_root.clone()) });
                    return;
                }
                let paths: Vec<PathBuf> = event.paths.into_iter().filter(|p| !rules.path_excluded(p, &event_root)).collect();
                if !paths.is_empty() {
                    let _ = event_tx.send(Msg::Fs { paths, rescan: None });
                }
            };
            let watcher = notify::recommended_watcher(handler).ok().and_then(|mut w| {
                w.watch(&root, notify::RecursiveMode::Recursive).ok().map(|_| w)
            });
            let _ = tx.send(Msg::Watch { root, watcher });
        });
    }

    fn queue_scan(&mut self, dir: PathBuf) {
        if !self.scan_queue.contains(&dir) {
            self.scan_queue.push(dir);
        }
    }

    /// 任务优先级：按目录所属位置在设置中的顺序
    fn rank_of(&self, dir: &Path) -> u16 {
        let mut best: Option<(usize, usize)> = None;
        for (i, root) in self.roots.iter().enumerate() {
            if dir.starts_with(root) {
                let depth = root.components().count();
                if best.is_none_or(|b| depth > b.1) {
                    best = Some((i, depth));
                }
            }
        }
        best.map(|b| b.0 as u16 + 1).unwrap_or(u16::MAX)
    }

    // ── 写入 ──

    /// 把积压的目录列举与内容结果一次性写入索引
    fn flush(&mut self) {
        if self.batch_listings.is_empty() && self.batch_docs.is_empty() {
            return;
        }
        let shared = self.shared.clone();
        let listings = std::mem::take(&mut self.batch_listings);
        let docs = std::mem::take(&mut self.batch_docs);
        let mut guard = shared.index.write().unwrap_or_else(|e| e.into_inner());
        let idx = &mut *guard;
        for listing in listings {
            self.apply_listing(idx, listing);
        }
        for doc in docs {
            Self::apply_doc(idx, doc);
        }
        if idx.content.should_freeze() {
            idx.content.freeze();
        }
        drop(guard);
        self.mark_changed();
    }

    fn mark_changed(&mut self) {
        self.dirty = true;
        self.changed = true;
        self.shared.version.fetch_add(1, Ordering::Relaxed);
    }

    fn apply_doc(idx: &mut Index, doc: IndexedDoc) {
        let Some(e) = idx.table.entries.get(doc.entry as usize).copied() else { return };
        // 条目已删除或文件在读取后又被修改：丢弃结果（新的任务已排队）
        if !e.alive() || !e.is(TEXT) || e.size() != doc.size || e.mtime != doc.mtime {
            return;
        }
        if e.has_doc() {
            idx.content.remove(e.doc);
        }
        let new_doc = match doc.grams {
            Some(grams) if !grams.is_empty() => idx.content.add(doc.entry, &grams),
            _ => DOC_SKIP,
        };
        idx.table.entries[doc.entry as usize].doc = new_doc;
    }

    fn apply_listing(&mut self, idx: &mut Index, listing: Listing) {
        let Some(dir_id) = self.pending_dirs.remove(&listing.dir) else { return };
        let Some(dir) = idx.table.entries.get(dir_id as usize).copied() else { return };
        if !dir.alive() || !dir.is(DIR) || !listing.ok {
            return;
        }
        if listing.cache_dir {
            idx.table.clear_children(dir_id, &mut idx.content);
            idx.table.entries[dir_id as usize].flags |= NO_DESCEND;
            return;
        }
        idx.table.entries[dir_id as usize].flags &= !NO_DESCEND;
        // 软件安装目录（含动态库或卸载程序）及其子孙只收录文件名；标记随父目录向下传递
        // 根目录是用户明确添加的位置（磁盘根目录也常散落动态库），不按此规则排除
        if dir.is(ROOT) {
            idx.table.entries[dir_id as usize].flags &= !NO_CONTENT;
        } else if listing.program_dir {
            idx.table.entries[dir_id as usize].flags |= NO_CONTENT;
        }
        let content_ok = !idx.table.entries[dir_id as usize].is(NO_CONTENT) && self.rules.content_allowed(&listing.dir);
        let ctx = Ctx { rank: self.rank_of(&listing.dir), from_scan: true };
        let mut existing: FxHashMap<String, u32> = idx
            .table
            .children
            .get(&dir_id)
            .map(|kids| kids.iter().map(|&k| (idx.table.name(k).to_string(), k)).collect())
            .unwrap_or_default();
        for raw in listing.entries {
            let path = listing.dir.join(&raw.name);
            match existing.remove(&raw.name) {
                Some(id) => self.update_entry(idx, id, raw, path, content_ok, ctx),
                None => {
                    self.insert_entry(idx, dir_id, raw, path, content_ok, ctx);
                }
            }
        }
        for (_, id) in existing {
            idx.table.remove_subtree(id, &mut idx.content);
        }
    }

    fn entry_flags(raw: &RawEntry, content_ok: bool) -> (u8, bool) {
        let mut flags = 0;
        if raw.is_dir {
            flags |= DIR;
            if !raw.descend {
                flags |= NO_DESCEND;
            }
            if !content_ok {
                flags |= NO_CONTENT;
            }
        }
        if raw.is_link {
            flags |= LINK;
        }
        if raw.hidden {
            flags |= HIDDEN;
        }
        let text = !raw.is_dir && !raw.is_link && !raw.no_content && content_ok && extract::kind_for(&raw.name, raw.size).is_some();
        if text {
            flags |= TEXT;
        }
        (flags, text)
    }

    fn insert_entry(&mut self, idx: &mut Index, parent: u32, raw: RawEntry, path: PathBuf, content_ok: bool, ctx: Ctx) -> u32 {
        let (flags, text) = Self::entry_flags(&raw, content_ok);
        let id = idx.table.add(parent, &raw.name, flags, raw.size, raw.mtime);
        if raw.is_dir && raw.descend {
            if ctx.from_scan {
                self.pending_dirs.insert(path, id);
            } else {
                // 新出现的目录（如整个移入）可能已有内容，扫描其子树
                self.queue_scan(path);
            }
        }
        if text {
            self.jobs.push(ctx.rank, id);
        }
        id
    }

    fn update_entry(&mut self, idx: &mut Index, id: u32, raw: RawEntry, path: PathBuf, content_ok: bool, ctx: Ctx) {
        let e = idx.table.entries[id as usize];
        // 类型变化（文件变目录等）：删除后重建
        if e.is(DIR) != raw.is_dir || e.is(LINK) != raw.is_link {
            let parent = e.parent;
            idx.table.remove_subtree(id, &mut idx.content);
            self.insert_entry(idx, parent, raw, path, content_ok, ctx);
            return;
        }
        let (flags, text) = Self::entry_flags(&raw, content_ok);
        let changed = e.size() != raw.size || e.mtime != raw.mtime;
        let entry = &mut idx.table.entries[id as usize];
        entry.set_size(raw.size);
        entry.mtime = raw.mtime;
        entry.flags = (entry.flags & !(HIDDEN | TEXT | NO_CONTENT)) | (flags & (HIDDEN | TEXT | NO_CONTENT));
        if raw.is_dir {
            if !raw.descend {
                // 变为隐藏等不进入的目录：清除此前收录的子项
                entry.flags |= NO_DESCEND;
                idx.table.clear_children(id, &mut idx.content);
            } else if ctx.from_scan {
                self.pending_dirs.insert(path, id);
            } else if e.is(NO_DESCEND) {
                // 由不进入变为可进入（如取消隐藏）：补扫其内容
                idx.table.entries[id as usize].flags &= !NO_DESCEND;
                self.queue_scan(path);
            }
            return;
        }
        if !text {
            if entry.has_doc() {
                let doc = entry.doc;
                idx.content.remove(doc);
            }
            idx.table.entries[id as usize].doc = NONE;
            return;
        }
        if changed || entry.doc == NONE {
            self.jobs.push(ctx.rank, id);
        }
    }

    /// 处理一条文件变化
    fn apply_fs_path(&mut self, idx: &mut Index, path: &Path) {
        let Some((root_id, rest)) = idx.table.locate_root(path) else { return };
        let Some((name, parents)) = rest.split_last() else { return };
        let name = name.to_string();
        let parents: Vec<String> = parents.iter().map(|s| s.to_string()).collect();
        let root_path = PathBuf::from(idx.table.name(root_id));
        if self.rules.path_excluded(path, &root_path) {
            return;
        }
        // 逐级定位父目录；上级目录尚未收录时改为重扫已知的最深目录
        let mut cur = root_id;
        let mut cur_path = root_path;
        for part in &parents {
            let e = idx.table.entries[cur as usize];
            if e.is(NO_DESCEND) || e.is(LINK) {
                return;
            }
            match idx.table.child_by_name(cur, part) {
                Some(c) if idx.table.entries[c as usize].is(DIR) && idx.table.name(c) == part.as_str() => {
                    cur = c;
                    cur_path.push(part);
                }
                _ => {
                    self.queue_scan(cur_path);
                    return;
                }
            }
        }
        let parent = idx.table.entries[cur as usize];
        if parent.is(NO_DESCEND) || parent.is(LINK) {
            return;
        }
        let existing = idx.table.child_by_name(cur, &name);
        let meta = match std::fs::symlink_metadata(path) {
            Ok(m) => m,
            Err(_) => {
                if let Some(id) = existing {
                    idx.table.remove_subtree(id, &mut idx.content);
                }
                return;
            }
        };
        let mut raw = scan::raw_entry(name.clone(), &meta);
        if raw.is_dir {
            if self.rules.skip_dir(path, &name) {
                if let Some(id) = existing {
                    idx.table.remove_subtree(id, &mut idx.content);
                }
                return;
            }
            if self.rules.is_package(&name) {
                raw.descend = false;
            }
        }
        let content_ok = !parent.is(NO_CONTENT) && self.rules.content_allowed(&cur_path);
        let ctx = Ctx { rank: 0, from_scan: false };
        match existing {
            Some(id) if idx.table.name(id) == name => self.update_entry(idx, id, raw, path.to_path_buf(), content_ok, ctx),
            Some(id) => {
                // 仅大小写变化的改名：按新名字重建
                idx.table.remove_subtree(id, &mut idx.content);
                self.insert_entry(idx, cur, raw, path.to_path_buf(), content_ok, ctx);
            }
            None => {
                self.insert_entry(idx, cur, raw, path.to_path_buf(), content_ok, ctx);
            }
        }
    }

    fn flush_fs(&mut self) {
        let paths: Vec<PathBuf> = self.fs_pending.drain().collect();
        self.fs_first = None;
        if paths.len() > FS_MAX_PATHS {
            // 大批量变化（解压、检出等）直接重扫涉及的位置，比逐条处理更快
            let roots: Vec<PathBuf> = self.roots.iter().filter(|r| paths.iter().any(|p| p.starts_with(r))).cloned().collect();
            for root in roots {
                self.queue_scan(root);
            }
            return;
        }
        let shared = self.shared.clone();
        let mut guard = shared.index.write().unwrap_or_else(|e| e.into_inner());
        for path in &paths {
            self.apply_fs_path(&mut guard, path);
        }
        drop(guard);
        self.mark_changed();
    }

    // ── 维护 ──

    fn maintain(&mut self) {
        if !self.enabled {
            return;
        }
        let now = Instant::now();
        if !self.fs_pending.is_empty()
            && (now.duration_since(self.fs_last) >= FS_QUIET || self.fs_first.is_some_and(|t| now.duration_since(t) >= FS_MAX_WAIT))
        {
            self.flush_fs();
        }
        // 监听不可用的位置定期重扫
        let due: Vec<PathBuf> = self
            .poll_roots
            .iter_mut()
            .filter(|(_, at)| at.elapsed() >= POLL_INTERVAL)
            .map(|(root, at)| {
                *at = Instant::now();
                root.clone()
            })
            .collect();
        for root in due {
            self.queue_scan(root);
        }
        if self.scan.is_none() && !self.scan_queue.is_empty() {
            self.start_scan();
        }
        self.merge_segments();
        self.maybe_save();
        if self.changed && self.last_emit.elapsed() >= EMIT_INTERVAL {
            self.changed = false;
            self.last_emit = Instant::now();
            (self.emit)();
        }
    }

    fn start_scan(&mut self) {
        let mut dirs = std::mem::take(&mut self.scan_queue);
        dirs.sort();
        dirs.dedup();
        // 已被其他起点包含的目录无需重复扫描
        let all = dirs.clone();
        dirs.retain(|d| !all.iter().any(|o| o != d && d.starts_with(o)));
        let mut starts = Vec::new();
        {
            let idx = self.shared.index.read().unwrap_or_else(|e| e.into_inner());
            for dir in dirs {
                if let Some(id) = idx.table.find_path(&dir) {
                    let e = idx.table.entries[id as usize];
                    if e.alive() && e.is(DIR) && !e.is(LINK) {
                        self.pending_dirs.insert(dir.clone(), id);
                        starts.push(dir);
                    }
                }
            }
        }
        if starts.is_empty() {
            return;
        }
        self.scan_seq += 1;
        let id = self.scan_seq;
        let cancel = Arc::new(AtomicBool::new(false));
        self.scan = Some(ActiveScan { id, cancel: cancel.clone() });
        let (tx, rules) = (self.tx.clone(), self.rules.clone());
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(2, 4);
        let _ = std::thread::Builder::new().name("nb-local-search-scan".into()).spawn(move || {
            let sink = |listing: Listing| {
                let _ = tx.send(Msg::Listing(id, listing));
            };
            scan::walk(starts, &rules, threads, &cancel, &sink);
            let _ = tx.send(Msg::ScanDone(id));
        });
    }

    /// 后台合并相邻段：持读锁计算（不阻塞查询），再短暂持写锁替换
    fn merge_segments(&mut self) {
        let shared = self.shared.clone();
        let (at, merged) = {
            let idx = shared.index.read().unwrap_or_else(|e| e.into_inner());
            let Some(at) = idx.content.merge_candidate() else { return };
            (at, idx.content.merged(at))
        };
        shared.index.write().unwrap_or_else(|e| e.into_inner()).content.replace_merged(at, merged);
        self.dirty = true;
    }

    fn is_idle(&self) -> bool {
        self.scan.is_none() && self.scan_queue.is_empty() && self.fs_pending.is_empty() && self.jobs.is_idle()
    }

    fn maybe_save(&mut self) {
        if self.snapshot.is_none() || !self.dirty {
            return;
        }
        let idle = self.is_idle();
        let elapsed = self.last_save.elapsed();
        let due = if self.saved_once { (idle && elapsed >= SAVE_INTERVAL) || elapsed >= SAVE_INTERVAL * 3 } else { idle };
        if due {
            self.save_now();
        }
    }

    /// 冻结活动段、空闲时压缩，然后写入快照
    fn save_now(&mut self) {
        let Some(path) = self.snapshot.clone() else { return };
        let idle = self.is_idle();
        let shared = self.shared.clone();
        {
            let mut guard = shared.index.write().unwrap_or_else(|e| e.into_inner());
            let idx = &mut *guard;
            idx.content.freeze();
            // 空闲时（没有排队任务引用条目编号）压缩已删除条目
            if idle && idx.table.dead > 20_000 && idx.table.dead * 4 > idx.table.entries.len() {
                let compacted = idx.table.compact(&mut idx.content);
                idx.table = compacted;
            }
        }
        let bytes = {
            let idx = shared.index.read().unwrap_or_else(|e| e.into_inner());
            persist::encode(&idx.table, &idx.content)
        };
        if let Err(e) = persist::save(&path, &bytes) {
            log::warn!("保存本地搜索索引失败: {}", e);
        }
        self.dirty = false;
        self.saved_once = true;
        self.last_save = Instant::now();
    }
}
