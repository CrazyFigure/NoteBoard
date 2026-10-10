// GitLab 后端（gitlab.com 与自建实例）
// 同步提交走 Commits API 的 actions 批量提交（一次同步一个原子提交）；
// 清单文件更新携带 last_commit_id，期间其他设备提交过则 GitLab 拒绝（乐观锁），引擎整体重试。

use super::{clean_dir, default_user_agent, encode_component, join_remote, CommitBatch, RemoteFile};
use crate::sync::config::GitRepoConfig;
use crate::sync::error::{from_reqwest, from_status, SyncError, SyncErrorKind, SyncResult};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{header, Method, StatusCode};
use serde_json::{json, Value};
use std::collections::HashSet;

const SERVICE: &str = "GitLab";

pub struct GitLab {
    client: reqwest::Client,
    api: String,
    /// URL 编码后的项目路径（group%2Fproject）
    project: String,
    branch: String,
    token: String,
    dir: String,
    head: Option<String>,
    /// 快照中存在的文件（决定 create/update，过滤删除项）
    existing: HashSet<String>,
    /// 快照中清单文件的 last_commit_id
    manifest_commit: Option<String>,
}

impl GitLab {
    pub fn new(client: reqwest::Client, cfg: &GitRepoConfig) -> SyncResult<Self> {
        if cfg.owner.trim().is_empty() || cfg.repo.trim().is_empty() {
            return Err(SyncError::config("请填写 GitLab 项目所属的用户/群组与项目名"));
        }
        if cfg.token.trim().is_empty() {
            return Err(SyncError::config("请填写 GitLab 访问令牌（Personal access token）"));
        }
        let base = if cfg.base_url.trim().is_empty() {
            "https://gitlab.com".to_string()
        } else {
            let b = cfg.base_url.trim().trim_end_matches('/').to_string();
            if b.starts_with("http://") || b.starts_with("https://") { b } else { format!("https://{}", b) }
        };
        let path = format!("{}/{}", cfg.owner.trim().trim_matches('/'), cfg.repo.trim().trim_end_matches(".git"));
        Ok(Self {
            client,
            api: format!("{}/api/v4", base),
            project: encode_component(&path),
            branch: cfg.branch.trim().to_string(),
            token: cfg.token.trim().to_string(),
            dir: clean_dir(&cfg.remote_dir),
            head: None,
            existing: HashSet::new(),
            manifest_commit: None,
        })
    }

    fn url(&self, tail: &str) -> String {
        format!("{}/projects/{}{}", self.api, self.project, tail)
    }

    fn request(&self, method: Method, url: &str) -> reqwest::RequestBuilder {
        self.client
            .request(method, url)
            .header(header::USER_AGENT, default_user_agent())
            .header("PRIVATE-TOKEN", &self.token)
    }

    async fn send(&self, rb: reqwest::RequestBuilder) -> SyncResult<reqwest::Response> {
        rb.send().await.map_err(|e| from_reqwest(e, SERVICE))
    }

    async fn fail(resp: reqwest::Response, hint: &str) -> SyncError {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        let lower = body.to_lowercase();
        // 文件已被他人修改/已存在 → 乐观锁冲突
        if status == 400
            && (lower.contains("already exists")
                || lower.contains("has changed")
                || lower.contains("has been updated")
                || lower.contains("doesn't exist")
                || lower.contains("does not exist"))
        {
            return SyncError::conflict();
        }
        if status == 403 && lower.contains("insufficient_scope") {
            return SyncError::new(SyncErrorKind::Forbidden, "GitLab 令牌权限不足：请勾选 api 权限范围");
        }
        from_status(status, SERVICE, hint, &body)
    }

    async fn json(&self, rb: reqwest::RequestBuilder, hint: &str) -> SyncResult<Value> {
        let resp = self.send(rb).await?;
        if !resp.status().is_success() {
            return Err(Self::fail(resp, hint).await);
        }
        resp.json::<Value>().await.map_err(|e| SyncError::server(format!("GitLab 响应解析失败：{}", e)))
    }

