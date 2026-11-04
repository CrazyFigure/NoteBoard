// 本地文件搜索：并行目录遍历与排除规则
//
// 普通权限下无法读取 NTFS 主文件表，这里用多线程逐目录列举（Windows 上目录项自带大小与时间，
// 不需要额外系统调用）。遍历线程以后台优先级运行，不与界面争抢 CPU 与磁盘。
// 排除规则只作用于索引根目录之下：用户明确添加的位置即使命中规则也照常索引。

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf, MAIN_SEPARATOR};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};

/// 目录中的一项
#[derive(Debug, Clone)]
pub struct RawEntry {
    pub name: String,
    /// 真实目录（不含符号链接）
    pub is_dir: bool,
    /// 是否进入目录内部：隐藏目录（多为工具数据）与软件包只收录自身
    pub descend: bool,
    /// 符号链接或目录联接（只记录名字，不跟随）
    pub is_link: bool,
    pub hidden: bool,
    /// 云盘占位文件等，读取会触发下载，不建立内容索引
    pub no_content: bool,
    pub size: u64,
    pub mtime: u32,
}

/// 一个目录的列举结果
#[derive(Debug)]
pub struct Listing {
    pub dir: PathBuf,
    pub entries: Vec<RawEntry>,
    /// 读取失败（无权限、已删除）
    pub ok: bool,
    /// 缓存目录（含 CACHEDIR.TAG）：不收录其中内容
    pub cache_dir: bool,
    /// 含可执行程序或动态库：视为软件安装目录，子树只收录文件名
    pub program_dir: bool,
}

/// 排除规则
#[derive(Debug, Default)]
pub struct Rules {
    /// 任意层级都不进入的目录名（已折叠）
    dir_names: HashSet<String>,
    /// 不进入的目录前缀（已折叠，以分隔符结尾）
    prefixes: Vec<String>,
    /// 以这些后缀结尾的目录不进入（如 \appdata\local）
    suffixes: Vec<String>,
    /// 只收录文件名、不建立内容索引的目录前缀
    content_prefixes: Vec<String>,
    /// 只收录包本身、不进入其内部的目录扩展名（macOS 应用包等）
    package_exts: Vec<&'static str>,
    /// 索引根目录（已折叠，以分隔符结尾）：用户明确添加的位置不受前缀规则影响
    roots: Vec<String>,
}

/// 通用排除目录名：版本库、依赖与缓存、系统回收站与元数据
const EXCLUDED_DIR_NAMES: &[&str] = &[
    ".git", ".svn", ".hg", "node_modules", "bower_components", "__pycache__", ".mypy_cache", ".pytest_cache",
    ".tox", ".venv", "site-packages", ".gradle", ".next", ".nuxt", ".turbo", ".parcel-cache", ".cache",
    "$recycle.bin", "system volume information", ".trash", ".trashes", ".spotlight-v100", ".fseventsd",
    ".documentrevisions-v100", ".temporaryitems", "lost+found",
];

/// 路径折叠：Windows 统一小写与反斜杠；其他平台保持原样
pub fn fold_path(path: &str) -> String {
    if cfg!(windows) {
        path.replace('/', "\\").to_lowercase()
    } else {
        path.to_string()
    }
}

fn with_sep(mut s: String) -> String {
    if !s.ends_with(MAIN_SEPARATOR) {
        s.push(MAIN_SEPARATOR);
    }
    s
}

fn home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var).map(PathBuf::from).filter(|p| p.is_absolute())
}

