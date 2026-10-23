// NoteBoard 文档历史记录：配置（<应用数据目录>/history/config.json）
//
// 与 settings.json 分离：模式切换需要迁移存储，必须由后端原子地完成后再生效，
// 不能随普通设置保存被前端直接改写。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 历史记录模式
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// 关闭（默认）
    #[default]
    Off,
    /// 仅本机：保存在应用数据目录
    Local,
    /// 跨设备同步：同步目录内的文档保存在 <同步目录>/.nb-history，随同步上传
    Sync,
}

/// 切出同步模式后待清理的远端数据（下次同步时删除本设备在远端的历史）
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct RetireItem {
    pub root: String,
    pub remote: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct HistoryConfig {
    pub format: u32,
    pub mode: Mode,
    /// 保留天数；0 表示永久保留
    pub retention_days: u32,
    /// 连续保存合并窗口（分钟）
    pub merge_window_min: u32,
    /// 总容量上限（MB）；0 表示按模式默认值
    pub max_total_mb: u32,
    pub retire_pending: Vec<RetireItem>,
}

impl Default for HistoryConfig {
    fn default() -> Self {
        Self { format: 1, mode: Mode::Off, retention_days: 90, merge_window_min: 10, max_total_mb: 0, retire_pending: Vec::new() }
    }
}

impl HistoryConfig {
    /// 规范化用户输入
    pub fn sanitize(&mut self) {
        self.merge_window_min = self.merge_window_min.clamp(1, 120);
        self.retention_days = self.retention_days.min(3650);
        self.max_total_mb = self.max_total_mb.min(100 * 1024);
    }

    /// 生效的容量上限（字节）
    pub fn max_total_bytes(&self, git_backend: bool) -> u64 {
        let mb = if self.max_total_mb > 0 {
            self.max_total_mb as u64
        } else {
            match self.mode {
                Mode::Sync if git_backend => 100,
                Mode::Sync => 300,
                _ => 1024,
            }
        };
        mb * 1024 * 1024
    }
}

pub fn config_path(base: &Path) -> PathBuf {
    base.join("config.json")
}

pub fn load(base: &Path) -> HistoryConfig {
    let mut cfg: HistoryConfig = std::fs::read(config_path(base))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    cfg.sanitize();
    cfg
}

pub fn save(base: &Path, cfg: &HistoryConfig) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(cfg).map_err(|e| e.to_string())?;
    super::store::write_atomic(&config_path(base), &json).map_err(|e| format!("保存历史记录设置失败：{}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_sanitize() {
        let cfg: HistoryConfig = serde_json::from_str(r#"{"mode":"local","mergeWindowMin":0}"#).unwrap();
        assert_eq!(cfg.mode, Mode::Local);
        assert_eq!(cfg.retention_days, 90);
        let mut c = cfg.clone();
        c.sanitize();
        assert_eq!(c.merge_window_min, 1);
        assert_eq!(HistoryConfig::default().mode, Mode::Off);
    }
}
