//! NoteBoard 应用更新检查、安装包下载与系统外链唤起模块。
//! 支持 Windows 系统代理读取、代理 403 / 故障自动降级直连重试，以及精确的 GitHub API 限流识别。

use std::{
    env, fs,
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::dto::UpdateCheckResult;

// GitHub Release 响应实体定义
#[derive(Debug, Deserialize)]
struct GitHubReleaseResponse {
    tag_name: String,
    name: Option<String>,
    html_url: String,
    published_at: Option<String>,
    body: Option<String>,
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
const GITHUB_RELEASE_API_URL: &str = "https://api.github.com/repos/CrazyFigure/NoteBoard/releases/latest";

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

/// 对 Release 附件资产进行打分，优先匹配 Windows 可执行安装包
fn installer_asset_score(asset_name: &str) -> i32 {
    let normalized = asset_name.to_ascii_lowercase();
    if !(normalized.ends_with(".exe") || normalized.ends_with(".msi")) {
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
        "NoteBoard-update.exe".into()
    } else {
        sanitized
    }
}

/// 校验更新安装包下载地址合法性
fn is_valid_update_download_url(url: &str) -> bool {
    let normalized = url.trim().to_ascii_lowercase();
    (normalized.starts_with("https://") || normalized.starts_with("http://"))
        && (normalized.ends_with(".exe") || normalized.ends_with(".msi"))
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

/// 直接唤起安装包；安装后的启动行为完全交给安装器完成页的用户选项决定
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

/// 请求 GitHub Release 元数据；支持系统代理与直连双模式
async fn fetch_latest_release(use_system_proxy: bool) -> Result<reqwest::Response, String> {
    let client = if use_system_proxy {
        build_update_http_client(UPDATE_HTTP_READ_TIMEOUT)?
    } else {
        build_direct_http_client(UPDATE_HTTP_READ_TIMEOUT)?
    };

    client
        .get(GITHUB_RELEASE_API_URL)
        .header(reqwest::header::USER_AGENT, "NoteBoard")
        .send()
        .await
        .map_err(|err| format!("update_error:network:{err}"))
}

/// 检查应用更新：优先系统代理，遇到 403 或网络异常自动回退直连重试
#[tauri::command]
pub async fn check_for_updates() -> Result<UpdateCheckResult, String> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let release_url = GITHUB_REPO_URL.to_string();

    // 首次走系统代理；若代理不可达或返回 403，则自动回退直连重试
    let mut response = match fetch_latest_release(true).await {
        Ok(response) => response,
        Err(_) => fetch_latest_release(false).await?,
    };
    if response.status() == reqwest::StatusCode::FORBIDDEN {
        response = fetch_latest_release(false).await?;
    }

    // 处理 403 限流或拒绝访问
    if response.status() == reqwest::StatusCode::FORBIDDEN {
        let rate_limited = response
            .headers()
            .get("x-ratelimit-remaining")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u32>().ok())
            == Some(0);
        if rate_limited {
            // 解析 GitHub 配额重置时间戳（Unix 秒）
            let reset_ts = response
                .headers()
                .get("x-ratelimit-reset")
                .and_then(|value| value.to_str().ok())
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

    let release = response
        .error_for_status()
        .map_err(|err| format!("update_error:http_status:{err}"))?
        .json::<GitHubReleaseResponse>()
        .await
        .map_err(|err| format!("update_error:parse:{err}"))?;

    let latest_version = release.tag_name.trim_start_matches(['v', 'V']).to_string();
    let update_available = is_newer_version(&release.tag_name, &current_version);
    let installer_asset = select_update_installer_asset(&release.assets);

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
    })
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

    let safe_file_name = sanitize_asset_file_name(&asset_name);
    // 下载至系统的临时更新目录中
    let update_dir = env::temp_dir().join("NoteBoard-updates");
    fs::create_dir_all(&update_dir).map_err(|error| error.to_string())?;
    let installer_path: PathBuf = update_dir.join(safe_file_name);

    // 本地已有完整匹配安装包时直接启动，免去二次下载
    if installer_path_matches_expected_size(&installer_path, installer_size)? {
        spawn_update_installer(&installer_path).map_err(|error| error.to_string())?;

        // 延迟 600ms 退出当前实例，让前端收到成功结果，并为安装器释放程序文件与单实例资源
        let handle_clone = app_handle.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(600));
            handle_clone.exit(0);
        });

        return Ok(installer_path.to_string_lossy().to_string());
    }

    // 优先系统代理，遇到 403 回退直连重试
    let client = build_update_http_client(UPDATE_INSTALLER_DOWNLOAD_TIMEOUT)?;
    if let Err(error) = download_update_installer(
        &app_handle,
        &client,
        normalized_url,
        &installer_path,
        installer_size,
    )
    .await
    {
        if error.contains("403") {
            let direct_client = build_direct_http_client(UPDATE_INSTALLER_DOWNLOAD_TIMEOUT)?;
            download_update_installer(
                &app_handle,
                &direct_client,
                normalized_url,
                &installer_path,
                installer_size,
            )
            .await?;
        } else {
            return Err(error);
        }
    }

    spawn_update_installer(&installer_path).map_err(|error| error.to_string())?;

    // 延迟 600ms 退出当前实例，让前端收到成功结果，并为安装器释放程序文件与单实例资源
    let handle_clone = app_handle.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(600));
        handle_clone.exit(0);
    });

    Ok(installer_path.to_string_lossy().to_string())
}

/// 在系统默认浏览器中打开外部链接
#[tauri::command]
pub fn open_external_url(url: String) -> Result<bool, String> {
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

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(normalized)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(true)
}
