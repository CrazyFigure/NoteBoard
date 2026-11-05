// NoteBoard 同步错误类型：统一把 HTTP 状态码、网络异常与本地 I/O 错误翻译成用户能看懂的提示

use std::fmt;
use std::error::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncErrorKind {
    /// 同名文件内容不同，需要用户确认本次更新方向；不自动重试。
    ConfirmationRequired,
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
    /// 等待确认的文件快照，仅在更新确认分支携带。
    pub updates: Vec<super::types::SyncFileUpdate>,
}

impl SyncError {
    pub fn new(kind: SyncErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into(), updates: Vec::new() }
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

/// 检查连接错误的底层原因；仅返回固定提示，错误原文可能含地址或凭证，不能直接展示。
fn connection_hint(error: &(dyn Error + 'static)) -> &'static str {
    let (mut tls, mut dns, mut proxy, mut refused) = (false, false, false, false);
    let mut current = Some(error);
    // 限制错误链深度，避免异常来源形成循环；优先报告比代理包装更具体的 TLS 或 DNS 原因。
    for _ in 0..16 {
        let Some(cause) = current else { break };
        let text = cause.to_string().to_lowercase();
        tls |= ["certificate", "tls", "unknownissuer", "unknown issuer"].iter().any(|term| text.contains(term));
        dns |= ["dns", "lookup address", "name or service not known", "no such host", "host not found"].iter().any(|term| text.contains(term));
        proxy |= text.contains("proxy") || text.contains("tunnel");
        if let Some(io) = cause.downcast_ref::<std::io::Error>() {
            refused |= io.kind() == std::io::ErrorKind::ConnectionRefused;
            dns |= io.raw_os_error() == Some(11001);
        }
        current = cause.source();
    }
    if tls { "TLS/证书校验失败，请检查服务域名、证书链及 HTTPS 代理证书" }
    else if dns { "域名解析失败，请检查服务端点与 DNS 设置" }
    else if proxy { "代理连接失败，请检查系统代理地址、认证及代理服务是否可用" }
    else if refused { "服务器拒绝连接，请检查地址、端口、防火墙或系统代理" }
    else { "请检查服务地址是否正确、网络是否可用（如需代理请先在系统中设置）" }
}

/// reqwest 网络异常 → 友好提示；连接错误须区分 DNS、TLS 和代理，且不暴露请求 URL。
pub fn from_reqwest(e: reqwest::Error, service: &str) -> SyncError {
    // 分类前先移除 URL，避免域名或查询参数中的 tls/proxy 字样被误判成底层故障。
    let e = e.without_url();
    let msg = if e.is_timeout() {
        format!("连接 {} 超时，请检查网络或代理设置", service)
    } else if e.is_connect() {
        format!("无法连接 {}：{}", service, connection_hint(&e))
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 模拟代理包装底层错误，验证诊断能穿透外层提示且不回显可能包含凭证的原文。
    #[derive(Debug)]
    struct ProxyFailure(std::io::Error);
    impl fmt::Display for ProxyFailure {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "proxy tunnel failed") }
    }
    impl Error for ProxyFailure {
        fn source(&self) -> Option<&(dyn Error + 'static)> { Some(&self.0) }
    }

    /// TLS 和 DNS 是具体根因，不能被外层代理错误掩盖，也不能把错误正文中的令牌显示给用户。
    #[test]
    fn connection_diagnostics_preserve_underlying_reason_without_details() {
        let tls = ProxyFailure(std::io::Error::other("invalid peer certificate: UnknownIssuer; private-token"));
        assert!(connection_hint(&tls).contains("TLS/证书"));
        assert!(!connection_hint(&tls).contains("private-token"));
        let dns = ProxyFailure(std::io::Error::other("dns error: failed to lookup address"));
        assert!(connection_hint(&dns).contains("域名解析"));
        assert!(connection_hint(&std::io::Error::from_raw_os_error(11001)).contains("域名解析"));
        assert!(connection_hint(&ProxyFailure(std::io::Error::other("authentication failed"))).contains("代理连接"));
        assert!(connection_hint(&std::io::Error::from(std::io::ErrorKind::ConnectionRefused)).contains("拒绝连接"));
    }

    /// 真实连接一个已关闭的回环端口；URL 中故意包含分类关键词和假令牌，均不能泄漏或误导分类。
    #[test]
    fn request_url_is_removed_before_classifying_connection_failure() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        super::super::runtime::block_on(async {
            let client = reqwest::Client::builder().no_proxy().timeout(std::time::Duration::from_secs(3)).build().unwrap();
            let error = client.get(format!("http://{}/private?tls=private-token&proxy=private-token", address)).send().await.unwrap_err();
            let translated = from_reqwest(error, "天翼云 ZOS");
            assert_eq!(translated.kind, SyncErrorKind::Network);
            assert!(translated.message.contains("拒绝连接"));
            assert!(!translated.message.contains("private-token") && !translated.message.contains("http://"));
        });
    }
}
