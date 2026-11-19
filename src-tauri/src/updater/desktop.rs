//! 桌面一键更新。只从官方发布渠道下载与本机安装方式匹配的签名附件。

use std::{
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use tauri::{AppHandle, Manager, WebviewWindow};
use tokio::sync::Mutex as AsyncMutex;

use super::commands::{
    build_direct_http_client, build_update_http_client, download_installer_with_fallback,
    update_cache_dir,
};
use crate::{
    release_channel::{ReleaseChannel, GITHUB_DOWNLOAD_BASE},
    state::AppState,
};

// 正式构建由发布工作流嵌入公钥；开发版和没有签名配置的发行版仅提供手动下载。
const PUBLIC_KEY: Option<&str> = option_env!("NOTEBOARD_UPDATE_PUBLIC_KEY");
const SIGNATURE_TIMEOUT: Duration = Duration::from_secs(40);

#[derive(Clone, Copy)]
enum PackageKind {
    #[cfg(windows)]
    Nsis,
    #[cfg(windows)]
    Portable,
    #[cfg(target_os = "macos")]
    App,
    #[cfg(target_os = "linux")]
    AppImage,
    #[cfg(target_os = "linux")]
    Deb,
}

impl PackageKind {
    /// 保留原有安装形态。AppImage 通过真正的外层文件路径更新；DEB 通过包管理器更新。
    fn running(app: &AppHandle) -> Option<Self> {
        #[cfg(windows)]
        {
            let _ = app;
            return Some(if crate::app_dirs::portable_data_root().is_some() {
                Self::Portable
            } else {
                Self::Nsis
            });
        }
        #[cfg(target_os = "macos")]
        {
            let _ = app;
            return mac_app_path().ok().map(|_| Self::App);
        }
        #[cfg(target_os = "linux")]
        {
            use tauri::utils::{config::BundleType, platform::bundle_type};
            match bundle_type() {
                Some(BundleType::AppImage) if app.env().appimage.is_some() => Some(Self::AppImage),
                Some(BundleType::Deb) => Some(Self::Deb),
                _ => None,
            }
        }
    }

    /// 文件名与发布工作流一致，并进入签名的可信注释，防止拿旧版本或其他发行格式冒充当前更新。
    fn filename(self, version: &str) -> Option<String> {
        let (windows, macos, linux) = match std::env::consts::ARCH {
            "x86_64" => ("x64", "x64", "amd64"),
            "aarch64" => ("arm64", "aarch64", "arm64"),
            _ => return None,
        };
        let _ = (windows, macos, linux);
        let name = match self {
            #[cfg(windows)]
            Self::Nsis => format!("NoteBoard_{version}_windows_{windows}-setup.exe"),
            #[cfg(windows)]
            Self::Portable => format!("NoteBoard_{version}_windows_{windows}_portable.exe"),
            #[cfg(target_os = "macos")]
            Self::App => format!("NoteBoard_{version}_{macos}.app.tar.gz"),
            #[cfg(target_os = "linux")]
            Self::AppImage => format!("NoteBoard_{version}_{linux}.AppImage"),
            #[cfg(target_os = "linux")]
            Self::Deb => format!("NoteBoard_{version}_{linux}.deb"),
        };
        Some(name)
    }
}

/// 只允许正式版本号进入路径，排除预发布、目录片段以及前导零等非规范形式。
fn stable_version(version: &str) -> Option<[u64; 3]> {
    let mut parts = version.split('.');
    let mut next = || {
        let value = parts.next()?;
        let number = value.parse::<u64>().ok()?;
        (number.to_string() == value).then_some(number)
    };
    let version = [next()?, next()?, next()?];
    parts.next().is_none().then_some(version)
}

fn signing_key() -> Result<PublicKey, String> {
    let value = PUBLIC_KEY
        .filter(|key| !key.trim().is_empty())
        .ok_or("此构建未配置桌面更新签名")?;
    let decoded = decode_signed_text(value)?;
    PublicKey::decode(&decoded).map_err(|error| format!("更新公钥无效：{error}"))
}

fn decode_signed_text(value: &str) -> Result<String, String> {
    let bytes = STANDARD
        .decode(value.trim())
        .map_err(|error| error.to_string())?;
    String::from_utf8(bytes).map_err(|error| error.to_string())
}

/// 发布列表只在客户端能校验签名、且版本与安装方式匹配时显示一键更新。
pub(super) fn package_for_release(app: &AppHandle, tag: &str) -> Option<String> {
    let version = tag.strip_prefix('v')?;
    stable_version(version)?;
    signing_key().ok()?;
    if cfg!(debug_assertions) {
        return None;
    }
    PackageKind::running(app)?.filename(version)
}

struct PreparedUpdate {
    id: String,
    owner: String,
    kind: PackageKind,
    file: PathBuf,
    signature: Signature,
    // 临时目录随准备结果释放，下载失败或换版本时自动清理。
    _directory: tempfile::TempDir,
}

#[derive(Default)]
pub struct DesktopUpdateState(AsyncMutex<Option<PreparedUpdate>>);

/// 使用 Tauri 签名格式流式校验发布包与签名中绑定的文件名。
fn verify_package(
    path: &Path,
    name: &str,
    key: &PublicKey,
    signature: &Signature,
) -> Result<(), String> {
    let signed_name = format!("file:{name}");
    if !signature
        .trusted_comment()
        .split('\t')
        .any(|part| part == signed_name)
    {
        return Err("签名与当前版本的更新包文件名不符".into());
    }
    let verify = || -> Result<(), Box<dyn std::error::Error>> {
        let mut file = BufReader::new(fs::File::open(path)?);
        let mut verifier = key.verify_stream(signature)?;
        loop {
            let chunk = file.fill_buf()?;
            if chunk.is_empty() {
                break;
            }
            verifier.update(chunk);
            let length = chunk.len();
            file.consume(length);
        }
        verifier.finalize()?;
        Ok(())
    };
    verify().map_err(|error| format!("更新包签名校验失败：{error}"))
}

/// 签名体积固定为几百字节，限制响应大小并沿用系统代理、直连回退。
async fn download_signature(url: &str) -> Result<Signature, String> {
    let request = |client: reqwest::Client| async move {
        let mut response = client
            .get(url)
            .header(reqwest::header::USER_AGENT, "NoteBoard")
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        let mut encoded = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            if encoded.len() + chunk.len() > 4096 {
                return Err("更新签名数据过大".to_string());
            }
            encoded.extend_from_slice(&chunk);
        }
        let decoded =
            decode_signed_text(std::str::from_utf8(&encoded).map_err(|e| e.to_string())?)?;
        Signature::decode(&decoded).map_err(|e| e.to_string())
    };
    match request(build_update_http_client(SIGNATURE_TIMEOUT)?).await {
        Ok(signature) => Ok(signature),
        Err(_) => request(build_direct_http_client(SIGNATURE_TIMEOUT)?).await,
    }
    .map_err(|error| format!("无法获取更新签名：{error}"))
}

