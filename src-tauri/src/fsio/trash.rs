// NoteBoard 回收站删除
// FR-706: 删除到回收站，非彻底删除

use std::path::Path;

pub fn move_to_trash(path: &Path) -> Result<(), String> {
    trash::delete(path).map_err(|e| format!("删除到回收站失败: {}", e))
}
