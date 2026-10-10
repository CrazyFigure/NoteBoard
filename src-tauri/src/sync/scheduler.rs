// NoteBoard 同步调度器
//
// 进程内唯一的后台线程，串行执行同步、备份与恢复任务（多窗口共享，不会并发同步）：
//   - 启动后延迟数秒在后台同步一次（不阻塞窗口启动与正常使用）
//   - 保存触发：文件写入后防抖 3 秒合并连续保存，持续写入时最长 30 秒必定同步一次
//   - 定时同步、定时自动备份
//   - 网络抖动/其他设备占用等临时错误按退避间隔自动重试
// 结果通过事件广播给所有窗口：nb://sync-status、nb://sync-report、nb://sync-applied。

use super::backup;
use super::config::{self, SyncConfigFile};
use super::engine;
use super::state;
use super::types::{BackupReport, LocalChange, SyncStatus};
use super::util::now_ms;
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const STARTUP_DELAY_MS: i64 = 4_000;
const SAVE_DEBOUNCE_MS: i64 = 3_000;
const SAVE_MAX_WAIT_MS: i64 = 30_000;
const MIN_INTERVAL_MINUTES: u32 = 1;

pub const EVENT_STATUS: &str = "nb://sync-status";
pub const EVENT_REPORT: &str = "nb://sync-report";
pub const EVENT_APPLIED: &str = "nb://sync-applied";
pub const EVENT_CONFIG: &str = "nb://sync-config-changed";

/// 需要等待结果的显式任务（恢复备份）
pub enum Job {
    RestoreToRoot { name: String, reply: std::sync::mpsc::Sender<Result<String, String>> },
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ReportEvent<'a, T: Serialize> {
    kind: &'a str,
    report: &'a T,
    /// 是否需要弹出提示
    notify: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AppliedEvent<'a> {
    changes: &'a [LocalChange],
}

struct Inner {
    config: SyncConfigFile,
    status: SyncStatus,
    pending_sync: Option<String>,
    startup_at: Option<i64>,
    change_first: Option<i64>,
    change_deadline: Option<i64>,
    retry_at: Option<i64>,
    retry_count: u32,
    next_interval: i64,
    pending_backup: Option<String>,
    backup_retry_at: i64,
    jobs: VecDeque<Job>,
}

pub struct Scheduler {
    app: AppHandle,
    inner: Mutex<Inner>,
    cv: Condvar,
}

static SCHEDULER: OnceLock<Arc<Scheduler>> = OnceLock::new();

pub fn get() -> Option<Arc<Scheduler>> {
    SCHEDULER.get().cloned()
}

/// 当前配置快照（钩子与命令使用）
pub fn current_config() -> SyncConfigFile {
    match get() {
        Some(s) => s.inner.lock().unwrap_or_else(|p| p.into_inner()).config.clone(),
        None => config::load(),
    }
}

fn interval_ms(cfg: &SyncConfigFile) -> i64 {
    cfg.sync.interval_minutes.max(MIN_INTERVAL_MINUTES) as i64 * 60_000
}

/// 在 setup 中启动调度线程
pub fn init(app: AppHandle) {
    let cfg = config::load();
    let st = state::snapshot();
    let now = now_ms();
    let inner = Inner {
        startup_at: if cfg.sync.enabled && cfg.sync.sync_on_startup { Some(now + STARTUP_DELAY_MS) } else { None },
        next_interval: now + interval_ms(&cfg),
        status: SyncStatus { last_sync: st.last_sync.clone(), last_backup: st.last_backup.clone(), ..Default::default() },
        config: cfg,
        pending_sync: None,
        change_first: None,
        change_deadline: None,
        retry_at: None,
        retry_count: 0,
        pending_backup: None,
        backup_retry_at: 0,
        jobs: VecDeque::new(),
    };
    let sched = Arc::new(Scheduler { app, inner: Mutex::new(inner), cv: Condvar::new() });
    if SCHEDULER.set(sched.clone()).is_err() {
        return;
    }
    std::thread::Builder::new()
        .name("nb-sync".into())
        .spawn(move || sched.run_loop())
        .ok();
}

enum Task {
    Sync(String),
    Backup(String),
    Job(Job),
}

impl Scheduler {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn sync_ready(cfg: &SyncConfigFile) -> bool {
        cfg.sync.enabled && !cfg.sync.root_dir.trim().is_empty()
    }

    /// 计算下次自动备份时间
    fn next_backup_at(g: &Inner) -> i64 {
        if !g.config.backup.auto_enabled || g.config.sync.root_dir.trim().is_empty() {
            return 0;
        }
        let last = state::snapshot().last_auto_backup_at;
        let hours = g.config.backup.interval_hours.max(1) as i64;
        (last + hours * 3_600_000).max(g.backup_retry_at)
    }

