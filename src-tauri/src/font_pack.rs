//! NoteBoard 应用内字体资源包：固定来源下载、完整性校验、原子安装与状态查询。

use std::{
    fs,
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;
use zip::ZipArchive;

use crate::{
    dto::{FontPackFace, FontPackStatus},
    settings::model::app_data_dir,
    updater::commands::{build_direct_http_client, build_update_http_client},
};

const FONT_PACK_ID: &str = "core";
const FONT_PACK_VERSION: &str = "1.0.0";
const FONT_PACK_RELEASE_TAG: &str = "fonts-v1.0.0";
const FONT_PACK_ASSET_NAME: &str = "NoteBoard-fontpack-core-v1.0.0.zip";
const FONT_PACK_DOWNLOAD_URL: &str = "https://github.com/CrazyFigure/NoteBoard/releases/download/fonts-v1.0.0/NoteBoard-fontpack-core-v1.0.0.zip";
// GitHub 工作流使用 Deflate ZIP；下载时优先采用实际 Content-Length，此值只用于下载前的界面说明。
const FONT_PACK_DOWNLOAD_ESTIMATE_BYTES: u64 = 19 * 1024 * 1024;
const FONT_PACK_INSTALLED_BYTES: u64 = 36_441_444;
// 压缩包只应包含约 35 MiB 原始字体及少量文本，限制压缩体积可阻止错误资产无限写盘。
const FONT_PACK_ARCHIVE_MAX_BYTES: u64 = 30 * 1024 * 1024;
const FONT_PACK_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
const FONT_PACK_PROGRESS_EVENT: &str = "noteboard-font-pack-download-progress";
const FONT_PACK_CHANGED_EVENT: &str = "noteboard-font-pack-changed";
const FONT_PACK_PROGRESS_THROTTLE: Duration = Duration::from_millis(100);

#[derive(Clone, Copy)]
struct FontFileSpec {
    name: &'static str,
    size: u64,
    sha256: &'static str,
}

// 文件清单固定在应用版本内：即使 GitHub 资产被替换，也必须逐文件大小与哈希完全一致。
const FONT_FILES: &[FontFileSpec] = &[
    FontFileSpec {
        name: "JetBrainsMono-Bold.woff2",
        size: 94_588,
        sha256: "c503cc5ec5f8b2c7666b7ecda1adf44bd45f2e6579b2eba0fc292150416588a2",
    },
    FontFileSpec {
        name: "JetBrainsMono-BoldItalic.woff2",
        size: 98_152,
        sha256: "3a013466c0eee979fb9d42c2d7a8887cd3645dc8b897cfc5b71781cf982efc5a",
    },
    FontFileSpec {
        name: "JetBrainsMono-Italic.woff2",
        size: 95_864,
        sha256: "cb6a1b246318ed3885d7dffa14a2609297fe80e9b8e500bea33b52fa312a36a4",
    },
    FontFileSpec {
        name: "JetBrainsMono-Regular.woff2",
        size: 92_164,
        sha256: "a9cb1cd82332b23a47e3a1239d25d13c86d16c4220695e34b243effa999f45f2",
    },
    FontFileSpec {
        name: "MapleMonoNormal-NF-CN-Bold.ttf",
        size: 17_957_868,
        sha256: "ab69a5e2abc5de7c031d2409f674e7a5957ae88f50c5d4ecb07c8e84f79ece07",
    },
    FontFileSpec {
        name: "MapleMonoNormal-NF-CN-Regular.ttf",
        size: 18_102_808,
        sha256: "0a02d131cf514418c560b516fe53094a1b2ac94a54771cd817b44d61a924ed9b",
    },
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FontPackDownloadProgressEvent {
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    percent: Option<u32>,
}

/// 后端只暴露稳定错误码，用户可见中文由前端统一生成。
fn font_pack_error(code: &str, detail: impl AsRef<str>) -> String {
    let detail = detail.as_ref();
    if detail.is_empty() {
        format!("font_pack_error:{code}")
    } else {
        format!("font_pack_error:{code}:{detail}")
    }
}

/// 发布版把可重新下载的大体积资源放入 LOCALAPPDATA，普通卸载和覆盖升级均可保留；
/// 开发版继续使用 NoteBoard 配置目录，避免调试构建误用已安装应用的正式字体缓存。
fn font_packs_root_dir() -> PathBuf {
    if !cfg!(debug_assertions) && cfg!(windows) {
        if let Ok(local_appdata) = std::env::var("LOCALAPPDATA") {
            let trimmed = local_appdata.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed)
                    .join("com.crazyfigure.noteboard")
                    .join("font-packs");
            }
        }
    }
    app_data_dir().join("font-packs")
}

