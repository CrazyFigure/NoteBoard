//! NoteBoard 应用更新检查、安装包下载与系统外链唤起模块。
//! 支持 Windows 系统代理与 Android 非 VPN 网络直连回退，以及准确的 GitHub API 限流识别。
//! 一次请求 Release 列表，汇总当前版本之后所有未安装版本的更新日志；
//! Android 在应用内下载 APK 后直接调起系统安装器，不再依赖浏览器下载。

use std::{
    fs,
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

// 仅桌面端需要启动安装器进程或系统打开命令
#[cfg(desktop)]
use std::process::Command;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::dto::{UpdateCheckResult, UpdateReleaseNote};

// GitHub Release 响应实体定义
#[derive(Debug, Deserialize)]
struct GitHubReleaseResponse {
    tag_name: String,
    name: Option<String>,
    html_url: String,
    published_at: Option<String>,
    body: Option<String>,
    // 草稿与预发布版本不参与更新提示，与原 releases/latest 接口语义一致
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<GitHubReleaseAsset>,
}

// GitHub Release 单个资产定义
#[derive(Debug, Clone, Deserialize)]
struct GitHubReleaseAsset {
    name: String,
    browser_download_url: String,
    size: Option<u64>,
}

// HTTP 连接建立超时限制（8秒快速失败）
const UPDATE_HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
// HTTP 数据分块读取超时限制（40秒提升慢速网络容忍度）
const UPDATE_HTTP_READ_TIMEOUT: Duration = Duration::from_secs(40);
// 安装包下载全局超时上限（10分钟）
const UPDATE_INSTALLER_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
// 下载进度事件名称，与前端监听保持一致
const UPDATE_DOWNLOAD_PROGRESS_EVENT: &str = "noteboard-update-download-progress";
// 下载进度事件推送节流间隔（100毫秒）
const UPDATE_DOWNLOAD_PROGRESS_THROTTLE: Duration = Duration::from_millis(100);

// GitHub 仓库与 API 默认地址
const GITHUB_REPO_URL: &str = "https://github.com/CrazyFigure/NoteBoard";
// 单页 Release 数量；改动时需同步 Android 直连（NbUpdateNetwork.kt）中的地址
const GITHUB_RELEASE_PAGE_SIZE: usize = 30;
const GITHUB_RELEASE_API_URL: &str =
    "https://api.github.com/repos/CrazyFigure/NoteBoard/releases?per_page=30";

/// 统一 Rust HTTP 与 Android 原生直连的响应，保留限流头与正文供后续准确分类。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseHttpResponse {
    status: u16,
    rate_limit_remaining: Option<String>,
    rate_limit_reset: Option<String>,
    body: String,
}

// 下载进度事件载荷
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateDownloadProgressEvent {
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    percent: Option<u32>,
}

/// 解析语义化版本号片段
fn parse_version_parts(version: &str) -> Option<Vec<u64>> {
    let normalized = version
        .trim()
        .trim_start_matches('v')
        .trim_start_matches('V');
    let core = normalized.split(['-', '+']).next().unwrap_or(normalized);
    let mut parts = Vec::new();
    for segment in core.split('.') {
        if segment.is_empty() {
            return None;
        }
        parts.push(segment.parse::<u64>().ok()?);
    }
    Some(parts)
}

/// 比较版本号大小，判断远程版本是否高于当前版本
fn is_newer_version(latest: &str, current: &str) -> bool {
    let Some(mut latest_parts) = parse_version_parts(latest) else {
        return false;
    };
    let Some(mut current_parts) = parse_version_parts(current) else {
        return false;
    };

    let len = latest_parts.len().max(current_parts.len());
    latest_parts.resize(len, 0);
    current_parts.resize(len, 0);
    latest_parts > current_parts
}

/// 对 Release 附件资产进行打分（Android：仅匹配 APK，优先 arm64）
#[cfg(target_os = "android")]
fn installer_asset_score(asset_name: &str) -> i32 {
    let normalized = asset_name.to_ascii_lowercase();
    if !normalized.ends_with(".apk") {
        return -1;
    }
    let mut score = 10;
    if normalized.contains("arm64") || normalized.contains("aarch64") {
        score += 5;
    }
    if normalized.contains("universal") {
        score += 2;
    }
    score
}

