// Gitee 后端
// Gitee OpenAPI v5 没有多文件原子提交接口，逐文件调用内容接口（每个文件一个提交）；
// 写清单前比对清单文件 sha 与会话快照（乐观锁），期间有其他设备同步过则放弃并由引擎整体重试。

use super::{clean_dir, default_user_agent, encode_component, encode_path, join_remote, CommitBatch, RemoteFile};
use crate::sync::config::GitRepoConfig;
use crate::sync::error::{from_reqwest, from_status, SyncError, SyncErrorKind, SyncResult};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{header, Method, StatusCode};
use serde_json::{json, Value};
use std::collections::HashMap;

const SERVICE: &str = "Gitee";

pub struct Gitee {
    client: reqwest::Client,
    api: String,
    owner: String,
    repo: String,
    branch: String,
    token: String,
    dir: String,
    head: Option<String>,
    /// 快照中的文件路径 → blob sha
    blobs: HashMap<String, String>,
    empty_repo: bool,
}

impl Gitee {
    pub fn new(client: reqwest::Client, cfg: &GitRepoConfig) -> SyncResult<Self> {
        if cfg.owner.trim().is_empty() || cfg.repo.trim().is_empty() {
            return Err(SyncError::config("请填写 Gitee 仓库所属空间（用户名/组织名）与仓库名"));
        }
        if cfg.token.trim().is_empty() {
            return Err(SyncError::config("请填写 Gitee 私人令牌"));
        }
        let api = if cfg.base_url.trim().is_empty() {
            "https://gitee.com/api/v5".to_string()
        } else {
            format!("{}/api/v5", cfg.base_url.trim().trim_end_matches('/'))
        };
        Ok(Self {
            client,
            api,
            owner: cfg.owner.trim().to_string(),
            repo: cfg.repo.trim().trim_end_matches(".git").to_string(),
            branch: cfg.branch.trim().to_string(),
            token: cfg.token.trim().to_string(),
            dir: clean_dir(&cfg.remote_dir),
            head: None,
            blobs: HashMap::new(),
            empty_repo: false,
        })
    }

    /// 拼接接口地址并附带 access_token 查询参数
    fn url(&self, tail: &str) -> String {
        let sep = if tail.contains('?') { '&' } else { '?' };
        format!(
            "{}/repos/{}/{}{}{}access_token={}",
            self.api,
            self.owner,
            self.repo,
            tail,
            sep,
            encode_component(&self.token)
        )
    }

    fn request(&self, method: Method, url: &str) -> reqwest::RequestBuilder {
        self.client.request(method, url).header(header::USER_AGENT, default_user_agent())
    }

    async fn send(&self, rb: reqwest::RequestBuilder) -> SyncResult<reqwest::Response> {
        rb.send().await.map_err(|e| from_reqwest(e, SERVICE))
    }

    async fn fail(resp: reqwest::Response, hint: &str) -> SyncError {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        if status == 400 && body.contains("sha") {
            return SyncError::conflict();
        }
        from_status(status, SERVICE, hint, &body)
    }

    async fn json(&self, rb: reqwest::RequestBuilder, hint: &str) -> SyncResult<Value> {
        let resp = self.send(rb).await?;
        if !resp.status().is_success() {
            return Err(Self::fail(resp, hint).await);
        }
        resp.json::<Value>().await.map_err(|e| SyncError::server(format!("Gitee 响应解析失败：{}", e)))
    }