    /// 取出当前到期的任务
    fn take_due(&self, g: &mut Inner, now: i64) -> Option<Task> {
        if let Some(job) = g.jobs.pop_front() {
            return Some(Task::Job(job));
        }
        let ready = Self::sync_ready(&g.config);
        if let Some(t) = g.pending_sync.take() {
            if ready {
                return Some(Task::Sync(t));
            }
        }
        if ready {
            if let Some(at) = g.startup_at {
                if now >= at {
                    g.startup_at = None;
                    return Some(Task::Sync("startup".into()));
                }
            }
            if let Some(at) = g.change_deadline {
                if now >= at {
                    g.change_deadline = None;
                    g.change_first = None;
                    return Some(Task::Sync("save".into()));
                }
            }
            if let Some(at) = g.retry_at {
                if now >= at {
                    g.retry_at = None;
                    return Some(Task::Sync("retry".into()));
                }
            }
            if g.config.sync.interval_enabled && now >= g.next_interval {
                return Some(Task::Sync("interval".into()));
            }
        }
        if let Some(t) = g.pending_backup.take() {
            return Some(Task::Backup(t));
        }
        let nb = Self::next_backup_at(g);
        if nb > 0 && now >= nb {
            return Some(Task::Backup("auto".into()));
        }
        None
    }

    /// 距下一个定时事件的等待时长
    fn wait_for(&self, g: &Inner, now: i64) -> Duration {
        let mut next = now + 60_000;
        let ready = Self::sync_ready(&g.config);
        if ready {
            for t in [g.startup_at, g.change_deadline, g.retry_at].into_iter().flatten() {
                next = next.min(t);
            }
            if g.config.sync.interval_enabled {
                next = next.min(g.next_interval);
            }
        }
        let nb = Self::next_backup_at(g);
        if nb > 0 {
            next = next.min(nb);
        }
        Duration::from_millis((next - now).clamp(50, 60_000) as u64)
    }

    fn run_loop(self: Arc<Self>) {
        loop {
            let task = {
                let mut g = self.lock();
                loop {
                    let now = now_ms();
                    if let Some(t) = self.take_due(&mut g, now) {
                        break t;
                    }
                    let wait = self.wait_for(&g, now);
                    g = self.cv.wait_timeout(g, wait).map(|(g, _)| g).unwrap_or_else(|p| p.into_inner().0);
                }
            };
            match task {
                Task::Sync(trigger) => self.do_sync(&trigger),
                Task::Backup(trigger) => self.do_backup(&trigger),
                Task::Job(job) => self.do_job(job),
            }
        }
    }

    fn emit_status(&self) {
        let status = {
            let g = self.lock();
            let mut s = g.status.clone();
            s.next_sync_at = if Self::sync_ready(&g.config) && g.config.sync.interval_enabled { g.next_interval } else { 0 };
            s.next_backup_at = Self::next_backup_at(&g);
            s
        };
        let _ = self.app.emit(EVENT_STATUS, &status);
    }

    pub fn status(&self) -> SyncStatus {
        let g = self.lock();
        let mut s = g.status.clone();
        s.next_sync_at = if Self::sync_ready(&g.config) && g.config.sync.interval_enabled { g.next_interval } else { 0 };
        s.next_backup_at = Self::next_backup_at(&g);
        s
    }

    fn do_sync(&self, trigger: &str) {
        let cfg = {
            let mut g = self.lock();
            g.status.syncing = true;
            g.config.clone()
        };
        self.emit_status();
        let outcome = tauri::async_runtime::block_on(engine::run_sync(&cfg.sync, &cfg.device_id, trigger));
        let report = outcome.report;
        let transient = !report.ok && outcome.transient;
        let now = now_ms();
        {
            let mut g = self.lock();
            g.status.syncing = false;
            g.status.last_sync = Some(report.clone());
            g.next_interval = now + interval_ms(&g.config);
            if transient {
                // 退避重试：30s、1min、2min……最长 10 分钟
                let backoff = (30_000i64 << g.retry_count.min(5)).min(600_000);
                g.retry_count += 1;
                g.retry_at = Some(now + backoff);
            } else {
                g.retry_count = 0;
                g.retry_at = None;
            }
        }
        state::with_state(|s| s.last_sync = Some(report.clone()));
        if !outcome.changes.is_empty() {
            let _ = self.app.emit(EVENT_APPLIED, &AppliedEvent { changes: &outcome.changes });
        }
        let explicit = matches!(trigger, "manual" | "enable" | "restore");
        // 自动重试中的临时错误只提示首次，避免每隔几十秒弹一次
        let first_failure = !report.ok && (!transient || self.lock().retry_count <= 1);
        let has_changes = report.upload.total() + report.download.total() > 0;
        let notify = explicit || first_failure || (report.ok && (has_changes || !report.errors.is_empty())) || (report.ok && cfg.sync.notify_no_change);
        let _ = self.app.emit(EVENT_REPORT, &ReportEvent { kind: "sync", report: &report, notify });
        self.emit_status();
    }

