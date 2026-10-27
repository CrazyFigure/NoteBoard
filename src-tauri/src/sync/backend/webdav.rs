// WebDAV 后端（坚果云、Nextcloud、群晖、Alist 等）
// 远端目录结构与本地一致，可在网盘中直接浏览；父目录按需 MKCOL 并在会话内缓存。

use super::{clean_dir, encode_path, join_remote, request_headers, xml, RemoteFile};
use crate::sync::config::WebDavConfig;
use crate::sync::error::{from_reqwest, from_status, SyncError, SyncResult};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{header, Method, StatusCode};
use std::collections::HashSet;

const SERVICE: &str = "WebDAV";

/// 单层目录元数据；首次配对需要保留子目录和原始修改时间。
pub struct DavEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: i64,
}

/// 仅兼容服务明确给出的缺失祖先目录错误，不吞掉其他 HTTP 409 冲突。
fn ancestors_not_found(body: &str) -> bool {
    body.split(|c: char| !c.is_ascii_alphanumeric()).any(|part| part == "AncestorsNotFound")
}

pub struct WebDav {
    client: reqwest::Client,
    /// 以 `/` 结尾的服务地址
    base: String,
    dir: String,
    auth: Option<String>,
    /// 所有 WebDAV 方法共用的请求头，包含网关认证及客户端标识。
    headers: header::HeaderMap,
    /// 本次会话已确认存在的远端目录
    known_dirs: HashSet<String>,
}