    pub async fn begin(&mut self) -> SyncResult<()> {
        let repo = self
            .json(self.request(Method::GET, &self.url("")), "仓库不存在，或令牌无权访问（请检查空间地址与仓库名）")
            .await?;
        if repo.pointer("/permission/push").and_then(|v| v.as_bool()) == Some(false) {
            return Err(SyncError::new(SyncErrorKind::Forbidden, "Gitee 账号对该仓库没有推送权限"));
        }
        let default_branch = repo.get("default_branch").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if self.branch.is_empty() {
            self.branch = if default_branch.is_empty() { "master".to_string() } else { default_branch.clone() };
        }
        let resp = self
            .send(self.request(Method::GET, &self.url(&format!("/branches/{}", encode_path(&self.branch)))))
            .await?;
        self.head = if resp.status() == StatusCode::NOT_FOUND {
            None
        } else if resp.status().is_success() {
            let v: Value = resp.json().await.map_err(|e| SyncError::server(e.to_string()))?;
            v.pointer("/commit/sha").and_then(|s| s.as_str()).map(|s| s.to_string())
        } else {
            return Err(Self::fail(resp, "读取分支失败").await);
        };
        self.empty_repo = self.head.is_none() && default_branch.is_empty();
        if self.head.is_none() && !self.empty_repo {
            return Err(SyncError::config(format!(
                "Gitee 仓库中不存在分支「{}」，请先在网页上创建该分支，或把分支留空使用默认分支",
                self.branch
            )));
        }
        self.blobs.clear();
        if let Some(head) = self.head.clone() {
            let v = self
                .json(self.request(Method::GET, &self.url(&format!("/git/trees/{}?recursive=1", head))), "读取目录树失败")
                .await?;
            if let Some(items) = v.get("tree").and_then(|t| t.as_array()) {
                for item in items {
                    if item.get("type").and_then(|t| t.as_str()) == Some("blob") {
                        if let (Some(p), Some(s)) = (
                            item.get("path").and_then(|p| p.as_str()),
                            item.get("sha").and_then(|s| s.as_str()),
                        ) {
                            self.blobs.insert(p.to_string(), s.to_string());
                        }
                    }
                }
            }
        }
        Ok(())
    }

    pub async fn read(&mut self, rel: &str) -> SyncResult<Option<Vec<u8>>> {
        let full = join_remote(&self.dir, rel);
        let Some(sha) = self.blobs.get(&full).cloned() else { return Ok(None) };
        let v = self.json(self.request(Method::GET, &self.url(&format!("/git/blobs/{}", sha))), "读取文件失败").await?;
        let content = v.get("content").and_then(|c| c.as_str()).unwrap_or("");
        let cleaned: String = content.chars().filter(|c| !c.is_whitespace()).collect();
        STANDARD
            .decode(cleaned)
            .map(Some)
            .map_err(|e| SyncError::server(format!("Gitee 文件内容解码失败：{}", e)))
    }

    /// 创建或更新单个文件（sha 为 None 时创建）
    async fn write_file(&self, full: &str, data: &[u8], sha: Option<&str>, message: &str) -> SyncResult<Option<String>> {
        let mut body = json!({ "content": STANDARD.encode(data), "message": message, "branch": self.branch });
        if self.empty_repo {
            // 空仓库没有分支，交给服务端在默认分支上创建首个提交
            body.as_object_mut().map(|o| o.remove("branch"));
        }
        let method = if let Some(s) = sha {
            body["sha"] = json!(s);
            Method::PUT
        } else {
            Method::POST
        };
        let resp = self
            .send(self.request(method, &self.url(&format!("/contents/{}", encode_path(full)))).json(&body))
            .await?;
        if !resp.status().is_success() {
            if self.empty_repo {
                return Err(SyncError::config(
                    "Gitee 仓库为空，请先在网页上初始化仓库（新建仓库时勾选「使用 Readme 文件初始化这个仓库」）",
                ));
            }
            return Err(Self::fail(resp, "上传文件失败").await);
        }
        let v: Value = resp.json().await.unwrap_or(Value::Null);
        Ok(v.pointer("/content/sha").and_then(|s| s.as_str()).map(|s| s.to_string()))
    }

    async fn delete_file(&self, full: &str, sha: &str, message: &str) -> SyncResult<()> {
        let url = self.url(&format!(
            "/contents/{}?sha={}&message={}&branch={}",
            encode_path(full),
            sha,
            encode_component(message),
            encode_component(&self.branch)
        ));
        let resp = self.send(self.request(Method::DELETE, &url)).await?;
        if resp.status().is_success() || resp.status() == StatusCode::NOT_FOUND {
            return Ok(());
        }
        Err(Self::fail(resp, "删除文件失败").await)
    }

