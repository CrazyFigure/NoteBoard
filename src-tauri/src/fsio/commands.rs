// NoteBoard fsio 命令 — IPC 接口
// 所有文件 I/O 命令的 Tauri command 封装

use crate::dto::{
    DocumentPayload, FileTreeNode, PathExistsResult, ProbeResult, WriteResult,
};
use crate::path as nbpath;
use std::path::{Path, PathBuf};

use super::dir;
use super::read;
use super::trash;
use super::write;

/// 读取文档
#[tauri::command]
pub fn read_document(path: String) -> Result<DocumentPayload, String> {
    let p = Path::new(&path);

    if !p.exists() {
        return Err(format!("文件不存在: {}", path));
    }

    // 只读二进制不做编码探测，防止恢复或外部变更核对时把 Office 内容解码为文本。
    if crate::dto::kind_from_path(&path).0 == crate::dto::DocumentKind::Preview {
        let metadata = std::fs::metadata(p).map_err(|e| e.to_string())?;
        return Ok(DocumentPayload {
            key: nbpath::normalize_key(&path), display_name: nbpath::basename(&path),
            dir_path: nbpath::parent_dir(&path).unwrap_or_default(), kind: crate::dto::DocumentKind::Preview,
            language: crate::dto::LanguageId::Plaintext, content: None,
            encoding: crate::dto::Encoding::Utf8, eol: crate::dto::Eol::Lf,
            size: metadata.len(), mtime: metadata.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|t| t.as_millis() as i64).unwrap_or(0), readonly: true,
        });
    }

    let result = read::read_file(p).map_err(|e| e.to_string())?;

    let (kind, language) = crate::dto::kind_from_path(&path);
    let key = nbpath::normalize_key(&path);
    let display_name = nbpath::basename(&path);
    let dir_path = nbpath::parent_dir(&path).unwrap_or_default();

    Ok(DocumentPayload {
        key,
        display_name,
        dir_path,
        kind,
        language,
        content: Some(result.content),
        encoding: result.encoding,
        eol: result.eol,
        size: result.size,
        mtime: result.mtime,
        readonly: result.readonly,
    })
}

/// 从应用文件层读取 XMind；阻塞磁盘操作放入工作线程，二进制响应避免逐字节 JSON 序列化。
#[tauri::command]
pub async fn read_xmind_file(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || read::read_xmind_bytes(Path::new(&path)))
        .await
        .map_err(|error| format!("读取 XMind 的任务失败: {}", error))??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 插件查看仅允许 Office、PDF、CAD、EPUB 等明确格式和 50 MiB 普通文件，原始字节走二进制 IPC。
#[tauri::command]
pub async fn read_preview_file(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        if crate::dto::kind_from_path(&path).0 != crate::dto::DocumentKind::Preview { return Err("此入口仅用于插件查看的文档".to_string()); }
        let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.len() > 50 * 1024 * 1024 { return Err("查看文件须为 50 MB 以内的普通文件".into()); }
        std::fs::read(path).map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 探测文件（读盘前）
#[tauri::command]
pub fn probe_document(path: String) -> Result<ProbeResult, String> {
    let p = Path::new(&path);

    if !p.exists() {
        return Ok(ProbeResult {
            exists: false,
            ..Default::default()
        });
    }

    if p.is_dir() {
        return Ok(ProbeResult {
            exists: true,
            is_dir: true,
            ..Default::default()
        });
    }

    let metadata = std::fs::metadata(p).map_err(|e| e.to_string())?;
    let (kind, _lang) = crate::dto::kind_from_path(&path);
    let is_text = read::is_text_file(p).unwrap_or(false);

    Ok(ProbeResult {
        size: metadata.len(),
        kind,
        is_text,
        exists: true,
        is_dir: false,
    })
}

/// 写入文档（原子写）
#[tauri::command]
pub fn write_document(
    path: String,
    content: String,
    encoding: crate::dto::Encoding,
    eol: crate::dto::Eol,
) -> Result<WriteResult, String> {
    let p = Path::new(&path);
    // 查看器文件禁止通过文本写入接口覆盖，二进制导入仍由专用接口处理。
    if crate::dto::kind_from_path(&path).0 == crate::dto::DocumentKind::Preview { return Err("Office 和 PDF 仅支持只读查看".into()); }
    crate::sync::hooks::prepare_write(p);
    // 历史记录：磁盘上尚未记录的旧内容（首次记录 / 应用外修改）在覆盖前补记
    crate::history::hooks::prepare_write(p);

    match write::write_with_encoding(p, &content, encoding, eol) {
        Ok((size, mtime)) => {
            // 同步目录内的手动/自动保存触发同步（防抖合并）
            crate::sync::hooks::on_written(p);
            // 历史记录：后台记录本次保存的版本
            crate::history::hooks::on_written(p);
            Ok(WriteResult {
                ok: true,
                mtime,
                size,
                error: None,
            })
        }
        Err(e) => Ok(WriteResult {
            ok: false,
            mtime: 0,
            size: 0,
            error: Some(e),
        }),
    }
}

/// 保存二进制文件（如粘贴或插入的图片，自动创建父级目录）
#[tauri::command]
pub fn save_binary_file(path: String, data: Vec<u8>) -> Result<WriteResult, String> {
    let p = Path::new(&path);

    // 确保目标父级目录存在
    if let Some(parent) = p.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建图片存储目录失败: {}", e))?;
        }
    }

    // 写入二进制字节数据
    std::fs::write(p, &data).map_err(|e| format!("写入二进制文件失败: {}", e))?;
    crate::sync::hooks::on_written(p);

    let metadata = std::fs::metadata(p).map_err(|e| e.to_string())?;
    let mtime = metadata
        .modified()
        .map(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64
        })
        .unwrap_or(0);

    Ok(WriteResult {
        ok: true,
        mtime: mtime as i64,
        size: metadata.len(),
        error: None,
    })
}