/// 下载并校验。由 Rust 拼装官方附件地址，IPC 不接收任意 URL 或本地路径。
#[tauri::command]
pub async fn stage_desktop_update(
    app: AppHandle,
    window: WebviewWindow,
    version: String,
    channel: String,
) -> Result<String, String> {
    let current = stable_version(env!("CARGO_PKG_VERSION")).ok_or("当前版本号无效")?;
    if !stable_version(&version).is_some_and(|next| next > current) {
        return Err("更新版本必须高于当前版本".into());
    }
    let tag = format!("v{version}");
    let name = package_for_release(&app, &tag).ok_or("当前安装方式暂不可一键更新")?;
    let kind = PackageKind::running(&app).ok_or("无法识别当前安装方式")?;
    let state = app.state::<DesktopUpdateState>();
    let mut pending = state.0.try_lock().map_err(|_| "已有更新任务正在执行")?;
    // 用户修复未保存文档后重试时，仍可使用本窗口已校验的更新包。
    if let Some(prepared) = pending
        .as_ref()
        .filter(|item| item.owner == window.label() && item.file.ends_with(&name))
    {
        return Ok(prepared.id.clone());
    }
    let cache = update_cache_dir();
    fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let directory = tempfile::tempdir_in(cache).map_err(|e| e.to_string())?;
    let file = directory.path().join(&name);
    let url = ReleaseChannel::from_setting(&channel)
        .rewrite_download_url(&format!("{GITHUB_DOWNLOAD_BASE}{tag}/{name}"));
    let signature = download_signature(&format!("{url}.sig")).await?;
    download_installer_with_fallback(&app, &url, &file, None).await?;
    let (signature, file) = tauri::async_runtime::spawn_blocking(move || {
        verify_package(&file, &name, &signing_key()?, &signature)?;
        Ok::<_, String>((signature, file))
    })
    .await
    .map_err(|e| e.to_string())??;
    let id = uuid::Uuid::new_v4().to_string();
    *pending = Some(PreparedUpdate {
        id: id.clone(),
        owner: window.label().into(),
        kind,
        file,
        signature,
        _directory: directory,
    });
    Ok(id)
}

