//! 画板手写字体包（小赖）：按需下载、逐文件校验、原子安装与状态查询。
//!
//! 小赖中文手写体约 13 MB（209 个 unicode-range 分片），为控制安装包体积不再随应用分发。
//! 与核心字体包（font_pack.rs）的区别：
//!   1. 信任根是内嵌清单 board_font_pack.json（scripts/build-board-font-pack.mjs 从 Excalidraw 生成），
//!      逐文件大小 + SHA-256 校验，并携带 unicode-range 供前端在同一会话内补注册字体面；
//!   2. 目录结构保留 Excalidraw 的 fonts/Xiaolai/<分片>，前端把包目录直接作为 EXCALIDRAW_ASSET_PATH 之一；
//!   3. 体积约为核心包的三分之一，状态查询在 blocking 线程同步完成全量校验，不引入后台验证状态机。

use std::{
    fs,
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
    sync::OnceLock,
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;
use zip::ZipArchive;

use crate::font_pack::{
    download_archive_with_fallback, font_pack_error, font_packs_root_dir, sha256_file,
    ArchiveSource,
};

const PACK_ID: &str = "board";
const RELEASE_TAG: &str = "fonts-board-v1.0.0";
const ASSET_NAME: &str = "NoteBoard-fontpack-board-v1.0.0.zip";
const DOWNLOAD_URL: &str = "https://github.com/CrazyFigure/NoteBoard/releases/download/fonts-board-v1.0.0/NoteBoard-fontpack-board-v1.0.0.zip";
// 附件为仅存储 ZIP（WOFF2 已压缩），约 12.2 MiB；上限留出余量并阻止错误资产无限写盘。
const ARCHIVE_MAX_BYTES: u64 = 20 * 1024 * 1024;
const PROGRESS_EVENT: &str = "noteboard-board-font-pack-download-progress";
const CHANGED_EVENT: &str = "noteboard-board-font-pack-changed";
const MANIFEST_JSON: &str = include_str!("board_font_pack.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: String,
    family: String,
    files: Vec<ManifestFile>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestFile {
    name: String,
    size: u64,
    sha256: String,
    unicode_range: String,
}

fn manifest() -> &'static Manifest {
    static MANIFEST: OnceLock<Manifest> = OnceLock::new();
    MANIFEST.get_or_init(|| serde_json::from_str(MANIFEST_JSON).expect("内嵌画板字体清单必须合法"))
}

/// 前端按分片注册 FontFace 所需的描述
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BoardFontFace {
    pub file: String,
    pub unicode_range: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BoardFontPackStatus {
    pub id: String,
    pub version: String,
    /// missing=从未安装；ready=文件完整；invalid=目录存在但文件缺失或校验失败。
    pub state: String,
    pub family: String,
    pub installed_size_bytes: u64,
    pub download_size_bytes: u64,
    /// 包目录（其下为 fonts/Xiaolai/<分片>），作为 Excalidraw 资源根目录
    pub base_dir: String,
    /// 仅 ready 时非空
    pub faces: Vec<BoardFontFace>,
}

fn pack_dir(root: &Path) -> PathBuf {
    root.join(PACK_ID).join(&manifest().version)
}

fn fonts_dir(pack_dir: &Path) -> PathBuf {
    pack_dir.join("fonts").join(&manifest().family)
}

fn installed_size() -> u64 {
    manifest().files.iter().map(|file| file.size).sum()
}

/// 每次查询都完整校验大小与 SHA-256，不能只凭目录存在就把字体交给 WebView。
fn verify_installed(pack_dir: &Path) -> Result<(), String> {
    let dir = fonts_dir(pack_dir);
    for spec in &manifest().files {
        let path = dir.join(&spec.name);
        let metadata =
            fs::metadata(&path).map_err(|_| font_pack_error("missing_file", &spec.name))?;
        if !metadata.is_file() || metadata.len() != spec.size || sha256_file(&path)? != spec.sha256
        {
            return Err(font_pack_error("invalid_file", &spec.name));
        }
    }
    Ok(())
}

fn status_with(root: &Path, state: &str) -> BoardFontPackStatus {
    let faces = if state == "ready" {
        manifest()
            .files
            .iter()
            .map(|file| BoardFontFace {
                file: file.name.clone(),
                unicode_range: file.unicode_range.clone(),
            })
            .collect()
    } else {
        Vec::new()
    };
    BoardFontPackStatus {
        id: PACK_ID.to_string(),
        version: manifest().version.clone(),
        state: state.to_string(),
        family: manifest().family.clone(),
        installed_size_bytes: installed_size(),
        download_size_bytes: installed_size(),
        base_dir: pack_dir(root).to_string_lossy().to_string(),
        faces,
    }
}

fn build_status(root: &Path) -> BoardFontPackStatus {
    let dir = pack_dir(root);
    let state = if !dir.exists() {
        "missing"
    } else if verify_installed(&dir).is_ok() {
        "ready"
    } else {
        "invalid"
    };
    status_with(root, state)
}

/// 只按清单中的固定名称提取文件，输出路径不采用 ZIP 内部路径，规避目录穿越。
fn extract_verified_archive(archive_path: &Path, staging_dir: &Path) -> Result<(), String> {
    let file =
        fs::File::open(archive_path).map_err(|error| font_pack_error("read", error.to_string()))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|error| font_pack_error("invalid_archive", error.to_string()))?;
    let output_dir = fonts_dir(staging_dir);
    fs::create_dir_all(&output_dir).map_err(|error| font_pack_error("write", error.to_string()))?;

    for spec in &manifest().files {
        let entry_name = format!("fonts/{}/{}", manifest().family, spec.name);
        let mut entry = archive
            .by_name(&entry_name)
            .map_err(|_| font_pack_error("missing_file", &spec.name))?;
        if entry.is_dir() || entry.size() != spec.size {
            return Err(font_pack_error("invalid_file", &spec.name));
        }
        let mut output = fs::File::create(output_dir.join(&spec.name))
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
                return Err(font_pack_error("invalid_file", &spec.name));
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
            return Err(font_pack_error("invalid_file", &spec.name));
        }
    }

    // 本地清单只记录安装来源；状态查询仍逐文件复核，不信任清单自身。
    let installed_manifest = serde_json::json!({
        "id": PACK_ID,
        "version": manifest().version,
        "releaseTag": RELEASE_TAG,
        "assetName": ASSET_NAME,
        "installedAt": chrono::Utc::now().to_rfc3339(),
    });
    fs::write(
        staging_dir.join("font-pack.json"),
        serde_json::to_vec_pretty(&installed_manifest)
            .map_err(|error| font_pack_error("write", error.to_string()))?,
    )
    .map_err(|error| font_pack_error("write", error.to_string()))
}