impl Rules {
    /// 按索引根目录生成规则；系统目录排除只在添加整盘时才会起作用
    pub fn new(roots: &[PathBuf], extra_excludes: &[PathBuf]) -> Rules {
        let mut rules = Rules {
            dir_names: EXCLUDED_DIR_NAMES.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        };
        let mut prefixes: Vec<PathBuf> = extra_excludes.to_vec();
        let mut content: Vec<PathBuf> = Vec::new();
        let home = home_dir();
        if cfg!(windows) {
            // 各盘根目录下的系统目录
            for root in roots {
                let s = root.to_string_lossy();
                if s.len() <= 3 && s.as_bytes().get(1) == Some(&b':') {
                    let drive = PathBuf::from(format!("{}\\", &s[..2]));
                    for name in ["Windows", "$WinREAgent", "$SysReset", "$Windows.~BT", "$Windows.~WS", "Recovery", "Config.Msi", "PerfLogs", "MSOCache"] {
                        prefixes.push(drive.join(name));
                    }
                    for name in ["Program Files", "Program Files (x86)", "ProgramData"] {
                        content.push(drive.join(name));
                    }
                }
            }
            // 用户目录中的本机缓存（浏览器缓存、临时文件），频繁变动且对搜索没有意义
            rules.suffixes.push(fold_path("\\AppData\\Local"));
            rules.suffixes.push(fold_path("\\AppData\\LocalLow"));
            if let Some(home) = &home {
                content.push(home.join("AppData"));
            }
            if let Some(temp) = std::env::var_os("TEMP") {
                prefixes.push(PathBuf::from(temp));
            }
        } else if cfg!(target_os = "macos") {
            for name in ["/System", "/private", "/dev", "/Volumes", "/cores", "/usr", "/bin", "/sbin", "/opt", "/Library", "/Network"] {
                prefixes.push(PathBuf::from(name));
            }
            content.push(PathBuf::from("/Applications"));
            if let Some(home) = &home {
                for name in ["Caches", "Containers", "Group Containers", "Application Support", "Logs", "Developer", "Saved Application State", "Metadata", "Biome"] {
                    prefixes.push(home.join("Library").join(name));
                }
                content.push(home.join("Library"));
            }
            rules.package_exts = vec!["app", "framework", "bundle", "photoslibrary", "musiclibrary", "plugin", "kext", "xcarchive"];
        } else {
            for name in ["/proc", "/sys", "/dev", "/run", "/snap", "/tmp", "/var/tmp", "/var/cache", "/var/lib", "/var/log", "/boot", "/usr", "/lib", "/lib32", "/lib64", "/libx32", "/bin", "/sbin", "/mnt", "/media", "/lost+found"] {
                prefixes.push(PathBuf::from(name));
            }
            content.push(PathBuf::from("/etc"));
            content.push(PathBuf::from("/opt"));
            if let Some(home) = &home {
                prefixes.push(home.join(".local").join("share").join("Trash"));
                content.push(home.join(".local"));
                content.push(home.join(".config"));
            }
        }
        // 用户目录中的包管理器与运行环境（scoop 软件、Go 模块缓存、conda 环境），文件数量巨大且不是用户文档
        if let Some(home) = &home {
            for name in ["scoop", "miniconda3", "anaconda3", "miniforge3"] {
                prefixes.push(home.join(name));
            }
            prefixes.push(home.join("go").join("pkg"));
        }
        // 本软件的数据目录（索引快照、历史记录、暂存）不能被自己索引，否则写快照会触发自我更新
        prefixes.push(crate::app_dirs::app_data_dir());
        rules.prefixes = prefixes.iter().map(|p| with_sep(fold_path(&p.to_string_lossy()))).collect();
        rules.content_prefixes = content.iter().map(|p| with_sep(fold_path(&p.to_string_lossy()))).collect();
        rules.roots = roots.iter().map(|p| with_sep(fold_path(&p.to_string_lossy()))).collect();
        rules
    }

    /// 前缀规则是否作用于该目录：若某个根目录位于规则范围之内且包含该目录，说明用户明确添加了这里，不排除
    fn prefix_hit(&self, prefixes: &[String], dir_with_sep: &str) -> bool {
        prefixes.iter().any(|p| {
            dir_with_sep.starts_with(p.as_str())
                && !self.roots.iter().any(|r| r.starts_with(p.as_str()) && dir_with_sep.starts_with(r.as_str()))
        })
    }

    /// 遍历时是否跳过某个子目录（path 为子目录完整路径）
    pub fn skip_dir(&self, path: &Path, name: &str) -> bool {
        if self.dir_names.contains(&name.to_lowercase()) {
            return true;
        }
        let folded = fold_path(&path.to_string_lossy());
        let with = with_sep(folded.clone());
        if self.prefix_hit(&self.prefixes, &with) {
            return true;
        }
        self.suffixes.iter().any(|s| folded.ends_with(s.as_str()))
    }

    /// 是否为只收录自身、不进入内部的软件包目录
    pub fn is_package(&self, name: &str) -> bool {
        if self.package_exts.is_empty() {
            return false;
        }
        name.rsplit_once('.').is_some_and(|(_, ext)| self.package_exts.contains(&ext.to_ascii_lowercase().as_str()))
    }

    /// 目录下的文件是否允许建立内容索引
    pub fn content_allowed(&self, dir: &Path) -> bool {
        let with = with_sep(fold_path(&dir.to_string_lossy()));
        !self.prefix_hit(&self.content_prefixes, &with)
    }

