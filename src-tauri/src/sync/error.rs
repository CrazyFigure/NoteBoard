// NoteBoard 同步错误类型：统一把 HTTP 状态码、网络异常与本地 I/O 错误翻译成用户能看懂的提示

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncErrorKind {
    /// 配置不完整或格式错误
    Config,
    /// 认证失败（401）
    Auth,
    /// 权限不足（403）
    Forbidden,
    /// 远端仓库、存储桶或目录不存在（404）
    NotFound,
    /// 网络不可达、超时、TLS 失败
    Network,
    /// 远端在本次同步期间被其他设备更新（乐观锁冲突，需要重新同步）
    Conflict,
    /// 另一台设备正在同步（锁文件未过期）
    Busy,
    /// 请求过于频繁被限流
    RateLimited,
    /// 服务端错误或无法识别的响应
    Server,
    /// 本地文件读写失败
    Local,
}

#[derive(Debug, Clone)]
pub struct SyncError {
    pub kind: SyncErrorKind,
    pub message: String,
}

impl SyncError {
    pub fn new(kind: SyncErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
    pub fn config(message: impl Into<String>) -> Self {
        Self::new(SyncErrorKind::Config, message)
    }
    pub fn local(message: impl Into<String>) -> Self {
        Self::new(SyncErrorKind::Local, message)
    }
    pub fn server(message: impl Into<String>) -> Self {
        Self::new(SyncErrorKind::Server, message)
    }
    pub fn conflict() -> Self {
        Self::new(SyncErrorKind::Conflict, "远端数据在同步期间被其他设备更新")
    }
    pub fn busy(message: impl Into<String>) -> Self {
        Self::new(SyncErrorKind::Busy, message)
    }

    /// 是否值得稍后自动重试（网络抖动、限流、其他设备占用）
    pub fn is_transient(&self) -> bool {
        matches!(
            self.kind,
            SyncErrorKind::Network | SyncErrorKind::Busy | SyncErrorKind::RateLimited | SyncErrorKind::Server
        )
    }
}

impl fmt::Display for SyncError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl From<std::io::Error> for SyncError {
    fn from(e: std::io::Error) -> Self {
        SyncError::local(format!("本地文件操作失败：{}", e))
    }
}

/// reqwest 网络异常 → 友好提示
pub fn from_reqwest(e: reqwest::Error, service: &str) -> SyncError {
    let msg = if e.is_timeout() {
        format!("连接 {} 超时，请检查网络或代理设置", service)
    } else if e.is_connect() {
        format!("无法连接 {}：请检查服务地址是否正确、网络是否可用（如需代理请先在系统中设置）", service)
    } else if e.is_builder() {
        format!("{} 地址格式不正确：{}", service, e)
    } else {
        format!("访问 {} 时网络异常：{}", service, e)
    };
    SyncError::new(SyncErrorKind::Network, msg)
}

/// HTTP 状态码 → 友好提示（各服务可在此基础上补充更具体的说明）
pub fn from_status(status: u16, service: &str, hint_404: &str, body: &str) -> SyncError {
    let detail = short_body(body);
    match status {
        401 => SyncError::new(
            SyncErrorKind::Auth,
            format!("{} 认证失败：账号、密码或令牌不正确，或令牌已过期", service),
        ),
        403 => {
            let lower = body.to_lowercase();
            if lower.contains("rate limit") || lower.contains("too many") {
                SyncError::new(SyncErrorKind::RateLimited, format!("{} 请求过于频繁被限流，请稍后再试", service))
            } else {
                SyncError::new(
                    SyncErrorKind::Forbidden,
                    format!("{} 拒绝访问：令牌/密钥权限不足（需要读写权限）{}", service, detail),
                )
            }
        }
        404 => SyncError::new(SyncErrorKind::NotFound, format!("{}：{}", service, hint_404)),
        409 | 412 => SyncError::conflict(),
        429 | 503 => SyncError::new(SyncErrorKind::RateLimited, format!("{} 请求过于频繁或服务繁忙，请稍后再试", service)),
        507 => SyncError::new(SyncErrorKind::Server, format!("{} 存储空间不足", service)),
        s if s >= 500 => SyncError::new(SyncErrorKind::Server, format!("{} 服务端错误（HTTP {}）{}", service, s, detail)),
        s => SyncError::new(SyncErrorKind::Server, format!("{} 返回异常状态 HTTP {}{}", service, s, detail)),
    }
}

/// 截取响应正文摘要，避免把整页 HTML 塞进提示
fn short_body(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.is_empty() || trimmed.starts_with("<!") || trimmed.starts_with("<html") {
        return String::new();
    }
    let s: String = trimmed.chars().take(160).collect();
    format!("（{}）", s.replace(['\r', '\n'], " "))
}

pub type SyncResult<T> = Result<T, SyncError>;
