// NoteBoard 同步远端后端
//
// 所有后端对外暴露同一组能力（以远端根目录为基准的 `/` 分隔相对路径）：
//   begin   —— 开始一次会话（Git 类后端读取分支当前提交作为一致快照）
//   read    —— 读取文件（不存在返回 None）
//   commit  —— 提交一批写入/删除与新的同步清单
//              Git 类：GitHub/GitLab 单个原子提交 + 分支乐观锁；Gitee/GitCode 逐文件提交 + 清单 sha 乐观锁
//              WebDAV/S3：先写内容、再校验清单版本后写清单、最后删除旧文件
//   list    —— 列出某目录下的文件（备份列表与保留策略使用）
//   put/delete —— 单文件写入与删除（备份上传与清理使用）

pub mod gitcode;
pub mod gitee;
pub mod github;
pub mod gitlab;
#[cfg(test)]
pub mod memory;
pub mod s3;
pub mod webdav;
pub mod xml;

use super::config::{HttpHeaders, ProviderConfig, ProviderKind};
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
    GitCode(gitcode::GitCode),
    GitLab(gitlab::GitLab),
    #[cfg(test)]
    Memory(memory::Memory),
}

/// 单个文件大小上限（Git 托管平台 API 对单文件有限制，超出时跳过并提示）
pub fn max_file_size(kind: ProviderKind) -> u64 {
    match kind {
        ProviderKind::Github => 90 * 1024 * 1024,
        ProviderKind::Gitee | ProviderKind::Gitcode | ProviderKind::Gitlab => 50 * 1024 * 1024,
        _ => 1024 * 1024 * 1024,
    }
}