/// 读取目录
#[tauri::command]
pub fn read_dir(path: String, show_hidden: bool) -> Result<Vec<FileTreeNode>, String> {
    let p = Path::new(&path);
    dir::read_directory(p, show_hidden)
}

/// 创建文件
#[tauri::command]
pub fn create_file(
    dir: String,
    name: String,
    template: String,
) -> Result<DocumentPayload, String> {
    let mut path = PathBuf::from(&dir);
    path.push(&name);

    // 检查是否已存在
    if path.exists() {
        return Err(format!("文件已存在: {}", path.display()));
    }

    // 创建文件
    std::fs::write(&path, "").map_err(|e| format!("创建文件失败: {}", e))?;
    crate::sync::hooks::on_written(&path);

    // 读取返回
    let result = read::read_file(&path).map_err(|e| e.to_string())?;
    let (kind, language) = if template == "markdown" {
        (crate::dto::DocumentKind::Markdown, crate::dto::LanguageId::Markdown)
    } else if template == "board" {
        (crate::dto::DocumentKind::Board, crate::dto::LanguageId::Plaintext)
    } else {
        crate::dto::kind_from_path(&path.to_string_lossy())
    };

    let key = nbpath::normalize_key(&path.to_string_lossy());
    let display_name = nbpath::basename(&path.to_string_lossy());
    let dir_path = nbpath::parent_dir(&path.to_string_lossy()).unwrap_or_default();

    Ok(DocumentPayload {
        key,
        display_name,
        dir_path,
        kind,
        language,
        content: Some(result.content),
        encoding: result.encoding,
        eol: result.eol,
        size: result.size,
        mtime: result.mtime,
        readonly: result.readonly,
    })
}

/// 创建目录
#[tauri::command]
pub fn create_dir(dir: String, name: String) -> Result<(), String> {
    let mut path = PathBuf::from(&dir);
    path.push(&name);
    std::fs::create_dir(&path).map_err(|e| format!("创建目录失败: {}", e))
}

/// 重命名
#[tauri::command]
pub fn rename_path(from: String, to: String) -> Result<(), String> {
    std::fs::rename(&from, &to).map_err(|e| format!("重命名失败: {}", e))?;
    // 同步目录内改名：登记改名线索，其他设备执行改名而不是删除+新建
    crate::sync::hooks::on_renamed(Path::new(&from), Path::new(&to));
    // 历史记录跟随新路径（目录改名时其中全部文档一起跟随）
    crate::history::hooks::on_renamed(Path::new(&from), Path::new(&to));
    Ok(())
}

/// 移到回收站
#[tauri::command]
pub fn move_to_trash(path: String) -> Result<(), String> {
    // 已开启多端同步且启用回收站时，同步目录内的删除移入同步回收站（可在各设备恢复）
    let result = match crate::sync::hooks::try_move_to_sync_trash(Path::new(&path)) {
        Some(result) => result,
        None => trash::move_to_trash(Path::new(&path)),
    };
    // 删除成功后历史转入待清理（保留期内恢复同一文件时重新关联）
    if result.is_ok() {
        crate::history::hooks::on_deleted(Path::new(&path));
    }
    result
}

/// 路径是否存在
#[tauri::command]
pub fn path_exists(path: String) -> Result<PathExistsResult, String> {
    let p = Path::new(&path);
    Ok(PathExistsResult {
        exists: p.exists(),
        is_dir: p.is_dir(),
    })
}

/// 在资源管理器中显示
#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    // 移动端没有可定位文件的系统文件管理器入口（前端已隐藏该操作）
    #[cfg(mobile)]
    {
        let _ = path;
        return Err("移动端不支持在文件管理器中显示".to_string());
    }
    #[allow(unreachable_code)]
    // 用 std::process::Command 调用 explorer
    std::process::Command::new("explorer")
        .arg(format!("/select,{}", path))
        .spawn()
        .map_err(|e| format!("无法打开资源管理器: {}", e))?;
    Ok(())
}

/// 用系统默认程序打开
#[tauri::command]
pub fn open_with_default_app(path: String) -> Result<(), String> {
    // 用 Windows 的 start 命令
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn()
            .map_err(|e| format!("无法打开文件: {}", e))?;
    }
    // macOS 没有 xdg-open，使用系统自带的 open
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("无法打开文件: {}", e))?;
    }
    #[cfg(all(not(windows), not(target_os = "macos"), desktop))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("无法打开文件: {}", e))?;
    }
    // 移动端以系统分享代替"用默认程序打开"（前端改走 share_file）
    #[cfg(mobile)]
    {
        let _ = path;
        return Err("移动端请使用分享打开文件".to_string());
    }
    #[allow(unreachable_code)]
    Ok(())
}


/// 取消监听
#[tauri::command]
pub fn unwatch_dir(_path: String) -> Result<(), String> {
    Ok(())
}
