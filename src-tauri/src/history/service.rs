// NoteBoard 文档历史记录：记录服务
//
// 进程内唯一。写盘钩子只做极轻的判断后把任务投递给后台线程「nb-history」，
// 压缩、哈希、索引更新都在后台串行执行，保存不会因历史记录变慢。
// 存储读写统一持有 state 锁：后台线程、IPC 命令与同步线程的历史阶段互斥，索引不会被并发改坏。
//
// 记录规则：
//   - 写盘前（prepare_write）：磁盘内容与上次记录不一致时先补记一版（首次记录 / 外部修改）
//   - 写盘后（on_written）：同一设备在合并窗口内的连续保存只更新最后一条，超出窗口另起一条
//   - 同步覆盖本机前补记本机内容，覆盖后记录来自其他设备的内容
//   - 内容与最后一版相同时不记录
//
// 存储空间：
//   - 仅本机模式，以及跨设备同步模式下同步目录之外的文档：<应用数据目录>/history/local（按路径映射文档标识）
//   - 跨设备同步模式下同步目录内的文档：<同步目录>/.nb-history/<本机设备ID>（按同步文件 ID）

use super::catalog::{self, Catalog};
use super::config::{self, HistoryConfig, Mode, RetireItem};
use super::identity::{path_key, Identity};
use super::model::{new_entry_id, DocIndex, Entry, Origin, Reason};
use super::retention;
use super::space::{self, is_temp_id, SyncCtx};
use super::stats;
use super::store::Store;
use crate::sync::runtime::EventSink;
use crate::sync::util::{pkey, sha256_hex};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, RwLock};
use std::time::Duration;

pub const EVENT_CHANGED: &str = "nb://history-changed";
/// 单文件超过此大小不记录
pub const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
/// 已删除文档的历史保留时长
pub const TRASH_KEEP_MS: i64 = 30 * retention::DAY_MS;
/// 定期维护（保留策略 + 垃圾回收）间隔
const MAINTAIN_INTERVAL: Duration = Duration::from_secs(6 * 3600);
/// 启动后延迟执行首次维护，避开启动高峰
const MAINTAIN_STARTUP_DELAY: Duration = Duration::from_secs(45);
/// 累计记录次数达到后触发一次维护
const MAINTAIN_EVERY_RECORDS: u32 = 200;

pub enum Job {
    /// 写盘前的磁盘内容（与上次记录不一致时）
    Baseline { path: PathBuf, bytes: Vec<u8>, meta: (u64, i64) },
    /// 同步覆盖前的本机内容
    BeforeSync { path: PathBuf, bytes: Vec<u8> },
    /// 写盘完成，由后台读取磁盘内容记录
    Written { path: PathBuf },
    /// 同步写入了其他设备的内容
    Pulled { path: PathBuf, origin: Origin, reason: Reason },
    Renamed { from: PathBuf, to: PathBuf },
    Deleted { path: PathBuf },
    Maintain,
    /// 测试与命令等待此前任务全部完成
    Barrier(Sender<()>),
}

/// 存储锁保护的状态：两个空间的文档标识映射（按需加载）
#[derive(Default)]
pub struct State {
    local: Option<Identity>,
    /// 同步空间的临时标识映射（映射文件路径, 映射）
    sync: Option<(PathBuf, Identity)>,
}

/// 文档在存储中的位置
#[derive(Clone, Debug)]
pub struct Located {
    /// 本机可写的命名空间
    pub store: Store,
    pub doc_id: String,
    /// 位于跨设备同步空间时的上下文
    pub ctx: Option<SyncCtx>,
}

/// 迁移日志：文件存在表示有未完成的模式切换，启动时继续执行
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct MigrationJournal {
    to: Mode,
}

pub struct Service {
    pub base: PathBuf,
    cfg: RwLock<HistoryConfig>,
    state: Mutex<State>,
    tx: Mutex<Option<Sender<Job>>>,
    /// 路径键 → 最近一次记录时的磁盘（大小, 修改时间）
    known: Mutex<HashMap<String, (u64, i64)>>,
    /// 已投递但尚未处理的写盘任务数
    inflight: Mutex<HashMap<String, u32>>,
    /// 下一次写盘使用的一次性原因（还原）
    one_shot: Mutex<HashMap<String, (Reason, Option<String>)>>,
    sink: Option<Arc<dyn EventSink>>,
    origin: Box<dyn Fn() -> Origin + Send + Sync>,
    /// 测试注入的同步空间（正式运行时取同步配置）
    ctx_override: Mutex<Option<Option<SyncCtx>>>,
}

static SERVICE: OnceLock<Arc<Service>> = OnceLock::new();

pub fn service() -> Option<&'static Arc<Service>> {
    SERVICE.get()
}

/// 当前设备（与同步共用设备标识和名称）
fn device_origin() -> Origin {
    let cfg = crate::sync::scheduler::current_config();
    Origin { device: cfg.device_id, name: cfg.sync.device_name }
}

/// 启动记录服务（进程唯一；须在应用数据目录初始化之后调用）
pub fn init(sink: impl EventSink) {
    let base = crate::app_dirs::app_data_dir().join("history");
    let svc = Arc::new(Service::new(base, Some(Arc::new(sink)), Box::new(device_origin)));
    if SERVICE.set(svc.clone()).is_err() {
        return;
    }
    svc.resume_migration();
    svc.spawn_worker();
}

/// 同步配置即将保存：跨设备同步模式下，同步目录或远端变化（或关闭同步）时先迁回本机
pub fn before_sync_config_saved(old: &crate::sync::config::SyncConfigFile, new: &crate::sync::config::SyncConfigFile) {
    let Some(svc) = service() else { return };
    let root = old.sync.root_dir.trim();
    if !old.sync.enabled || root.is_empty() {
        return;
    }
    let old_ctx = SyncCtx {
        root: PathBuf::from(root),
        me: old.device_id.clone(),
        remote: old.sync.provider.identity(),
        device_name: old.sync.device_name.clone(),
    };
    let still_valid = new.sync.enabled
        && pkey(new.sync.root_dir.trim()) == pkey(root)
        && new.sync.provider.identity() == old_ctx.remote;
    svc.on_sync_target_changing(&old_ctx, still_valid);
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn file_meta(path: &Path) -> Option<(u64, i64)> {
    let m = std::fs::metadata(path).ok()?;
    m.is_file().then(|| (m.len(), crate::sync::util::mtime_ms(&m)))
}

/// 参与历史记录的文档类型；只读查看格式、图片与导入型的 XMind 不记录
pub fn kind_of(path: &Path) -> Option<&'static str> {
    use crate::dto::DocumentKind as K;
    let s = path.to_string_lossy();
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if ext == "xmind" {
        return None;
    }
    match crate::dto::kind_from_path(&s).0 {
        K::Markdown => Some("markdown"),
        K::Code => Some("code"),
        K::Board => Some("board"),
        K::Mindmap => Some("mindmap"),
        K::Drawio => Some("drawio"),
        K::Bitable => Some("bitable"),
        _ => None,
    }
}

/// 是否应记录此路径：可编辑类型，且不在回收站、历史目录、应用数据目录（暂存区等）中
pub fn eligible(path: &Path) -> bool {
    if kind_of(path).is_none() {
        return false;
    }
    let key = path_key(path);
    let lower = key.to_lowercase();
    for seg in ["/.nb-trash/", "/.nb-history/", "/.nb-sync-tmp/"] {
        if lower.contains(seg) {
            return false;
        }
    }
    let data = path_key(&crate::app_dirs::app_data_dir());
    !(key == data || key.starts_with(&format!("{}/", data)))
}

