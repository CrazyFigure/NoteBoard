// NoteBoard 回收站删除
// FR-706: 删除到回收站，非彻底删除

use std::path::Path;

#[cfg(desktop)]
pub fn move_to_trash(path: &Path) -> Result<(), String> {
    trash::delete(path).map_err(|e| format!("删除到回收站失败: {}", e))
}

/// 移动端没有系统回收站：直接永久删除（前端在调用前已做二次确认并提示不可恢复）
#[cfg(mobile)]
pub fn move_to_trash(path: &Path) -> Result<(), String> {
    let result = if path.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    result.map_err(|e| format!("删除失败: {}", e))
}