/// 对 Release 附件资产进行打分，优先匹配 Windows 可执行安装包
#[cfg(target_os = "windows")]
fn installer_asset_score(asset_name: &str) -> i32 {
    let normalized = asset_name.to_ascii_lowercase();
    if !(normalized.ends_with(".exe") || normalized.ends_with(".msi")) {
        return -1;
    }
    // 免安装版不是安装器，直接运行不会完成升级
    if normalized.contains("portable") {
        return -1;
    }

    let mut score = 10;
    if normalized.ends_with(".exe") {
        score += 8;
    }
    if normalized.contains("setup") || normalized.contains("installer") {
        score += 6;
    }
    if normalized.contains("windows")
        || normalized.contains("win")
        || normalized.contains("pc-windows")
    {
        score += 5;
    }
    if normalized.contains("x64") || normalized.contains("amd64") {
        score += 3;
    }
    if normalized.contains("nsis") {
        score += 2;
    }
    if normalized.ends_with(".msi") {
        score += 1;
    }
    score
}

/// Unix 只匹配本系统与 CPU 架构的安装包，防止误下载 Windows EXE 或另一种 Mac 架构。
#[cfg(all(not(target_os = "android"), not(target_os = "windows")))]
fn installer_asset_score(asset_name: &str) -> i32 {
    let name = asset_name.to_ascii_lowercase();
    let extension_ok = if cfg!(target_os = "macos") { name.ends_with(".dmg") }
        else if cfg!(target_os = "linux") { name.ends_with(".appimage") || name.ends_with(".deb") } else { false };
    if !extension_ok { return -1; }
    let arm = name.contains("aarch64") || name.contains("arm64");
    let x64 = name.contains("x86_64") || name.contains("amd64") || name.contains("x64");
    if !name.contains("universal") && ((cfg!(target_arch = "aarch64") && !arm) || (cfg!(target_arch = "x86_64") && !x64)) { return -1; }
    if name.ends_with(".appimage") { 20 } else { 10 }
}

/// 是否为 Windows 免安装版：NSIS 安装目录必有 uninstall.exe，免安装版 exe 旁边没有
fn is_portable_build() -> bool {
    if !cfg!(target_os = "windows") {
        return false;
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| !dir.join("uninstall.exe").is_file()))
        .unwrap_or(false)
}

/// 从 Release 资产列表中挑选最优安装包
fn select_update_installer_asset(assets: &[GitHubReleaseAsset]) -> Option<GitHubReleaseAsset> {
    assets
        .iter()
        .filter_map(|asset| {
            let score = installer_asset_score(&asset.name);
            (score >= 0).then_some((score, asset))
        })
        .max_by_key(|(score, _)| *score)
        .map(|(_, asset)| asset.clone())
}

/// 清理并规范化安装包保存文件名，防止路径遍历与特殊字符
fn sanitize_asset_file_name(asset_name: &str) -> String {
    let sanitized: String = asset_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect();
    if sanitized.trim_matches('_').is_empty() {
        // 移动端安装包为 APK，桌面端为 EXE
        if cfg!(mobile) {
            "NoteBoard-update.apk".into()
        } else {
            "NoteBoard-update.exe".into()
        }
    } else {
        sanitized
    }
}

/// 校验更新安装包下载地址合法性
#[cfg(not(mobile))]
fn is_valid_update_download_url(url: &str) -> bool {
    let normalized = url.trim().to_ascii_lowercase();
    (normalized.starts_with("https://") || normalized.starts_with("http://"))
        && if cfg!(target_os = "windows") { normalized.ends_with(".exe") || normalized.ends_with(".msi") }
            else if cfg!(target_os = "macos") { normalized.ends_with(".dmg") }
            else { normalized.ends_with(".appimage") || normalized.ends_with(".deb") }
        && !normalized.chars().any(|character| character.is_control())
}

/// 校验更新安装包下载地址合法性（移动端：仅接受 HTTPS 的 APK）
#[cfg(mobile)]
fn is_valid_update_download_url(url: &str) -> bool {
    let normalized = url.trim().to_ascii_lowercase();
    normalized.starts_with("https://")
        && normalized.ends_with(".apk")
        && !normalized.chars().any(|character| character.is_control())
}

/// 构建支持 Windows 系统代理的 HTTP 客户端
pub(crate) fn build_update_http_client(total_timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(UPDATE_HTTP_CONNECT_TIMEOUT)
        .read_timeout(UPDATE_HTTP_READ_TIMEOUT)
        .timeout(total_timeout)
        .build()
        .map_err(|e| e.to_string())
}

/// 构建强制直连（忽略代理）的 HTTP 客户端，用于代理节点 403 或不可达时的降级回退
pub(crate) fn build_direct_http_client(total_timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(UPDATE_HTTP_CONNECT_TIMEOUT)
        .read_timeout(UPDATE_HTTP_READ_TIMEOUT)
        .timeout(total_timeout)
        .build()
        .map_err(|e| e.to_string())
}