    /// 查询分支上文件的最新 sha（快照之外的实时状态）
    async fn current_sha(&self, full: &str) -> SyncResult<Option<String>> {
        if self.empty_repo {
            return Ok(None);
        }
        let url = self.url(&format!("/contents/{}?ref={}", encode_path(full), encode_component(&self.branch)));
        let resp = self.send(self.request(Method::GET, &url)).await?;
        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !resp.status().is_success() {
            return Err(Self::fail(resp, "读取文件信息失败").await);
        }
        let v: Value = resp.json().await.map_err(|e| SyncError::server(e.to_string()))?;
        // 路径不存在时 Gitee 可能返回空数组
        Ok(v.get("sha").and_then(|s| s.as_str()).map(|s| s.to_string()))
    }

    pub async fn commit(&mut self, batch: CommitBatch) -> SyncResult<()> {
        let manifest_full = join_remote(&self.dir, &batch.manifest_path);
        // 乐观锁：写入任何内容前确认清单仍是会话开始时的版本
        let snapshot_sha = self.blobs.get(&manifest_full).cloned();
        let current = self.current_sha(&manifest_full).await?;
        if current != snapshot_sha || batch.base_rev.is_some() != snapshot_sha.is_some() {
            return Err(SyncError::conflict());
        }
        for (rel, data) in batch.puts {
            let full = join_remote(&self.dir, &rel);
            let sha = self.blobs.get(&full).cloned();
            let new_sha = self.write_file(&full, &data, sha.as_deref(), &batch.message).await?;
            // 空仓库首个提交后分支已建立
            self.empty_repo = false;
            if let Some(s) = new_sha {
                self.blobs.insert(full, s);
            }
        }
        // 写清单前再次确认（逐文件提交耗时较长，缩小并发窗口）
        let current = self.current_sha(&manifest_full).await?;
        if current != snapshot_sha {
            return Err(SyncError::conflict());
        }
        self.write_file(&manifest_full, &batch.manifest, snapshot_sha.as_deref(), &batch.message).await?;
        self.empty_repo = false;
        for rel in batch.deletes {
            let full = join_remote(&self.dir, &rel);
            if let Some(sha) = self.blobs.get(&full).cloned() {
                let _ = self.delete_file(&full, &sha, &batch.message).await;
            }
        }
        Ok(())
    }

    pub async fn put_single(&mut self, rel: &str, data: Vec<u8>, message: &str) -> SyncResult<()> {
        if self.branch.is_empty() {
            self.begin().await?;
        }
        let full = join_remote(&self.dir, rel);
        let sha = self.current_sha(&full).await?;
        self.write_file(&full, &data, sha.as_deref(), message).await?;
        self.empty_repo = false;
        Ok(())
    }

    pub async fn delete_single(&mut self, rel: &str, message: &str) -> SyncResult<()> {
        if self.branch.is_empty() {
            self.begin().await?;
        }
        let full = join_remote(&self.dir, rel);
        if let Some(sha) = self.current_sha(&full).await? {
            self.delete_file(&full, &sha, message).await?;
        }
        Ok(())
    }

    pub async fn list(&mut self, dir: &str) -> SyncResult<Vec<RemoteFile>> {
        if self.branch.is_empty() {
            self.begin().await?;
        }
        if self.empty_repo {
            return Ok(Vec::new());
        }
        let full = join_remote(&self.dir, dir);
        let url = self.url(&format!("/contents/{}?ref={}", encode_path(&full), encode_component(&self.branch)));
        let resp = self.send(self.request(Method::GET, &url)).await?;
        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(Vec::new());
        }
        if !resp.status().is_success() {
            return Err(Self::fail(resp, "读取目录失败").await);
        }
        let v: Value = resp.json().await.map_err(|e| SyncError::server(e.to_string()))?;
        Ok(v.as_array()
            .map(|items| {
                items
                    .iter()
                    .filter(|i| i.get("type").and_then(|t| t.as_str()) == Some("file"))
                    .map(|i| RemoteFile {
                        name: i.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string(),
                        size: i.get("size").and_then(|s| s.as_u64()).unwrap_or(0),
                    })
                    .collect()
            })
            .unwrap_or_default())
    }
}