fn pack_version_dir(root: &Path) -> PathBuf {
    root.join(FONT_PACK_ID).join(FONT_PACK_VERSION)
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file =
        fs::File::open(path).map_err(|error| font_pack_error("read", error.to_string()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let size = file
            .read(&mut buffer)
            .map_err(|error| font_pack_error("read", error.to_string()))?;
        if size == 0 {
            break;
        }
        hasher.update(&buffer[..size]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// 每次启动校验完整大小与 SHA-256，不能只凭目录存在就把字体二进制交给 WebView。
fn verify_installed_pack(version_dir: &Path) -> Result<(), String> {
    for spec in FONT_FILES {
        let path = version_dir.join("fonts").join(spec.name);
        let metadata =
            fs::metadata(&path).map_err(|_| font_pack_error("missing_file", spec.name))?;
        if !metadata.is_file() || metadata.len() != spec.size {
            return Err(font_pack_error("invalid_file", spec.name));
        }
        if sha256_file(&path)? != spec.sha256 {
            return Err(font_pack_error("invalid_file", spec.name));
        }
    }
    Ok(())
}

fn face(version_dir: &Path, family: &str, weight: &str, style: &str, file: &str) -> FontPackFace {
    FontPackFace {
        family: family.to_string(),
        weight: weight.to_string(),
        style: style.to_string(),
        path: version_dir
            .join("fonts")
            .join(file)
            .to_string_lossy()
            .to_string(),
    }
}

/// 字体族与旧版 CSS 声明完全一致，已有用户设置无需迁移即可继续生效。
fn build_font_faces(version_dir: &Path) -> Vec<FontPackFace> {
    vec![
        face(
            version_dir,
            "JetBrains Mono",
            "400",
            "normal",
            "JetBrainsMono-Regular.woff2",
        ),
        face(
            version_dir,
            "JetBrains Mono",
            "400",
            "italic",
            "JetBrainsMono-Italic.woff2",
        ),
        face(
            version_dir,
            "JetBrains Mono",
            "700",
            "normal",
            "JetBrainsMono-Bold.woff2",
        ),
        face(
            version_dir,
            "JetBrains Mono",
            "700",
            "italic",
            "JetBrainsMono-BoldItalic.woff2",
        ),
        face(
            version_dir,
            "Maple Mono Normal NF CN",
            "400",
            "normal",
            "MapleMonoNormal-NF-CN-Regular.ttf",
        ),
        face(
            version_dir,
            "Maple Mono Normal NF CN",
            "700",
            "normal",
            "MapleMonoNormal-NF-CN-Bold.ttf",
        ),
    ]
}

fn build_status(root: &Path) -> FontPackStatus {
    let version_dir = pack_version_dir(root);
    let (state, faces) = if !version_dir.exists() {
        ("missing", Vec::new())
    } else if verify_installed_pack(&version_dir).is_ok() {
        ("ready", build_font_faces(&version_dir))
    } else {
        ("invalid", Vec::new())
    };
    FontPackStatus {
        id: FONT_PACK_ID.to_string(),
        version: FONT_PACK_VERSION.to_string(),
        state: state.to_string(),
        installed_size_bytes: FONT_PACK_INSTALLED_BYTES,
        download_size_bytes: FONT_PACK_DOWNLOAD_ESTIMATE_BYTES,
        download_url: FONT_PACK_DOWNLOAD_URL.to_string(),
        faces,
    }
}

fn emit_changed(app_handle: &AppHandle, status: &FontPackStatus) {
    // 多窗口各自拥有独立 FontFaceSet，状态变化必须广播，不能只更新发起命令的窗口。
    let _ = app_handle.emit(FONT_PACK_CHANGED_EVENT, status);
}

/// 流式下载到唯一临时文件，并以固定上限约束 Content-Length 与实际接收字节数。
async fn download_archive(
    app_handle: &AppHandle,
    client: &reqwest::Client,
    archive_path: &Path,
) -> Result<(), String> {
    let mut response = client
        .get(FONT_PACK_DOWNLOAD_URL)
        .header(reqwest::header::USER_AGENT, "NoteBoard")
        .send()
        .await
        .map_err(|error| font_pack_error("download", error.to_string()))?
        .error_for_status()
        .map_err(|error| font_pack_error("download", error.to_string()))?;
    let total_bytes = response.content_length();
    if total_bytes.is_some_and(|size| size == 0 || size > FONT_PACK_ARCHIVE_MAX_BYTES) {
        return Err(font_pack_error("archive_size", "content-length"));
    }

    let mut output = fs::File::create(archive_path)
        .map_err(|error| font_pack_error("write", error.to_string()))?;
    let mut downloaded_bytes = 0_u64;
    let mut last_emit = Instant::now();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| font_pack_error("download", error.to_string()))?
    {
        downloaded_bytes += chunk.len() as u64;
        if downloaded_bytes > FONT_PACK_ARCHIVE_MAX_BYTES {
            return Err(font_pack_error("archive_size", "downloaded"));
        }
        output
            .write_all(&chunk)
            .map_err(|error| font_pack_error("write", error.to_string()))?;
        if last_emit.elapsed() >= FONT_PACK_PROGRESS_THROTTLE {
            let percent = total_bytes.map(|total| {
                ((downloaded_bytes as f64 / total as f64) * 100.0)
                    .min(100.0)
                    .round() as u32
            });
            let _ = app_handle.emit(
                FONT_PACK_PROGRESS_EVENT,
                &FontPackDownloadProgressEvent {
                    downloaded_bytes,
                    total_bytes,
                    percent,
                },
            );
            last_emit = Instant::now();
        }
    }
    output
        .flush()
        .map_err(|error| font_pack_error("write", error.to_string()))?;
    if downloaded_bytes == 0 {
        return Err(font_pack_error("archive_size", "empty"));
    }
    let _ = app_handle.emit(
        FONT_PACK_PROGRESS_EVENT,
        &FontPackDownloadProgressEvent {
            downloaded_bytes,
            total_bytes: total_bytes.or(Some(downloaded_bytes)),
            percent: Some(100),
        },
    );
    Ok(())
}

/// 只按固定名称提取受信文件，输出路径不采用 ZIP 内部路径，彻底规避目录穿越。
fn extract_verified_archive(archive_path: &Path, staging_dir: &Path) -> Result<(), String> {
    let file =
        fs::File::open(archive_path).map_err(|error| font_pack_error("read", error.to_string()))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|error| font_pack_error("invalid_archive", error.to_string()))?;
    let fonts_dir = staging_dir.join("fonts");
    fs::create_dir_all(&fonts_dir).map_err(|error| font_pack_error("write", error.to_string()))?;

    for spec in FONT_FILES {
        let entry_name = format!("fonts/{}", spec.name);
        let mut entry = archive
            .by_name(&entry_name)
            .map_err(|_| font_pack_error("missing_file", spec.name))?;
        if entry.is_dir() || entry.size() != spec.size {
            return Err(font_pack_error("invalid_file", spec.name));
        }
        let output_path = fonts_dir.join(spec.name);
        let mut output = fs::File::create(&output_path)
            .map_err(|error| font_pack_error("write", error.to_string()))?;
        let mut hasher = Sha256::new();
        let mut written = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let size = entry
                .read(&mut buffer)
                .map_err(|error| font_pack_error("invalid_archive", error.to_string()))?;
            if size == 0 {
                break;
            }
            written += size as u64;
            if written > spec.size {
                return Err(font_pack_error("invalid_file", spec.name));
            }
            hasher.update(&buffer[..size]);
            output
                .write_all(&buffer[..size])
                .map_err(|error| font_pack_error("write", error.to_string()))?;
        }
        output
            .flush()
            .map_err(|error| font_pack_error("write", error.to_string()))?;
        if written != spec.size || format!("{:x}", hasher.finalize()) != spec.sha256 {
            return Err(font_pack_error("invalid_file", spec.name));
        }
    }

    // 本地清单只记录校验后的安装来源；启动状态仍逐文件复核，不信任清单自身。
    let installed_manifest = serde_json::json!({
        "id": FONT_PACK_ID,
        "version": FONT_PACK_VERSION,
        "releaseTag": FONT_PACK_RELEASE_TAG,
        "assetName": FONT_PACK_ASSET_NAME,
        "installedAt": chrono::Utc::now().to_rfc3339(),
    });
    fs::write(
        staging_dir.join("font-pack.json"),
        serde_json::to_vec_pretty(&installed_manifest)
            .map_err(|error| font_pack_error("write", error.to_string()))?,
    )
    .map_err(|error| font_pack_error("write", error.to_string()))?;
    Ok(())
}

/// 先完整解压到同盘临时目录，再用目录重命名切换；失败时恢复旧包，避免修复破坏可用版本。
fn install_archive_atomically(archive_path: &Path, root: &Path) -> Result<FontPackStatus, String> {
    let pack_root = root.join(FONT_PACK_ID);
    fs::create_dir_all(&pack_root).map_err(|error| font_pack_error("write", error.to_string()))?;
    let operation_id = Uuid::new_v4();
    let target_dir = pack_version_dir(root);
    let staging_dir = pack_root.join(format!(".{FONT_PACK_VERSION}-installing-{operation_id}"));
    let backup_dir = pack_root.join(format!(".{FONT_PACK_VERSION}-backup-{operation_id}"));

    if let Err(error) = extract_verified_archive(archive_path, &staging_dir) {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(error);
    }

    if target_dir.exists() {
        fs::rename(&target_dir, &backup_dir)
            .map_err(|error| font_pack_error("write", error.to_string()))?;
    }
    if let Err(error) = fs::rename(&staging_dir, &target_dir) {
        if backup_dir.exists() {
            let _ = fs::rename(&backup_dir, &target_dir);
        }
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(font_pack_error("write", error.to_string()));
    }
    // 理论上解压阶段已经校验；若落盘后仍发生异常，必须恢复旧版本而不是遗留损坏目录。
    if let Err(error) = verify_installed_pack(&target_dir) {
        let _ = fs::remove_dir_all(&target_dir);
        if backup_dir.exists() {
            let _ = fs::rename(&backup_dir, &target_dir);
        }
        return Err(error);
    }
    let _ = fs::remove_dir_all(&backup_dir);
    Ok(build_status(root))
}

/// 查询字体包状态时总是重新校验，供首次启动与设置页修复入口共同使用。
#[tauri::command]
pub fn get_font_pack_status() -> Result<FontPackStatus, String> {
    Ok(build_status(&font_packs_root_dir()))
}

/// 从固定 GitHub Release 下载并启用字体包；系统代理失败或返回 403 时回退直连。
#[tauri::command]
pub async fn download_font_pack(app_handle: AppHandle) -> Result<FontPackStatus, String> {
    let root = font_packs_root_dir();
    let current = build_status(&root);
    if current.state == "ready" {
        return Ok(current);
    }
    fs::create_dir_all(&root).map_err(|error| font_pack_error("write", error.to_string()))?;
    // 每次操作使用独立临时文件，多窗口同时请求不会互删下载中的数据。
    let archive_path = root.join(format!(
        "{FONT_PACK_ID}-{FONT_PACK_VERSION}-{}.zip.download",
        Uuid::new_v4()
    ));

    let client = build_update_http_client(FONT_PACK_DOWNLOAD_TIMEOUT)
        .map_err(|error| font_pack_error("download", error))?;
    let first_attempt = download_archive(&app_handle, &client, &archive_path).await;
    let download_result = match first_attempt {
        Err(error) if error.contains("403") => {
            let direct_client = build_direct_http_client(FONT_PACK_DOWNLOAD_TIMEOUT)
                .map_err(|direct_error| font_pack_error("download", direct_error))?;
            download_archive(&app_handle, &direct_client, &archive_path).await
        }
        result => result,
    };
    if let Err(error) = download_result {
        let _ = fs::remove_file(&archive_path);
        return Err(error);
    }

    let install_path = archive_path.clone();
    let install_root = root.clone();
    let install_result = tauri::async_runtime::spawn_blocking(move || {
        install_archive_atomically(&install_path, &install_root)
    })
    .await
    .map_err(|error| font_pack_error("install", error.to_string()))?;
    let _ = fs::remove_file(&archive_path);
    let status = install_result?;
    emit_changed(&app_handle, &status);
    Ok(status)
}

/// 导入离线字体包仍执行同一份大小与哈希校验，不能绕过固定清单信任根。
#[tauri::command]
pub async fn import_font_pack(
    app_handle: AppHandle,
    source_path: String,
) -> Result<FontPackStatus, String> {
    let source = PathBuf::from(source_path.trim());
    let metadata =
        fs::metadata(&source).map_err(|error| font_pack_error("read", error.to_string()))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > FONT_PACK_ARCHIVE_MAX_BYTES {
        return Err(font_pack_error("archive_size", "import"));
    }
    let root = font_packs_root_dir();
    let install_path = source.clone();
    let status = tauri::async_runtime::spawn_blocking(move || {
        install_archive_atomically(&install_path, &root)
    })
    .await
    .map_err(|error| font_pack_error("install", error.to_string()))??;
    emit_changed(&app_handle, &status);
    Ok(status)
}

/// 删除当前字体包与残留下载文件；普通应用卸载不会调用该命令，因此升级和默认卸载均保留字体。
#[tauri::command]
pub fn remove_font_pack(app_handle: AppHandle) -> Result<FontPackStatus, String> {
    let root = font_packs_root_dir();
    let version_dir = pack_version_dir(&root);
    match fs::remove_dir_all(&version_dir) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(font_pack_error("remove", error.to_string())),
    }
    // 清理由历史失败或中断留下的下载文件，只触碰当前字体包命名空间。
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            let path = entry.path();
            let is_download = path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.starts_with(&format!("{FONT_PACK_ID}-{FONT_PACK_VERSION}-"))
                        && name.ends_with(".zip.download")
                });
            if is_download {
                let _ = fs::remove_file(path);
            }
        }
    }
    let status = build_status(&root);
    emit_changed(&app_handle, &status);
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 内置总体积用于界面说明，必须与逐文件信任清单严格一致。
    #[test]
    fn font_manifest_size_matches_file_specs() {
        let total: u64 = FONT_FILES.iter().map(|spec| spec.size).sum();
        assert_eq!(total, FONT_PACK_INSTALLED_BYTES);
    }

    /// 每个 WebView 注册描述都必须引用清单中的受信文件。
    #[test]
    fn font_face_files_are_all_declared_in_manifest() {
        let root = Path::new("C:/font-pack-test");
        let declared = FONT_FILES
            .iter()
            .map(|spec| spec.name)
            .collect::<std::collections::HashSet<_>>();
        for face in build_font_faces(root) {
            let name = Path::new(&face.path)
                .file_name()
                .and_then(|value| value.to_str())
                .expect("字体描述应包含 UTF-8 文件名");
            assert!(declared.contains(name));
        }
    }

    /// 仓库内用于 GitHub Action 制包的源文件必须与应用内置哈希清单相同。
    #[test]
    fn source_font_files_match_embedded_manifest() {
        let font_source_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("src")
            .join("assets")
            .join("fonts");
        for spec in FONT_FILES {
            let path = font_source_dir.join(spec.name);
            let metadata = fs::metadata(&path).expect("字体包源文件应存在");
            assert_eq!(metadata.len(), spec.size, "字体大小不匹配：{}", spec.name);
            assert_eq!(
                sha256_file(&path).expect("字体包源文件应可读取"),
                spec.sha256,
                "字体哈希不匹配：{}",
                spec.name
            );
        }
    }
}