/// 先完整解压到同盘临时目录，再用目录重命名切换；失败时恢复旧包。
fn install_archive_atomically(
    archive_path: &Path,
    root: &Path,
) -> Result<BoardFontPackStatus, String> {
    let pack_root = root.join(PACK_ID);
    fs::create_dir_all(&pack_root).map_err(|error| font_pack_error("write", error.to_string()))?;
    let version = &manifest().version;
    let operation_id = Uuid::new_v4();
    let target_dir = pack_dir(root);
    let staging_dir = pack_root.join(format!(".{version}-installing-{operation_id}"));
    let backup_dir = pack_root.join(format!(".{version}-backup-{operation_id}"));

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
    let _ = fs::remove_dir_all(&backup_dir);
    Ok(build_status(root))
}

fn emit_changed(app_handle: &AppHandle, status: &BoardFontPackStatus) {
    // 多窗口各自拥有独立 FontFaceSet，状态变化必须广播。
    let _ = app_handle.emit(CHANGED_EVENT, status);
}

/// 查询画板手写字体包状态；全量校验约 13 MB，在 blocking 线程执行。
#[tauri::command]
pub async fn get_board_font_pack_status() -> Result<BoardFontPackStatus, String> {
    tauri::async_runtime::spawn_blocking(|| build_status(&font_packs_root_dir()))
        .await
        .map_err(|error| font_pack_error("read", error.to_string()))
}

/// 从固定 GitHub Release（或其 CNB 镜像）下载并安装画板手写字体包。
#[tauri::command]
pub async fn download_board_font_pack(
    app_handle: AppHandle,
) -> Result<BoardFontPackStatus, String> {
    let root = font_packs_root_dir();
    fs::create_dir_all(&root).map_err(|error| font_pack_error("write", error.to_string()))?;
    // 每次操作使用独立临时文件，多窗口同时请求不会互删下载中的数据。
    let archive_path = root.join(format!(
        "{PACK_ID}-{}-{}.zip.download",
        manifest().version,
        Uuid::new_v4()
    ));
    let source = ArchiveSource {
        url: DOWNLOAD_URL,
        max_bytes: ARCHIVE_MAX_BYTES,
        progress_event: PROGRESS_EVENT,
    };
    if let Err(error) = download_archive_with_fallback(&app_handle, &archive_path, &source).await {
        let _ = fs::remove_file(&archive_path);
        return Err(error);
    }
    let install_path = archive_path.clone();
    let install_root = root.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        install_archive_atomically(&install_path, &install_root)
    })
    .await
    .map_err(|error| font_pack_error("install", error.to_string()))?;
    let _ = fs::remove_file(&archive_path);
    let status = result?;
    emit_changed(&app_handle, &status);
    Ok(status)
}

