// NoteBoard 应用目录统一入口
// Windows 免安装发布版使用 EXE 同目录的 data/NoteBoard；安装版与开发版保留已有 APPDATA 路径。
// macOS / Linux 与移动端在 setup 中使用 Tauri 平台目录，不能套用 Windows 的免安装判定。

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

// 免安装版必须在插件和 WebView 创建前写入；其他非 Windows 平台在 setup 时写入。
static DATA_ROOT_OVERRIDE: OnceLock<PathBuf> = OnceLock::new();
static CACHE_ROOT_OVERRIDE: OnceLock<PathBuf> = OnceLock::new();
// 只在 Windows 免安装发布版初始化，供更新器、资源包及所有窗口共用同一运行模式。
static PORTABLE_DATA_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// NSIS 安装目录带 uninstall.exe；开发构建始终沿用原路径，EXE 改名不影响免安装判定。
#[cfg(any(windows, test))]
fn windows_portable_root(exe: &Path, development: bool) -> Option<PathBuf> {
    let directory = exe.parent()?;
    if development || directory.join("uninstall.exe").is_file() {
        return None;
    }
    // data 可能属于其他程序，应用文件仅写入自己的专用子目录。
    Some(directory.join("data").join("NoteBoard"))
}

/// 返回当前免安装版的数据根目录；其他平台、安装版及开发版均返回 None。
pub fn portable_data_root() -> Option<&'static Path> {
    PORTABLE_DATA_ROOT.get().map(PathBuf::as_path)
}

/// 按数据目录生成稳定的实例标识：同目录覆盖升级/改名仍合并实例，不同副本与安装版互不接管。
#[cfg(any(windows, test))]
pub(crate) fn portable_identifier(identifier: &str, root: &Path) -> String {
    use sha2::{Digest, Sha256};
    let key = crate::path::normalize_key(&root.to_string_lossy());
    let digest = Sha256::digest(crate::path::lower_key(&key).as_bytes());
    format!("{identifier}.portable.{digest:x}")
}

/// 在主窗口和插件创建前准备本地数据目录；不可写时返回错误，禁止静默回退到安装版数据。
#[cfg(windows)]
pub fn init_portable() -> std::io::Result<()> {
    let exe = std::env::current_exe()?;
    if let Some(root) = windows_portable_root(&exe, cfg!(debug_assertions)) {
        activate_portable_root(root)?;
    }
    Ok(())
}

/// 所有应用目录同时切换，避免设置、插件和更新器各自推导出不同的数据归属。
#[cfg(any(windows, test))]
fn activate_portable_root(root: PathBuf) -> std::io::Result<()> {
    prepare_portable_root(&root)?;
    set_data_root(root.clone());
    set_cache_root(root.join("cache"));
    let _ = PORTABLE_DATA_ROOT.set(root);
    Ok(())
}

/// 提前验证数据、缓存与浏览器目录均可写，避免启动后才发现部分数据无法保存。
#[cfg(any(windows, test))]
fn prepare_portable_root(root: &Path) -> std::io::Result<()> {
    use std::io::ErrorKind;
    std::fs::create_dir_all(root)?;
    // 首次运行只接管空的专用目录；已有同名目录且无法确认归属时停止，不读取或覆盖其中的配置。
    let marker = root.join(".noteboard-portable");
    if !marker.is_file() && std::fs::read_dir(root)?.next().is_some() && !marker.is_file() {
        return Err(std::io::Error::new(
            ErrorKind::AlreadyExists,
            format!(
                "{} 已有其他内容且缺少 NoteBoard 标记，请先移动该子目录或换一个程序位置",
                root.display()
            ),
        ));
    }
    // 原子创建归属标记；并发首次启动时，另一个实例已创建同一标记也可继续。
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&marker)
    {
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::AlreadyExists && marker.is_file() => {}
        Err(error) => return Err(error),
    }
    for directory in [root.to_path_buf(), root.join("cache"), root.join("webview")] {
        std::fs::create_dir_all(&directory)?;
        // 临时探针离开作用域即删除，不覆盖用户已有文件。
        let _probe = tempfile::NamedTempFile::new_in(&directory)?;
    }
    Ok(())
}

/// 设置应用数据根目录（仅首次调用生效）
#[cfg_attr(desktop, allow(dead_code))]
pub fn set_data_root(path: PathBuf) {
    let _ = DATA_ROOT_OVERRIDE.set(path);
}

/// 设置缓存根目录（仅首次调用生效）
#[cfg_attr(desktop, allow(dead_code))]
pub fn set_cache_root(path: PathBuf) {
    let _ = CACHE_ROOT_OVERRIDE.set(path);
}

