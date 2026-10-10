// GitHub 后端
// 同步提交走 Git Data API：创建 blob/tree/commit 后以非强制方式更新分支——
// 同一次同步的所有增删改与清单在同一个原子提交中；期间其他设备推送过则更新分支失败（乐观锁），引擎整体重试。

use super::{clean_dir, default_user_agent, encode_path, join_remote, CommitBatch, RemoteFile};
use crate::sync::config::GitRepoConfig;
use crate::sync::error::{from_reqwest, from_status, SyncError, SyncErrorKind, SyncResult};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{header, Method, StatusCode};
use serde_json::{json, Value};
use std::collections::HashSet;

const SERVICE: &str = "GitHub";
/// 文本文件内联进 tree 请求的单文件上限（超过则单独创建 blob）
const INLINE_FILE_LIMIT: usize = 512 * 1024;
/// 单次 tree 请求内联文本累计上限
const INLINE_TOTAL_LIMIT: usize = 16 * 1024 * 1024;

pub struct GitHub {
    client: reqwest::Client,
    api: String,
    owner: String,
    repo: String,
    branch: String,
    token: String,
    dir: String,
    /// 本次会话的分支提交（None 表示空仓库）
    head: Option<String>,
    tree: Option<String>,
}

impl GitHub {
    pub fn new(client: reqwest::Client, cfg: &GitRepoConfig) -> SyncResult<Self> {
        if cfg.owner.trim().is_empty() || cfg.repo.trim().is_empty() {
            return Err(SyncError::config("请填写 GitHub 仓库所有者与仓库名"));
        }
        if cfg.token.trim().is_empty() {
            return Err(SyncError::config("请填写 GitHub 访问令牌（Personal access token）"));
        }
        let api = if cfg.base_url.trim().is_empty() {
            "https://api.github.com".to_string()
        } else {
            // GitHub Enterprise Server
            format!("{}/api/v3", cfg.base_url.trim().trim_end_matches('/'))
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
            tree: None,
        })
    }

    fn repo_url(&self, tail: &str) -> String {
        format!("{}/repos/{}/{}{}", self.api, self.owner, self.repo, tail)
    }

    fn request(&self, method: Method, url: &str) -> reqwest::RequestBuilder {
        self.client
            .request(method, url)
            .header(header::USER_AGENT, default_user_agent())
            .header(header::AUTHORIZATION, format!("Bearer {}", self.token))
            .header(header::ACCEPT, "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
    }

    async fn send(&self, rb: reqwest::RequestBuilder) -> SyncResult<reqwest::Response> {
        rb.send().await.map_err(|e| from_reqwest(e, SERVICE))
    }

    async fn fail(resp: reqwest::Response, hint: &str) -> SyncError {
        let status = resp.status().as_u16();
        let remaining = resp
            .headers()
            .get("x-ratelimit-remaining")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let body = resp.text().await.unwrap_or_default();
        if (status == 403 || status == 429) && remaining.as_deref() == Some("0") {
            return SyncError::new(SyncErrorKind::RateLimited, "GitHub API 调用次数已达上限，请稍后再试");
        }
        from_status(status, SERVICE, hint, &body)
    }

    async fn json(&self, rb: reqwest::RequestBuilder, hint: &str) -> SyncResult<Value> {
        let resp = self.send(rb).await?;
        if !resp.status().is_success() {
            return Err(Self::fail(resp, hint).await);
        }
        resp.json::<Value>().await.map_err(|e| SyncError::server(format!("GitHub 响应解析失败：{}", e)))
    }

    /// 读取仓库与分支快照；分支不存在时从默认分支创建
    pub async fn begin(&mut self) -> SyncResult<()> {
        let repo = self
            .json(
                self.request(Method::GET, &self.repo_url("")),
                "仓库不存在，或令牌无权访问该仓库（Fine-grained 令牌需在 Repository access 中选中此仓库）",
            )
            .await?;
        if repo.pointer("/permissions/push").and_then(|v| v.as_bool()) == Some(false) {
            return Err(SyncError::new(
                SyncErrorKind::Forbidden,
                "GitHub 令牌对该仓库只有读取权限，请授予 Contents: Read and write 权限",
            ));
        }
        let default_branch = repo.get("default_branch").and_then(|v| v.as_str()).unwrap_or("main").to_string();
        if self.branch.is_empty() {
            self.branch = default_branch.clone();
        }
        self.head = self.branch_head(&self.branch.clone()).await?;
        if self.head.is_none() && self.branch != default_branch {
            // 非空仓库但分支不存在：从默认分支拉出同名分支
            if let Some(base) = self.branch_head(&default_branch).await? {
                let body = json!({ "ref": format!("refs/heads/{}", self.branch), "sha": base });
                self.json(self.request(Method::POST, &self.repo_url("/git/refs")).json(&body), "创建分支失败").await?;
                self.head = Some(base);
            }
        }
        self.tree = match &self.head {
            Some(sha) => {
                let commit = self
                    .json(self.request(Method::GET, &self.repo_url(&format!("/git/commits/{}", sha))), "读取提交失败")
                    .await?;
                commit.pointer("/tree/sha").and_then(|v| v.as_str()).map(|s| s.to_string())
            }
            None => None,
        };
        Ok(())
    }

    /// 读取分支最新提交；分支不存在或仓库为空时返回 None
    async fn branch_head(&self, branch: &str) -> SyncResult<Option<String>> {
        let url = self.repo_url(&format!("/git/ref/heads/{}", encode_path(branch)));
        let resp = self.send(self.request(Method::GET, &url)).await?;
        // 404 分支不存在；409 空仓库
        if resp.status() == StatusCode::NOT_FOUND || resp.status() == StatusCode::CONFLICT {
            return Ok(None);
        }
        if !resp.status().is_success() {
            return Err(Self::fail(resp, "读取分支失败").await);
        }
        let v: Value = resp.json().await.map_err(|e| SyncError::server(e.to_string()))?;
        Ok(v.pointer("/object/sha").and_then(|s| s.as_str()).map(|s| s.to_string()))
    }

    pub async fn read(&mut self, rel: &str) -> SyncResult<Option<Vec<u8>>> {
        let Some(head) = self.head.clone() else { return Ok(None) };
        let full = join_remote(&self.dir, rel);
        let url = self.repo_url(&format!("/contents/{}?ref={}", encode_path(&full), head));
        let resp = self
            .send(self.request(Method::GET, &url).header(header::ACCEPT, "application/vnd.github.raw"))
            .await?;
        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !resp.status().is_success() {
            return Err(Self::fail(resp, "读取文件失败").await);
        }
        Ok(Some(resp.bytes().await.map_err(|e| from_reqwest(e, SERVICE))?.to_vec()))
    }

    /// 空仓库无法使用 Git Data API：先用内容接口创建首个提交初始化分支
    async fn init_empty_repo(&mut self, manifest_path: &str, manifest: &[u8]) -> SyncResult<()> {
        let full = join_remote(&self.dir, manifest_path);
        let body = json!({
            "message": "NoteBoard 同步：初始化",
            "content": STANDARD.encode(manifest),
            "branch": self.branch,
        });
        let url = self.repo_url(&format!("/contents/{}", encode_path(&full)));
        let resp = self.send(self.request(Method::PUT, &url).json(&body)).await?;
        if !resp.status().is_success() {
            return Err(Self::fail(resp, "初始化空仓库失败").await);
        }
        self.begin().await
    }

    /// 读取 base tree 中实际存在的文件（用于过滤删除项：删除不存在的路径会被 API 拒绝）
    async fn existing_paths(&self) -> SyncResult<HashSet<String>> {
        let Some(tree) = &self.tree else { return Ok(HashSet::new()) };
        let v = self
            .json(self.request(Method::GET, &self.repo_url(&format!("/git/trees/{}?recursive=1", tree))), "读取目录树失败")
            .await?;
        Ok(v.get("tree")
            .and_then(|t| t.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter(|i| i.get("type").and_then(|t| t.as_str()) == Some("blob"))
                    .filter_map(|i| i.get("path").and_then(|p| p.as_str()).map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default())
    }

    pub async fn commit(&mut self, batch: CommitBatch) -> SyncResult<()> {
        if self.head.is_none() {
            if batch.base_rev.is_some() {
                return Err(SyncError::conflict());
            }
            self.init_empty_repo(&batch.manifest_path, &batch.manifest).await?;
        }
        let head = self.head.clone().ok_or_else(|| SyncError::server("GitHub 分支初始化失败"))?;
        let base_tree = self.tree.clone();

        let mut entries: Vec<Value> = Vec::new();
        let mut inline_total = 0usize;
        let mut puts = batch.puts;
        puts.push((batch.manifest_path.clone(), batch.manifest));
        for (rel, data) in puts {
            let path = join_remote(&self.dir, &rel);
            let inline = data.len() <= INLINE_FILE_LIMIT && inline_total + data.len() <= INLINE_TOTAL_LIMIT;
            match (inline, String::from_utf8(data)) {
                (true, Ok(text)) => {
                    inline_total += text.len();
                    entries.push(json!({ "path": path, "mode": "100644", "type": "blob", "content": text }));
                }
                (_, Ok(text)) => {
                    let sha = self.create_blob(text.as_bytes()).await?;
                    entries.push(json!({ "path": path, "mode": "100644", "type": "blob", "sha": sha }));
                }
                (_, Err(e)) => {
                    let sha = self.create_blob(e.as_bytes()).await?;
                    entries.push(json!({ "path": path, "mode": "100644", "type": "blob", "sha": sha }));
                }
            }
        }
        if !batch.deletes.is_empty() {
            let existing = self.existing_paths().await?;
            for rel in &batch.deletes {
                let path = join_remote(&self.dir, rel);
                if existing.contains(&path) {
                    entries.push(json!({ "path": path, "mode": "100644", "type": "blob", "sha": Value::Null }));
                }
            }
        }

        let mut tree_body = json!({ "tree": entries });
        if let Some(base) = base_tree {
            tree_body["base_tree"] = json!(base);
        }
        let tree = self.json(self.request(Method::POST, &self.repo_url("/git/trees")).json(&tree_body), "创建目录树失败").await?;
        let tree_sha = tree.get("sha").and_then(|v| v.as_str()).ok_or_else(|| SyncError::server("GitHub 未返回 tree sha"))?;

        let commit_body = json!({ "message": batch.message, "tree": tree_sha, "parents": [head] });
        let commit = self.json(self.request(Method::POST, &self.repo_url("/git/commits")).json(&commit_body), "创建提交失败").await?;
        let commit_sha = commit.get("sha").and_then(|v| v.as_str()).ok_or_else(|| SyncError::server("GitHub 未返回 commit sha"))?;

        // 非强制更新：分支已被其他设备推进时返回 422（非快进），视为乐观锁冲突
        let url = self.repo_url(&format!("/git/refs/heads/{}", encode_path(&self.branch)));
        let resp = self
            .send(self.request(Method::PATCH, &url).json(&json!({ "sha": commit_sha, "force": false })))
            .await?;
        if resp.status() == StatusCode::UNPROCESSABLE_ENTITY || resp.status() == StatusCode::CONFLICT {
            return Err(SyncError::conflict());
        }
        if !resp.status().is_success() {
            return Err(Self::fail(resp, "更新分支失败").await);
        }
        self.head = Some(commit_sha.to_string());
        self.tree = Some(tree_sha.to_string());
        Ok(())
    }

    async fn create_blob(&self, data: &[u8]) -> SyncResult<String> {
        let body = json!({ "content": STANDARD.encode(data), "encoding": "base64" });
        let v = self.json(self.request(Method::POST, &self.repo_url("/git/blobs")).json(&body), "上传文件失败").await?;
        v.get("sha").and_then(|s| s.as_str()).map(|s| s.to_string()).ok_or_else(|| SyncError::server("GitHub 未返回 blob sha"))
    }

    /// 读取文件元信息中的 sha（单文件写入/删除需要）
    async fn file_sha(&self, full: &str) -> SyncResult<Option<String>> {
        let url = self.repo_url(&format!("/contents/{}?ref={}", encode_path(full), encode_path(&self.branch)));
        let resp = self.send(self.request(Method::GET, &url)).await?;
        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !resp.status().is_success() {
            return Err(Self::fail(resp, "读取文件失败").await);
        }
        let v: Value = resp.json().await.map_err(|e| SyncError::server(e.to_string()))?;
        Ok(v.get("sha").and_then(|s| s.as_str()).map(|s| s.to_string()))
    }

    pub async fn put_single(&mut self, rel: &str, data: Vec<u8>, message: &str) -> SyncResult<()> {
        if self.branch.is_empty() {
            self.begin().await?;
        }
        let full = join_remote(&self.dir, rel);
        let mut body = json!({ "message": message, "content": STANDARD.encode(&data), "branch": self.branch });
        if let Some(sha) = self.file_sha(&full).await? {
            body["sha"] = json!(sha);
        }
        let url = self.repo_url(&format!("/contents/{}", encode_path(&full)));
        self.json(self.request(Method::PUT, &url).json(&body), "上传文件失败").await?;
        Ok(())
    }

    pub async fn delete_single(&mut self, rel: &str, message: &str) -> SyncResult<()> {
        if self.branch.is_empty() {
            self.begin().await?;
        }
        let full = join_remote(&self.dir, rel);
        let Some(sha) = self.file_sha(&full).await? else { return Ok(()) };
        let body = json!({ "message": message, "sha": sha, "branch": self.branch });
        let url = self.repo_url(&format!("/contents/{}", encode_path(&full)));
        self.json(self.request(Method::DELETE, &url).json(&body), "删除文件失败").await?;
        Ok(())
    }

    pub async fn list(&mut self, dir: &str) -> SyncResult<Vec<RemoteFile>> {
        if self.branch.is_empty() {
            self.begin().await?;
        }
        let full = join_remote(&self.dir, dir);
        let url = self.repo_url(&format!("/contents/{}?ref={}", encode_path(&full), encode_path(&self.branch)));
        let resp = self.send(self.request(Method::GET, &url)).await?;
        // 目录不存在或空仓库（404/409）
        if resp.status() == StatusCode::NOT_FOUND || resp.status() == StatusCode::CONFLICT {
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