/// 删除画板手写字体包与残留下载文件，只触碰本包命名空间。
#[tauri::command]
pub fn remove_board_font_pack(app_handle: AppHandle) -> Result<BoardFontPackStatus, String> {
    let root = font_packs_root_dir();
    match fs::remove_dir_all(pack_dir(&root)) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(font_pack_error("remove", error.to_string())),
    }
    let prefix = format!("{PACK_ID}-{}-", manifest().version);
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            let is_download = entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(&prefix) && name.ends_with(".zip.download"));
            if is_download {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    let status = status_with(&root, "missing");
    emit_changed(&app_handle, &status);
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 内嵌清单可解析，且文件名均为 Excalidraw 小赖分片（防止清单被误替换为任意路径）
    #[test]
    fn manifest_is_valid() {
        let manifest = manifest();
        assert_eq!(manifest.family, "Xiaolai");
        assert!(manifest.files.len() > 100);
        for file in &manifest.files {
            assert!(file.name.starts_with("Xiaolai-Regular-") && file.name.ends_with(".woff2"));
            assert!(!file.name.contains(['/', '\\']));
            assert_eq!(file.sha256.len(), 64);
            assert!(file.unicode_range.starts_with("U+"));
        }
        assert!(installed_size() < ARCHIVE_MAX_BYTES);
    }

    /// 下载地址与版本、附件名一致，CNB 渠道按同名附件改写
    #[test]
    fn download_url_matches_release_asset() {
        assert!(DOWNLOAD_URL.ends_with(&format!("{RELEASE_TAG}/{ASSET_NAME}")));
        assert!(ASSET_NAME.contains(&format!("v{}", manifest().version)));
    }

    /// 发布前手动验证真实附件：NB_BOARD_FONT_ZIP=<zip 路径> cargo test --lib board_font_pack -- --ignored
    #[test]
    #[ignore]
    fn installs_release_asset_from_env() {
        let archive =
            PathBuf::from(std::env::var("NB_BOARD_FONT_ZIP").expect("需设置 NB_BOARD_FONT_ZIP"));
        let root = std::env::temp_dir().join(format!("nb-board-font-asset-{}", Uuid::new_v4()));
        let status = install_archive_atomically(&archive, &root).unwrap();
        assert_eq!(status.state, "ready");
        assert_eq!(status.faces.len(), manifest().files.len());
        let _ = fs::remove_dir_all(&root);
    }

    /// 由制包脚本产出的 ZIP 结构安装后应判定为 ready；篡改任一分片则为 invalid
    #[test]
    fn install_and_verify_roundtrip() {
        let temp = std::env::temp_dir().join(format!("nb-board-font-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp).unwrap();
        let source_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("node_modules")
            .join("@excalidraw")
            .join("excalidraw")
            .join("dist")
            .join("prod")
            .join("fonts")
            .join("Xiaolai");
        if !source_dir.exists() {
            // 未安装前端依赖的纯 Rust 环境跳过
            return;
        }
        let archive_path = temp.join("pack.zip");
        {
            let mut writer = zip::ZipWriter::new(fs::File::create(&archive_path).unwrap());
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            for spec in &manifest().files {
                writer
                    .start_file(format!("fonts/Xiaolai/{}", spec.name), options)
                    .unwrap();
                writer
                    .write_all(&fs::read(source_dir.join(&spec.name)).unwrap())
                    .unwrap();
            }
            writer.finish().unwrap();
        }
        let root = temp.join("root");
        let status = install_archive_atomically(&archive_path, &root).unwrap();
        assert_eq!(status.state, "ready");
        assert_eq!(status.faces.len(), manifest().files.len());
        let first = fonts_dir(&pack_dir(&root)).join(&manifest().files[0].name);
        fs::write(&first, b"tampered").unwrap();
        assert_eq!(build_status(&root).state, "invalid");
        let _ = fs::remove_dir_all(&temp);
    }
}