/// 构建同步用 HTTP 客户端；携带自定义凭证时仅跟随同源重定向，避免将网关令牌转发到其他地址。
pub fn http_client(cfg: &ProviderConfig) -> SyncResult<reqwest::Client> {
    let custom: &[_] = match cfg.kind {
        ProviderKind::Webdav => &cfg.webdav.http.headers,
        ProviderKind::S3 => &cfg.s3.http.headers,
        _ => &[][..],
    };
    let mut builder = reqwest::Client::builder();
    // 单独自定义 UA 不包含网关凭证，保持旧版 UA 设置的重定向行为。
    if custom.iter().any(|item| !item.name.trim().eq_ignore_ascii_case("user-agent")
        && (!item.name.trim().is_empty() || !item.value.trim().is_empty()))
    {
        builder = builder.redirect(reqwest::redirect::Policy::custom(|attempt| {
            let target = attempt.url();
            let same_origin = attempt.previous().first().is_some_and(|source| {
                source.scheme() == target.scheme()
                    && source.host_str() == target.host_str()
                    && source.port_or_known_default() == target.port_or_known_default()
            });
            if !same_origin {
                attempt.error("自定义 Header 不允许跨源重定向，请直接填写最终服务地址")
            } else if attempt.previous().len() >= 10 {
                // 与 reqwest 的默认限制一致，防止同源重定向循环。
                attempt.error("重定向次数过多")
            } else {
                attempt.follow()
            }
        }));
    }
    // 保留系统代理和大文件传输超时，其他服务沿用原有重定向策略。
    builder
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

/// 构造并校验服务请求头：保留默认 UA，忽略空白草稿行，拒绝重名和协议托管字段。
pub fn request_headers(cfg: &HttpHeaders, service: &str, reserved: &[&str]) -> SyncResult<reqwest::header::HeaderMap> {
    use reqwest::header::{HeaderMap, HeaderName, HeaderValue, USER_AGENT};
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_str(&default_user_agent()).unwrap());
    let mut seen = std::collections::HashSet::new();
    for (index, item) in cfg.headers.iter().enumerate() {
        // 添加按钮产生的空行可以保存；只有填写了名称或值的行才参与请求。
        let name = item.name.trim();
        if name.is_empty() && item.value.trim().is_empty() {
            continue;
        }
        let key = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| SyncError::config(format!("{} 第 {} 个 Header 名称无效", service, index + 1)))?;
        // 主机、消息长度和连接字段由 HTTP 客户端管理，避免破坏传输或签名。
        if matches!(key.as_str(), "host" | "content-length" | "transfer-encoding" | "connection" | "trailer" | "te" | "upgrade")
            || reserved.contains(&key.as_str())
        {
            return Err(SyncError::config(format!("{} Header {} 由程序管理，请移除该自定义项", service, name)));
        }
        if !seen.insert(key.clone()) {
            return Err(SyncError::config(format!("{} Header {} 重复，请合并为一项", service, name)));
        }
        // 不修剪值，保留令牌中的有效空格；报错仅定位行号，禁止泄露凭证内容。
        let mut value = HeaderValue::from_str(&item.value)
            .map_err(|_| SyncError::config(format!("{} 第 {} 个 Header 值无效，不能包含换行等控制字符", service, index + 1)))?;
        value.set_sensitive(true);
        headers.insert(key, value);
    }
    Ok(headers)
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
        let client = http_client(cfg)?;
        Ok(match cfg.kind {
            ProviderKind::Webdav => Backend::WebDav(webdav::WebDav::new(client, &cfg.webdav)?),
            ProviderKind::S3 => Backend::S3(s3::S3::new(client, &cfg.s3)?),
            ProviderKind::Github => Backend::GitHub(github::GitHub::new(client, &cfg.github)?),
            ProviderKind::Gitee => Backend::Gitee(gitee::Gitee::new(client, &cfg.gitee)?),
            ProviderKind::Gitcode => Backend::GitCode(gitcode::GitCode::new(client, &cfg.gitcode)?),
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
            Backend::GitCode(b) => b.begin().await,
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
            Backend::GitCode(b) => b.read(rel).await,
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
            Backend::GitCode(b) => b.put_single(rel, data, message).await,
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
            Backend::GitCode(b) => b.delete_single(rel, message).await,
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
            Backend::GitCode(b) => b.list(dir).await,
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
            Backend::GitCode(b) => b.commit(batch).await,
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

    /// UA 默认值、覆盖、空草稿和凭证原值必须同时兼容，不能产生重复 UA。
    #[test]
    fn custom_headers_keep_defaults_and_exact_values() {
        let defaults = request_headers(&HttpHeaders::default(), "WebDAV", &[]).unwrap();
        assert_eq!(defaults["user-agent"], default_user_agent());
        let cfg: HttpHeaders = serde_json::from_value(serde_json::json!({ "headers": [
            { "name": "", "value": "" },
            { "name": " User-Agent ", "value": "Custom/1" },
            { "name": "CF-Access-Client-Secret", "value": " token with spaces " }
        ] })).unwrap();
        let headers = request_headers(&cfg, "WebDAV", &[]).unwrap();
        assert_eq!(headers.get_all("user-agent").iter().count(), 1);
        assert_eq!(headers["user-agent"], "Custom/1");
        assert_eq!(headers["cf-access-client-secret"], " token with spaces ");
        assert!(headers["cf-access-client-secret"].is_sensitive());
    }

    /// 请求头大小写等价；名称错误、控制字符和协议字段均须在发起网络请求前明确拒绝。
    #[test]
    fn invalid_headers_fail_without_disclosing_values() {
        let cases = [
            serde_json::json!([{ "name": "", "value": "private-token" }]),
            serde_json::json!([{ "name": "Invalid Name", "value": "private-token" }]),
            serde_json::json!([{ "name": "X-Token", "value": "private-token\r\nX-Evil: 1" }]),
            serde_json::json!([{ "name": "X-Token", "value": "1" }, { "name": "x-token", "value": "private-token" }]),
            serde_json::json!([{ "name": "Host", "value": "private-token" }]),
            serde_json::json!([{ "name": "Content-Length", "value": "private-token" }]),
            serde_json::json!([{ "name": "Authorization", "value": "private-token" }]),
        ];
        for items in cases {
            let cfg: HttpHeaders = serde_json::from_value(serde_json::json!({ "headers": items })).unwrap();
            let error = request_headers(&cfg, "S3", &["authorization"]).unwrap_err();
            assert_eq!(error.kind, super::super::error::SyncErrorKind::Config);
            assert!(!error.message.contains("private-token"));
        }
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