    /// 监听事件的路径是否落在排除范围内（只检查根目录之下的各级目录）
    pub fn path_excluded(&self, path: &Path, root: &Path) -> bool {
        let Ok(rest) = path.strip_prefix(root) else { return false };
        let mut cur = root.to_path_buf();
        let comps: Vec<_> = rest.components().collect();
        // 最后一级可能是文件，只检查其上各级目录；若最后一级本身是被排除的目录也一并忽略
        for (i, comp) in comps.iter().enumerate() {
            let name = comp.as_os_str().to_string_lossy();
            cur.push(comp.as_os_str());
            let is_last = i + 1 == comps.len();
            if self.skip_dir(&cur, &name) && (!is_last || self.dir_names.contains(&name.to_lowercase()) || cur.is_dir()) {
                return true;
            }
            // 隐藏目录与软件包内部不收录（目录自身的增删仍然处理）
            if !is_last && (name.starts_with('.') || self.is_package(&name)) {
                return true;
            }
        }
        false
    }
}

/// 把当前线程设为后台优先级（降低 CPU 与磁盘优先级），避免建索引时影响前台操作
pub fn lower_thread_priority() {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_MODE_BACKGROUND_BEGIN};
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN);
    }
    #[cfg(target_os = "linux")]
    unsafe {
        // Linux 的 nice 值按线程生效
        let tid = libc::syscall(libc::SYS_gettid) as libc::id_t;
        let _ = libc::setpriority(libc::PRIO_PROCESS, tid, 10);
    }
    #[cfg(target_os = "macos")]
    unsafe {
        let _ = libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_UTILITY, 0);
    }
}

fn unix_secs(t: std::io::Result<std::time::SystemTime>) -> u32 {
    t.ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs().min(u32::MAX as u64) as u32)
        .unwrap_or(0)
}

/// 由元数据生成目录项（遍历与监听更新共用）
pub fn raw_entry(name: String, meta: &fs::Metadata) -> RawEntry {
    let ft = meta.file_type();
    let is_link = ft.is_symlink();
    let dot = name.starts_with('.');
    #[cfg(windows)]
    let (hidden, no_content) = {
        use std::os::windows::fs::MetadataExt;
        const HIDDEN: u32 = 0x2;
        const OFFLINE: u32 = 0x1000;
        const RECALL_ON_OPEN: u32 = 0x40000;
        const RECALL_ON_DATA_ACCESS: u32 = 0x400000;
        let attrs = meta.file_attributes();
        // OneDrive 等仅在线文件：读取内容会触发下载
        (dot || attrs & HIDDEN != 0, attrs & (OFFLINE | RECALL_ON_OPEN | RECALL_ON_DATA_ACCESS) != 0)
    };
    #[cfg(target_os = "macos")]
    let (hidden, no_content) = {
        use std::os::macos::fs::MetadataExt;
        // iCloud 未下载文件（SF_DATALESS）
        (dot, meta.st_flags() & 0x4000_0000 != 0)
    };
    #[cfg(not(any(windows, target_os = "macos")))]
    let (hidden, no_content) = (dot, false);
    let is_dir = ft.is_dir() && !is_link;
    RawEntry {
        name,
        is_dir,
        // 隐藏目录（.cargo、.vscode、AppData 等）多为工具与缓存数据，不进入内部
        descend: is_dir && !hidden,
        is_link,
        hidden,
        no_content,
        size: if ft.is_file() { meta.len() } else { 0 },
        mtime: unix_secs(meta.modified()),
    }
}

/// 是否为软件安装目录的标志文件：动态库或卸载程序
/// （单独的 .exe 不算：下载与桌面目录常放安装包，不能因此漏掉其中的文档）
pub fn is_program_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".dll") && lower.len() > 4 || lower.ends_with(".exe") && (lower.starts_with("unins") || lower.starts_with("uninstall"))
}

/// 列举单个目录（不递归）
pub fn list_dir(dir: &Path, rules: &Rules) -> Listing {
    let mut listing = Listing { dir: dir.to_path_buf(), entries: Vec::new(), ok: true, cache_dir: false, program_dir: false };
    let read = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => {
            listing.ok = false;
            return listing;
        }
    };
    for item in read.flatten() {
        // 非 UTF-8 名字极少见，无法可靠还原路径，直接跳过
        let Ok(name) = item.file_name().into_string() else { continue };
        if name == "CACHEDIR.TAG" {
            listing.cache_dir = true;
        }
        if is_program_file(&name) {
            listing.program_dir = true;
        }
        // Windows 上目录项自带元数据；其他平台为一次 lstat
        let Ok(meta) = item.metadata() else { continue };
        let mut raw = raw_entry(name, &meta);
        if raw.is_dir {
            let path = dir.join(&raw.name);
            if rules.skip_dir(&path, &raw.name) {
                continue;
            }
            // 软件包只收录自身，不进入内部
            if rules.is_package(&raw.name) {
                raw.descend = false;
            }
        }
        listing.entries.push(raw);
    }
    if listing.cache_dir {
        listing.entries.clear();
    }
    listing
}