impl WebDav {
    /// 校验地址和自定义请求头；填写账号时由程序生成 Basic 认证，避免与自定义认证冲突。
    pub fn new(client: reqwest::Client, cfg: &WebDavConfig) -> SyncResult<Self> {
        let url = cfg.url.trim();
        if url.is_empty() {
            return Err(SyncError::config("请填写 WebDAV 服务地址"));
        }
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err(SyncError::config("WebDAV 地址需以 http:// 或 https:// 开头"));
        }
        let auth = if cfg.username.trim().is_empty() {
            None
        } else {
            let raw = format!("{}:{}", cfg.username.trim(), cfg.password);
            Some(format!("Basic {}", STANDARD.encode(raw.as_bytes())))
        };
        let mut reserved = vec!["depth", "content-type"];
        if auth.is_some() {
            reserved.push("authorization");
        }
        let headers = request_headers(&cfg.http, SERVICE, &reserved)?;
        Ok(Self {
            client,
            base: format!("{}/", url.trim_end_matches('/')),
            dir: clean_dir(&cfg.remote_dir),
            auth,
            headers,
            known_dirs: HashSet::new(),
        })
    }

    fn url_of(&self, full: &str) -> String {
        format!("{}{}", self.base, encode_path(full))
    }

    /// 所有读写、建目录和列表请求统一携带自定义头，原有 WebDAV 认证另行补齐。
    fn request(&self, method: Method, url: &str) -> reqwest::RequestBuilder {
        let mut rb = self.client.request(method, url).headers(self.headers.clone());
        if let Some(auth) = &self.auth {
            rb = rb.header(header::AUTHORIZATION, auth);
        }
        rb
    }

    async fn send(&self, rb: reqwest::RequestBuilder) -> SyncResult<reqwest::Response> {
        rb.send().await.map_err(|e| from_reqwest(e, SERVICE))
    }

    async fn fail(resp: reqwest::Response, hint: &str) -> SyncError {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        from_status(status, SERVICE, hint, &body)
    }

    /// 读取文件；仅 404 或明确的缺失祖先目录响应视为不存在，其他冲突保留错误语义。
    pub async fn read(&mut self, rel: &str) -> SyncResult<Option<Vec<u8>>> {
        let url = self.url_of(&join_remote(&self.dir, rel));
        let resp = self.send(self.request(Method::GET, &url)).await?;
        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if resp.status() == StatusCode::CONFLICT {
            let body = resp.text().await.map_err(|e| from_reqwest(e, SERVICE))?;
            return if ancestors_not_found(&body) { Ok(None) } else { Err(from_status(409, SERVICE, "读取失败", &body)) };
        }
        if !resp.status().is_success() {
            return Err(Self::fail(resp, "文件不存在或服务地址错误").await);
        }
        let bytes = resp.bytes().await.map_err(|e| from_reqwest(e, SERVICE))?;
        Ok(Some(bytes.to_vec()))
    }

    /// 逐级创建父目录（已存在返回 405，同样视为成功）
    async fn ensure_dirs(&mut self, full_file: &str) -> SyncResult<()> {
        let parts: Vec<&str> = full_file.split('/').collect();
        let mut cur = String::new();
        for seg in &parts[..parts.len().saturating_sub(1)] {
            if seg.is_empty() {
                continue;
            }
            cur = if cur.is_empty() { seg.to_string() } else { format!("{}/{}", cur, seg) };
            if self.known_dirs.contains(&cur) {
                continue;
            }
            let url = format!("{}/", self.url_of(&cur));
            let method = Method::from_bytes(b"MKCOL").expect("MKCOL");
            let resp = self.send(self.request(method, &url)).await?;
            let code = resp.status().as_u16();
            // 201 新建；405 已存在；301/302 部分服务对目录重定向
            if !(resp.status().is_success() || code == 405 || code == 301 || code == 302) {
                if code == 409 {
                    return Err(SyncError::server(format!("WebDAV 无法创建目录 {}，请确认远端根目录存在", cur)));
                }
                return Err(Self::fail(resp, "服务地址不正确（请确认 WebDAV 根地址，例如坚果云为 https://dav.jianguoyun.com/dav/）").await);
            }
            self.known_dirs.insert(cur.clone());
        }
        Ok(())
    }

    pub async fn put(&mut self, rel: &str, data: Vec<u8>) -> SyncResult<()> {
        let full = join_remote(&self.dir, rel);
        self.ensure_dirs(&full).await?;
        let url = self.url_of(&full);
        let len = data.len();
        let resp = self
            .send(
                self.request(Method::PUT, &url)
                    .header(header::CONTENT_TYPE, "application/octet-stream")
                    .header(header::CONTENT_LENGTH, len)
                    .body(data),
            )
            .await?;
        if !resp.status().is_success() {
            return Err(Self::fail(resp, "上传失败，远端目录不存在").await);
        }
        Ok(())
    }

    pub async fn delete(&mut self, rel: &str) -> SyncResult<()> {
        let url = self.url_of(&join_remote(&self.dir, rel));
        let resp = self.send(self.request(Method::DELETE, &url)).await?;
        if resp.status().is_success() || resp.status() == StatusCode::NOT_FOUND {
            return Ok(());
        }
        Err(Self::fail(resp, "删除失败").await)
    }

    /// 备份列表继续只返回直属文件；首次配对通过 entries 读取目录元数据。
    pub async fn list(&mut self, dir: &str) -> SyncResult<Vec<RemoteFile>> {
        Ok(self.entries(dir).await?.into_iter().filter(|entry| !entry.is_dir)
            .map(|entry| RemoteFile { name: entry.name, size: entry.size }).collect())
    }

    /// 按层读取目录，限制响应大小；保留目录项供首次同步递归发现已有文件。
    pub async fn entries(&mut self, dir: &str) -> SyncResult<Vec<DavEntry>> {
        let full = join_remote(&self.dir, dir);
        let url = format!("{}/", self.url_of(&full).trim_end_matches('/'));
        let body = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>"#;
        let method = Method::from_bytes(b"PROPFIND").expect("PROPFIND");
        let resp = self
            .send(
                self.request(method, &url)
                    .header("Depth", "1")
                    .header(header::CONTENT_TYPE, "application/xml; charset=utf-8")
                    .body(body),
            )
            .await?;
        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(Vec::new());
        }
        if resp.status() == StatusCode::CONFLICT {
            let body = resp.text().await.map_err(|e| from_reqwest(e, SERVICE))?;
            return if ancestors_not_found(&body) { Ok(Vec::new()) } else { Err(from_status(409, SERVICE, "目录读取失败", &body)) };
        }
        if !resp.status().is_success() {
            return Err(Self::fail(resp, "目录不存在").await);
        }
        // 目录可能经过服务端重定向，href 应相对最终地址解析；兼容相对路径与绝对地址。
        let directory_url = resp.url().clone();
        let parent = percent_encoding::percent_decode_str(directory_url.path()).decode_utf8_lossy();
        let prefix = format!("{}/", parent.trim_end_matches('/'));
        // 逐块限制目录 XML，避免异常服务返回无限响应耗尽内存。
        const MAX_LIST_BYTES: usize = 8 * 1024 * 1024;
        let mut resp = resp;
        let mut bytes = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(|e| from_reqwest(e, SERVICE))? {
            if bytes.len() + chunk.len() > MAX_LIST_BYTES {
                return Err(SyncError::server("WebDAV 单层目录过大，请选择更小的同步目录"));
            }
            bytes.extend_from_slice(&chunk);
        }
        let text = String::from_utf8(bytes).map_err(|_| SyncError::server("WebDAV 目录响应不是有效 UTF-8"))?;
        // 登录页等异常 2xx 响应不能被当成空目录，否则可能漏掉应当确认的同名文件。
        if xml::elements(&text, "multistatus").is_empty() {
            return Err(SyncError::server("WebDAV 未返回有效目录列表，请检查服务地址和访问权限"));
        }
        let mut files = Vec::new();
        for response in xml::elements(&text, "response") {
            let Some(href) = xml::first_text(&response, "href") else { continue };
            // href 可以是绝对地址或绝对路径；只接收当前目录的直接子项，跳过目录自身。
            let href_url = directory_url.join(&href).map_err(|_| SyncError::server("WebDAV 返回了无效的文件地址"))?;
            let href_path = href_url.path();
            let decoded = percent_encoding::percent_decode_str(href_path.trim_end_matches('/'))
                .decode_utf8_lossy()
                .to_string();
            if decoded == prefix.trim_end_matches('/') { continue; }
            let Some(name) = decoded.strip_prefix(&prefix) else {
                return Err(SyncError::server("WebDAV 返回的目录路径与请求不一致，已停止同步"));
            };
            if name.is_empty() || name.contains('/') { return Err(SyncError::server("WebDAV 未返回正确的单层目录列表，已停止同步")); }
            let size = xml::first_text(&response, "getcontentlength")
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0);
            let mtime = xml::first_text(&response, "getlastmodified")
                .and_then(|text| chrono::DateTime::parse_from_rfc2822(&text).ok())
                .map(|time| time.timestamp_millis()).unwrap_or(0);
            files.push(DavEntry { name: name.to_string(), size, mtime, is_dir: !xml::elements(&response, "collection").is_empty() });
        }
        Ok(files)
    }

    /// 流式计算远端内容哈希，比较使用 SHA-256；不把整个目录的正文同时装入内存。
    pub async fn content_hash(&self, rel: &str, limit: u64) -> SyncResult<(String, u64)> {
        use sha2::{Digest, Sha256};
        let url = self.url_of(&join_remote(&self.dir, rel));
        let mut resp = self.send(self.request(Method::GET, &url)).await?;
        if !resp.status().is_success() {
            return Err(Self::fail(resp, "远端文件在检查期间已变化，请重试").await);
        }
        let mut hash = Sha256::new();
        let mut size = 0u64;
        while let Some(chunk) = resp.chunk().await.map_err(|e| from_reqwest(e, SERVICE))? {
            size += chunk.len() as u64;
            if size > limit { return Err(SyncError::server(format!("远端文件过大，无法首次配对：{}", rel))); }
            hash.update(&chunk);
        }
        Ok((hex::encode(hash.finalize()), size))
    }
}
