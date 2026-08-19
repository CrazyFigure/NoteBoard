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

    match write::write_with_encoding(p, &content, encoding, eol) {
        Ok((size, mtime)) => Ok(WriteResult {
            ok: true,
            mtime,
            size,
            error: None,
        }),
        Err(e) => Ok(WriteResult {
            ok: false,
            mtime: 0,
            size: 0,
            error: Some(e),
        }),
    }
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
    std::fs::rename(&from, &to).map_err(|e| format!("重命名失败: {}", e))
}

/// 移到回收站
#[tauri::command]
pub fn move_to_trash(path: String) -> Result<(), String> {
    trash::move_to_trash(Path::new(&path))
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
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("无法打开文件: {}", e))?;
    }
    Ok(())
}

/// 监听目录
#[tauri::command]
pub fn watch_dir(_path: String, _recursive: bool, _delay_ms: u64) -> Result<(), String> {
    // tauri-plugin-fs 的 watch 由前端直接调用
    Ok(())
}

/// 取消监听
#[tauri::command]
pub fn unwatch_dir(_path: String) -> Result<(), String> {
    Ok(())
}
