// PDF 专用分块读取：大文件不经过整文件 IPC，其他预览格式仍保持原有限制。
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

const MAX_PDF_BYTES: u64 = 512 * 1024 * 1024;
const MAX_RANGE_BYTES: u64 = 1024 * 1024;

/// 每次最多读取 1 MiB，并核对打开时的大小，避免文件变化后拼接出错误内容。
pub fn read_range(path: &Path, begin: u64, end: u64, size: u64) -> Result<Vec<u8>, String> {
    if !path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
    {
        return Err("分块读取仅支持 PDF 文件".into());
    }
    if begin >= end || end > size || end - begin > MAX_RANGE_BYTES {
        return Err("PDF 读取范围无效或超过 1 MB".into());
    }
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_PDF_BYTES {
        return Err("PDF 须为 512 MB 以内的普通文件".into());
    }
    if metadata.len() != size {
        return Err("PDF 已发生变化，请重新打开".into());
    }
    file.seek(SeekFrom::Start(begin))
        .map_err(|e| e.to_string())?;
    let mut bytes = vec![0; (end - begin) as usize];
    file.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn large_pdf_reads_only_requested_bytes_and_checks_boundaries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large.PDF");
        let mut file = File::create(&path).unwrap();
        // 稀疏文件覆盖 300 MiB 与 512 MiB 边界，不分配同等大小的测试内存。
        file.set_len(MAX_PDF_BYTES).unwrap();
        std::io::Write::write_all(&mut file, b"%PDF-").unwrap();
        assert_eq!(read_range(&path, 0, 5, MAX_PDF_BYTES).unwrap(), b"%PDF-");
        assert_eq!(
            read_range(
                &path,
                300 * 1024 * 1024,
                300 * 1024 * 1024 + 8,
                MAX_PDF_BYTES
            )
            .unwrap(),
            vec![0; 8]
        );
        assert!(read_range(&path, 0, MAX_RANGE_BYTES + 1, MAX_PDF_BYTES).is_err());
        assert!(read_range(&path, 8, 7, MAX_PDF_BYTES).is_err());
        assert!(read_range(&path, MAX_PDF_BYTES, MAX_PDF_BYTES + 1, MAX_PDF_BYTES).is_err());
        assert!(read_range(&path, 0, 5, 10).is_err());
        file.set_len(MAX_PDF_BYTES + 1).unwrap();
        assert!(read_range(&path, 0, 5, MAX_PDF_BYTES + 1).is_err());
        assert!(read_range(dir.path(), 0, 1, 1).is_err());
        file.set_len(5).unwrap();
        drop(file);
        let other = dir.path().join("large.docx");
        std::fs::rename(path, &other).unwrap();
        assert!(read_range(&other, 0, 5, 5).is_err());
    }
}