/// 检查本地文件是否已存在且大小完全匹配 Release 预期大小
fn installer_path_matches_expected_size(
    path: &Path,
    expected_size: Option<u64>,
) -> Result<bool, String> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.is_file() {
        return Ok(false);
    }

    Ok(expected_size
        .map(|size| metadata.len() == size)
        .unwrap_or(metadata.len() > 0))
}

/// 下载安装包到临时路径，流式推送进度并在完成后重命名为目标文件
async fn download_update_installer(
    app_handle: &AppHandle,
    client: &reqwest::Client,
    download_url: &str,
    installer_path: &Path,
    expected_size: Option<u64>,
) -> Result<(), String> {
    // 写入 `.download` 后缀的临时文件，避免下载中断留下损坏的文件
    let temp_installer_path = installer_path.with_extension(format!(
        "{}.download",
        installer_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("tmp")
    ));
    match fs::remove_file(&temp_installer_path) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }

    let mut response = client
        .get(download_url)
        .header(reqwest::header::USER_AGENT, "NoteBoard")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;

    let mut temp_file = fs::File::create(&temp_installer_path).map_err(|e| e.to_string())?;
    let mut downloaded_size = 0_u64;
    let mut last_progress_emit = Instant::now();

    // 逐 chunk 读取数据流并落盘
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        downloaded_size += chunk.len() as u64;
        if expected_size.is_some_and(|size| downloaded_size > size) {
            return Err("下载的安装包体积超出预期元数据大小".to_string());
        }
        temp_file.write_all(&chunk).map_err(|e| e.to_string())?;

        // 节流向前端推送下载进度
        if last_progress_emit.elapsed() >= UPDATE_DOWNLOAD_PROGRESS_THROTTLE {
            let percent = expected_size.map(|size| {
                ((downloaded_size as f64 / size as f64) * 100.0)
                    .min(100.0)
                    .round() as u32
            });
            let _ = app_handle.emit(
                UPDATE_DOWNLOAD_PROGRESS_EVENT,
                &UpdateDownloadProgressEvent {
                    downloaded_bytes: downloaded_size,
                    total_bytes: expected_size,
                    percent,
                },
            );
            last_progress_emit = Instant::now();
        }
    }
    temp_file.flush().map_err(|e| e.to_string())?;
    drop(temp_file);

    // 下载完成推送 100% 进度
    let _ = app_handle.emit(
        UPDATE_DOWNLOAD_PROGRESS_EVENT,
        &UpdateDownloadProgressEvent {
            downloaded_bytes: downloaded_size,
            total_bytes: expected_size,
            percent: expected_size.map(|size| {
                ((downloaded_size as f64 / size as f64) * 100.0)
                    .min(100.0)
                    .round() as u32
            }),
        },
    );

    // 校验最终下载体积
    if expected_size.is_some_and(|size| downloaded_size != size) {
        return Err("下载的安装包大小与 Release 元数据不符".to_string());
    }
    if downloaded_size == 0 {
        return Err("下载的安装包文件为空".to_string());
    }

    match fs::remove_file(installer_path) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    fs::rename(&temp_installer_path, installer_path).map_err(|e| e.to_string())?;
    Ok(())
}

/// 移动端：通过原生桥接以 FileProvider 授权调起系统软件包安装器；安装完成后由系统替换并重启应用
#[cfg(mobile)]
async fn launch_mobile_installer(app_handle: &AppHandle, installer_path: &Path) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let app = app_handle.clone();
        let path = installer_path.to_string_lossy().to_string();
        // 原生调用为同步阻塞，放入阻塞任务，避免占用异步运行时工作线程
        return tauri::async_runtime::spawn_blocking(move || {
            let bridge = app
                .try_state::<crate::mobile_bridge::NbMobile<tauri::Wry>>()
                .ok_or_else(|| "原生桥接未初始化".to_string())?;
            bridge
                .0
                .run_mobile_plugin::<serde_json::Value>(
                    "installApk",
                    serde_json::json!({ "path": path }),
                )
                .map(|_| ())
                .map_err(|error| format!("无法启动系统安装器：{error}"))
        })
        .await
        .map_err(|error| error.to_string())?;
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app_handle, installer_path);
        Err("当前平台暂不支持应用内安装".to_string())
    }
}

/// 更新安装包缓存目录（桌面为系统临时目录，移动端为应用私有缓存目录）
fn update_cache_dir() -> PathBuf {
    crate::app_dirs::cache_dir().join("NoteBoard-updates")
}