/// 并行遍历多个起点目录；每列举完一个目录调用一次 sink（父目录总在子目录之前送出）
pub fn walk(starts: Vec<PathBuf>, rules: &Rules, threads: usize, cancel: &AtomicBool, sink: &(dyn Fn(Listing) + Sync)) {
    struct Queue {
        dirs: Vec<PathBuf>,
        active: usize,
    }
    let state = Mutex::new(Queue { dirs: starts, active: 0 });
    let cv = Condvar::new();
    std::thread::scope(|scope| {
        for _ in 0..threads.max(1) {
            scope.spawn(|| {
                lower_thread_priority();
                loop {
                    // 取下一个目录；队列为空且没有线程在工作时结束
                    let dir = {
                        let mut q = state.lock().unwrap();
                        loop {
                            if cancel.load(Ordering::Relaxed) {
                                q.dirs.clear();
                            }
                            if let Some(d) = q.dirs.pop() {
                                q.active += 1;
                                break Some(d);
                            }
                            if q.active == 0 {
                                break None;
                            }
                            q = cv.wait(q).unwrap();
                        }
                    };
                    let Some(dir) = dir else {
                        cv.notify_all();
                        return;
                    };
                    let listing = list_dir(&dir, rules);
                    let subdirs: Vec<PathBuf> = listing.entries.iter().filter(|e| e.descend).map(|e| dir.join(&e.name)).collect();
                    // 先送出本目录，再把子目录放入队列，保证接收方先建立父目录
                    sink(listing);
                    let mut q = state.lock().unwrap();
                    if !cancel.load(Ordering::Relaxed) {
                        q.dirs.extend(subdirs);
                    }
                    q.active -= 1;
                    drop(q);
                    cv.notify_all();
                }
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    #[test]
    fn walk_lists_parents_before_children_and_skips_excluded() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        fs::create_dir_all(root.join("a/b/c")).unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::create_dir_all(root.join("build")).unwrap();
        fs::write(root.join("build/CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55").unwrap();
        fs::write(root.join("build/out.txt"), "x").unwrap();
        fs::write(root.join("a/b/c/note.md"), "hello").unwrap();
        let rules = Rules::new(std::slice::from_ref(&root), &[]);
        let seen = StdMutex::new(Vec::<(PathBuf, usize, bool)>::new());
        walk(vec![root.clone()], &rules, 3, &AtomicBool::new(false), &|l: Listing| {
            seen.lock().unwrap().push((l.dir.clone(), l.entries.len(), l.cache_dir));
        });
        let seen = seen.into_inner().unwrap();
        let order: Vec<&PathBuf> = seen.iter().map(|s| &s.0).collect();
        let pos = |p: &Path| order.iter().position(|x| x.as_path() == p).unwrap();
        assert!(pos(&root) < pos(&root.join("a")));
        assert!(pos(&root.join("a/b")) < pos(&root.join("a/b/c")));
        assert!(!order.iter().any(|p| p.ends_with("node_modules")));
        let build = seen.iter().find(|s| s.0 == root.join("build")).unwrap();
        assert!(build.2 && build.1 == 0);
    }

    #[test]
    fn rules_only_apply_below_roots() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        fs::create_dir_all(root.join("node_modules/x")).unwrap();
        let rules = Rules::new(std::slice::from_ref(&root), &[]);
        assert!(rules.path_excluded(&root.join("node_modules/x/index.js"), &root));
        assert!(!rules.path_excluded(&root.join("src/index.js"), &root));
        // 根目录自身即使名字命中规则也照常处理
        let nm_root = root.join("node_modules");
        assert!(!rules.path_excluded(&nm_root.join("x/index.js"), &nm_root));
    }

    #[cfg(windows)]
    #[test]
    fn windows_drive_rules_skip_system_folders() {
        let rules = Rules::new(&[PathBuf::from("C:\\")], &[]);
        assert!(rules.skip_dir(Path::new("C:\\Windows"), "Windows"));
        assert!(rules.skip_dir(Path::new("C:\\Users\\a\\AppData\\Local"), "Local"));
        assert!(!rules.skip_dir(Path::new("C:\\Users\\a\\Documents"), "Documents"));
        assert!(!rules.content_allowed(Path::new("C:\\Program Files\\App")));
        assert!(rules.content_allowed(Path::new("C:\\Users\\a\\Documents")));
    }
}