    pub async fn begin(&mut self) -> SyncResult<()> {
        let project = self
            .json(
                self.request(Method::GET, &self.url("")),
                "项目不存在，或令牌无权访问（请检查地址、用户/群组与项目名）",
            )
            .await?;
        // 访问级别：30 = Developer，可推送
        let level = project
            .pointer("/permissions/project_access/access_level")
            .and_then(|v| v.as_u64())
            .max(project.pointer("/permissions/group_access/access_level").and_then(|v| v.as_u64()));
        if let Some(l) = level {
            if l < 30 {
                return Err(SyncError::new(SyncErrorKind::Forbidden, "GitLab 账号在该项目中没有推送权限（至少需要 Developer 角色）"));
            }
        }
        let default_branch = project.get("default_branch").and_then(|v| v.as_str()).unwrap_or("main").to_string();
        let empty = project.get("empty_repo").and_then(|v| v.as_bool()).unwrap_or(false);
        if self.branch.is_empty() {
            self.branch = default_branch.clone();
        }
        self.head = self.branch_head(&self.branch.clone()).await?;
        if self.head.is_none() && !empty && self.branch != default_branch {
            let url = self.url(&format!(
                "/repository/branches?branch={}&ref={}",
                encode_component(&self.branch),
                encode_component(&default_branch)
            ));
            let v = self.json(self.request(Method::POST, &url), "创建分支失败").await?;
            self.head = v.pointer("/commit/id").and_then(|s| s.as_str()).map(|s| s.to_string());
        }
        self.existing.clear();
        self.manifest_commit = None;
        if let Some(head) = self.head.clone() {
            self.load_tree(&head).await?;
        }
        Ok(())
    }

    async fn branch_head(&self, branch: &str) -> SyncResult<Option<String>> {
        let resp = self
            .send(self.request(Method::GET, &self.url(&format!("/repository/branches/{}", encode_component(branch)))))
            .await?;
        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !resp.status().is_success() {
            return Err(Self::fail(resp, "读取分支失败").await);
        }
        let v: Value = resp.json().await.map_err(|e| SyncError::server(e.to_string()))?;
        Ok(v.pointer("/commit/id").and_then(|s| s.as_str()).map(|s| s.to_string()))
    }