/// 从安装包文件名中提取版本号（如 NoteBoard_0.5.2_android_arm64.apk → 0.5.2）
fn version_from_installer_name(file_name: &str) -> Option<&str> {
    file_name
        .split(['_', '-'])
        .find(|segment| segment.contains('.') && parse_version_parts(segment).is_some())
}

/// 判断缓存的安装包是否应清理：下载残留、无法识别版本，或版本不高于当前版本（已安装 / 已过期）。
/// 高于当前版本的安装包保留，用户取消安装后再次点击可直接安装，无需重新下载。
fn should_remove_cached_installer(file_name: &str, current_version: &str) -> bool {
    if file_name.ends_with(".download") {
        return true;
    }
    match version_from_installer_name(file_name) {
        Some(version) => !is_newer_version(version, current_version),
        None => true,
    }
}

/// 启动时清理已安装或过期的更新安装包，避免安装包长期累积占用存储空间。
/// 尽力而为：文件被占用（如桌面安装器仍在运行）或删除失败时忽略，下次启动再试。
pub fn cleanup_installed_update_packages() {
    let current_version = env!("CARGO_PKG_VERSION");
    let Ok(entries) = fs::read_dir(update_cache_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().to_string();
        if should_remove_cached_installer(&file_name, current_version) {
            let _ = fs::remove_file(&path);
        }
    }
}

/// 移动端：清理更新目录中除目标安装包外的旧 APK 与残留临时文件，避免旧版本长期占用存储空间
#[cfg(mobile)]
fn remove_stale_update_files(update_dir: &Path, keep: &Path) {
    let Ok(entries) = fs::read_dir(update_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path != keep && path.is_file() {
            let _ = fs::remove_file(path);
        }
    }
}

/// 直接唤起安装包；安装后的启动行为完全交给安装器完成页的用户选项决定
#[cfg(target_os = "windows")]
fn spawn_update_installer(installer_path: &Path) -> std::io::Result<()> {
    let extension = installer_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    // EXE 安装包直接启动，MSI 安装包交给系统安装服务，避免经 cmd 中转产生黑框和二次启动竞态
    if extension == "exe" {
        Command::new(installer_path).spawn()?;
    } else if extension == "msi" {
        Command::new("msiexec.exe")
            .arg("/i")
            .arg(installer_path)
            .spawn()?;
    } else {
        return Err(std::io::Error::new(
            ErrorKind::InvalidInput,
            "不支持的安装包格式",
        ));
    }

    Ok(())
}

/// Unix 交由系统打开安装包所在目录，由用户完成覆盖安装；不直接执行下载的文件。
#[cfg(all(desktop, not(target_os = "windows")))]
fn spawn_update_installer(installer_path: &Path) -> std::io::Result<()> {
    let parent = installer_path.parent().unwrap_or(installer_path);
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    Command::new(opener).arg(parent).spawn()?;
    Ok(())
}

/// 请求 GitHub Release 列表元数据并保存状态、限流头与正文；桌面支持忽略系统 HTTP 代理。
async fn fetch_latest_release(use_system_proxy: bool) -> Result<ReleaseHttpResponse, String> {
    let client = if use_system_proxy {
        build_update_http_client(UPDATE_HTTP_READ_TIMEOUT)?
    } else {
        build_direct_http_client(UPDATE_HTTP_READ_TIMEOUT)?
    };

    let response = client
        .get(GITHUB_RELEASE_API_URL)
        .header(reqwest::header::USER_AGENT, "NoteBoard")
        .send()
        .await
        .map_err(|err| format!("update_error:network:{err}"))?;
    let status = response.status().as_u16();
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
    };
    let rate_limit_remaining = header("x-ratelimit-remaining");
    let rate_limit_reset = header("x-ratelimit-reset");
    let body = response
        .text()
        .await
        .map_err(|err| format!("update_error:network:{err}"))?;
    Ok(ReleaseHttpResponse {
        status,
        rate_limit_remaining,
        rate_limit_reset,
        body,
    })
}

