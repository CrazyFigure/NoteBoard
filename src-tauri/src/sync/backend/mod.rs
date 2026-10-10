// NoteBoard 同步远端后端
//
// 所有后端对外暴露同一组能力（以远端根目录为基准的 `/` 分隔相对路径）：
//   begin   —— 开始一次会话（Git 类后端读取分支当前提交作为一致快照）
//   read    —— 读取文件（不存在返回 None）
//   commit  —— 提交一批写入/删除与新的同步清单
//              Git 类：GitHub/GitLab 单个原子提交 + 分支乐观锁；Gitee 逐文件提交 + 清单 sha 乐观锁
//              WebDAV/S3：先写内容、再校验清单版本后写清单、最后删除旧文件
//   list    —— 列出某目录下的文件（备份列表与保留策略使用）
//   put/delete —— 单文件写入与删除（备份上传与清理使用）

pub mod gitee;
pub mod github;
pub mod gitlab;
#[cfg(test)]
pub mod memory;
pub mod s3;
pub mod webdav;
pub mod xml;

use super::config::{ProviderConfig, ProviderKind};
use super::error::{SyncError, SyncResult};
use std::time::Duration;

/// 远端目录列表项
#[derive(Debug, Clone)]
pub struct RemoteFile {
    /// 文件名（不含目录）
    pub name: String,
    pub size: u64,
}

/// 一次提交的内容
pub struct CommitBatch {
    /// 需要写入的文件（相对路径, 内容）
    pub puts: Vec<(String, Vec<u8>)>,
    /// 需要删除的文件
    pub deletes: Vec<String>,
    /// 清单相对路径
    pub manifest_path: String,
    /// 新清单内容
    pub manifest: Vec<u8>,
    /// 读取时的清单版本（乐观锁校验用）；None 表示读取时远端还没有清单
    pub base_rev: Option<u64>,
    /// 提交说明（Git 类后端使用）
    pub message: String,
}

pub enum Backend {
    WebDav(webdav::WebDav),
    S3(s3::S3),
    GitHub(github::GitHub),
    Gitee(gitee::Gitee),
    GitLab(gitlab::GitLab),
    #[cfg(test)]
    Memory(memory::Memory),
}

/// 单个文件大小上限（Git 托管平台 API 对单文件有限制，超出时跳过并提示）
pub fn max_file_size(kind: ProviderKind) -> u64 {
    match kind {
        ProviderKind::Github => 90 * 1024 * 1024,
        ProviderKind::Gitee | ProviderKind::Gitlab => 50 * 1024 * 1024,
        _ => 1024 * 1024 * 1024,
    }
}

/// 构建同步用 HTTP 客户端（读取系统代理；大文件传输放宽总超时）
pub fn http_client() -> SyncResult<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(60))
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| SyncError::server(format!("初始化网络组件失败：{}", e)))
}

/// 默认 User-Agent
pub fn default_user_agent() -> String {
    format!("NoteBoard/{}", env!("CARGO_PKG_VERSION"))
}

/// URL 路径分段编码集合：仅保留 RFC 3986 非保留字符（S3 SigV4 规范 URI 同样要求此规则）
pub const SEGMENT: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// 逐段编码 `/` 分隔的路径（分隔符本身保留）
pub fn encode_path(path: &str) -> String {
    path.split('/')
        .map(|seg| percent_encoding::utf8_percent_encode(seg, SEGMENT).to_string())
        .collect::<Vec<_>>()
        .join("/")
}

/// 整体编码（GitLab 文件接口要求把 `/` 也编码为 %2F）
pub fn encode_component(s: &str) -> String {
    percent_encoding::utf8_percent_encode(s, SEGMENT).to_string()
}

/// 规范化远端子目录：去除首尾斜杠与空白
pub fn clean_dir(dir: &str) -> String {
    dir.trim().replace('\\', "/").trim_matches('/').to_string()
}

/// 拼接远端子目录与相对路径
pub fn join_remote(dir: &str, rel: &str) -> String {
    let d = clean_dir(dir);
    let r = rel.trim_start_matches('/');
    if d.is_empty() {
        r.to_string()
    } else if r.is_empty() {
        d
    } else {
        format!("{}/{}", d, r)
    }
}

impl Backend {
    /// 按配置创建后端（会先校验必填项，给出具体缺失提示）
    pub fn new(cfg: &ProviderConfig) -> SyncResult<Self> {
        let client = http_client()?;
        Ok(match cfg.kind {
            ProviderKind::Webdav => Backend::WebDav(webdav::WebDav::new(client, &cfg.webdav)?),
            ProviderKind::S3 => Backend::S3(s3::S3::new(client, &cfg.s3)?),
            ProviderKind::Github => Backend::GitHub(github::GitHub::new(client, &cfg.github)?),
            ProviderKind::Gitee => Backend::Gitee(gitee::Gitee::new(client, &cfg.gitee)?),
            ProviderKind::Gitlab => Backend::GitLab(gitlab::GitLab::new(client, &cfg.gitlab)?),
        })
    }

    /// 是否需要锁文件防止多台设备并发写（Git 原子提交自带乐观锁，不需要）
    pub fn needs_lock(&self) -> bool {
        is_plain(self)
    }

