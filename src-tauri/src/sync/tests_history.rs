// 端到端历史记录同步测试：两台「设备」通过同一个内存远端同步文档与历史，
// 覆盖临时标识换正式 ID、上传本机目录、下载其他设备版本、时间线合并、切出同步后清理远端。

use super::backend::memory::Memory;
use super::backend::Backend;
use super::config::SyncSettings;
use super::engine::run_sync_with;
use super::state::{self, LocalState};
use super::types::SyncReport;
use crate::history::config::{self as hconfig, HistoryConfig, Mode};
use crate::history::model::{Origin, Reason};
use crate::history::service::Service;
use crate::history::space::SyncCtx;
use std::path::{Path, PathBuf};
use std::sync::Arc;

struct Device {
    root: tempfile::TempDir,
    _data: tempfile::TempDir,
    state: LocalState,
    id: String,
    name: String,
    svc: Arc<Service>,
}

impl Device {
    fn new(name: &str) -> Self {
        let root = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let id = format!("{}-device-id", name);
        let base = data.path().join("history");
        hconfig::save(&base, &HistoryConfig { mode: Mode::Sync, ..Default::default() }).unwrap();
        let (dev, nm) = (id.clone(), name.to_string());
        let svc = Arc::new(Service::new(base, None, Box::new(move || Origin { device: dev.clone(), name: nm.clone() })));
        svc.set_ctx_for_test(Some(SyncCtx {
            root: root.path().to_path_buf(),
            me: id.clone(),
            remote: SyncSettings::default().provider.identity(),
            device_name: name.into(),
        }));
        Self { root, _data: data, state: LocalState::default(), id, name: name.into(), svc }
    }

    fn settings(&self) -> SyncSettings {
        SyncSettings {
            enabled: true,
            root_dir: self.root.path().to_string_lossy().to_string(),
            device_name: self.name.clone(),
            trash_enabled: true,
            trash_days: 30,
            ..Default::default()
        }
    }

    fn path(&self, rel: &str) -> PathBuf {
        super::util::rel_to_abs(self.root.path(), rel)
    }

    fn with_state<R>(&mut self, f: impl FnOnce(&Path) -> R) -> R {
        state::swap_for_test(std::mem::take(&mut self.state));
        let r = f(self.root.path());
        self.state = state::swap_for_test(LocalState::default());
        r
    }

    /// 写文件并记录一个已封口的版本
    fn save(&mut self, rel: &str, content: &str) {
        let p = self.path(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, content).unwrap();
        let svc = self.svc.clone();
        self.with_state(|_| {
            svc.record(&p, content.as_bytes(), Reason::Save, None, None, super::util::now_ms());
            svc.seal_path(&p);
        });
    }

    /// 主同步 + 历史阶段
    fn sync(&mut self, remote: &Memory) -> SyncReport {
        let settings = self.settings();
        let id = self.id.clone();
        let svc = self.svc.clone();
        self.with_state(|_| {
            let out = super::runtime::block_on(run_sync_with(&settings, &id, "test", Ok(Backend::Memory(remote.clone()))));
            assert!(out.report.ok, "同步失败：{:?}", out.report.errors);
            let mut report = SyncReport::default();
            let mut backend = Backend::Memory(remote.clone());
            super::runtime::block_on(super::history_phase::run_with(&svc, &settings, &id, &mut backend, &mut report));
            assert!(report.errors.is_empty(), "历史阶段失败：{:?}", report.errors);
            report
        })
    }

    fn list(&mut self, rel: &str) -> Vec<(String, bool, String)> {
        let p = self.path(rel);
        let svc = self.svc.clone();
        self.with_state(|_| {
            let list = svc.list(&p);
            list.entries
                .iter()
                .map(|e| (e.entry.origin.device.clone(), e.is_own, svc.read(&p, &e.entry.id).unwrap().content))
                .collect()
        })
    }
}

fn remote_has(remote: &Memory, prefix: &str) -> bool {
    remote.files.lock().unwrap().keys().any(|k| k.starts_with(prefix))
}

#[test]
fn two_devices_share_history_and_retire_cleans_remote() {
    // 与其他轮流替换全局同步状态的测试互斥
    let _guard = state::TEST_STATE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let data = tempfile::tempdir().unwrap();
    crate::app_dirs::set_data_root(data.path().to_path_buf());
    let remote = Memory::default();
    let mut a = Device::new("A");
    let mut b = Device::new("B");

    // 1. A 在首次同步前记录：先用临时标识；同步分配文件 ID 后并入并上传
    a.save("笔记.md", "第一版\n");
    a.sync(&remote);
    let own_ids = a.svc.sync_ctx().unwrap().own().list_doc_ids();
    assert_eq!(own_ids.len(), 1);
    assert!(!own_ids[0].starts_with("p-"), "临时标识应已换成正式文件 ID：{:?}", own_ids);
    assert!(remote_has(&remote, ".nb-history/A-device-id/catalog.json"));
    assert!(remote_has(&remote, ".nb-history/A-device-id/docs/"));
    assert!(remote_has(&remote, ".nb-history/A-device-id/blobs/"));
    // 主同步不上传 .nb-history 下的本地文件（例如临时标识映射）
    assert!(!remote_has(&remote, ".nb-history/A-device-id/identity.json"));

    // 2. B 同步：拿到文档与 A 的历史
    b.sync(&remote);
    let list = b.list("笔记.md");
    assert_eq!(list.len(), 1);
    assert_eq!(list[0], ("A-device-id".to_string(), false, "第一版\n".to_string()));

    // 3. B 修改并同步；A 同步后时间线包含双方版本，新到旧
    std::thread::sleep(std::time::Duration::from_millis(20));
    b.save("笔记.md", "第一版\nB 的补充\n");
    b.sync(&remote);
    a.sync(&remote);
    let list = a.list("笔记.md");
    let devices: Vec<&str> = list.iter().map(|(d, _, _)| d.as_str()).collect();
    assert_eq!(devices, vec!["B-device-id", "A-device-id"], "{:?}", list);
    assert_eq!(list[0].2, "第一版\nB 的补充\n");
    assert!(list[1].1, "A 自己的版本标记为本机");

    // 4. 再次同步没有变化：不重复上传（目录版本不变）
    let rev = |r: &Memory, d: &str| -> u64 {
        let files = r.files.lock().unwrap();
        let b = files.get(&format!(".nb-history/{}/catalog.json", d)).unwrap();
        serde_json::from_slice::<serde_json::Value>(b).unwrap()["rev"].as_u64().unwrap()
    };
    let before = rev(&remote, "A-device-id");
    a.sync(&remote);
    assert_eq!(rev(&remote, "A-device-id"), before);

    // 5. A 切到仅本机：两台设备的版本都导入本机；下次同步删除远端 A 目录，B 的不受影响
    let svc = a.svc.clone();
    a.with_state(|_| svc.set_mode(Mode::Local).unwrap());
    assert!(!a.root.path().join(".nb-history").exists());
    let p = a.path("笔记.md");
    let svc = a.svc.clone();
    let local_count = a.with_state(|_| svc.list(&p).entries.len());
    assert_eq!(local_count, 2);
    a.sync(&remote);
    assert!(!remote_has(&remote, ".nb-history/A-device-id/"), "远端 A 目录应已清理");
    assert!(remote_has(&remote, ".nb-history/B-device-id/catalog.json"));
    assert!(a.svc.config().retire_pending.is_empty());
}