/// Android 通过原生 Network 绑定到非 VPN 网络；其余平台继续使用 no_proxy 直连。
async fn fetch_direct_latest_release(app: &AppHandle) -> Result<ReleaseHttpResponse, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let app = app.clone();
        // 原生调用等待 Kotlin 网络线程返回，放入阻塞任务，避免占用异步运行时工作线程。
        return tauri::async_runtime::spawn_blocking(move || {
            let bridge = app
                .try_state::<crate::mobile_bridge::NbMobile<tauri::Wry>>()
                .ok_or_else(|| "update_error:network:原生网络桥接未初始化".to_string())?;
            bridge
                .0
                .run_mobile_plugin::<ReleaseHttpResponse>("checkUpdateDirect", ())
                .map_err(|error| format!("update_error:network:{error}"))
        })
        .await
        .map_err(|error| format!("update_error:network:{error}"))?;
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        fetch_latest_release(false).await
    }
}

/// 仅在网络故障、403 或 429 时直连一次；直连不可用时保留原限流响应，避免误报。
async fn release_response_with_fallback(
    primary: impl std::future::Future<Output = Result<ReleaseHttpResponse, String>>,
    direct: impl std::future::Future<Output = Result<ReleaseHttpResponse, String>>,
) -> Result<ReleaseHttpResponse, String> {
    let response = primary.await;
    match response {
        Ok(response) if matches!(response.status, 403 | 429) => {
            // 两个出口均异常时优先保留原响应中的配额信息，而不是覆盖成直连网络错误。
            match direct.await {
                Ok(direct_response)
                    if (200..300).contains(&direct_response.status)
                        || matches!(direct_response.status, 403 | 429) =>
                {
                    Ok(direct_response)
                }
                _ => Ok(response),
            }
        }
        Err(_) => direct.await,
        Ok(response) => Ok(response),
    }
}