    fn do_backup(&self, trigger: &str) {
        let cfg = {
            let mut g = self.lock();
            g.status.backing_up = true;
            g.config.clone()
        };
        self.emit_status();
        let report: BackupReport = tauri::async_runtime::block_on(backup::run_backup(&cfg, trigger));
        {
            let mut g = self.lock();
            g.status.backing_up = false;
            g.status.last_backup = Some(report.clone());
            // 自动备份失败 1 小时后再试，避免反复失败刷屏
            g.backup_retry_at = if report.ok { 0 } else { now_ms() + 3_600_000 };
        }
        state::with_state(|s| {
            s.last_backup = Some(report.clone());
            if trigger == "auto" {
                s.last_auto_backup_at = now_ms();
            }
        });
        let notify = trigger != "auto" || !report.ok;
        let _ = self.app.emit(EVENT_REPORT, &ReportEvent { kind: "backup", report: &report, notify });
        self.emit_status();
    }

    fn do_job(&self, job: Job) {
        match job {
            Job::RestoreToRoot { name, reply } => {
                let cfg = self.lock().config.clone();
                let result = tauri::async_runtime::block_on(backup::restore_to_sync_root(&cfg, &name));
                match result {
                    Ok((msg, changes)) => {
                        if !changes.is_empty() {
                            let _ = self.app.emit(EVENT_APPLIED, &AppliedEvent { changes: &changes });
                        }
                        let _ = reply.send(Ok(msg));
                        // 恢复后立即同步，把恢复结果推送到其他设备
                        if Self::sync_ready(&cfg) {
                            self.do_sync("restore");
                        }
                    }
                    Err(e) => {
                        let _ = reply.send(Err(e.message));
                    }
                }
            }
        }
    }

    // ── 外部请求 ──

    pub fn request_sync(&self, trigger: &str) {
        let mut g = self.lock();
        g.pending_sync = Some(trigger.to_string());
        self.cv.notify_all();
    }

    pub fn request_backup(&self, trigger: &str) {
        let mut g = self.lock();
        g.pending_backup = Some(trigger.to_string());
        self.cv.notify_all();
    }

    pub fn push_job(&self, job: Job) {
        let mut g = self.lock();
        g.jobs.push_back(job);
        self.cv.notify_all();
    }

    /// 同步目录中的文件被保存/新建/改名/删除：防抖后同步
    pub fn notify_change(&self) {
        let mut g = self.lock();
        if !Self::sync_ready(&g.config) || !g.config.sync.sync_on_save {
            return;
        }
        let now = now_ms();
        let first = *g.change_first.get_or_insert(now);
        let deadline = (now + SAVE_DEBOUNCE_MS).min(first + SAVE_MAX_WAIT_MS);
        g.change_deadline = Some(deadline);
        self.cv.notify_all();
    }

    /// 更新配置：开启同步或切换同步文件夹时立即同步一次，改动定时间隔后重新计时
    pub fn set_config(&self, cfg: SyncConfigFile) {
        {
            let mut g = self.lock();
            let was_ready = Self::sync_ready(&g.config);
            let interval_changed = g.config.sync.interval_minutes != cfg.sync.interval_minutes
                || g.config.sync.interval_enabled != cfg.sync.interval_enabled;
            // 只有切换同步文件夹才立即同步；服务配置在输入过程中会频繁保存，
            // 不能每次都触发同步（半截地址必然失败），由「测试连接 / 立即同步」或下次定时同步生效
            let target_changed = g.config.sync.root_dir != cfg.sync.root_dir;
            g.config = cfg;
            if interval_changed {
                g.next_interval = now_ms() + interval_ms(&g.config);
            }
            let ready = Self::sync_ready(&g.config);
            if ready && (!was_ready || target_changed) {
                g.pending_sync = Some("enable".into());
            }
            if !ready {
                g.change_deadline = None;
                g.change_first = None;
                g.retry_at = None;
            }
            self.cv.notify_all();
        }
        let cfg = self.lock().config.clone();
        let _ = self.app.emit(EVENT_CONFIG, &cfg);
        self.emit_status();
    }
}