/// 最后一次核对窗口和文档状态。会话只恢复最近一个窗口，避免更新时丢失其他窗口的会话。
fn check_restart_ready(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<Mutex<AppState>>();
    let state = state.lock().map_err(|e| e.to_string())?;
    if state.documents.values().any(|doc| doc.is_dirty) {
        return Err("请先保存未保存的文档，再重试更新".into());
    }
    if state.windows.len() != 1 {
        return Err("请先关闭其他 NoteBoard 窗口，再重试更新".into());
    }
    Ok(())
}

/// 暂存完成后才冻结会话并应用。安装失败保留已下载的包，允许安全重试。
#[tauri::command]
pub async fn apply_desktop_update(
    app: AppHandle,
    window: WebviewWindow,
    id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DesktopUpdateState>();
        let mut pending = state.0.try_lock().map_err(|_| "已有更新任务正在执行")?;
        let update = pending
            .as_ref()
            .filter(|item| item.id == id && item.owner == window.label())
            .ok_or("请重新准备当前窗口的更新包")?;
        let name = update
            .file
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("更新包文件名无效")?;
        if let Err(error) = verify_package(&update.file, name, &signing_key()?, &update.signature) {
            // 缓存损坏时丢弃，以便下一次点击重新下载，而不是反复校验同一个坏包。
            *pending = None;
            return Err(error);
        }
        check_restart_ready(&app)?;
        install(&app, update).map_err(|e| format!("无法安装更新：{e}"))?;
        *pending = None;
        // Windows 的安装器或更新助手负责在旧进程退出后启动；Unix 保留 Tauri 的退出清理流程。
        #[cfg(windows)]
        app.exit(0);
        #[cfg(not(windows))]
        app.request_restart();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(windows)]
