// NoteBoard 原子写入 — 先写临时文件再 rename 覆盖
// FR-1205: 避免写入中断导致文件损坏
// 临时文件必须与目标同目录（跨卷 rename 不是原子操作）

use crate::dto::{Encoding, Eol, WriteError};
use std::io::Write;
use std::path::Path;

/// 原子写入
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), WriteError> {
    let dir = path.parent().ok_or_else(|| WriteError::PathNotFound {
        path: path.to_string_lossy().to_string(),
    })?;

    // 确保目录存在
    if !dir.exists() {
        return Err(WriteError::PathNotFound {
            path: dir.to_string_lossy().to_string(),
        });
    }

    // ① 创建同目录临时文件
    let tmp = match tempfile::Builder::new()
        .prefix(".nb-tmp-")
        .tempfile_in(dir)
    {
        Ok(f) => f,
        Err(e) => {
            if e.kind() == std::io::ErrorKind::PermissionDenied {
                return Err(WriteError::PermissionDenied {
                    path: path.to_string_lossy().to_string(),
                });
            }
            return Err(WriteError::Io {
                message: e.to_string(),
            });
        }
    };

    // ② 写入数据
    if let Err(e) = tmp.as_file().write_all(bytes) {
        if e.kind() == std::io::ErrorKind::StorageFull {
            return Err(WriteError::DiskFull);
        }
        return Err(WriteError::Io {
            message: e.to_string(),
        });
    }

    // ③ 落盘（sync_all）
    if let Err(e) = tmp.as_file().sync_all() {
        return Err(WriteError::Io {
            message: e.to_string(),
        });
    }

    // ④ rename 覆盖（NTFS 同目录原子）
    if let Err(e) = tmp.persist(path) {
        let e_str = e.to_string();
        let e_lower = e_str.to_lowercase();
        if e_lower.contains("permission") || e_lower.contains("access") {
            return Err(WriteError::PermissionDenied {
                path: path.to_string_lossy().to_string(),
            });
        }
        if e_lower.contains("readonly") {
            return Err(WriteError::Readonly {
                path: path.to_string_lossy().to_string(),
            });
        }
        return Err(WriteError::Io {
            message: e_str,
        });
    }

    Ok(())
}

/// 编码并写入文件
pub fn write_with_encoding(
    path: &Path,
    content: &str,
    encoding: Encoding,
    eol: Eol,
) -> Result<(u64, i64), WriteError> {
    // 统一行尾符
    let content = match eol {
        Eol::Crlf => content.replace('\n', "\r\n").replace("\r\r\n", "\r\n"),
        Eol::Lf => content.replace("\r\n", "\n").replace('\r', "\n"),
    };

    // 编码
    let bytes: Vec<u8> = match encoding {
        Encoding::Utf8 => content.into_bytes(),
        Encoding::Utf8Bom => {
            let mut v = vec![0xEF, 0xBB, 0xBF];
            v.extend_from_slice(content.as_bytes());
            v
        }
        Encoding::Gbk => {
            let (cow, _, _) = encoding_rs::GBK.encode(&content);
            cow.to_vec()
        }
    };

    let size = bytes.len() as u64;

    // 原子写入
    atomic_write(path, &bytes)?;

    // 获取写入后的 mtime
    let mtime = std::fs::metadata(path)
        .ok()
        .and_then(|m| {
            m.modified()
                .ok()
                .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64)
        })
        .unwrap_or(0);

    Ok((size, mtime))
}
