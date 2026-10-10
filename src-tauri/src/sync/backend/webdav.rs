// WebDAV 后端（坚果云、Nextcloud、群晖、Alist 等）
// 远端目录结构与本地一致，可在网盘中直接浏览；父目录按需 MKCOL 并在会话内缓存。

use super::{clean_dir, default_user_agent, encode_path, join_remote, xml, RemoteFile};
use crate::sync::config::WebDavConfig;
use crate::sync::error::{from_reqwest, from_status, SyncError, SyncResult};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{header, Method, StatusCode};
use std::collections::HashSet;

const SERVICE: &str = "WebDAV";

pub struct WebDav {
    client: reqwest::Client,
    /// 以 `/` 结尾的服务地址
    base: String,
    dir: String,
    auth: Option<String>,
    user_agent: String,
    /// 本次会话已确认存在的远端目录
    known_dirs: HashSet<String>,
}

impl WebDav {
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
        let user_agent = if cfg.user_agent.trim().is_empty() {
            default_user_agent()
        } else {
            cfg.user_agent.trim().to_string()
        };
        Ok(Self {
            client,
            base: format!("{}/", url.trim_end_matches('/')),
            dir: clean_dir(&cfg.remote_dir),
            auth,
            user_agent,
            known_dirs: HashSet::new(),
        })
    }

    fn url_of(&self, full: &str) -> String {
        format!("{}{}", self.base, encode_path(full))
    }

    fn request(&self, method: Method, url: &str) -> reqwest::RequestBuilder {
        let mut rb = self.client.request(method, url).header(header::USER_AGENT, &self.user_agent);
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

    pub async fn read(&mut self, rel: &str) -> SyncResult<Option<Vec<u8>>> {
        let url = self.url_of(&join_remote(&self.dir, rel));
        let resp = self.send(self.request(Method::GET, &url)).await?;
        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(None);
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

    pub async fn list(&mut self, dir: &str) -> SyncResult<Vec<RemoteFile>> {
        let full = join_remote(&self.dir, dir);
        let url = format!("{}/", self.url_of(&full).trim_end_matches('/'));
        let body = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>"#;
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
        if !resp.status().is_success() {
            return Err(Self::fail(resp, "目录不存在").await);
        }
        let text = resp.text().await.map_err(|e| from_reqwest(e, SERVICE))?;
        let mut files = Vec::new();
        for response in xml::elements(&text, "response") {
            // 目录（含被列举的目录自身）跳过
            if !xml::elements(&response, "collection").is_empty() {
                continue;
            }
            let Some(href) = xml::first_text(&response, "href") else { continue };
            let decoded = percent_encoding::percent_decode_str(href.trim_end_matches('/'))
                .decode_utf8_lossy()
                .to_string();
            let name = decoded.rsplit('/').next().unwrap_or("").to_string();
            if name.is_empty() {
                continue;
            }
            let size = xml::first_text(&response, "getcontentlength")
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0);
            files.push(RemoteFile { name, size });
        }
        Ok(files)
    }
}
