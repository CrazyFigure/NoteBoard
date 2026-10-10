// NoteBoard 同步与备份配置
// 持久化在 <应用数据目录>/sync/config.json；密码/令牌字段经 secret 模块本机加密后落盘，
// 内存与 IPC 中为明文（设置页需要「显示明文」）。与 settings.json 分离：密钥不随设置广播事件扩散。

use super::secret;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// 远端服务类型
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    #[default]
    Webdav,
    S3,
    Github,
    Gitee,
    Gitlab,
}

impl ProviderKind {
    pub fn label(&self) -> &'static str {
        match self {
            ProviderKind::Webdav => "WebDAV",
            ProviderKind::S3 => "S3",
            ProviderKind::Github => "GitHub",
            ProviderKind::Gitee => "Gitee",
            ProviderKind::Gitlab => "GitLab",
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct WebDavConfig {
    /// 服务地址，例如 https://dav.jianguoyun.com/dav/
    pub url: String,
    pub username: String,
    pub password: String,
    /// 自定义 User-Agent（部分服务按 UA 限流或要求特定 UA）；留空使用 NoteBoard/版本号
    pub user_agent: String,
    /// 远端目录（相对服务地址），例如 NoteBoard
    pub remote_dir: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct S3Config {
    /// 服务端点，例如 https://s3.us-east-1.amazonaws.com、https://oss-cn-hangzhou.aliyuncs.com
    pub endpoint: String,
    /// 区域，例如 us-east-1、cn-hangzhou；Cloudflare R2 填 auto
    pub region: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    /// 对象键前缀（相当于远端目录）
    pub prefix: String,
    /// 路径风格访问（MinIO 等自建服务通常需要开启）
    pub path_style: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct GitRepoConfig {
    /// 自建实例地址（GitLab 自建；GitHub/Gitee 留空使用官方地址）
    pub base_url: String,
    /// 仓库所有者（GitLab 可为多级群组路径 group/subgroup）
    pub owner: String,
    pub repo: String,
    /// 分支，留空默认 main（Gitee 默认 master）
    pub branch: String,
    pub token: String,
    /// 仓库内子目录，留空表示仓库根目录
    pub remote_dir: String,
}

/// 一套远端服务配置；所有类型的输入都保留，切换类型不丢失已填写的内容
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderConfig {
    pub kind: ProviderKind,
    pub webdav: WebDavConfig,
    pub s3: S3Config,
    pub github: GitRepoConfig,
    pub gitee: GitRepoConfig,
    pub gitlab: GitRepoConfig,
}

impl ProviderConfig {
    /// 对所有密钥字段执行同一变换（加密/解密）
    fn map_secrets(&mut self, f: &dyn Fn(&str) -> String) {
        self.webdav.password = f(&self.webdav.password);
        self.s3.secret_access_key = f(&self.s3.secret_access_key);
        self.github.token = f(&self.github.token);
        self.gitee.token = f(&self.gitee.token);
        self.gitlab.token = f(&self.gitlab.token);
    }

    /// 远端身份：用于判断用户是否换了同步目标（换目标后需要重建本地同步基线）
    pub fn identity(&self) -> String {
        match self.kind {
            ProviderKind::Webdav => format!(
                "webdav|{}|{}|{}",
                self.webdav.url.trim().trim_end_matches('/'),
                self.webdav.username.trim(),
                self.webdav.remote_dir.trim().trim_matches('/')
            ),
            ProviderKind::S3 => format!(
                "s3|{}|{}|{}",
                self.s3.endpoint.trim().trim_end_matches('/'),
                self.s3.bucket.trim(),
                self.s3.prefix.trim().trim_matches('/')
            ),
            ProviderKind::Github | ProviderKind::Gitee | ProviderKind::Gitlab => {
                let g = self.git();
                format!(
                    "{}|{}|{}/{}|{}|{}",
                    self.kind.label(),
                    g.base_url.trim().trim_end_matches('/'),
                    g.owner.trim(),
                    g.repo.trim(),
                    g.branch.trim(),
                    g.remote_dir.trim().trim_matches('/')
                )
            }
        }
    }

    /// 当前类型对应的 Git 仓库配置
    pub fn git(&self) -> &GitRepoConfig {
        match self.kind {
            ProviderKind::Gitee => &self.gitee,
            ProviderKind::Gitlab => &self.gitlab,
            _ => &self.github,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncSettings {
    /// 多端同步总开关（默认关闭）
    pub enabled: bool,
    /// 同步范围：本地文件夹绝对路径
    pub root_dir: String,
    /// 本机名称（同步结果、备份文件名与其他设备上显示）
    pub device_name: String,
    pub provider: ProviderConfig,
    /// 每次手动/自动保存后同步（防抖合并连续保存）
    pub sync_on_save: bool,
    /// 定时同步
    pub interval_enabled: bool,
    pub interval_minutes: u32,
    /// 启动软件后在后台同步一次
    pub sync_on_startup: bool,
    /// 没有任何变化时也弹出提示（默认只在有变化、出错或手动同步时提示）
    pub notify_no_change: bool,
    /// 同步区域回收站
    pub trash_enabled: bool,
    pub trash_days: u32,
}

impl Default for SyncSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            root_dir: String::new(),
            device_name: default_device_name(),
            provider: ProviderConfig::default(),
            sync_on_save: true,
            interval_enabled: true,
            interval_minutes: 30,
            sync_on_startup: true,
            notify_no_change: false,
            trash_enabled: true,
            trash_days: 30,
        }
    }
}

/// 备份目标
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum BackupTarget {
    /// 本地其他文件夹
    #[default]
    Local,
    /// 远端服务（使用备份自己的服务配置）
    Remote,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct BackupSettings {
    /// 定时自动备份
    pub auto_enabled: bool,
    pub interval_hours: u32,
    /// 只保留本机最新 N 份备份；0 表示不限制
    pub keep_count: u32,
    pub target: BackupTarget,
    /// 本地备份目录
    pub local_dir: String,
    /// 远端备份服务配置（独立于同步配置，可一键复制同步配置）
    pub provider: ProviderConfig,
}

impl Default for BackupSettings {
    fn default() -> Self {
        Self {
            auto_enabled: false,
            interval_hours: 24,
            keep_count: 10,
            target: BackupTarget::Local,
            local_dir: String::new(),
            provider: ProviderConfig::default(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncConfigFile {
    pub version: u32,
    /// 本机唯一标识（首次加载生成，不随配置导入导出变化）
    pub device_id: String,
    pub sync: SyncSettings,
    pub backup: BackupSettings,
}

impl Default for SyncConfigFile {
    fn default() -> Self {
        Self {
            version: 1,
            device_id: String::new(),
            sync: SyncSettings::default(),
            backup: BackupSettings::default(),
        }
    }
}

/// 默认设备名：Windows 取计算机名，其他平台给出通用名称
pub fn default_device_name() -> String {
    if cfg!(target_os = "android") {
        return "安卓设备".to_string();
    }
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "我的电脑".to_string())
}

/// 同步数据目录：配置、本地基线状态、三方合并基线内容
pub fn sync_data_dir() -> PathBuf {
    crate::app_dirs::app_data_dir().join("sync")
}

fn config_path() -> PathBuf {
    sync_data_dir().join("config.json")
}

/// 读取配置（缺字段填默认值；密钥解密为明文）
pub fn load() -> SyncConfigFile {
    let mut cfg: SyncConfigFile = std::fs::read_to_string(config_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    cfg.sync.provider.map_secrets(&secret::unprotect);
    cfg.backup.provider.map_secrets(&secret::unprotect);
    let mut changed = false;
    if cfg.device_id.is_empty() {
        cfg.device_id = uuid::Uuid::new_v4().simple().to_string();
        changed = true;
    }
    if cfg.sync.device_name.trim().is_empty() {
        cfg.sync.device_name = default_device_name();
    }
    if changed {
        let _ = save(&cfg);
    }
    cfg
}

/// 保存配置（密钥加密后原子写）
pub fn save(cfg: &SyncConfigFile) -> Result<(), String> {
    let dir = sync_data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建同步数据目录失败：{}", e))?;
    let mut stored = cfg.clone();
    stored.sync.provider.map_secrets(&secret::protect);
    stored.backup.provider.map_secrets(&secret::protect);
    let json = serde_json::to_string_pretty(&stored).map_err(|e| e.to_string())?;
    crate::fsio::write::atomic_write(&config_path(), json.as_bytes()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_fields_use_defaults() {
        let cfg: SyncConfigFile = serde_json::from_str(r#"{"sync":{"enabled":true}}"#).unwrap();
        assert!(cfg.sync.enabled);
        assert_eq!(cfg.sync.trash_days, 30);
        assert!(cfg.sync.trash_enabled);
        assert_eq!(cfg.backup.keep_count, 10);
        assert_eq!(cfg.sync.provider.kind, ProviderKind::Webdav);
    }

    #[test]
    fn provider_kind_serializes_lowercase() {
        let json = serde_json::to_string(&ProviderKind::Gitlab).unwrap();
        assert_eq!(json, "\"gitlab\"");
    }
}
