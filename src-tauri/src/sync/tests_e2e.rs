// 端到端同步测试：两台「设备」各自一个本地目录，通过同一个内存远端轮流同步，
// 覆盖首次上传/下载、两端改不同行的行级合并、应用外改名、删除进回收站、恢复、删除与修改的时间裁决、幂等。

use super::backend::memory::Memory;
use super::backend::Backend;
use super::config::SyncSettings;
use super::engine::{run_sync_with, SyncOutcome};
use super::state::{self, LocalState};
use super::trash;
use std::path::Path;

struct Device {
    root: tempfile::TempDir,
    state: LocalState,
    id: String,
    name: String,
}

impl Device {
    fn new(name: &str) -> Self {
        Self { root: tempfile::tempdir().unwrap(), state: LocalState::default(), id: format!("{}-device-id", name), name: name.into() }
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

    fn path(&self, rel: &str) -> std::path::PathBuf {
        super::util::rel_to_abs(self.root.path(), rel)
    }

    fn write(&self, rel: &str, content: &str) {
        let p = self.path(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }

    fn read(&self, rel: &str) -> Option<String> {
        std::fs::read_to_string(self.path(rel)).ok()
    }

    /// 在该设备的状态上下文中执行（回收站等操作读写全局状态）
    fn with_state<R>(&mut self, f: impl FnOnce(&Path) -> R) -> R {
        state::swap_for_test(std::mem::take(&mut self.state));
        let r = f(self.root.path());
        self.state = state::swap_for_test(LocalState::default());
        r
    }

    fn sync(&mut self, remote: &Memory) -> SyncOutcome {
        let settings = self.settings();
        let id = self.id.clone();
        let backend = Backend::Memory(remote.clone());
        let out = self.with_state(|_| tauri::async_runtime::block_on(run_sync_with(&settings, &id, "test", Ok(backend))));
        assert!(out.report.ok, "{} 同步失败：{:?}", self.name, out.report.errors);
        out
    }
}

fn pause() {
    std::thread::sleep(std::time::Duration::from_millis(30));
}

#[test]
fn two_devices_full_lifecycle() {
    // 测试数据写入临时应用数据目录，绝不触碰真实的用户配置
    let data = tempfile::tempdir().unwrap();
    crate::app_dirs::set_data_root(data.path().to_path_buf());

    let remote = Memory::default();
    let mut a = Device::new("A");
    let mut b = Device::new("B");

    // 1. A 首次同步：上传全部文件（含二进制）
    a.write("a.md", "l1\nl2\nl3\n");
    a.write("目录/b.md", "B");
    std::fs::write(a.path("img.bin"), [0u8, 159, 146, 150]).unwrap();
    let out = a.sync(&remote);
    assert_eq!(out.report.upload.added, 3);
    assert!(remote.files.lock().unwrap().contains_key(".noteboard-sync/manifest.json"));

    // 2. B 首次同步：下载全部文件
    let out = b.sync(&remote);
    assert_eq!(out.report.download.added, 3);
    assert_eq!(b.read("a.md").unwrap(), "l1\nl2\nl3\n");
    assert_eq!(std::fs::read(b.path("img.bin")).unwrap(), vec![0u8, 159, 146, 150]);

    // 3. 两端同时修改同一文档的不同行 → 行级合并，两处修改都保留
    pause();
    a.write("a.md", "L1\nl2\nl3\n");
    b.write("a.md", "l1\nl2\nL3\n");
    a.sync(&remote);
    let out = b.sync(&remote);
    assert_eq!(out.report.merged, 1);
    assert_eq!(b.read("a.md").unwrap(), "L1\nl2\nL3\n");
    a.sync(&remote);
    assert_eq!(a.read("a.md").unwrap(), "L1\nl2\nL3\n");

    // 4. B 在应用外改名 → A 执行改名（不是删除+新建）
    std::fs::rename(b.path("目录/b.md"), b.path("目录/c.md")).unwrap();
    let out = b.sync(&remote);
    assert_eq!(out.report.upload.modified, 1);
    let out = a.sync(&remote);
    assert_eq!(out.report.download.modified, 1);
    assert!(a.read("目录/b.md").is_none());
    assert_eq!(a.read("目录/c.md").unwrap(), "B");

    // 5. A 删除文件（应用外删除）→ 两端都移入同步回收站
    std::fs::remove_file(a.path("a.md")).unwrap();
    let out = a.sync(&remote);
    assert_eq!(out.report.upload.deleted, 1);
    assert_eq!(a.read(".nb-trash/a.md").unwrap(), "L1\nl2\nL3\n");
    let out = b.sync(&remote);
    assert_eq!(out.report.download.deleted, 1);
    assert!(b.read("a.md").is_none());
    assert_eq!(b.read(".nb-trash/a.md").unwrap(), "L1\nl2\nL3\n");
    let items = b.with_state(|root| trash::list_items(root, 30, true));
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].orig_path, "a.md");
    assert!(items[0].expires_at > items[0].trashed_at);

