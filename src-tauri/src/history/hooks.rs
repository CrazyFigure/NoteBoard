// NoteBoard 文档历史记录：文件命令钩子
//
// 由 fsio 命令（以及网页服务的文件接口）在写入、改名、删除前后调用。
// 历史记录关闭或服务未启动时全部立即返回，不影响文件操作本身。

use super::service::service;
use std::path::Path;

/// 写盘前：补记磁盘上尚未记录的内容（首次记录 / 外部修改）
pub fn prepare_write(path: &Path) {
    if let Some(s) = service() {
        s.prepare_write(path);
    }
}

/// 写盘成功后：记录保存的版本
pub fn on_written(path: &Path) {
    if let Some(s) = service() {
        s.on_written(path);
    }
}

/// 改名/移动成功后：历史跟随新路径
pub fn on_renamed(from: &Path, to: &Path) {
    if let Some(s) = service() {
        s.on_renamed(from, to);
    }
}

/// 同步即将用其他设备的内容覆盖本机文件：本机内容尚未记录时先补记
pub fn before_overwrite(path: &Path) {
    if let Some(s) = service() {
        s.before_overwrite(path);
    }
}

/// 同步写入了其他设备的内容（merged：本机与远端按行合并的结果）
pub fn after_pulled(path: &Path, device: &str, name: &str, merged: bool) {
    if let Some(s) = service() {
        s.after_pulled(path, super::model::Origin { device: device.to_string(), name: name.to_string() }, merged);
    }
}

/// 删除成功后：历史转入待清理（保留期内同一路径恢复相同内容时重新关联）
pub fn on_deleted(path: &Path) {
    if let Some(s) = service() {
        s.on_deleted(path);
    }
}