/// 解析统一响应，识别主限流、次级限流与普通拒绝访问，成功时读取 Release 列表元数据。
fn parse_release_response(
    response: ReleaseHttpResponse,
) -> Result<Vec<GitHubReleaseResponse>, String> {
    if matches!(response.status, 403 | 429) {
        let message = serde_json::from_str::<serde_json::Value>(&response.body)
            .ok()
            .and_then(|body| {
                body.get("message")
                    .and_then(|value| value.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_default()
            .to_ascii_lowercase();
        let rate_limited = response
            .rate_limit_remaining
            .as_deref()
            .and_then(|value| value.parse::<u32>().ok())
            == Some(0)
            || response.status == 429
            || message.contains("rate limit");
        if rate_limited {
            // 解析 GitHub 配额重置时间戳（Unix 秒）
            let reset_ts = response
                .rate_limit_reset
                .as_deref()
                .filter(|value| value.parse::<i64>().is_ok())
                .unwrap_or_default();
            return Err(if reset_ts.is_empty() {
                "update_error:rate_limited".to_string()
            } else {
                format!("update_error:rate_limited:{reset_ts}")
            });
        }
        return Err("update_error:forbidden".to_string());
    }

    if !(200..300).contains(&response.status) {
        return Err(format!("update_error:http_status:{}", response.status));
    }
    serde_json::from_str(&response.body).map_err(|err| format!("update_error:parse:{err}"))
}

/// 从 Release 列表中挑选最新正式版，并按版本从新到旧收集高于当前版本的其余正式版。
/// 返回 (最新版本, 更早的未安装版本)；没有任何可解析的正式版时返回 None。
fn collect_pending_releases(
    releases: Vec<GitHubReleaseResponse>,
    current_version: &str,
) -> Option<(GitHubReleaseResponse, Vec<GitHubReleaseResponse>)> {
    // 仅保留版本号可解析的正式版，按语义化版本从高到低排序（不依赖 GitHub 的创建时间顺序）
    let mut stable: Vec<(Vec<u64>, GitHubReleaseResponse)> = releases
        .into_iter()
        .filter(|release| !release.draft && !release.prerelease)
        .filter_map(|release| parse_version_parts(&release.tag_name).map(|parts| (parts, release)))
        .map(|(mut parts, release)| {
            // 去掉末尾的 0，使 1.2 与 1.2.0 比较结果一致
            while parts.len() > 1 && parts.last() == Some(&0) {
                parts.pop();
            }
            (parts, release)
        })
        .collect();
    stable.sort_by(|left, right| right.0.cmp(&left.0));

    let mut iter = stable.into_iter().map(|(_, release)| release);
    let latest = iter.next()?;
    let pending: Vec<GitHubReleaseResponse> = iter
        .take_while(|release| is_newer_version(&release.tag_name, current_version))
        .collect();
    Some((latest, pending))
}

/// 将 Release 元数据转为前端展示用的版本日志条目
fn to_release_note(release: &GitHubReleaseResponse) -> UpdateReleaseNote {
    UpdateReleaseNote {
        version: release.tag_name.trim_start_matches(['v', 'V']).to_string(),
        name: release.name.clone(),
        url: release.html_url.clone(),
        published_at: release.published_at.clone(),
        body: release.body.clone(),
    }
}

/// 检查应用更新：先使用默认网络，网络故障或限流时按平台尝试真实直连，再挑选安装包。
#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<UpdateCheckResult, String> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let release_url = GITHUB_REPO_URL.to_string();
    let response = release_response_with_fallback(
        fetch_latest_release(true),
        fetch_direct_latest_release(&app),
    )
    .await?;
    let releases = parse_release_response(response)?;
    // 列表满页时，更早的未安装版本可能落在下一页，需提示前端日志不完整
    let page_full = releases.len() >= GITHUB_RELEASE_PAGE_SIZE;
    let (release, older_pending) = collect_pending_releases(releases, &current_version)
        .ok_or_else(|| "update_error:parse:未找到已发布的正式版本".to_string())?;

    let latest_version = release.tag_name.trim_start_matches(['v', 'V']).to_string();
    let update_available = is_newer_version(&release.tag_name, &current_version);
    // 免安装版不下载运行安装包，避免在旁边另装一份安装版
    let portable = is_portable_build();
    let installer_asset = if portable {
        None
    } else {
        select_update_installer_asset(&release.assets)
    };

    // 未安装版本日志：最新版在前，其后依次为更早的未安装版本
    let release_notes: Vec<UpdateReleaseNote> = if update_available {
        std::iter::once(&release)
            .chain(older_pending.iter())
            .map(to_release_note)
            .collect()
    } else {
        Vec::new()
    };
    let release_notes_truncated =
        update_available && page_full && older_pending.len() + 1 >= GITHUB_RELEASE_PAGE_SIZE;

    Ok(UpdateCheckResult {
        current_version,
        latest_version,
        release_name: release.name,
        release_url: if release.html_url.is_empty() {
            release_url
        } else {
            release.html_url
        },
        published_at: release.published_at,
        update_available,
        installer_asset_name: installer_asset.as_ref().map(|asset| asset.name.clone()),
        installer_download_url: installer_asset
            .as_ref()
            .map(|asset| asset.browser_download_url.clone()),
        installer_size: installer_asset.and_then(|asset| asset.size),
        release_body: release.body,
        release_notes,
        release_notes_truncated,
        portable,
    })
}

/// 优先系统代理下载，遇到 403 回退直连重试
async fn download_installer_with_fallback(
    app_handle: &AppHandle,
    download_url: &str,
    installer_path: &Path,
    installer_size: Option<u64>,
) -> Result<(), String> {
    let client = build_update_http_client(UPDATE_INSTALLER_DOWNLOAD_TIMEOUT)?;
    if let Err(error) =
        download_update_installer(app_handle, &client, download_url, installer_path, installer_size)
            .await
    {
        if error.contains("403") {
            let direct_client = build_direct_http_client(UPDATE_INSTALLER_DOWNLOAD_TIMEOUT)?;
            download_update_installer(
                app_handle,
                &direct_client,
                download_url,
                installer_path,
                installer_size,
            )
            .await?;
        } else {
            return Err(error);
        }
    }
    Ok(())
}

/// 下载并执行安装包升级
#[tauri::command]
pub async fn download_and_install_update(
    app_handle: AppHandle,
    download_url: String,
    asset_name: String,
    installer_size: Option<u64>,
) -> Result<String, String> {
    let normalized_url = download_url.trim();
    if !is_valid_update_download_url(normalized_url) {
        return Err("无效的更新安装包下载地址".to_string());
    }
    if is_portable_build() {
        return Err("免安装版请前往 Release 页面下载新版本".to_string());
    }

    let safe_file_name = sanitize_asset_file_name(&asset_name);
    // 下载至缓存目录下的更新子目录（桌面为系统临时目录，移动端为应用私有缓存目录）
    let update_dir = update_cache_dir();
    fs::create_dir_all(&update_dir).map_err(|error| error.to_string())?;
    let installer_path: PathBuf = update_dir.join(safe_file_name);

    // 本地已有完整匹配安装包时直接启动（如上次取消了安装），免去二次下载
    if !installer_path_matches_expected_size(&installer_path, installer_size)? {
        // 移动端顺带清理旧版本 APK 与残留临时文件，避免长期占用存储空间
        #[cfg(mobile)]
        remove_stale_update_files(&update_dir, &installer_path);
        download_installer_with_fallback(&app_handle, normalized_url, &installer_path, installer_size)
            .await?;
    }

    // 移动端：应用内下载 APK 后调起系统安装器。
    // 不再交给浏览器下载：部分浏览器（如 Edge）由外部 Intent 发起的 APK 下载会卡在 99% 无法完成。
    // 也不主动退出：系统覆盖安装时会自动结束旧进程，用户取消安装则继续使用当前版本。
    #[cfg(mobile)]
    {
        launch_mobile_installer(&app_handle, &installer_path).await?;
        return Ok(installer_path.to_string_lossy().to_string());
    }

    #[cfg(not(mobile))]
    {
        spawn_update_installer(&installer_path).map_err(|error| error.to_string())?;

        // 延迟 600ms 退出当前实例，让前端收到成功结果，并为安装器释放程序文件与单实例资源
        // Windows 安装器需要释放当前程序；Unix 打开目录后继续保留应用，等待用户手动安装。
        #[cfg(target_os = "windows")]
        let handle_clone = app_handle.clone();
        #[cfg(target_os = "windows")]
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(600));
            handle_clone.exit(0);
        });

        Ok(installer_path.to_string_lossy().to_string())
    }
}