    /// 分页读取远端目录树（仅同步子目录范围）
    async fn load_tree(&mut self, head: &str) -> SyncResult<()> {
        let mut page = 1u32;
        loop {
            let mut url = self.url(&format!(
                "/repository/tree?recursive=true&per_page=100&page={}&ref={}",
                page,
                encode_component(head)
            ));
            if !self.dir.is_empty() {
                url.push_str(&format!("&path={}", encode_component(&self.dir)));
            }
            let resp = self.send(self.request(Method::GET, &url)).await?;
            if resp.status() == StatusCode::NOT_FOUND {
                break;
            }
            if !resp.status().is_success() {
                return Err(Self::fail(resp, "读取目录树失败").await);
            }
            let next = resp
                .headers()
                .get("x-next-page")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<u32>().ok());
            let v: Value = resp.json().await.map_err(|e| SyncError::server(e.to_string()))?;
            if let Some(items) = v.as_array() {
                for item in items {
                    if item.get("type").and_then(|t| t.as_str()) == Some("blob") {
                        if let Some(p) = item.get("path").and_then(|p| p.as_str()) {
                            self.existing.insert(p.to_string());
                        }
                    }
                }
            }
            match next {
                Some(n) if n > page => page = n,
                _ => break,
            }
        }
        Ok(())
    }

    pub async fn read(&mut self, rel: &str) -> SyncResult<Option<Vec<u8>>> {
        let Some(head) = self.head.clone() else { return Ok(None) };
        let full = join_remote(&self.dir, rel);
        let url = self.url(&format!(
            "/repository/files/{}/raw?ref={}",
            encode_component(&full),
            encode_component(&head)
        ));
        let resp = self.send(self.request(Method::GET, &url)).await?;
        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !resp.status().is_success() {
            return Err(Self::fail(resp, "读取文件失败").await);
        }
        Ok(Some(resp.bytes().await.map_err(|e| from_reqwest(e, SERVICE))?.to_vec()))
    }

    /// 读取文件最后一次修改它的提交（清单乐观锁）
    async fn last_commit_of(&self, full: &str, rev: &str) -> SyncResult<Option<String>> {
        let url = self.url(&format!("/repository/files/{}?ref={}", encode_component(full), encode_component(rev)));
        let resp = self.send(self.request(Method::HEAD, &url)).await?;
        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !resp.status().is_success() {
            return Err(Self::fail(resp, "读取文件信息失败").await);
        }
        Ok(resp
            .headers()
            .get("x-gitlab-last-commit-id")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string()))
    }

    pub async fn commit(&mut self, batch: CommitBatch) -> SyncResult<()> {
        let manifest_full = join_remote(&self.dir, &batch.manifest_path);
        if let Some(head) = self.head.clone() {
            if self.existing.contains(&manifest_full) && self.manifest_commit.is_none() {
                self.manifest_commit = self.last_commit_of(&manifest_full, &head).await?;
            }
        }
        // 快照里有无清单必须与读取时一致，否则说明期间有其他设备初始化过
        if batch.base_rev.is_some() != self.existing.contains(&manifest_full) {
            return Err(SyncError::conflict());
        }

        let mut actions: Vec<Value> = Vec::new();
        let mut written: HashSet<String> = HashSet::new();
        for (rel, data) in batch.puts {
            let path = join_remote(&self.dir, &rel);
            let action = if self.existing.contains(&path) { "update" } else { "create" };
            written.insert(path.clone());
            actions.push(json!({
                "action": action,
                "file_path": path,
                "content": STANDARD.encode(&data),
                "encoding": "base64",
            }));
        }
        let mut manifest_action = json!({
            "action": if self.existing.contains(&manifest_full) { "update" } else { "create" },
            "file_path": manifest_full,
            "content": STANDARD.encode(&batch.manifest),
            "encoding": "base64",
        });
        if let Some(id) = &self.manifest_commit {
            manifest_action["last_commit_id"] = json!(id);
        }
        actions.push(manifest_action);
        for rel in &batch.deletes {
            let path = join_remote(&self.dir, rel);
            if self.existing.contains(&path) && !written.contains(&path) {
                actions.push(json!({ "action": "delete", "file_path": path }));
            }
        }

        let body = json!({ "branch": self.branch, "commit_message": batch.message, "actions": actions });
        let v = self.json(self.request(Method::POST, &self.url("/repository/commits")).json(&body), "提交失败").await?;
        self.head = v.get("id").and_then(|s| s.as_str()).map(|s| s.to_string());
        Ok(())
    }

    pub async fn put_single(&mut self, rel: &str, data: Vec<u8>, message: &str) -> SyncResult<()> {
        if self.branch.is_empty() {
            self.begin().await?;
        }
        let full = join_remote(&self.dir, rel);
        let exists = self.last_commit_of(&full, &self.branch.clone()).await?.is_some();
        let body = json!({
            "branch": self.branch,
            "commit_message": message,
            "content": STANDARD.encode(&data),
            "encoding": "base64",
        });
        let method = if exists { Method::PUT } else { Method::POST };
        let url = self.url(&format!("/repository/files/{}", encode_component(&full)));
        self.json(self.request(method, &url).json(&body), "上传文件失败").await?;
        Ok(())
    }

    pub async fn delete_single(&mut self, rel: &str, message: &str) -> SyncResult<()> {
        if self.branch.is_empty() {
            self.begin().await?;
        }
        let full = join_remote(&self.dir, rel);
        let url = self.url(&format!("/repository/files/{}", encode_component(&full)));
        let body = json!({ "branch": self.branch, "commit_message": message });
        let resp = self.send(self.request(Method::DELETE, &url).json(&body)).await?;
        if resp.status().is_success() || resp.status() == StatusCode::NOT_FOUND || resp.status() == StatusCode::BAD_REQUEST {
            return Ok(());
        }
        Err(Self::fail(resp, "删除文件失败").await)
    }

    pub async fn list(&mut self, dir: &str) -> SyncResult<Vec<RemoteFile>> {
        if self.branch.is_empty() {
            self.begin().await?;
        }
        let full = join_remote(&self.dir, dir);
        let mut files = Vec::new();
        let mut page = 1u32;
        loop {
            let url = self.url(&format!(
                "/repository/tree?path={}&ref={}&per_page=100&page={}",
                encode_component(&full),
                encode_component(&self.branch),
                page
            ));
            let resp = self.send(self.request(Method::GET, &url)).await?;
            if resp.status() == StatusCode::NOT_FOUND {
                break;
            }
            if !resp.status().is_success() {
                return Err(Self::fail(resp, "读取目录失败").await);
            }
            let next = resp
                .headers()
                .get("x-next-page")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<u32>().ok());
            let v: Value = resp.json().await.map_err(|e| SyncError::server(e.to_string()))?;
            for item in v.as_array().cloned().unwrap_or_default() {
                if item.get("type").and_then(|t| t.as_str()) == Some("blob") {
                    files.push(RemoteFile {
                        name: item.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string(),
                        size: 0,
                    });
                }
            }
            match next {
                Some(n) if n > page => page = n,
                _ => break,
            }
        }
        Ok(files)
    }
}
