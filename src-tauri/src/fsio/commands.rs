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

/// 插件查看按格式执行大小限制；磁盘读取放入工作线程，原始字节走二进制 IPC。
#[tauri::command]
pub async fn read_preview_file(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || read::read_preview_bytes(Path::new(&path)))
        .await.map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// PDF 分块只在工作线程读盘；二进制响应避免逐字节 JSON 序列化。
#[tauri::command]
pub async fn read_pdf_file_range(path: String, begin: u64, end: u64, size: u64) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || super::pdf::read_range(Path::new(&path), begin, end, size))
        .await.map_err(|e| e.to_string())??;
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
/// 保留给网页端适配层兼容使用；桌面与移动端改用 save_binary_file_raw：
/// 这里的 data 以 JSON 数字数组传输且在主线程反序列化，1 MB 约需 0.2 秒，期间界面卡住。
#[tauri::command]
pub fn save_binary_file(path: String, data: Vec<u8>) -> Result<WriteResult, String> {
    write_binary_file(Path::new(&path), &data)
}

/// 保存二进制文件：正文为原始字节，目标路径经 x-nb-path 请求头传递（百分号编码，支持中文路径）。
/// 异步命令在工作线程写盘，不占用主线程；传输约为 JSON 数字数组的 1/14 耗时。
#[tauri::command]
pub async fn save_binary_file_raw(request: tauri::ipc::Request<'_>) -> Result<WriteResult, String> {
    // 兼容 postMessage 回退通道（安卓、CSP 拦截自定义协议后）传来的 JSON 数字数组
    let Some(data) = crate::ipc_body::body_bytes(request.body()) else {
        return Err("文件数据格式无效".to_string());
    };
    let path = request
        .headers()
        .get("x-nb-path")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| percent_encoding::percent_decode_str(value).decode_utf8().ok())
        .map(|value| value.into_owned())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "缺少保存路径".to_string())?;
    tauri::async_runtime::spawn_blocking(move || write_binary_file(Path::new(&path), &data))
        .await
        .map_err(|e| format!("保存文件的任务失败: {}", e))?
}

/// 写入二进制文件并返回写后元数据（两个保存命令共用）
fn write_binary_file(p: &Path, data: &[u8]) -> Result<WriteResult, String> {
    // 确保目标父级目录存在
    if let Some(parent) = p.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建图片存储目录失败: {}", e))?;
        }
    }

    // 写入二进制字节数据
    std::fs::write(p, data).map_err(|e| format!("写入二进制文件失败: {}", e))?;
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
    // 系统重命名遇到同名目标会直接覆盖（Windows 同样替换已有文件），资源管理器改名时会静默丢失另一个文件；
    // 与网页版服务端一致，目标已存在时拒绝。仅大小写不同且指向同一文件时（不区分大小写的文件系统）放行。
    if rename_target_conflicts(Path::new(&from), Path::new(&to)) {
        return Err(format!("已存在同名文件或文件夹：{}", nbpath::basename(&to)));
    }
    std::fs::rename(&from, &to).map_err(|e| format!("重命名失败: {}", e))?;
    // 同步目录内改名：登记改名线索，其他设备执行改名而不是删除+新建
    crate::sync::hooks::on_renamed(Path::new(&from), Path::new(&to));
    // 历史记录跟随新路径（目录改名时其中全部文档一起跟随）
    crate::history::hooks::on_renamed(Path::new(&from), Path::new(&to));
    Ok(())
}

/// 重命名目标是否会覆盖另一个已存在的文件或文件夹
fn rename_target_conflicts(from: &Path, to: &Path) -> bool {
    // symlink_metadata：目标是失效的符号链接时同样视为已存在
    std::fs::symlink_metadata(to).is_ok() && !is_same_file(from, to)
}

/// 两个路径是否指向同一文件（用于放行仅改大小写的重命名）
fn is_same_file(a: &Path, b: &Path) -> bool {
    // Unix（含 macOS / 安卓）按设备号 + inode 判断，不受大小写与链接写法影响
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (std::fs::metadata(a), std::fs::metadata(b)) {
            (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
            _ => false,
        }
    }
    // Windows 规范化路径会取回磁盘上的真实大小写，同一文件两种写法得到相同结果
    #[cfg(windows)]
    {
        match (dunce::canonicalize(a), dunce::canonicalize(b)) {
            (Ok(x), Ok(y)) => x == y,
            _ => false,
        }
    }
}

#[cfg(test)]
mod rename_tests {
    use super::*;

    #[test]
    fn rename_refuses_to_overwrite_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.png");
        let b = dir.path().join("b.png");
        std::fs::write(&a, b"A").unwrap();
        std::fs::write(&b, b"B").unwrap();
        let result = rename_path(a.to_string_lossy().into_owned(), b.to_string_lossy().into_owned());
        assert!(result.unwrap_err().contains("已存在同名"));
        // 两个文件都保持原样
        assert_eq!(std::fs::read(&a).unwrap(), b"A");
        assert_eq!(std::fs::read(&b).unwrap(), b"B");
    }

    #[test]
    fn rename_to_new_name_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.png");
        let c = dir.path().join("c.png");
        std::fs::write(&a, b"A").unwrap();
        rename_path(a.to_string_lossy().into_owned(), c.to_string_lossy().into_owned()).unwrap();
        assert!(!a.exists());
        assert_eq!(std::fs::read(&c).unwrap(), b"A");
    }

    #[test]
    fn case_only_rename_is_allowed() {
        let dir = tempfile::tempdir().unwrap();
        let lower = dir.path().join("shot.png");
        let upper = dir.path().join("Shot.png");
        std::fs::write(&lower, b"A").unwrap();
        // 不区分大小写的文件系统上两种写法是同一文件，不算冲突；区分大小写时目标不存在，同样不冲突
        assert!(!rename_target_conflicts(&lower, &upper));
    }
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
/// 异步命令：macOS / Linux 的定位调用（NSWorkspace / D-Bus）不占用主线程
#[tauri::command]
pub async fn reveal_in_explorer(path: String) -> Result<(), String> {
    // 移动端没有可定位文件的系统文件管理器入口（前端已隐藏该操作）
    #[cfg(mobile)]
    {
        let _ = path;
        return Err("移动端不支持在文件管理器中显示".to_string());
    }
    // Windows 用 std::process::Command 调用 explorer
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path))
            .spawn()
            .map_err(|e| format!("无法打开资源管理器: {}", e))?;
    }
    // macOS 访达 / Linux 文件管理器没有 explorer 命令，交给 opener 插件定位并选中文件
    #[cfg(all(desktop, not(windows)))]
    {
        tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| format!("无法打开文件管理器: {}", e))?;
    }
    #[allow(unreachable_code)]
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