    pub async fn begin(&mut self) -> SyncResult<()> {
        match self {
            Backend::GitHub(b) => b.begin().await,
            Backend::Gitee(b) => b.begin().await,
            Backend::GitLab(b) => b.begin().await,
            _ => Ok(()),
        }
    }

    pub async fn read(&mut self, rel: &str) -> SyncResult<Option<Vec<u8>>> {
        match self {
            Backend::WebDav(b) => b.read(rel).await,
            Backend::S3(b) => b.read(rel).await,
            Backend::GitHub(b) => b.read(rel).await,
            Backend::Gitee(b) => b.read(rel).await,
            Backend::GitLab(b) => b.read(rel).await,
            #[cfg(test)]
            Backend::Memory(b) => b.read(rel).await,
        }
    }

    pub async fn put(&mut self, rel: &str, data: Vec<u8>, message: &str) -> SyncResult<()> {
        match self {
            Backend::WebDav(b) => b.put(rel, data).await,
            Backend::S3(b) => b.put(rel, data).await,
            Backend::GitHub(b) => b.put_single(rel, data, message).await,
            Backend::Gitee(b) => b.put_single(rel, data, message).await,
            Backend::GitLab(b) => b.put_single(rel, data, message).await,
            #[cfg(test)]
            Backend::Memory(b) => b.put(rel, data).await,
        }
    }

    pub async fn delete(&mut self, rel: &str, message: &str) -> SyncResult<()> {
        match self {
            Backend::WebDav(b) => b.delete(rel).await,
            Backend::S3(b) => b.delete(rel).await,
            Backend::GitHub(b) => b.delete_single(rel, message).await,
            Backend::Gitee(b) => b.delete_single(rel, message).await,
            Backend::GitLab(b) => b.delete_single(rel, message).await,
            #[cfg(test)]
            Backend::Memory(b) => b.delete(rel).await,
        }
    }

    pub async fn list(&mut self, dir: &str) -> SyncResult<Vec<RemoteFile>> {
        match self {
            Backend::WebDav(b) => b.list(dir).await,
            Backend::S3(b) => b.list(dir).await,
            Backend::GitHub(b) => b.list(dir).await,
            Backend::Gitee(b) => b.list(dir).await,
            Backend::GitLab(b) => b.list(dir).await,
            #[cfg(test)]
            Backend::Memory(b) => b.list(dir).await,
        }
    }

    pub async fn commit(&mut self, batch: CommitBatch) -> SyncResult<()> {
        match self {
            Backend::GitHub(b) => b.commit(batch).await,
            Backend::GitLab(b) => b.commit(batch).await,
            Backend::Gitee(b) => b.commit(batch).await,
            _ => self.commit_plain(batch).await,
        }
    }

    /// WebDAV/S3 通用提交：内容 → 清单版本校验 → 清单 → 删除旧文件
    async fn commit_plain(&mut self, batch: CommitBatch) -> SyncResult<()> {
        for (rel, data) in batch.puts {
            self.put(&rel, data, &batch.message).await?;
        }
        // 写清单前再次读取远端清单版本：期间若有其他设备写入则放弃，由引擎整体重试
        let current = self.read(&batch.manifest_path).await?;
        let current_rev = current
            .as_deref()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(b).ok())
            .and_then(|v| v.get("rev").and_then(|r| r.as_u64()));
        if current_rev != batch.base_rev {
            return Err(SyncError::conflict());
        }
        self.put(&batch.manifest_path, batch.manifest, &batch.message).await?;
        for rel in batch.deletes {
            // 删除失败不影响一致性（清单已不再引用），仅留下孤立文件
            let _ = self.delete(&rel, &batch.message).await;
        }
        Ok(())
    }

    /// 测试连接：读取远端清单（不存在也算成功），并尝试写入/删除一个探测文件验证写权限
    pub async fn test(&mut self) -> SyncResult<String> {
        self.begin().await?;
        let manifest = self.read(&format!("{}/manifest.json", super::util::META_DIR)).await?;
        let probe = format!("{}/probe-{}.txt", super::util::META_DIR, uuid::Uuid::new_v4().simple());
        // Git 类后端每次写入都会产生提交，测试时只验证读权限，避免污染提交历史
        if is_plain(self) {
            self.put(&probe, b"NoteBoard connection test".to_vec(), "NoteBoard 连接测试").await?;
            let _ = self.delete(&probe, "NoteBoard 连接测试").await;
        }
        Ok(if manifest.is_some() {
            "连接成功，远端已有同步数据，开启同步后将与本机双向合并".to_string()
        } else {
            "连接成功，远端暂无同步数据，首次同步会上传本机文件".to_string()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_remote_trims_slashes() {
        assert_eq!(join_remote("/NoteBoard/", "a/b.md"), "NoteBoard/a/b.md");
        assert_eq!(join_remote("", "a.md"), "a.md");
        assert_eq!(join_remote("dir", ""), "dir");
    }
}

/// 无原子提交能力、需要锁文件的后端（WebDAV/S3，以及测试用内存后端）
fn is_plain(b: &Backend) -> bool {
    match b {
        Backend::WebDav(_) | Backend::S3(_) => true,
        #[cfg(test)]
        Backend::Memory(_) => true,
        _ => false,
    }
}