/// 列表接口返回的条目
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EntryView {
    #[serde(flatten)]
    pub entry: Entry,
    /// 是否由本机产生
    pub is_own: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ListResult {
    pub doc_id: Option<String>,
    pub kind: String,
    pub device_id: String,
    /// 新到旧
    pub entries: Vec<EntryView>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReadResult {
    pub content: String,
    pub encoding: crate::dto::Encoding,
    pub size: u64,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub bytes: u64,
    pub docs: u64,
    pub entries: u64,
}

/// 设置页使用的配置视图
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConfigView {
    pub mode: Mode,
    pub retention_days: u32,
    pub merge_window_min: u32,
    pub max_total_mb: u32,
    /// 当前生效的容量上限（MB）
    pub effective_max_mb: u64,
    /// 已开启多端同步且设置了同步目录（可选择跨设备同步）
    pub sync_available: bool,
    /// 同步服务为 Git 类仓库（历史文件会永久保留在仓库记录中）
    pub git_backend: bool,
}

/// 由历史配置与当前同步配置生成设置页视图
pub fn view(cfg: &HistoryConfig) -> ConfigView {
    let sync = crate::sync::scheduler::current_config();
    use crate::sync::config::ProviderKind as P;
    let git_backend = matches!(sync.sync.provider.kind, P::Github | P::Gitee | P::Gitcode | P::Gitlab);
    ConfigView {
        mode: cfg.mode,
        retention_days: cfg.retention_days,
        merge_window_min: cfg.merge_window_min,
        max_total_mb: cfg.max_total_mb,
        effective_max_mb: cfg.max_total_bytes(git_backend) / 1024 / 1024,
        sync_available: sync.sync.enabled && !sync.sync.root_dir.trim().is_empty(),
        git_backend,
    }
}

/// 按时间排序并去掉相邻的相同内容（保留最早的一条：真正产生该内容的设备）
fn merge_timeline(mut all: Vec<(Entry, Store)>) -> Vec<(Entry, Store)> {
    all.sort_by(|a, b| a.0.at.cmp(&b.0.at).then(a.0.id.cmp(&b.0.id)));
    let mut out: Vec<(Entry, Store)> = Vec::with_capacity(all.len());
    for item in all {
        if out.last().is_some_and(|l| l.0.hash == item.0.hash || l.0.id == item.0.id) {
            continue;
        }
        out.push(item);
    }
    out
}

impl Service {
    pub fn new(base: PathBuf, sink: Option<Arc<dyn EventSink>>, origin: Box<dyn Fn() -> Origin + Send + Sync>) -> Self {
        let cfg = config::load(&base);
        Self {
            base,
            cfg: RwLock::new(cfg),
            state: Mutex::new(State::default()),
            tx: Mutex::new(None),
            known: Mutex::new(HashMap::new()),
            inflight: Mutex::new(HashMap::new()),
            one_shot: Mutex::new(HashMap::new()),
            sink,
            origin,
            ctx_override: Mutex::new(None),
        }
    }

    pub fn config(&self) -> HistoryConfig {
        self.cfg.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn store_config(&self, cfg: HistoryConfig) -> Result<(), String> {
        config::save(&self.base, &cfg)?;
        *self.cfg.write().unwrap_or_else(|p| p.into_inner()) = cfg;
        Ok(())
    }

    pub fn enabled(&self) -> bool {
        self.config().mode != Mode::Off
    }

    /// 仅测试：固定同步空间（None 表示未开启同步）
    #[cfg(test)]
    pub fn set_ctx_for_test(&self, ctx: Option<SyncCtx>) {
        *lock(&self.ctx_override) = Some(ctx);
    }

    /// 当前同步空间（未开启多端同步时为 None）
    pub fn sync_ctx(&self) -> Option<SyncCtx> {
        if let Some(v) = lock(&self.ctx_override).clone() {
            return v;
        }
        space::current_ctx()
    }

    /// 本机命名空间
    pub fn local_store(&self) -> Store {
        Store::new(self.base.join("local"))
    }

    fn local_identity_path(&self) -> PathBuf {
        self.base.join("local").join("identity.json")
    }

    fn local_idt<'a>(&self, st: &'a mut State) -> &'a mut Identity {
        if st.local.is_none() {
            st.local = Some(Identity::load(&self.local_identity_path()));
        }
        st.local.as_mut().expect("identity loaded")
    }

    fn save_local_idt(&self, st: &State) {
        if let Some(idt) = &st.local {
            if let Err(e) = idt.save(&self.local_identity_path()) {
                log::warn!("[history] 保存文档身份映射失败: {}", e);
            }
        }
    }

    fn sync_idt<'a>(&self, st: &'a mut State, ctx: &SyncCtx) -> &'a mut Identity {
        let path = ctx.identity_path();
        if st.sync.as_ref().map(|(p, _)| p != &path).unwrap_or(true) {
            st.sync = Some((path.clone(), Identity::load(&path)));
        }
        &mut st.sync.as_mut().expect("identity loaded").1
    }

    fn save_sync_idt(&self, st: &State) {
        if let Some((path, idt)) = &st.sync {
            if let Err(e) = idt.save(path) {
                log::warn!("[history] 保存同步临时标识失败: {}", e);
            }
        }
    }

    fn emit_changed(&self, path: &Path) {
        if let Some(sink) = &self.sink {
            sink.emit_json(EVENT_CHANGED, serde_json::json!({ "path": path.to_string_lossy() }));
        }
    }

    fn send(&self, job: Job) {
        if let Some(tx) = lock(&self.tx).as_ref() {
            let _ = tx.send(job);
        }
    }

    // ── 钩子入口（调用方线程，必须轻量） ──

    /// 写盘前：磁盘内容与上次记录不一致时读出旧内容投递给后台补记
    pub fn prepare_write(&self, path: &Path) {
        if !self.enabled() || !eligible(path) {
            return;
        }
        let key = path_key(path);
        if lock(&self.inflight).get(&key).copied().unwrap_or(0) > 0 {
            return;
        }
        let Some(meta) = file_meta(path) else { return };
        if meta.0 > MAX_FILE_BYTES || lock(&self.known).get(&key) == Some(&meta) {
            return;
        }
        let Ok(bytes) = std::fs::read(path) else { return };
        self.send(Job::Baseline { path: path.to_path_buf(), bytes, meta });
    }

    /// 写盘后：投递记录任务
    pub fn on_written(&self, path: &Path) {
        if !self.enabled() || !eligible(path) {
            return;
        }
        *lock(&self.inflight).entry(path_key(path)).or_insert(0) += 1;
        self.send(Job::Written { path: path.to_path_buf() });
    }

    pub fn on_renamed(&self, from: &Path, to: &Path) {
        if self.enabled() {
            self.send(Job::Renamed { from: from.to_path_buf(), to: to.to_path_buf() });
        }
    }

    pub fn on_deleted(&self, path: &Path) {
        if self.enabled() {
            self.send(Job::Deleted { path: path.to_path_buf() });
        }
    }

    /// 同步即将覆盖本机文件：本机内容尚未记录时补记（同步线程调用，同步读取后投递）
    pub fn before_overwrite(&self, path: &Path) {
        if !self.enabled() || !eligible(path) {
            return;
        }
        let Some(meta) = file_meta(path) else { return };
        if meta.0 > MAX_FILE_BYTES || lock(&self.known).get(&path_key(path)) == Some(&meta) {
            return;
        }
        let Ok(bytes) = std::fs::read(path) else { return };
        self.send(Job::BeforeSync { path: path.to_path_buf(), bytes });
    }

    /// 同步写入了其他设备的内容
    pub fn after_pulled(&self, path: &Path, origin: Origin, merged: bool) {
        if !self.enabled() || !eligible(path) {
            return;
        }
        let reason = if merged { Reason::SyncMerge } else { Reason::SyncPull };
        self.send(Job::Pulled { path: path.to_path_buf(), origin, reason });
    }

    // ── 后台线程 ──

    pub fn spawn_worker(self: &Arc<Self>) {
        let (tx, rx) = mpsc::channel();
        *lock(&self.tx) = Some(tx);
        let svc = self.clone();
        std::thread::Builder::new().name("nb-history".into()).spawn(move || svc.run_loop(rx)).ok();
    }

    fn run_loop(&self, rx: Receiver<Job>) {
        let mut next_maintain = std::time::Instant::now() + MAINTAIN_STARTUP_DELAY;
        let mut records = 0u32;
        loop {
            let wait = next_maintain.saturating_duration_since(std::time::Instant::now());
            let first = match rx.recv_timeout(wait) {
                Ok(job) => job,
                Err(RecvTimeoutError::Timeout) => Job::Maintain,
                Err(RecvTimeoutError::Disconnected) => return,
            };
            // 取出当前积压的全部任务：同一路径的连续写盘只需按最终内容记录一次
            let mut batch = vec![first];
            while let Ok(job) = rx.try_recv() {
                batch.push(job);
            }
            let n = batch.len();
            let mut skip = vec![false; n];
            for i in 0..n {
                let Job::Written { path } = &batch[i] else { continue };
                let key = path_key(path);
                for later in &batch[i + 1..] {
                    match later {
                        Job::Written { path: p } if path_key(p) == key => {
                            skip[i] = true;
                            break;
                        }
                        Job::Written { .. } | Job::Maintain | Job::Barrier(_) => {}
                        _ => break,
                    }
                }
            }
            for (job, skipped) in batch.into_iter().zip(skip) {
                match job {
                    Job::Written { path } => {
                        if !skipped && self.handle_written(&path) {
                            records += 1;
                        }
                        let key = path_key(&path);
                        let mut inflight = lock(&self.inflight);
                        if let Some(c) = inflight.get_mut(&key) {
                            *c = c.saturating_sub(1);
                            if *c == 0 {
                                inflight.remove(&key);
                            }
                        }
                    }
                    Job::Baseline { path, bytes, meta } => self.handle_baseline(&path, &bytes, meta),
                    Job::BeforeSync { path, bytes } => {
                        self.record(&path, &bytes, Reason::BeforeSync, None, None, crate::sync::util::now_ms());
                    }
                    Job::Pulled { path, origin, reason } => {
                        if let (Some(meta), Ok(bytes)) = (file_meta(&path), std::fs::read(&path)) {
                            if meta.0 <= MAX_FILE_BYTES {
                                self.record(&path, &bytes, reason, None, Some(origin), crate::sync::util::now_ms());
                                lock(&self.known).insert(path_key(&path), meta);
                            }
                        }
                    }
                    Job::Renamed { from, to } => self.handle_renamed(&from, &to),
                    Job::Deleted { path } => self.handle_deleted(&path),
                    Job::Maintain => {
                        self.maintain(crate::sync::util::now_ms());
                        records = 0;
                        next_maintain = std::time::Instant::now() + MAINTAIN_INTERVAL;
                    }
                    Job::Barrier(reply) => {
                        let _ = reply.send(());
                    }
                }
            }
            if records >= MAINTAIN_EVERY_RECORDS {
                self.maintain(crate::sync::util::now_ms());
                records = 0;
            }
        }
    }

    /// 等待此前投递的任务全部处理完（测试与需要读后写一致的命令使用）
    pub fn flush(&self) {
        // 后台线程未启动时没有积压任务，不能空等
        if lock(&self.tx).is_none() {
            return;
        }
        let (tx, rx) = mpsc::channel();
        self.send(Job::Barrier(tx));
        let _ = rx.recv_timeout(Duration::from_secs(10));
    }

    fn handle_written(&self, path: &Path) -> bool {
        let Some(meta) = file_meta(path) else { return false };
        if meta.0 > MAX_FILE_BYTES {
            return false;
        }
        let Ok(bytes) = std::fs::read(path) else { return false };
        let key = path_key(path);
        let (reason, restored_from) = lock(&self.one_shot).remove(&key).unwrap_or((Reason::Save, None));
        let changed = self.record(path, &bytes, reason, restored_from, None, crate::sync::util::now_ms());
        // 读取期间文件未再变化时才登记元数据，否则下次写盘前重新核对
        if file_meta(path) == Some(meta) {
            lock(&self.known).insert(key, meta);
        }
        changed
    }

    fn handle_baseline(&self, path: &Path, bytes: &[u8], meta: (u64, i64)) {
        let now = crate::sync::util::now_ms();
        let reason = {
            let mut st = lock(&self.state);
            let cfg = self.config();
            let has = self
                .locate(&mut st, &cfg, path, None)
                .and_then(|loc| loc.store.read_index(&loc.doc_id))
                .map(|i| !i.entries.is_empty())
                .unwrap_or(false);
            if has { Reason::External } else { Reason::Initial }
        };
        self.record(path, bytes, reason, None, None, now);
        lock(&self.known).insert(path_key(path), meta);
    }

    fn handle_renamed(&self, from: &Path, to: &Path) {
        let (fk, tk) = (path_key(from), path_key(to));
        let mut st = lock(&self.state);
        if !self.local_idt(&mut st).rename(&fk, &tk).is_empty() {
            self.save_local_idt(&st);
        }
        // 同步空间内尚未同步的文件：临时标识按相对路径跟随
        if let Some(ctx) = self.sync_ctx() {
            if let (Some(a), Some(b)) = (ctx.rel(from), ctx.rel(to)) {
                if !self.sync_idt(&mut st, &ctx).rename(&pkey(&a), &pkey(&b)).is_empty() {
                    self.save_sync_idt(&st);
                }
            }
        }
        drop(st);
        let mut known = lock(&self.known);
        let keys: Vec<String> = known.keys().filter(|k| *k == &fk || k.starts_with(&format!("{}/", fk))).cloned().collect();
        for k in keys {
            if let Some(v) = known.remove(&k) {
                known.insert(format!("{}{}", tk, &k[fk.len()..]), v);
            }
        }
    }

    fn handle_deleted(&self, path: &Path) {
        let key = path_key(path);
        let now = crate::sync::util::now_ms();
        let mut st = lock(&self.state);
        if !self.local_idt(&mut st).trash(&key, now).is_empty() {
            self.save_local_idt(&st);
        }
        if let Some(ctx) = self.sync_ctx() {
            if let Some(rel) = ctx.rel(path) {
                if !self.sync_idt(&mut st, &ctx).trash(&pkey(&rel), now).is_empty() {
                    self.save_sync_idt(&st);
                }
            }
        }
        lock(&self.known).retain(|k, _| !(k == &key || k.starts_with(&format!("{}/", key))));
    }

    // ── 定位文档 ──

    /// 路径所在的同步空间（跨设备同步模式且位于同步目录内）
    fn sync_space(&self, cfg: &HistoryConfig, path: &Path) -> Option<(SyncCtx, String)> {
        if cfg.mode != Mode::Sync {
            return None;
        }
        let ctx = self.sync_ctx()?;
        let rel = ctx.rel(path)?;
        Some((ctx, rel))
    }

    /// 定位文档；create 为 Some(内容哈希) 时找不到就新建（本机空间会尝试关联同路径内容一致的已删除历史）
    fn locate(&self, st: &mut State, cfg: &HistoryConfig, path: &Path, create: Option<&str>) -> Option<Located> {
        if let Some((ctx, rel)) = self.sync_space(cfg, path) {
            let store = ctx.own();
            let key = pkey(&rel);
            let fid = space::file_id_of(&ctx, &rel);
            let temp = self.sync_idt(st, &ctx).lookup(&key);
            let doc_id = match (fid, temp) {
                (Some(fid), Some(tmp)) => {
                    // 同步已分配正式 ID：临时历史并入正式 ID
                    if let Err(e) = Self::merge_doc(&store, &tmp, &fid) {
                        log::warn!("[history] 合并临时历史失败: {}", e);
                    }
                    self.sync_idt(st, &ctx).forget(&tmp);
                    self.save_sync_idt(st);
                    fid
                }
                (Some(fid), None) => fid,
                (None, Some(tmp)) => tmp,
                (None, None) => {
                    create?;
                    let id = format!("{}{}", space::TEMP_PREFIX, uuid::Uuid::new_v4().simple());
                    self.sync_idt(st, &ctx).bind(&key, &id);
                    self.save_sync_idt(st);
                    id
                }
            };
            return Some(Located { store, doc_id, ctx: Some(ctx) });
        }
        let store = self.local_store();
        let key = path_key(path);
        let idt = self.local_idt(st);
        if let Some(id) = idt.lookup(&key) {
            return Some(Located { store, doc_id: id, ctx: None });
        }
        let hash = create?;
        let reclaimed = idt
            .trashed_at(&key)
            .into_iter()
            .find(|id| store.read_index(id).and_then(|i| i.last().map(|e| e.hash == hash)).unwrap_or(false));
        let id = match reclaimed {
            Some(id) => {
                idt.bind(&key, &id);
                id
            }
            None => idt.assign(&key),
        };
        self.save_local_idt(st);
        Some(Located { store, doc_id: id, ctx: None })
    }

    /// 把 from 文档的历史并入 to（临时标识换成正式 ID、迁移时同一文档的合并）
    fn merge_doc(store: &Store, from: &str, to: &str) -> std::io::Result<()> {
        if from == to {
            return Ok(());
        }
        let Some(mut a) = store.read_index(from) else { return Ok(()) };
        Self::seal_last(store, &mut a)?;
        let mut b = match store.read_index(to) {
            Some(mut b) => {
                Self::seal_last(store, &mut b)?;
                b
            }
            None => DocIndex::new(to, &a.kind, &a.path),
        };
        b.entries.extend(a.entries);
        b.entries.sort_by(|x, y| x.at.cmp(&y.at).then(x.id.cmp(&y.id)));
        b.entries.dedup_by(|x, y| x.id == y.id);
        b.doc_id = to.to_string();
        if b.path.is_empty() {
            b.path = a.path;
        }
        store.write_index(&b)?;
        store.delete_index(from);
        Ok(())
    }

    // ── 记录核心 ──

    /// 记录一个版本；内容与最后一版相同时返回 false
    pub fn record(&self, path: &Path, bytes: &[u8], reason: Reason, restored_from: Option<String>, origin: Option<Origin>, now: i64) -> bool {
        let Some(kind) = kind_of(path) else { return false };
        let hash = sha256_hex(bytes);
        // 先取锁再读配置：模式切换（迁移）期间的记录等迁移完成后写入新空间
        let mut st = lock(&self.state);
        let cfg = self.config();
        if cfg.mode == Mode::Off {
            return false;
        }
        let Some(loc) = self.locate(&mut st, &cfg, path, Some(&hash)) else { return false };
        let (store, doc_id) = (loc.store, loc.doc_id);
        let mut idx = store.read_index(&doc_id).unwrap_or_else(|| DocIndex::new(&doc_id, kind, ""));
        idx.path = path.to_string_lossy().to_string();
        idx.kind = kind.to_string();
        if idx.last().map(|e| e.hash == hash).unwrap_or(false) {
            return false;
        }
        let me = origin.unwrap_or_else(|| (self.origin)());
        let window = cfg.merge_window_min as i64 * 60_000;
        let mergeable = idx.last().is_some_and(|e| {
            e.open && reason == Reason::Save && e.reason == Reason::Save && e.origin.device == me.device && now - e.start < window
        });
        let result: std::io::Result<()> = (|| {
            if mergeable {
                // 合并窗口内：与窗口开始前的版本比较统计，覆盖 pending 正文
                let n = idx.entries.len();
                let prev = if n >= 2 { store.read_entry(&doc_id, &idx.entries[n - 2]).ok() } else { None };
                store.put_pending(&doc_id, bytes)?;
                let last = idx.entries.last_mut().expect("mergeable has last");
                last.hash = hash.clone();
                last.size = bytes.len() as u64;
                last.at = now;
                last.stats = stats::compute(kind, prev.as_deref(), bytes);
            } else {
                Self::seal_last(&store, &mut idx)?;
                let prev = idx.last().and_then(|e| store.read_entry(&doc_id, e).ok());
                let open = reason == Reason::Save;
                if open {
                    store.put_pending(&doc_id, bytes)?;
                } else {
                    store.put_blob(&hash, bytes)?;
                }
                // 同毫秒多次记录时保证时间不倒退
                let mut at = now;
                if let Some(last) = idx.last() {
                    at = at.max(last.at);
                }
                idx.entries.push(Entry {
                    id: new_entry_id(at),
                    start: at,
                    at,
                    hash: hash.clone(),
                    size: bytes.len() as u64,
                    reason,
                    origin: me.clone(),
                    stats: stats::compute(kind, prev.as_deref(), bytes),
                    restored_from,
                    pinned: false,
                    open,
                });
            }
            store.write_index(&idx)
        })();
        drop(st);
        match result {
            Ok(()) => {
                self.emit_changed(path);
                true
            }
            Err(e) => {
                log::warn!("[history] 记录版本失败 {}: {}", path.display(), e);
                false
            }
        }
    }

    /// 封口最后一条（合并窗口结束）
    fn seal_last(store: &Store, idx: &mut DocIndex) -> std::io::Result<()> {
        let doc_id = idx.doc_id.clone();
        if let Some(last) = idx.entries.last_mut() {
            if last.open {
                store.seal_pending(&doc_id, &last.hash)?;
                last.open = false;
            }
        }
        Ok(())
    }

    /// 封口指定文档（关闭文档、还原前）
    pub fn seal_path(&self, path: &Path) {
        let mut st = lock(&self.state);
        let cfg = self.config();
        let Some(loc) = self.locate(&mut st, &cfg, path, None) else { return };
        let Some(mut idx) = loc.store.read_index(&loc.doc_id) else { return };
        if idx.last().is_some_and(|e| e.open) && Self::seal_last(&loc.store, &mut idx).is_ok() {
            let _ = loc.store.write_index(&idx);
        }
    }

    // ── 查询与管理（IPC 命令） ──

    /// 文档的完整时间线（本机 + 其他设备），时间升序
    fn timeline(&self, path: &Path) -> Option<(Located, Vec<(Entry, Store)>)> {
        let cfg = self.config();
        if cfg.mode == Mode::Off {
            return None;
        }
        let mut st = lock(&self.state);
        let loc = self.locate(&mut st, &cfg, path, None)?;
        drop(st);
        let mut all: Vec<(Entry, Store)> = Vec::new();
        if let Some(idx) = loc.store.read_index(&loc.doc_id) {
            all.extend(idx.entries.into_iter().map(|e| (e, loc.store.clone())));
        }
        if let Some(ctx) = &loc.ctx {
            if !is_temp_id(&loc.doc_id) {
                for (_, store) in ctx.others() {
                    if let Some(idx) = store.read_index(&loc.doc_id) {
                        all.extend(idx.entries.into_iter().filter(|e| !e.open).map(|e| (e, store.clone())));
                    }
                }
            }
        }
        Some((loc, merge_timeline(all)))
    }

    pub fn list(&self, path: &Path) -> ListResult {
        let me = (self.origin)();
        let mut out = ListResult { device_id: me.device.clone(), kind: kind_of(path).unwrap_or("code").into(), ..Default::default() };
        let Some((loc, timeline)) = self.timeline(path) else { return out };
        if !timeline.is_empty() {
            out.doc_id = Some(loc.doc_id.clone());
        }
        out.entries = timeline
            .into_iter()
            .rev()
            .map(|(e, _)| EntryView { is_own: e.origin.device == me.device, entry: e })
            .collect();
        out
    }

    pub fn read(&self, path: &Path, entry_id: &str) -> Result<ReadResult, String> {
        let (loc, timeline) = self.timeline(path).ok_or("没有找到这个文档的历史记录")?;
        let (entry, store) = timeline.into_iter().find(|(e, _)| e.id == entry_id).ok_or("版本不存在或已被清理")?;
        let bytes = store.read_entry(&loc.doc_id, &entry).map_err(|e| format!("读取历史版本失败：{}", e))?;
        let (content, encoding) = crate::fsio::read::decode_bytes(&bytes);
        Ok(ReadResult { content, encoding, size: bytes.len() as u64 })
    }

    /// 检查点：close 封口；before-restore 记录未保存内容；restore 标记下一次写盘为还原
    pub fn checkpoint(&self, path: &Path, reason: &str, content: Option<String>, restored_from: Option<String>) -> Result<(), String> {
        if !self.enabled() || !eligible(path) {
            return Ok(());
        }
        // 先处理已投递的写盘任务，保证检查点在它们之后
        self.flush();
        match reason {
            "close" => self.seal_path(path),
            "before-restore" => {
                self.seal_path(path);
                if let Some(text) = content {
                    self.record(path, text.as_bytes(), Reason::BeforeRestore, None, None, crate::sync::util::now_ms());
                }
            }
            "restore" => {
                lock(&self.one_shot).insert(path_key(path), (Reason::Restore, restored_from));
            }
            _ => return Err("未知的检查点类型".into()),
        }
        Ok(())
    }

    fn update_entry(&self, path: &Path, entry_id: &str, f: impl FnOnce(&Store, &mut DocIndex, usize) -> Result<(), String>) -> Result<(), String> {
        let mut st = lock(&self.state);
        let cfg = self.config();
        let loc = self.locate(&mut st, &cfg, path, None).ok_or("没有找到这个文档的历史记录")?;
        let mut idx = loc.store.read_index(&loc.doc_id).ok_or("只能修改本机产生的版本")?;
        let pos = idx.entries.iter().position(|e| e.id == entry_id).ok_or("只能修改本机产生的版本")?;
        f(&loc.store, &mut idx, pos)?;
        loc.store.write_index(&idx).map_err(|e| e.to_string())?;
        drop(st);
        self.emit_changed(path);
        Ok(())
    }

    pub fn pin(&self, path: &Path, entry_id: &str, pinned: bool) -> Result<(), String> {
        self.update_entry(path, entry_id, |_, idx, pos| {
            idx.entries[pos].pinned = pinned;
            Ok(())
        })
    }

    pub fn delete_entry(&self, path: &Path, entry_id: &str) -> Result<(), String> {
        let me = (self.origin)().device;
        self.update_entry(path, entry_id, |store, idx, pos| {
            if idx.entries[pos].origin.device != me {
                return Err("只能删除本机产生的版本".into());
            }
            let e = idx.entries.remove(pos);
            if e.open {
                let _ = std::fs::remove_file(store.pending_path(&idx.doc_id));
            }
            Ok(())
        })?;
        self.send(Job::Maintain);
        Ok(())
    }

    pub fn usage(&self) -> Usage {
        let _st = lock(&self.state);
        let mut stores = vec![self.local_store()];
        let mut bytes = 0;
        if self.config().mode == Mode::Sync {
            if let Some(ctx) = self.sync_ctx() {
                stores.push(ctx.own());
                bytes += ctx.others().iter().map(|(_, s)| s.usage()).sum::<u64>();
            }
        }
        let mut u = Usage { bytes, ..Default::default() };
        for store in stores {
            u.bytes += store.usage();
            for id in store.list_doc_ids() {
                if let Some(idx) = store.read_index(&id) {
                    u.docs += 1;
                    u.entries += idx.entries.len() as u64;
                }
            }
        }
        u
    }

    /// 删除本机产生的全部历史（跨设备同步模式下下次同步会删除远端本机目录；其他设备的版本不受影响）
    pub fn clear_all(&self) -> Result<(), String> {
        self.flush();
        let mut st = lock(&self.state);
        st.local = None;
        st.sync = None;
        let dir = self.base.join("local");
        if dir.exists() {
            std::fs::remove_dir_all(&dir).map_err(|e| format!("清理历史记录失败：{}", e))?;
        }
        if self.config().mode == Mode::Sync {
            if let Some(ctx) = self.sync_ctx() {
                let own = ctx.ns().join(&ctx.me);
                if own.exists() {
                    std::fs::remove_dir_all(&own).map_err(|e| format!("清理历史记录失败：{}", e))?;
                }
            }
        }
        lock(&self.known).clear();
        Ok(())
    }

    // ── 模式切换与迁移 ──

    fn journal_path(&self) -> PathBuf {
        self.base.join("migration.json")
    }

    /// 启动时继续未完成的模式切换
    fn resume_migration(&self) {
        let Some(journal) = std::fs::read(self.journal_path()).ok().and_then(|b| serde_json::from_slice::<MigrationJournal>(&b).ok()) else {
            return;
        };
        if let Err(e) = self.set_mode(journal.to) {
            log::warn!("[history] 继续切换历史记录模式失败: {}", e);
        }
    }

    /// 切换模式：迁移已有历史到新空间，或在关闭时删除；完成后才更新配置
    pub fn set_mode(&self, mode: Mode) -> Result<HistoryConfig, String> {
        let mut cfg = self.config();
        if cfg.mode == mode {
            let _ = std::fs::remove_file(self.journal_path());
            return Ok(cfg);
        }
        self.flush();
        let ctx = self.sync_ctx();
        if mode == Mode::Sync && ctx.is_none() {
            return Err("需先开启多端同步".into());
        }
        let journal = serde_json::to_vec(&MigrationJournal { to: mode }).map_err(|e| e.to_string())?;
        super::store::write_atomic(&self.journal_path(), &journal).map_err(|e| format!("写入迁移日志失败：{}", e))?;
        // 迁移期间持有存储锁：后台线程的新记录等迁移完成后按新模式写入
        let mut st = lock(&self.state);
        let from = cfg.mode;
        let result: Result<(), String> = (|| {
            match (from, mode) {
                (Mode::Local, Mode::Sync) => self.migrate_local_to_sync(&mut st, ctx.as_ref().expect("checked")),
                (Mode::Sync, Mode::Local) => {
                    if let Some(ctx) = &ctx {
                        self.migrate_sync_to_local(&mut st, ctx)?;
                        Self::add_retire(&mut cfg, ctx);
                    }
                    Ok(())
                }
                (Mode::Sync, Mode::Off) => {
                    if let Some(ctx) = &ctx {
                        let ns = ctx.ns();
                        if ns.exists() {
                            std::fs::remove_dir_all(&ns).map_err(|e| format!("清理同步目录中的历史失败：{}", e))?;
                        }
                        Self::add_retire(&mut cfg, ctx);
                    }
                    self.remove_local(&mut st)
                }
                (Mode::Local, Mode::Off) => self.remove_local(&mut st),
                _ => Ok(()),
            }
        })();
        result?;
        cfg.mode = mode;
        st.sync = None;
        drop(st);
        self.store_config(cfg.clone())?;
        let _ = std::fs::remove_file(self.journal_path());
        lock(&self.known).clear();
        Ok(cfg)
    }

    fn add_retire(cfg: &mut HistoryConfig, ctx: &SyncCtx) {
        let item = RetireItem { root: ctx.root.to_string_lossy().to_string(), remote: ctx.remote.clone() };
        if !cfg.retire_pending.contains(&item) {
            cfg.retire_pending.push(item);
        }
    }

    fn remove_local(&self, st: &mut State) -> Result<(), String> {
        st.local = None;
        for dir in [self.base.join("local"), self.base.join("uploaded")] {
            if dir.exists() {
                std::fs::remove_dir_all(&dir).map_err(|e| format!("清理历史记录失败：{}", e))?;
            }
        }
        Ok(())
    }

    /// 复制一个文档的历史（正文与索引）到目标命名空间，目标已有同名文档时合并
    fn copy_doc(from: &Store, from_id: &str, extra: &[(Store, DocIndex)], to: &Store, to_id: &str, path: &str) -> std::io::Result<bool> {
        let mut entries: Vec<(Entry, Store)> = Vec::new();
        if let Some(mut idx) = from.read_index(from_id) {
            Self::seal_last(from, &mut idx)?;
            from.write_index(&idx)?;
            entries.extend(idx.entries.into_iter().map(|e| (e, from.clone())));
        }
        for (store, idx) in extra {
            entries.extend(idx.entries.iter().filter(|e| !e.open).cloned().map(|e| (e, store.clone())));
        }
        if let Some(mut existing) = to.read_index(to_id) {
            Self::seal_last(to, &mut existing)?;
            entries.extend(existing.entries.into_iter().map(|e| (e, to.clone())));
        }
        let merged = merge_timeline(entries);
        if merged.is_empty() {
            return Ok(false);
        }
        let kind = from
            .read_index(from_id)
            .map(|i| i.kind)
            .or_else(|| extra.first().map(|(_, i)| i.kind.clone()))
            .unwrap_or_else(|| "code".into());
        let mut idx = DocIndex::new(to_id, &kind, path);
        for (entry, store) in merged {
            to.copy_blob_from(&store, &entry.hash)?;
            idx.entries.push(entry);
        }
        to.write_index(&idx)?;
        Ok(true)
    }

    /// 仅本机 → 跨设备同步：同步目录内的文档迁入 .nb-history/<本机>，其余留在本机
    fn migrate_local_to_sync(&self, st: &mut State, ctx: &SyncCtx) -> Result<(), String> {
        let local = self.local_store();
        let own = ctx.own();
        let mapping: Vec<(String, String)> = self.local_idt(st).map.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        let total = mapping.len();
        for (i, (_, doc_id)) in mapping.into_iter().enumerate() {
            let Some(idx) = local.read_index(&doc_id) else { continue };
            let abs = PathBuf::from(&idx.path);
            let Some(rel) = ctx.rel(&abs) else { continue };
            let target = match space::file_id_of(ctx, &rel) {
                Some(fid) => fid,
                None => {
                    let key = pkey(&rel);
                    match self.sync_idt(st, ctx).lookup(&key) {
                        Some(t) => t,
                        None => {
                            let t = format!("{}{}", space::TEMP_PREFIX, uuid::Uuid::new_v4().simple());
                            self.sync_idt(st, ctx).bind(&key, &t);
                            t
                        }
                    }
                }
            };
            Self::copy_doc(&local, &doc_id, &[], &own, &target, &idx.path).map_err(|e| format!("迁移历史失败：{}", e))?;
            local.delete_index(&doc_id);
            self.local_idt(st).forget(&doc_id);
            self.emit_migration(i + 1, total);
        }
        self.save_sync_idt(st);
        self.save_local_idt(st);
        Self::collect_store(&local);
        Ok(())
    }

    /// 跨设备同步 → 仅本机：本机与其他设备的版本合并导入本机，删除同步目录中的历史
    fn migrate_sync_to_local(&self, st: &mut State, ctx: &SyncCtx) -> Result<(), String> {
        let local = self.local_store();
        let own = ctx.own();
        let others = ctx.others();
        let mut ids: Vec<String> = own.list_doc_ids();
        for (_, s) in &others {
            ids.extend(s.list_doc_ids());
        }
        ids.sort();
        ids.dedup();
        let total = ids.len();
        for (i, id) in ids.into_iter().enumerate() {
            let own_idx = own.read_index(&id);
            let extra: Vec<(Store, DocIndex)> = if is_temp_id(&id) {
                Vec::new()
            } else {
                others.iter().filter_map(|(_, s)| s.read_index(&id).map(|idx| (s.clone(), idx))).collect()
            };
            // 当前路径：同步基线 / 改名线索优先，其次索引中记录的最后路径
            let abs = (!is_temp_id(&id))
                .then(|| space::rel_of_id(ctx, &id))
                .flatten()
                .map(|rel| ctx.abs(&rel))
                .or_else(|| own_idx.as_ref().map(|i| PathBuf::from(&i.path)))
                .or_else(|| extra.first().map(|(_, i)| PathBuf::from(&i.path)));
            let Some(abs) = abs else { continue };
            let key = path_key(&abs);
            let in_trash = ctx.rel(&abs).map(|r| crate::sync::util::is_in_trash(&r)).unwrap_or(false);
            let target = match self.local_idt(st).lookup(&key) {
                Some(t) => t,
                None => self.local_idt(st).assign(&key),
            };
            let copied = Self::copy_doc(&own, &id, &extra, &local, &target, &abs.to_string_lossy())
                .map_err(|e| format!("迁移历史失败：{}", e))?;
            if !copied {
                self.local_idt(st).forget(&target);
            } else if in_trash {
                // 位于同步回收站的文档：按已删除处理，保留期后清除
                self.local_idt(st).trash(&key, crate::sync::util::now_ms());
            }
            self.emit_migration(i + 1, total);
        }
        self.save_local_idt(st);
        let ns = ctx.ns();
        if ns.exists() {
            std::fs::remove_dir_all(&ns).map_err(|e| format!("清理同步目录中的历史失败：{}", e))?;
        }
        Ok(())
    }

    fn emit_migration(&self, done: usize, total: usize) {
        if let Some(sink) = &self.sink {
            if done == total || done.is_multiple_of(20) {
                sink.emit_json("nb://history-migration", serde_json::json!({ "done": done, "total": total }));
            }
        }
    }

    /// 同步目录或远端变更（或关闭多端同步）前调用：跨设备同步模式下先把旧同步目录中的历史迁回本机
    pub fn on_sync_target_changing(&self, old: &SyncCtx, still_valid: bool) {
        if self.config().mode != Mode::Sync || still_valid {
            return;
        }
        self.flush();
        let mut cfg = self.config();
        let mut st = lock(&self.state);
        if let Err(e) = self.migrate_sync_to_local(&mut st, old) {
            log::warn!("[history] 同步目录变更时迁回历史失败: {}", e);
            return;
        }
        Self::add_retire(&mut cfg, old);
        cfg.mode = Mode::Local;
        st.sync = None;
        drop(st);
        if let Err(e) = self.store_config(cfg) {
            log::warn!("[history] 保存历史记录设置失败: {}", e);
        }
    }

    pub fn set_options(&self, retention_days: u32, merge_window_min: u32, max_total_mb: u32) -> Result<HistoryConfig, String> {
        let mut cfg = self.config();
        cfg.retention_days = retention_days;
        cfg.merge_window_min = merge_window_min;
        cfg.max_total_mb = max_total_mb;
        cfg.sanitize();
        self.store_config(cfg.clone())?;
        self.send(Job::Maintain);
        Ok(cfg)
    }

    // ── 维护：保留策略、已删除文档清理、容量上限、垃圾回收 ──

    pub fn maintain(&self, now: i64) {
        let mut st = lock(&self.state);
        let cfg = self.config();
        if cfg.mode == Mode::Off {
            return;
        }
        // 本机空间：按路径映射判断文档是否仍存活
        let local = self.local_store();
        let expired = self.local_idt(&mut st).purge(now, TRASH_KEEP_MS);
        for id in &expired {
            local.delete_index(id);
        }
        let live: HashSet<String> = {
            let idt = self.local_idt(&mut st);
            idt.map.values().chain(idt.trashed.keys()).cloned().collect()
        };
        let emptied = Self::maintain_store(&local, &cfg, now, &|id| live.contains(id), cfg.max_total_bytes(false));
        for id in &emptied {
            self.local_idt(&mut st).forget(id);
        }
        if !expired.is_empty() || !emptied.is_empty() {
            self.save_local_idt(&st);
        }
        // 同步空间（本机目录）：正式 ID 由历史阶段按同步清单清理，这里只管临时标识
        if cfg.mode == Mode::Sync {
            if let Some(ctx) = self.sync_ctx() {
                let own = ctx.own();
                let expired = self.sync_idt(&mut st, &ctx).purge(now, TRASH_KEEP_MS);
                for id in &expired {
                    own.delete_index(id);
                }
                let temps: HashSet<String> = {
                    let idt = self.sync_idt(&mut st, &ctx);
                    idt.map.values().chain(idt.trashed.keys()).cloned().collect()
                };
                let git = crate::sync::scheduler::current_config().sync.provider.kind;
                use crate::sync::config::ProviderKind as P;
                let cap = cfg.max_total_bytes(matches!(git, P::Github | P::Gitee | P::Gitcode | P::Gitlab));
                let emptied = Self::maintain_store(&own, &cfg, now, &|id| !is_temp_id(id) || temps.contains(id), cap);
                for id in &emptied {
                    self.sync_idt(&mut st, &ctx).forget(id);
                }
                if !expired.is_empty() || !emptied.is_empty() {
                    self.save_sync_idt(&st);
                }
            }
        }
    }

    /// 对单个命名空间执行保留策略与容量淘汰，返回被清空的文档标识
    fn maintain_store(store: &Store, cfg: &HistoryConfig, now: i64, live: &dyn Fn(&str) -> bool, cap: u64) -> Vec<String> {
        let window = cfg.merge_window_min as i64 * 60_000;
        let mut emptied = Vec::new();
        let mut indexes: Vec<DocIndex> = Vec::new();
        for id in store.list_doc_ids() {
            // 没有任何身份映射的索引是孤儿（例如映射文件损坏前的残留），一并清理
            if !live(&id) {
                store.delete_index(&id);
                emptied.push(id);
                continue;
            }
            let Some(mut idx) = store.read_index(&id) else { continue };
            let mut dirty = false;
            // 超出合并窗口仍未封口的版本（上次退出前的最后一次保存）
            if idx.last().is_some_and(|e| e.open && now - e.at > window) && Self::seal_last(store, &mut idx).is_ok() {
                dirty = true;
            }
            if !retention::apply(&mut idx.entries, now, cfg.retention_days).is_empty() {
                dirty = true;
            }
            if idx.entries.is_empty() {
                store.delete_index(&id);
                emptied.push(id);
                continue;
            }
            if dirty {
                let _ = store.write_index(&idx);
            }
            indexes.push(idx);
        }
        Self::collect(store, &indexes);
        // 容量上限：跨文档淘汰最旧的未保护版本
        let mut used = store.usage();
        if used > cap {
            let mut candidates: Vec<(i64, usize, String)> = Vec::new();
            for (di, idx) in indexes.iter().enumerate() {
                let keep = retention::protected(&idx.entries);
                for (i, e) in idx.entries.iter().enumerate() {
                    if !keep.contains(&i) {
                        candidates.push((e.at, di, e.id.clone()));
                    }
                }
            }
            candidates.sort();
            let mut refs: HashMap<String, usize> = HashMap::new();
            for idx in &indexes {
                for e in idx.entries.iter().filter(|e| !e.open) {
                    *refs.entry(e.hash.clone()).or_insert(0) += 1;
                }
            }
            let mut touched = HashSet::new();
            for (_, di, eid) in candidates {
                if used <= cap {
                    break;
                }
                let idx = &mut indexes[di];
                let Some(pos) = idx.entries.iter().position(|e| e.id == eid) else { continue };
                let e = idx.entries.remove(pos);
                touched.insert(di);
                if let Some(c) = refs.get_mut(&e.hash) {
                    *c -= 1;
                    if *c == 0 {
                        used = used.saturating_sub(store.blob_size(&e.hash));
                    }
                }
            }
            for di in touched {
                let _ = store.write_index(&indexes[di]);
            }
            Self::collect(store, &indexes);
        }
        emptied
    }

    fn collect(store: &Store, indexes: &[DocIndex]) {
        let referenced: HashSet<String> =
            indexes.iter().flat_map(|i| i.entries.iter().filter(|e| !e.open).map(|e| e.hash.clone())).collect();
        let live_docs: HashSet<String> =
            indexes.iter().filter(|i| i.last().is_some_and(|e| e.open)).map(|i| i.doc_id.clone()).collect();
        store.gc(&referenced, &live_docs);
    }

    /// 只做垃圾回收（不应用保留策略）
    fn collect_store(store: &Store) {
        let indexes: Vec<DocIndex> = store.list_doc_ids().iter().filter_map(|id| store.read_index(id)).collect();
        Self::collect(store, &indexes);
    }

    // ── 同步历史阶段使用（由 sync::history_phase 调用，网络操作在外部完成） ──

    /// 上次成功上传到远端的本机目录
    fn uploaded_path(&self, ctx: &SyncCtx) -> PathBuf {
        let digest = sha256_hex(format!("{}|{}", pkey(&ctx.root.to_string_lossy()), ctx.remote).as_bytes());
        self.base.join("uploaded").join(format!("{}.json", &digest[..16]))
    }

    pub fn load_uploaded(&self, ctx: &SyncCtx) -> Option<Catalog> {
        std::fs::read(self.uploaded_path(ctx)).ok().and_then(|b| Catalog::parse(&b))
    }

    pub fn save_uploaded(&self, ctx: &SyncCtx, cat: Option<&Catalog>) {
        let path = self.uploaded_path(ctx);
        match cat {
            Some(c) => {
                if let Err(e) = super::store::write_atomic(&path, &c.to_bytes()) {
                    log::warn!("[history] 保存上传状态失败: {}", e);
                }
            }
            None => {
                let _ = std::fs::remove_file(path);
            }
        }
    }

    /// 历史阶段开始：封口闲置的合并窗口，临时标识换成同步分配的正式 ID
    pub fn phase_prepare(&self, ctx: &SyncCtx, now: i64) {
        let mut st = lock(&self.state);
        let cfg = self.config();
        let own = ctx.own();
        let window = cfg.merge_window_min as i64 * 60_000;
        for id in own.list_doc_ids() {
            let Some(mut idx) = own.read_index(&id) else { continue };
            if idx.last().is_some_and(|e| e.open && now - e.at > window) && Self::seal_last(&own, &mut idx).is_ok() {
                let _ = own.write_index(&idx);
            }
        }
        let temps: Vec<(String, String)> = self.sync_idt(&mut st, ctx).map.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        let mut changed = false;
        for (key, tmp) in temps {
            if let Some(fid) = space::file_id_of(ctx, &key) {
                if Self::merge_doc(&own, &tmp, &fid).is_ok() {
                    self.sync_idt(&mut st, ctx).forget(&tmp);
                    changed = true;
                }
            }
        }
        if changed {
            self.save_sync_idt(&st);
        }
    }

    /// 本机期望上传的目录与各文档索引内容
    pub fn phase_desired(&self, ctx: &SyncCtx) -> (Catalog, BTreeMap<String, Vec<u8>>) {
        let _st = lock(&self.state);
        catalog::desired_catalog(&ctx.own(), &ctx.me, &ctx.device_name)
    }

    /// 读取本机已封口正文的压缩字节
    pub fn phase_blob(&self, ctx: &SyncCtx, sha: &str) -> Option<Vec<u8>> {
        ctx.own().read_blob_gz(sha).ok()
    }

    /// 清理已被同步删除的文档（墓碑超过保留期或已从清单移除）：本机目录与其他设备缓存
    pub fn phase_drop_docs(&self, ctx: &SyncCtx, dead: &HashSet<String>) {
        if dead.is_empty() {
            return;
        }
        let _st = lock(&self.state);
        let own = ctx.own();
        for id in dead {
            own.delete_index(id);
        }
        Self::collect_store(&own);
    }

    /// 写入从其他设备下载的索引与正文，并移除远端已删除的文档
    pub fn phase_store_download(&self, ctx: &SyncCtx, device: &str, docs: &[(String, Vec<u8>)], blobs: &[(String, Vec<u8>)], drop_docs: &[String], remote: &Catalog) -> Result<(), String> {
        let store = ctx.device_store(device).ok_or("设备标识无效")?;
        let _st = lock(&self.state);
        for (sha, gz) in blobs {
            store.write_blob_gz(sha, gz).map_err(|e| e.to_string())?;
        }
        for (id, bytes) in docs {
            let mut idx: DocIndex = serde_json::from_slice(bytes).map_err(|e| format!("历史索引格式错误：{}", e))?;
            if !super::store::valid_doc_id(id) {
                continue;
            }
            idx.doc_id = id.clone();
            idx.entries.retain(|e| !e.open);
            store.write_index(&idx).map_err(|e| e.to_string())?;
        }
        for id in drop_docs {
            store.delete_index(id);
        }
        super::store::write_atomic(&store.dir.join("catalog.json"), &remote.to_bytes()).map_err(|e| e.to_string())?;
        let referenced: HashSet<String> = remote.all_blobs().into_iter().collect();
        store.gc(&referenced, &HashSet::new());
        drop(_st);
        // 已打开这些文档历史的窗口刷新列表
        for (id, _) in docs {
            if let Some(rel) = space::rel_of_id(ctx, id) {
                self.emit_changed(&ctx.abs(&rel));
            }
        }
        Ok(())
    }

    /// 其他设备在本地缓存的目录
    pub fn cached_catalog(&self, ctx: &SyncCtx, device: &str) -> Catalog {
        ctx.device_store(device)
            .and_then(|s| std::fs::read(s.dir.join("catalog.json")).ok())
            .and_then(|b| Catalog::parse(&b))
            .unwrap_or_default()
    }

    /// 待清理的远端本机目录（切出跨设备同步后）
    pub fn retire_items(&self) -> Vec<RetireItem> {
        self.config().retire_pending
    }

    pub fn finish_retire(&self, item: &RetireItem) {
        let mut cfg = self.config();
        cfg.retire_pending.retain(|r| r != item);
        let _ = self.store_config(cfg);
    }

    /// 切出同步后清理远端时使用的上传状态（按同步目录与远端身份）
    pub fn uploaded_for(&self, root: &str, remote: &str, me: &str) -> (SyncCtx, Option<Catalog>) {
        let ctx = SyncCtx { root: PathBuf::from(root), me: me.to_string(), remote: remote.to_string(), device_name: String::new() };
        let cat = self.load_uploaded(&ctx);
        (ctx, cat)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn svc(dir: &Path) -> Arc<Service> {
        let base = dir.join("history");
        let cfg = HistoryConfig { mode: Mode::Local, ..Default::default() };
        config::save(&base, &cfg).unwrap();
        let s = Arc::new(Service::new(base, None, Box::new(|| Origin { device: "deva".into(), name: "A".into() })));
        s.set_ctx_for_test(None);
        s.spawn_worker();
        s
    }

    fn write(path: &Path, s: &str) {
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p).unwrap();
        }
        std::fs::write(path, s).unwrap();
    }

    #[test]
    fn save_flow_records_initial_merges_window_and_detects_external() {
        let dir = tempfile::tempdir().unwrap();
        let s = svc(dir.path());
        let doc = dir.path().join("笔记.md");
        write(&doc, "原文\n");

        // 首次保存：先补记磁盘原内容（initial），再记录保存（save，处于合并窗口）
        s.prepare_write(&doc);
        write(&doc, "原文\n第一次\n");
        s.on_written(&doc);
        s.flush();
        let list = s.list(&doc);
        assert_eq!(list.entries.len(), 2);
        assert_eq!(list.entries[0].entry.reason, Reason::Save);
        assert!(list.entries[0].entry.open);
        assert_eq!(list.entries[1].entry.reason, Reason::Initial);
        assert_eq!(list.entries[0].entry.stats.as_ref().unwrap().ins, 3);

        // 合并窗口内再次保存：仍是两条，内容更新
        s.prepare_write(&doc);
        write(&doc, "原文\n第一次\n第二次\n");
        s.on_written(&doc);
        s.flush();
        let list = s.list(&doc);
        assert_eq!(list.entries.len(), 2);
        let latest = s.read(&doc, &list.entries[0].entry.id).unwrap();
        assert_eq!(latest.content, "原文\n第一次\n第二次\n");

        // 应用外修改后再保存：补记 external
        std::thread::sleep(Duration::from_millis(20));
        write(&doc, "外部改过\n");
        s.prepare_write(&doc);
        write(&doc, "外部改过\n再保存\n");
        s.on_written(&doc);
        s.flush();
        let reasons: Vec<Reason> = s.list(&doc).entries.iter().map(|e| e.entry.reason).collect();
        assert_eq!(reasons, vec![Reason::Save, Reason::External, Reason::Save, Reason::Initial]);
        // 旧的合并窗口版本已封口，可读取
        let list = s.list(&doc);
        assert!(!list.entries[2].entry.open);
        assert_eq!(s.read(&doc, &list.entries[2].entry.id).unwrap().content, "原文\n第一次\n第二次\n");
    }

    #[test]
    fn rename_follows_and_delete_then_reclaim() {
        let dir = tempfile::tempdir().unwrap();
        let s = svc(dir.path());
        let a = dir.path().join("a.md");
        write(&a, "v1");
        s.on_written(&a);
        s.flush();
        let b = dir.path().join("b.md");
        std::fs::rename(&a, &b).unwrap();
        s.on_renamed(&a, &b);
        s.flush();
        assert_eq!(s.list(&b).entries.len(), 1);
        assert!(s.list(&a).entries.is_empty());

        // 删除后同一路径重新出现相同内容：历史恢复关联
        s.on_deleted(&b);
        s.flush();
        assert!(s.list(&b).entries.is_empty());
        write(&b, "v1");
        s.prepare_write(&b);
        s.flush();
        assert_eq!(s.list(&b).entries.len(), 1);
    }

    #[test]
    fn restore_checkpoints_and_mode_off_clears() {
        let dir = tempfile::tempdir().unwrap();
        let s = svc(dir.path());
        let doc = dir.path().join("x.md");
        write(&doc, "一");
        s.on_written(&doc);
        s.flush();
        let first = s.list(&doc).entries[0].entry.id.clone();
        write(&doc, "二");
        s.on_written(&doc);
        s.flush();

        // 还原：未保存内容记为 before-restore，随后的写盘记为 restore
        s.checkpoint(&doc, "before-restore", Some("二（未保存）".into()), None).unwrap();
        s.checkpoint(&doc, "restore", None, Some(first.clone())).unwrap();
        write(&doc, "一");
        s.on_written(&doc);
        s.flush();
        let list = s.list(&doc);
        assert_eq!(list.entries[0].entry.reason, Reason::Restore);
        assert_eq!(list.entries[0].entry.restored_from.as_deref(), Some(first.as_str()));
        assert_eq!(list.entries[1].entry.reason, Reason::BeforeRestore);

        s.set_mode(Mode::Off).unwrap();
        assert!(!s.base.join("local").exists());
        assert!(s.list(&doc).entries.is_empty());
    }

    #[test]
    fn maintain_collects_garbage_and_ineligible_paths_skip() {
        let dir = tempfile::tempdir().unwrap();
        let s = svc(dir.path());
        let doc = dir.path().join("d.md");
        for (i, text) in ["1", "2", "3"].iter().enumerate() {
            write(&doc, text);
            // 非保存原因的版本立即封口，分别成为独立版本
            s.record(&doc, text.as_bytes(), Reason::External, None, None, 1_000 + i as i64);
        }
        let list = s.list(&doc);
        assert_eq!(list.entries.len(), 3);
        s.delete_entry(&doc, &list.entries[1].entry.id).unwrap();
        s.flush();
        s.maintain(2_000);
        let store = s.local_store();
        assert!(!store.has_blob(&sha256_hex(b"2")));
        assert!(store.has_blob(&sha256_hex(b"3")));

        assert!(kind_of(Path::new("a.xmind")).is_none());
        assert!(kind_of(Path::new("a.pdf")).is_none());
        assert!(!eligible(&dir.path().join(".nb-trash").join("a.md")));
    }

    #[test]
    fn sync_space_temp_ids_migration_and_timeline_with_other_devices() {
        let dir = tempfile::tempdir().unwrap();
        let s = svc(dir.path());
        let root = dir.path().join("同步");
        std::fs::create_dir_all(&root).unwrap();
        let inside = root.join("项目").join("a.md");
        let outside = dir.path().join("外部.md");
        write(&inside, "v1");
        s.on_written(&inside);
        write(&outside, "o1");
        s.on_written(&outside);
        s.flush();

        // 本机 → 跨设备同步：同步目录内文档迁入 .nb-history/<本机>，目录外的留在本机
        let ctx = SyncCtx { root: root.clone(), me: "deva".into(), remote: "mem".into(), device_name: "A".into() };
        s.set_ctx_for_test(Some(ctx.clone()));
        s.set_mode(Mode::Sync).unwrap();
        let own_ids = ctx.own().list_doc_ids();
        assert_eq!(own_ids.len(), 1);
        assert!(is_temp_id(&own_ids[0]), "未同步过的文件使用临时标识");
        assert_eq!(s.list(&inside).entries.len(), 1);
        assert_eq!(s.list(&outside).entries.len(), 1);
        assert_eq!(s.local_store().list_doc_ids().len(), 1);

        // 其他设备的缓存不参与临时标识的时间线；同步分配正式 ID 后并入
        let temp = own_ids[0].clone();
        Service::merge_doc(&ctx.own(), &temp, "fid1").unwrap();
        let other = ctx.device_store("devb").unwrap();
        let mut idx = DocIndex::new("fid1", "markdown", &inside.to_string_lossy());
        let body = b"v2 from b";
        let sha = sha256_hex(body);
        other.put_blob(&sha, body).unwrap();
        idx.entries.push(Entry {
            id: new_entry_id(i64::MAX / 4), start: 0, at: i64::MAX / 4, hash: sha.clone(), size: 9, reason: Reason::Save,
            origin: Origin { device: "devb".into(), name: "B".into() }, stats: None, restored_from: None, pinned: false, open: false,
        });
        other.write_index(&idx).unwrap();
        let tl = merge_timeline(
            ctx.own().read_index("fid1").unwrap().entries.into_iter().map(|e| (e, ctx.own()))
                .chain(idx.entries.iter().cloned().map(|e| (e, other.clone()))).collect(),
        );
        assert_eq!(tl.len(), 2);
        assert_eq!(tl[1].0.origin.device, "devb");

        // 跨设备同步 → 本机：本机与其他设备的版本一起导入，同步目录中的历史被删除并登记远端清理
        // （测试环境没有同步基线，按索引里记录的路径归位）
        let mut own_idx = ctx.own().read_index("fid1").unwrap();
        own_idx.path = inside.to_string_lossy().to_string();
        ctx.own().write_index(&own_idx).unwrap();
        s.set_mode(Mode::Local).unwrap();
        assert!(!ctx.ns().exists());
        let cfg = s.config();
        assert_eq!(cfg.retire_pending.len(), 1);
        let list = s.list(&inside);
        assert_eq!(list.entries.len(), 2);
        assert_eq!(s.read(&inside, &list.entries[0].entry.id).unwrap().content, "v2 from b");
    }

    #[test]
    fn interrupted_migration_resumes_on_startup() {
        let dir = tempfile::tempdir().unwrap();
        let s = svc(dir.path());
        let doc = dir.path().join("r.md");
        write(&doc, "x");
        s.on_written(&doc);
        s.flush();
        // 模拟切换到关闭时进程在更新配置前中断：日志已写入
        std::fs::write(s.base.join("migration.json"), br#"{"to":"off"}"#).unwrap();
        let again = Service::new(s.base.clone(), None, Box::new(|| Origin { device: "deva".into(), name: "A".into() }));
        again.set_ctx_for_test(None);
        again.resume_migration();
        assert_eq!(again.config().mode, Mode::Off);
        assert!(!again.base.join("migration.json").exists());
        assert!(!again.base.join("local").exists());
    }
}