/// 在系统默认浏览器中打开外部链接
#[tauri::command]
pub fn open_external_url(app: AppHandle, url: String) -> Result<bool, String> {
    let _ = &app;
    let normalized = url.trim();
    if !(normalized.starts_with("https://") || normalized.starts_with("http://")) {
        return Err("仅支持打开 http/https 协议的外部链接".to_string());
    }
    if normalized.chars().any(|character| character.is_control()) {
        return Err("链接包含非法控制字符".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use windows::core::HSTRING;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        // 使用 Windows 原生 ShellExecuteW 唤起默认浏览器，避免 explorer.exe 导致的双重打开问题
        let url_wide = HSTRING::from(normalized);
        let operation = HSTRING::from("open");
        unsafe {
            let result = ShellExecuteW(
                None,
                &operation,
                &url_wide,
                None,
                None,
                SW_SHOWNORMAL,
            );
            // ShellExecute 返回值大于 32 表示成功
            if result.0 as usize <= 32 {
                return Err(format!("打开外部链接失败，错误代码: {}", result.0 as usize));
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(normalized)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    // 移动端：通过 opener 插件交给系统（Android 为 ACTION_VIEW Intent）
    #[cfg(mobile)]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url(normalized, None::<&str>)
            .map_err(|e| e.to_string())?;
    }

    #[cfg(all(unix, not(target_os = "macos"), desktop))]
    {
        Command::new("xdg-open")
            .arg(normalized)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    /// 构造不同出口的 API 响应，测试只模拟返回值，不访问公网或真实 VPN。
    fn response(status: u16, remaining: Option<&str>, body: &str) -> ReleaseHttpResponse {
        ReleaseHttpResponse {
            status,
            rate_limit_remaining: remaining.map(str::to_string),
            rate_limit_reset: Some("1800000000".to_string()),
            body: body.to_string(),
        }
    }

    // 模拟真实 Release 列表包含 Android 安装包，验证直连结果进入原来的版本及安装包处理流程。
    const RELEASE_BODY: &str = r#"[{"tag_name":"v0.4.6","html_url":"https://github.com/CrazyFigure/NoteBoard/releases/tag/v0.4.6","assets":[{"name":"NoteBoard_android_arm64.apk","browser_download_url":"https://example.com/update.apk","size":123}]}]"#;

    /// 构造仅含版本号的 Release，用于版本筛选与排序测试
    fn release(tag: &str, prerelease: bool) -> GitHubReleaseResponse {
        GitHubReleaseResponse {
            tag_name: tag.to_string(),
            name: None,
            html_url: String::new(),
            published_at: None,
            body: Some(format!("{tag} 更新说明")),
            draft: false,
            prerelease,
            assets: Vec::new(),
        }
    }

    /// 跨多个版本更新时，按版本从新到旧收集所有未安装的正式版，跳过预发布与已安装版本。
    #[test]
    fn collects_all_pending_stable_releases_in_order() {
        let releases = vec![
            release("v0.4.10", false),
            release("v0.5.0-beta", true),
            release("v0.4.8", false),
            release("v0.4.9", false),
            release("v0.4.7", false),
            release("v0.4.6", false),
        ];
        let (latest, pending) = collect_pending_releases(releases, "0.4.7").unwrap();
        assert_eq!(latest.tag_name, "v0.4.10");
        let tags: Vec<&str> = pending.iter().map(|item| item.tag_name.as_str()).collect();
        assert_eq!(tags, ["v0.4.9", "v0.4.8"]);
    }

    /// 启动清理：已安装 / 过期的安装包与下载残留被删除，比当前版本新的安装包保留以便直接安装。
    #[test]
    fn cleanup_keeps_only_newer_installers() {
        let current = "0.5.2";
        assert!(should_remove_cached_installer("NoteBoard_0.5.2_android_arm64.apk", current));
        assert!(should_remove_cached_installer("NoteBoard_0.5.1_windows_x64-setup.exe", current));
        assert!(should_remove_cached_installer("NoteBoard_0.5.3_android_arm64.apk.download", current));
        assert!(should_remove_cached_installer("NoteBoard-update.apk", current));
        assert!(!should_remove_cached_installer("NoteBoard_0.5.3_android_arm64.apk", current));
        assert!(!should_remove_cached_installer("NoteBoard_0.6.0_windows_x64-setup.exe", current));
    }

    /// 已是最新版本时，最新正式版仍被识别，但没有更早的未安装版本。
    #[test]
    fn up_to_date_has_no_pending_releases() {
        let (latest, pending) =
            collect_pending_releases(vec![release("v0.4.6", false)], "0.4.6").unwrap();
        assert_eq!(latest.tag_name, "v0.4.6");
        assert!(pending.is_empty());
        assert!(collect_pending_releases(vec![release("v1.0.0", true)], "0.4.6").is_none());
    }

    /// 默认出口被 403 / 429 限流时，必须等待并使用直连出口的成功结果。
    #[test]
    fn limited_default_network_uses_direct_result() {
        for status in [403, 429] {
            let direct_calls = Cell::new(0);
            let result = tauri::async_runtime::block_on(release_response_with_fallback(
                async { Ok(response(status, Some("0"), "{}")) },
                async {
                    direct_calls.set(direct_calls.get() + 1);
                    Ok(response(200, Some("59"), RELEASE_BODY))
                },
            ))
            .unwrap();
            let releases = parse_release_response(result).unwrap();
            let release = &releases[0];
            assert_eq!(direct_calls.get(), 1);
            assert_eq!(release.tag_name, "v0.4.6");
            assert_eq!(release.assets[0].size, Some(123));
            assert!(is_newer_version(&release.tag_name, "0.4.5"));
        }
    }

    /// 正常默认网络不需要直连；直连 Future 未被轮询，避免额外请求与无谓切换网络。
    #[test]
    fn successful_default_network_skips_direct_request() {
        let called = Cell::new(false);
        let result = tauri::async_runtime::block_on(release_response_with_fallback(
            async { Ok(response(200, None, RELEASE_BODY)) },
            async {
                called.set(true);
                Err("不应调用".to_string())
            },
        ))
        .unwrap();
        assert!(!called.get());
        assert!(parse_release_response(result).is_ok());
    }

    /// VPN 连接故障同样应触发一次直连，不能先在同一出口重复重试。
    #[test]
    fn default_network_failure_tries_direct_once() {
        let called = Cell::new(0);
        let result = tauri::async_runtime::block_on(release_response_with_fallback(
            async { Err("update_error:network:VPN 故障".to_string()) },
            async {
                called.set(called.get() + 1);
                Ok(response(200, None, RELEASE_BODY))
            },
        ))
        .unwrap();
        assert_eq!(called.get(), 1);
        assert!(parse_release_response(result).is_ok());
    }

    /// VPN 禁止绕行或普通网络不可达时，保留原来的限流与重置时间，而不是误报未知网络异常。
    #[test]
    fn unavailable_direct_network_preserves_rate_limit() {
        let result = tauri::async_runtime::block_on(release_response_with_fallback(
            async { Ok(response(403, Some("0"), "{}")) },
            async { Err("update_error:network:VPN 禁止绕行".to_string()) },
        ))
        .unwrap();
        assert_eq!(
            parse_release_response(result).unwrap_err(),
            "update_error:rate_limited:1800000000"
        );
    }

    /// 次级限流可能没有配额耗尽响应头；429 与明确的 GitHub rate limit 消息均需准确识别。
    #[test]
    fn rate_limit_classification_covers_secondary_limits() {
        for limited in [
            response(429, None, "{}"),
            response(
                403,
                None,
                r#"{"message":"You have exceeded a secondary rate limit"}"#,
            ),
        ] {
            assert_eq!(
                parse_release_response(limited).unwrap_err(),
                "update_error:rate_limited:1800000000"
            );
        }
        assert_eq!(
            parse_release_response(response(403, None, "{}")).unwrap_err(),
            "update_error:forbidden"
        );
    }
}