    // 6. B 从回收站恢复 → A 也恢复
    b.with_state(|root| trash::restore(root, ".nb-trash/a.md")).unwrap();
    b.sync(&remote);
    let out = a.sync(&remote);
    assert_eq!(out.report.download.added, 1);
    assert_eq!(a.read("a.md").unwrap(), "L1\nl2\nL3\n");
    assert!(a.read(".nb-trash/a.md").is_none());

    // 7. 恢复时原位置已有同名文件 → 自动追加序号
    std::fs::remove_file(a.path("a.md")).unwrap();
    a.sync(&remote);
    a.write("a.md", "新的 a");
    a.with_state(|root| trash::restore(root, ".nb-trash/a.md")).unwrap();
    assert_eq!(a.read("a (1).md").unwrap(), "L1\nl2\nL3\n");
    assert_eq!(a.read("a.md").unwrap(), "新的 a");
    a.sync(&remote);
    b.sync(&remote);
    assert_eq!(b.read("a (1).md").unwrap(), "L1\nl2\nL3\n");
    assert_eq!(b.read("a.md").unwrap(), "新的 a");

    // 8. 删除与修改：B 先删除，A 之后修改 → 修改更新，文件回到原位置并带上修改
    pause();
    std::fs::remove_file(b.path("目录/c.md")).unwrap();
    b.sync(&remote);
    pause();
    a.write("目录/c.md", "A 删除之后的修改");
    a.sync(&remote);
    assert_eq!(a.read("目录/c.md").unwrap(), "A 删除之后的修改");
    b.sync(&remote);
    assert_eq!(b.read("目录/c.md").unwrap(), "A 删除之后的修改");
    assert!(b.read(".nb-trash/c.md").is_none());

    // 9. 再同步一轮：两端都没有任何变化（幂等）
    let out = a.sync(&remote);
    assert_eq!(out.report.upload.total() + out.report.download.total(), 0, "{:?}", out.report);
    let out = b.sync(&remote);
    assert_eq!(out.report.upload.total() + out.report.download.total(), 0, "{:?}", out.report);

    // 10. 新设备 C 首次同步时本地已有同名但内容不同的旧文件：较新的远端版本胜出，
    //     C 的旧内容作为「本机冲突版本」保留在回收站，不会悄悄丢失
    let mut c = Device::new("C");
    c.write("a.md", "C 设备上很久以前的 a");
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(3600 * 24 * 30);
    std::fs::File::options().write(true).open(c.path("a.md")).unwrap().set_modified(old).unwrap();
    let out = c.sync(&remote);
    assert_eq!(c.read("a.md").unwrap(), "新的 a");
    assert!(out.report.conflicts >= 1);
    let trash_items = c.with_state(|root| trash::list_items(root, 30, true));
    let copy = trash_items.iter().find(|t| t.name.contains("本机冲突版本")).expect("冲突版本应保留在回收站");
    assert_eq!(copy.orig_path, "a.md");
    assert_eq!(std::fs::read_to_string(c.path(&copy.id)).unwrap(), "C 设备上很久以前的 a");
}