fn install(_: &AppHandle, update: &PreparedUpdate) -> std::io::Result<()> {
    use std::{io, os::windows::process::CommandExt, process::Command};

    match update.kind {
        PackageKind::Nsis => {
            // 安装器在应用退出后仍要读取自身文件；新版启动时按版本清理缓存。
            let name = update
                .file
                .file_name()
                .unwrap_or_default()
                .to_string_lossy();
            let installer = update_cache_dir().join(format!("{}_{name}", update.id));
            fs::copy(&update.file, &installer)?;
            let parent = format!("/NB_PID={}", std::process::id());
            if let Err(error) = Command::new(&installer)
                .args(["/P", "/UPDATE", "/R", &parent])
                .spawn()
            {
                let _ = fs::remove_file(installer);
                return Err(error);
            }
        }
        PackageKind::Portable => {
            // 同卷暂存使替换为原子操作，保留任意 EXE 文件名及同目录下的用户数据。
            let exe = std::env::current_exe()?;
            let parent = exe
                .parent()
                .ok_or_else(|| io::Error::other("无法定位免安装版目录"))?;
            let workspace = tempfile::Builder::new()
                .prefix(".noteboard-update-")
                .tempdir_in(parent)?;
            let source = workspace.path().join("new.exe");
            let script = workspace.path().join("apply.ps1");
            fs::copy(&update.file, &source)?;
            // Windows PowerShell 5.1 需要 BOM 才能读取 UTF-8 中文错误文案。
            fs::write(
                &script,
                concat!("\u{feff}", include_str!("replace-portable.ps1")),
            )?;
            let powershell = std::env::var_os("SystemRoot")
                .map(PathBuf::from)
                .ok_or_else(|| io::Error::other("无法定位 Windows PowerShell"))?
                .join("System32/WindowsPowerShell/v1.0/powershell.exe");
            // 参数单独传递，路径中的空格和引号不进入脚本命令。
            Command::new(powershell)
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                ])
                .arg(script)
                .arg(std::process::id().to_string())
                .arg(exe)
                .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                .spawn()?;
            let _ = workspace.keep();
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn install(app: &AppHandle, update: &PreparedUpdate) -> std::io::Result<()> {
    use std::{io, process::Command};

    match update.kind {
        PackageKind::AppImage => {
            // 先写入同目录临时文件再原子替换，写盘失败时保留可用旧版。
            let target = tauri::process::current_binary(&app.env())?.canonicalize()?;
            let parent = target
                .parent()
                .ok_or_else(|| io::Error::other("无法定位 AppImage 目录"))?;
            let mut staged = tempfile::NamedTempFile::new_in(parent)?;
            io::copy(&mut fs::File::open(&update.file)?, &mut staged)?;
            staged
                .as_file()
                .set_permissions(fs::metadata(&target)?.permissions())?;
            staged.as_file().sync_all()?;
            staged.persist(target)?;
        }
        PackageKind::Deb => {
            // 仅由系统 polkit 请求管理员授权；取消或安装失败时继续运行旧实例。
            let status = Command::new("/usr/bin/pkexec")
                .args(["/usr/bin/dpkg", "--install"])
                .arg(&update.file)
                .status()?;
            if !status.success() {
                return Err(io::Error::other(
                    "DEB 安装未完成，请检查系统授权或使用包管理器安装",
                ));
            }
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn mac_app_path() -> std::io::Result<PathBuf> {
    let binary = std::env::current_exe()?;
    binary
        .ancestors()
        .nth(3)
        .filter(|path| path.extension().is_some_and(|ext| ext == "app"))
        .map(Path::to_path_buf)
        .ok_or_else(|| std::io::Error::other("无法定位 NoteBoard.app"))
}

#[cfg(target_os = "macos")]
fn install(_: &AppHandle, update: &PreparedUpdate) -> std::io::Result<()> {
    use std::{ffi::CString, io, os::unix::ffi::OsStrExt, process::Command};

    let target = mac_app_path()?;
    let parent = target
        .parent()
        .ok_or_else(|| io::Error::other("无法定位应用目录"))?;
    let directory = tempfile::tempdir_in(parent)?;
    // 只解包已经校验签名的正式应用；同卷交换保留旧版，避免解包失败破坏正在用的应用。
    let status = Command::new("/usr/bin/tar")
        .arg("-xzf")
        .arg(&update.file)
        .arg("-C")
        .arg(directory.path())
        .status()?;
    let staged = directory.path().join("NoteBoard.app");
    if !status.success() || !staged.join("Contents/Info.plist").is_file() {
        return Err(io::Error::other("更新包缺少可用的 NoteBoard.app"));
    }
    let source = CString::new(staged.as_os_str().as_bytes())?;
    let destination = CString::new(target.as_os_str().as_bytes())?;
    // SAFETY: 两个路径均为有效 C 字符串，且在调用期间存活。
    if unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_SWAP) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_versions_exclude_path_and_prerelease() {
        assert_eq!(stable_version("1.2.3"), Some([1, 2, 3]));
        for value in [
            "1.2.3/../test",
            "1.2.3-beta",
            "v1.2.3",
            "1.02.3",
            "1.2.3.4",
            "1.2",
        ] {
            assert_eq!(stable_version(value), None, "{value}");
        }
    }

    #[test]
    fn verifies_tauri_signature_and_rejects_tampering_and_relabeling() {
        // 由 Tauri CLI 签名的公开测试样本。私钥未保存；只用于验证正式工具的签名格式。
        let public_key = PublicKey::decode(
            &decode_signed_text(concat!(
                "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDYyODU2ODRENDQ2QzgyNUMK",
                "UldSY2dteEVUV2lGWW5mam9nd0Qva3B5cWRjQ1loY1ZnMUJkdDRhZHZqdzVZNlpLblFKTW1FNDMK",
            ))
            .unwrap(),
        )
        .unwrap();
        let signature = Signature::decode(&decode_signed_text(concat!(
            "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSY2dteEVUV2lGWWk3U2RzNUprb0Yvd05HTG5H",
            "ZHZhbTBpd2R0VnJIVy9sY0ZkTXViUnZVejVLcHp3SU92ZjBZejNvOFZJTlBJRGVNTmJZQld6T2hvSkFhRCtlWW9mVlFjPQp0cnVzdGVkIGNvbW1l",
            "bnQ6IHRpbWVzdGFtcDoxNzk1MDc2MDQ0CWZpbGU6Tm90ZUJvYXJkXzEuMi4zX3dpbmRvd3NfeDY0LXNldHVwLmV4ZQpDNitYWHJ2cmd4aEdGNVp0",
            "OW50eHhITW1oTUV6QWV5bi9wTGFuUUkxUEg5bFNLNGJOaUZ2UFZPMUN6anAxdEpkdDhVMmJEMGY2VThDWS9CMjJQTmpDdz09Cg==",
        )).unwrap()).unwrap();
        let file = tempfile::NamedTempFile::new().unwrap();
        let name = "NoteBoard_1.2.3_windows_x64-setup.exe";
        fs::write(file.path(), b"NoteBoard fixture").unwrap();
        verify_package(file.path(), name, &public_key, &signature).unwrap();
        assert!(verify_package(
            file.path(),
            "NoteBoard_1.2.4_windows_x64-setup.exe",
            &public_key,
            &signature
        )
        .is_err());
        fs::write(file.path(), b"modified fixture").unwrap();
        assert!(verify_package(file.path(), name, &public_key, &signature).is_err());
    }
}