/// 应用数据目录：settings.json、session.json、favorites.json、drafts、staging 等均位于此处
pub fn app_data_dir() -> PathBuf {
    if let Some(root) = DATA_ROOT_OVERRIDE.get() {
        return root.clone();
    }
    let base = std::env::var("APPDATA")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(base).join("NoteBoard")
}

/// 临时/缓存目录：免安装版使用 data/NoteBoard/cache，其他端由系统或平台路径初始化。
pub fn cache_dir() -> PathBuf {
    if let Some(root) = CACHE_ROOT_OVERRIDE.get() {
        return root.clone();
    }
    std::env::temp_dir()
}

/// 移动端默认笔记工作区（应用私有目录，无需存储权限）
pub fn default_workspace_dir() -> PathBuf {
    app_data_dir().join("workspace")
}

/// 外部收件箱：系统分享/“用其他应用打开”传入的 content:// 文件复制到这里后再按普通路径打开
pub fn inbox_dir() -> PathBuf {
    app_data_dir().join("inbox")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 安装器和免安装分发复用同一 EXE，必须依据安装目录判定，不能依赖文件名或工作目录。
    #[test]
    fn portable_release_uses_executable_directory_even_after_rename() {
        let directory = tempfile::tempdir().unwrap();
        for name in ["NoteBoard_0.6.7_windows_x64_portable.exe", "笔记.exe"] {
            assert_eq!(
                windows_portable_root(&directory.path().join(name), false),
                Some(directory.path().join("data/NoteBoard"))
            );
        }
        assert_eq!(
            windows_portable_root(&directory.path().join("noteboard.exe"), true),
            None
        );
        std::fs::write(directory.path().join("uninstall.exe"), b"installer").unwrap();
        assert_eq!(
            windows_portable_root(&directory.path().join("NoteBoard.exe"), false),
            None
        );
    }

    /// 重复启动可复用目录；准备失败必须上报，不能改用 APPDATA 或吞掉冲突文件。
    #[test]
    fn portable_root_is_writable_and_preserves_existing_data() {
        let directory = tempfile::tempdir().unwrap();
        let data = directory.path().join("data");
        std::fs::create_dir(&data).unwrap();
        std::fs::write(data.join("settings.json"), b"other app").unwrap();
        let root = data.join("NoteBoard");
        prepare_portable_root(&root).unwrap();
        std::fs::write(root.join("settings.json"), b"existing").unwrap();
        prepare_portable_root(&root).unwrap();
        assert_eq!(
            std::fs::read(root.join("settings.json")).unwrap(),
            b"existing"
        );
        assert_eq!(
            std::fs::read(data.join("settings.json")).unwrap(),
            b"other app"
        );
        assert!(root.join("cache").is_dir());
        assert!(root.join("webview").is_dir());
        let blocked = directory.path().join("blocked");
        std::fs::write(&blocked, b"keep").unwrap();
        assert!(prepare_portable_root(&blocked).is_err());
        assert_eq!(std::fs::read(blocked).unwrap(), b"keep");
    }

    /// 同名专用目录也可能含用户文件；没有归属标记时不读取、不改名、不覆盖任何现有内容。
    #[test]
    fn unowned_nonempty_directory_is_rejected_without_changing_files() {
        let directory = tempfile::tempdir().unwrap();
        let settings = directory.path().join("settings.json");
        std::fs::write(&settings, b"unrelated settings").unwrap();
        assert!(prepare_portable_root(directory.path()).is_err());
        assert_eq!(std::fs::read(settings).unwrap(), b"unrelated settings");
        assert!(!directory.path().join(".noteboard-portable").exists());
        assert!(!directory.path().join("cache").exists());
    }

    /// 子目录被普通文件占用时明确失败，不能删除文件后强行创建缓存目录。
    #[test]
    fn portable_cache_collision_preserves_the_conflicting_file() {
        let directory = tempfile::tempdir().unwrap();
        prepare_portable_root(directory.path()).unwrap();
        std::fs::remove_dir(directory.path().join("cache")).unwrap();
        std::fs::write(directory.path().join("cache"), b"keep cache file").unwrap();
        assert!(prepare_portable_root(directory.path()).is_err());
        assert_eq!(
            std::fs::read(directory.path().join("cache")).unwrap(),
            b"keep cache file"
        );
    }

    /// 两次首次启动可能同时准备目录；归属标记与写入探针不能互相误判为其他程序的数据。
    #[test]
    fn concurrent_first_start_can_share_the_same_owned_directory() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("data/NoteBoard");
        let barrier = std::sync::Barrier::new(8);
        std::thread::scope(|scope| {
            for _ in 0..8 {
                scope.spawn(|| {
                    barrier.wait();
                    prepare_portable_root(&root).unwrap();
                });
            }
        });
        assert_eq!(std::fs::read_dir(root).unwrap().count(), 3);
    }

    /// 用独立测试进程实际保存设置、会话、草稿、收藏与同步配置，避免全局目录锁影响其他测试。
    #[test]
    fn portable_profile_keeps_persistent_data_and_resources_together() {
        const TEST_ROOT: &str = "NOTEBOARD_PORTABLE_TEST_ROOT";
        let Ok(root) = std::env::var(TEST_ROOT) else {
            let directory = tempfile::tempdir().unwrap();
            // 用隔离的安装版配置哨兵验证免安装版既不继承旧设置，也不改写旧数据。
            let installed = directory.path().join("installed/NoteBoard");
            std::fs::create_dir_all(&installed).unwrap();
            std::fs::write(installed.join("settings.json"), br#"{"revision":99}"#).unwrap();
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "app_dirs::tests::portable_profile_keeps_persistent_data_and_resources_together"])
                .env(TEST_ROOT, directory.path().join("data/NoteBoard"))
                .env("APPDATA", directory.path().join("installed"))
                .env("LOCALAPPDATA", directory.path().join("installed-local"))
                .output().unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(
                std::fs::read(installed.join("settings.json")).unwrap(),
                br#"{"revision":99}"#
            );
            assert!(!directory.path().join("installed-local").exists());
            return;
        };
        let root = PathBuf::from(root);
        activate_portable_root(root.clone()).unwrap();
        assert_eq!(crate::settings::model::load().revision, 0);
        assert_eq!(app_data_dir(), root);
        assert_eq!(cache_dir(), root.join("cache"));
        assert_eq!(
            crate::font_pack::font_packs_root_dir(),
            root.join("font-packs")
        );
        assert_eq!(crate::sync::config::sync_data_dir(), root.join("sync"));
        assert_eq!(
            crate::settings::model::default_staging_directory(),
            root.join("staging").to_string_lossy()
        );

        let mut settings = crate::settings::model::Settings::default();
        crate::settings::model::save(&mut settings).unwrap();
        crate::session::commands::save_session(crate::session::Session::default()).unwrap();
        crate::session::commands::write_draft(
            "untitled:test".into(),
            "便携草稿".into(),
            "markdown".into(),
        )
        .unwrap();
        crate::favorites::commands::save_favorites(crate::favorites::FavoritesData::default())
            .unwrap();
        crate::sync::config::save(&crate::sync::config::SyncConfigFile::default()).unwrap();
        for relative in ["settings.json", "favorites.json", "sync/config.json"] {
            assert!(
                root.join(relative).is_file(),
                "{relative} 应写入免安装数据目录"
            );
        }
        let session_name = if cfg!(debug_assertions) {
            "session-dev.json"
        } else {
            "session.json"
        };
        assert!(root.join(session_name).is_file());
        assert_eq!(std::fs::read_dir(root.join("drafts")).unwrap().count(), 1);
        let stored: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join("settings.json")).unwrap()).unwrap();
        assert!(stored["file"].get("stagingDirectory").is_none());
    }

    /// 实例标识只绑定目录，不绑定版本或 EXE 文件名，不同便携副本可以同时运行。
    #[test]
    fn portable_instance_identity_is_stable_and_isolated() {
        let directory = tempfile::tempdir().unwrap();
        let first = windows_portable_root(&directory.path().join("first/v1.exe"), false).unwrap();
        let renamed = windows_portable_root(&directory.path().join("first/v2.exe"), false).unwrap();
        let second =
            windows_portable_root(&directory.path().join("second/NoteBoard.exe"), false).unwrap();
        let identifier = "com.crazyfigure.noteboard";
        assert_eq!(
            portable_identifier(identifier, &first),
            portable_identifier(identifier, &renamed)
        );
        assert_ne!(
            portable_identifier(identifier, &first),
            portable_identifier(identifier, &second)
        );
        assert_ne!(portable_identifier(identifier, &first), identifier);
    }

    /// Windows 的实例标识应与文件系统的大小写不敏感规则一致。
    #[cfg(windows)]
    #[test]
    fn portable_instance_identity_ignores_windows_path_case() {
        assert_eq!(
            portable_identifier("noteboard", Path::new("C:\\便携\\data")),
            portable_identifier("noteboard", Path::new("c:\\便携\\DATA")),
        );
    }

    /// 非 Windows 发布物不启用 EXE 同目录写入，继续依赖各自平台目录。
    #[cfg(not(windows))]
    #[test]
    fn other_platforms_do_not_enable_windows_portable_mode() {
        assert!(portable_data_root().is_none());
    }
}
