// S3 兼容对象存储后端（AWS S3、阿里云 OSS、腾讯云 COS、Cloudflare R2、MinIO 等）
// 使用 AWS Signature V4 签名；对象键 = 前缀 + 与本地一致的相对路径。

use super::{clean_dir, encode_component, encode_path, join_remote, request_headers, xml, RemoteFile};
use crate::sync::config::{ProviderKind, S3Config};
use crate::sync::error::{from_reqwest, from_status, SyncError, SyncErrorKind, SyncResult};
use crate::sync::util::sha256_hex;
use reqwest::{header, Method, StatusCode};
use sha2::{Digest, Sha256};

const SERVICE: &str = "S3";

pub struct S3 {
    client: reqwest::Client,
    scheme: String,
    /// 主机（含非默认端口）
    host: String,
    region: String,
    bucket: String,
    access_key: String,
    secret_key: String,
    prefix: String,
    path_style: bool,
    /// CNAME 已经绑定到桶，请求主机和路径均不再追加桶名。
    custom_domain: bool,
    /// OBS 的 V4 接口仅接受不签名请求体或指定的流式模式。
    unsigned_payload: bool,
    /// 网关认证等自定义头；程序生成的签名字段不能被覆盖。
    headers: header::HeaderMap,
}

impl S3 {
    /// 校验存储桶、密钥与请求头，预先拒绝会覆盖 SigV4 或 HTTP 传输字段的配置。
    pub fn new(client: reqwest::Client, cfg: &S3Config, kind: ProviderKind) -> SyncResult<Self> {
        // 只有通用 S3 可回退 AWS 默认值，厂商入口必须明确提供其资源池地址与签名区域。
        if kind != ProviderKind::S3 && (cfg.endpoint.trim().is_empty() || cfg.region.trim().is_empty()) {
            return Err(SyncError::config(format!("请填写 {} 的服务端点和区域（以存储桶控制台为准）", kind.label())));
        }
        let region = if cfg.region.trim().is_empty() { "us-east-1".to_string() } else { cfg.region.trim().to_string() };
        let endpoint = if cfg.endpoint.trim().is_empty() {
            format!("https://s3.{}.amazonaws.com", region)
        } else {
            cfg.endpoint.trim().to_string()
        };
        let endpoint = if endpoint.starts_with("http://") || endpoint.starts_with("https://") {
            endpoint
        } else {
            format!("https://{}", endpoint)
        };
        let parsed = url::Url::parse(&endpoint).map_err(|_| SyncError::config("S3 服务端点格式不正确，例如 https://s3.us-east-1.amazonaws.com"))?;
        // 旧版通用 S3 只使用端点的协议、主机和端口，已保存的路径等内容并不参与对象定位。
        // 保留原解析规则且不改写配置，避免升级后拒绝原本可用的连接或改变同步目标身份。
        // 新厂商入口及新增的自定义域名模式仍要求纯服务域名，防止新配置产生歧义。
        let legacy_endpoint = kind == ProviderKind::S3 && !cfg.custom_domain;
        if !legacy_endpoint && (!matches!(parsed.scheme(), "http" | "https") || !parsed.username().is_empty() || parsed.password().is_some()
            || !matches!(parsed.path(), "" | "/") || parsed.query().is_some() || parsed.fragment().is_some()
        ) {
            return Err(SyncError::config("服务端点只能填写 http(s) 域名及可选端口，请将远端目录填入对象前缀"));
        }
        let host = parsed.host_str().ok_or_else(|| SyncError::config("S3 服务端点缺少主机名"))?.to_string();
        let host = match parsed.port() {
            Some(p) => format!("{}:{}", host, p),
            None => host,
        };
        if cfg.bucket.trim().is_empty() {
            return Err(SyncError::config("请填写 S3 存储桶（Bucket）名称"));
        }
        if cfg.access_key_id.trim().is_empty() || cfg.secret_access_key.trim().is_empty() {
            return Err(SyncError::config("请填写 S3 Access Key ID 与 Secret Access Key"));
        }
        if cfg.custom_domain && cfg.path_style {
            return Err(SyncError::config("自定义域名已绑定存储桶，不能同时开启路径风格访问"));
        }
        if cfg.path_style && matches!(kind, ProviderKind::Oss | ProviderKind::Obs | ProviderKind::Cos) {
            return Err(SyncError::config(format!("{} 请使用桶域名访问或已绑定的自定义域名", kind.label())));
        }
        let unsigned_payload = kind == ProviderKind::Obs
            || (host.starts_with("obs.") && host.ends_with(".myhuaweicloud.com"));
        Ok(Self {
            client,
            scheme: parsed.scheme().to_string(),
            host,
            region,
            bucket: cfg.bucket.trim().to_string(),
            access_key: cfg.access_key_id.trim().to_string(),
            secret_key: cfg.secret_access_key.trim().to_string(),
            prefix: clean_dir(&cfg.prefix),
            path_style: cfg.path_style,
            custom_domain: cfg.custom_domain,
            unsigned_payload,
            headers: request_headers(&cfg.http, SERVICE, &["authorization", "x-amz-date", "x-amz-content-sha256"])?,
        })
    }

    /// 计算请求的主机与规范 URI（key 为空表示存储桶根）
    fn locate(&self, key: &str) -> (String, String) {
        let encoded = encode_path(key);
        if self.custom_domain {
            (self.host.clone(), format!("/{}", encoded))
        } else if self.path_style {
            let uri = if key.is_empty() { format!("/{}", self.bucket) } else { format!("/{}/{}", self.bucket, encoded) };
            (self.host.clone(), uri)
        } else {
            (format!("{}.{}", self.bucket, self.host), format!("/{}", encoded))
        }
    }

    /// 构造带 SigV4 签名的请求；新增 x-amz-* 与内容描述头参与签名，网关头和 UA 保持独立。
    fn signed(&self, method: Method, key: &str, query: &[(String, String)], body: Vec<u8>) -> reqwest::RequestBuilder {
        let (host, uri) = self.locate(key);
        let now = chrono::Utc::now();
        let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
        let date = now.format("%Y%m%d").to_string();
        // 不签名请求体时，规范请求与实际 Header 必须使用同一标记，不能仅替换发送的请求头。
        let payload_hash = if self.unsigned_payload { "UNSIGNED-PAYLOAD".to_string() } else { sha256_hex(&body) };

        let mut sorted: Vec<(String, String)> = query
            .iter()
            .map(|(k, v)| (encode_component(k), encode_component(v)))
            .collect();
        sorted.sort();
        let canonical_query = sorted.iter().map(|(k, v)| format!("{}={}", k, v)).collect::<Vec<_>>().join("&");

        // AWS 要求签入全部 x-amz-*，以及存在的 Content-Type / Content-MD5。
        // 用排序表保证名称小写且顺序稳定；规范值压缩 ASCII 空白，实际发送仍保留原值。
        let mut signing_headers = std::collections::BTreeMap::from([
            ("host".to_string(), host.clone()),
            ("x-amz-content-sha256".to_string(), payload_hash.clone()),
            ("x-amz-date".to_string(), amz_date.clone()),
        ]);
        for (name, value) in &self.headers {
            if name.as_str().starts_with("x-amz-") || matches!(name.as_str(), "content-type" | "content-md5") {
                let normalized = String::from_utf8_lossy(value.as_bytes()).split_ascii_whitespace().collect::<Vec<_>>().join(" ");
                signing_headers.insert(name.as_str().to_string(), normalized);
            }
        }
        let canonical_headers = signing_headers.iter().map(|(name, value)| format!("{}:{}\n", name, value)).collect::<String>();
        let signed_headers = signing_headers.keys().cloned().collect::<Vec<_>>().join(";");
        let canonical_request = format!(
            "{}\n{}\n{}\n{}\n{}\n{}",
            method.as_str(),
            uri,
            canonical_query,
            canonical_headers,
            signed_headers,
            payload_hash
        );
        let scope = format!("{}/{}/s3/aws4_request", date, self.region);
        let string_to_sign = format!("AWS4-HMAC-SHA256\n{}\n{}\n{}", amz_date, scope, sha256_hex(canonical_request.as_bytes()));
        let k_date = hmac_sha256(format!("AWS4{}", self.secret_key).as_bytes(), date.as_bytes());
        let k_region = hmac_sha256(&k_date, self.region.as_bytes());
        let k_service = hmac_sha256(&k_region, b"s3");
        let k_signing = hmac_sha256(&k_service, b"aws4_request");
        let signature = hex::encode(hmac_sha256(&k_signing, string_to_sign.as_bytes()));
        let authorization = format!(
            "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
            self.access_key, scope, signed_headers, signature
        );

        let url = if canonical_query.is_empty() {
            format!("{}://{}{}", self.scheme, host, uri)
        } else {
            format!("{}://{}{}?{}", self.scheme, host, uri, canonical_query)
        };
        let has_body = method == Method::PUT || !body.is_empty();
        let mut rb = self
            .client
            .request(method, url)
            .headers(self.headers.clone())
            .header("x-amz-date", amz_date)
            .header("x-amz-content-sha256", payload_hash)
            .header(header::AUTHORIZATION, authorization);
        // PUT 空文件也必须携带 Content-Length: 0，否则部分服务返回 411
        if has_body {
            rb = rb.header(header::CONTENT_LENGTH, body.len()).body(body);
        }
        rb
    }

    async fn send(&self, rb: reqwest::RequestBuilder) -> SyncResult<reqwest::Response> {
        rb.send().await.map_err(|e| from_reqwest(e, SERVICE))
    }

    /// S3 错误响应带 <Code>，翻译常见错误码
    async fn fail(resp: reqwest::Response) -> SyncError {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        Self::response_error(status, &body)
    }

    /// 错误体只读取一次，列表接口可先判断兼容性，再保留原有认证和配置错误提示。
    fn response_error(status: u16, body: &str) -> SyncError {
        let code = xml::first_text(body, "Code").unwrap_or_default();
        match code.as_str() {
            "NoSuchBucket" => SyncError::new(SyncErrorKind::NotFound, "S3 存储桶不存在，请检查 Bucket 名称与区域"),
            "InvalidAccessKeyId" => SyncError::new(SyncErrorKind::Auth, "S3 Access Key ID 不存在或已停用"),
            "SignatureDoesNotMatch" => SyncError::new(SyncErrorKind::Auth, "S3 签名校验失败：Secret Access Key 不正确，或区域（Region）填写有误"),
            "AccessDenied" => SyncError::new(SyncErrorKind::Forbidden, "S3 拒绝访问：该密钥没有此存储桶的读写权限"),
            "AuthorizationHeaderMalformed" => SyncError::new(SyncErrorKind::Config, "S3 区域（Region）填写不正确"),
            "PublicEndpointForbidden" => SyncError::config("此 OSS 账号的中国内地存储桶需绑定自定义域名，请填写该域名并开启「使用自定义域名」"),
            "RequestTimeTooSkewed" => SyncError::config("设备时间与对象存储服务器偏差过大，请校准系统时间后重试"),
            "PermanentRedirect" | "IllegalLocationConstraintException" => {
                SyncError::new(SyncErrorKind::Config, "S3 存储桶不在当前端点/区域，请改用存储桶所在区域的端点")
            }
            _ => from_status(status, SERVICE, "存储桶或对象不存在", body),
        }
    }

    fn key_of(&self, rel: &str) -> String {
        join_remote(&self.prefix, rel)
    }

    pub async fn read(&mut self, rel: &str) -> SyncResult<Option<Vec<u8>>> {
        let resp = self.send(self.signed(Method::GET, &self.key_of(rel), &[], Vec::new())).await?;
        if resp.status() == StatusCode::NOT_FOUND {
            // NoSuchKey 视为不存在；NoSuchBucket 需要明确报错
            let body = resp.text().await.unwrap_or_default();
            if xml::first_text(&body, "Code").as_deref() == Some("NoSuchBucket") {
                return Err(SyncError::new(SyncErrorKind::NotFound, "S3 存储桶不存在，请检查 Bucket 名称与区域"));
            }
            return Ok(None);
        }
        if !resp.status().is_success() {
            return Err(Self::fail(resp).await);
        }
        Ok(Some(resp.bytes().await.map_err(|e| from_reqwest(e, SERVICE))?.to_vec()))
    }

    pub async fn put(&mut self, rel: &str, data: Vec<u8>) -> SyncResult<()> {
        let resp = self.send(self.signed(Method::PUT, &self.key_of(rel), &[], data)).await?;
        if !resp.status().is_success() {
            return Err(Self::fail(resp).await);
        }
        Ok(())
    }

    pub async fn delete(&mut self, rel: &str) -> SyncResult<()> {
        let resp = self.send(self.signed(Method::DELETE, &self.key_of(rel), &[], Vec::new())).await?;
        if resp.status().is_success() || resp.status() == StatusCode::NOT_FOUND {
            return Ok(());
        }
        Err(Self::fail(resp).await)
    }

    pub async fn list(&mut self, dir: &str) -> SyncResult<Vec<RemoteFile>> {
        let prefix = format!("{}/", self.key_of(dir).trim_end_matches('/'));
        let prefix = if prefix == "/" { String::new() } else { prefix };
        let mut files = Vec::new();
        let mut token: Option<String> = None;
        // 老对象存储可能只支持 V1；只在明确不支持 V2 时回退，不吞掉权限或网络错误。
        let mut use_v2 = true;
        let mut seen_tokens = std::collections::HashSet::new();
        loop {
            let mut query = vec![
                ("prefix".to_string(), prefix.clone()),
                ("delimiter".to_string(), "/".to_string()),
            ];
            if use_v2 {
                query.push(("list-type".to_string(), "2".to_string()));
            }
            if let Some(t) = &token {
                query.push((if use_v2 { "continuation-token" } else { "marker" }.to_string(), t.clone()));
            }
            let resp = self.send(self.signed(Method::GET, "", &query, Vec::new())).await?;
            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.map_err(|e| from_reqwest(e, SERVICE))?;
                let code = xml::first_text(&body, "Code").unwrap_or_default();
                if use_v2 && (status == StatusCode::NOT_IMPLEMENTED
                    || matches!(code.as_str(), "NotImplemented" | "NotSupported" | "UnsupportedOperation")
                    || (code == "InvalidArgument" && body.contains("list-type")))
                {
                    use_v2 = false;
                    files.clear();
                    token = None;
                    seen_tokens.clear();
                    continue;
                }
                return Err(Self::response_error(status.as_u16(), &body));
            }
            let text = resp.text().await.map_err(|e| from_reqwest(e, SERVICE))?;
            if xml::elements(&text, "ListBucketResult").is_empty() {
                return Err(SyncError::server("对象存储未返回有效文件列表，请检查服务端点是否为对象存储数据接口"));
            }
            for item in xml::elements(&text, "Contents") {
                let Some(key) = xml::first_text(&item, "Key") else { continue };
                let name = key.rsplit('/').next().unwrap_or("").to_string();
                if name.is_empty() {
                    continue;
                }
                let size = xml::first_text(&item, "Size").and_then(|s| s.parse().ok()).unwrap_or(0);
                files.push(RemoteFile { name, size });
            }
            let truncated = xml::first_text(&text, "IsTruncated").map(|s| s == "true").unwrap_or(false);
            if !truncated {
                break;
            }
            token = xml::first_text(&text, if use_v2 { "NextContinuationToken" } else { "NextMarker" }).filter(|s| !s.is_empty());
            // 部分旧服务忽略 list-type 并直接返回 V1 响应，从首页按 V1 重取以免丢页。
            if use_v2 && token.is_none() && xml::first_text(&text, "NextMarker").is_some() {
                use_v2 = false;
                files.clear();
                seen_tokens.clear();
                continue;
            }
            if token.as_ref().is_none_or(|next| !seen_tokens.insert(next.clone())) {
                return Err(SyncError::server("对象存储文件列表缺少有效分页标记，已停止操作以避免遗漏备份"));
            }
        }
        Ok(files)
    }
}

/// HMAC-SHA256（RFC 2104），避免为签名额外引入依赖
pub fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; BLOCK];
    let mut opad = [0x5cu8; BLOCK];
    for i in 0..BLOCK {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(data);
    let inner_hash = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner_hash);
    outer.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 地址构造必须区分服务域名、路径风格和已绑定桶的 CNAME，且保留中文路径编码。
    #[test]
    fn addressing_and_obs_payload_follow_provider_rules() {
        let mut cfg = S3Config { endpoint: "https://objects.example.com".into(), region: "region".into(), bucket: "notes".into(), access_key_id: "key".into(), secret_access_key: "secret".into(), ..Default::default() };
        let client = reqwest::Client::new();
        let virtual_host = S3::new(client.clone(), &cfg, ProviderKind::Cos).unwrap();
        assert_eq!(virtual_host.locate("目录/a b.md"), ("notes.objects.example.com".into(), "/%E7%9B%AE%E5%BD%95/a%20b.md".into()));
        cfg.path_style = true;
        assert!(S3::new(client.clone(), &cfg, ProviderKind::Cos).is_err());
        assert_eq!(S3::new(client.clone(), &cfg, ProviderKind::S3).unwrap().locate("a.md").1, "/notes/a.md");
        cfg.path_style = false;
        cfg.custom_domain = true;
        for kind in [ProviderKind::S3, ProviderKind::Oss, ProviderKind::Zos, ProviderKind::Oos, ProviderKind::Obs, ProviderKind::Cos] {
            let backend = S3::new(client.clone(), &cfg, kind).unwrap();
            assert_eq!(backend.locate("a.md"), ("objects.example.com".into(), "/a.md".into()));
            let request = backend.signed(Method::PUT, "a.md", &[], b"notes".to_vec()).build().unwrap();
            assert_eq!(request.headers()["x-amz-content-sha256"], if kind == ProviderKind::Obs { "UNSIGNED-PAYLOAD".into() } else { sha256_hex(b"notes") });
        }
        cfg.path_style = true;
        assert!(S3::new(client, &cfg, ProviderKind::Oss).is_err());
    }

    /// 新厂商入口拒绝会被忽略的 URL 路径或凭证，空地址也不能误连到 AWS 默认端点。
    #[test]
    fn invalid_endpoints_and_missing_vendor_region_are_rejected() {
        let mut cfg = S3Config { region: "region".into(), bucket: "notes".into(), access_key_id: "key".into(), secret_access_key: "secret".into(), ..Default::default() };
        let client = reqwest::Client::new();
        assert!(S3::new(client.clone(), &cfg, ProviderKind::Obs).is_err());
        for endpoint in ["https://objects.example.com/bucket", "https://user:password@objects.example.com", "https://objects.example.com?prefix=notes", "https://objects.example.com#notes"] {
            cfg.endpoint = endpoint.into();
            assert!(S3::new(client.clone(), &cfg, ProviderKind::Oss).is_err());
            cfg.custom_domain = true;
            assert!(S3::new(client.clone(), &cfg, ProviderKind::S3).is_err());
            cfg.custom_domain = false;
        }
    }

    /// 旧 S3 的缺省区域、路径风格及附带 URL 路径仍按原规则解析，升级不要求重新填写。
    #[test]
    fn legacy_s3_endpoints_keep_their_effective_target() {
        let client = reqwest::Client::new();
        for endpoint in ["https://objects.example.com", "https://objects.example.com/notes/?old=1#saved", "objects.example.com/notes/"] {
            // 使用旧版字段反序列化，customDomain 缺省必须为 false。
            let cfg: S3Config = serde_json::from_value(serde_json::json!({
                "endpoint": endpoint, "bucket": "notes", "accessKeyId": "key", "secretAccessKey": "secret", "pathStyle": true, "prefix": "my-notes"
            })).unwrap();
            let backend = S3::new(client.clone(), &cfg, ProviderKind::S3).unwrap();
            assert_eq!(backend.region, "us-east-1");
            assert_eq!(backend.locate(&backend.key_of("a.md")), ("objects.example.com".into(), "/notes/my-notes/a.md".into()));
            assert_eq!(cfg.endpoint, endpoint);
        }
        let cfg = S3Config { bucket: "notes".into(), access_key_id: "key".into(), secret_access_key: "secret".into(), ..Default::default() };
        let backend = S3::new(client, &cfg, ProviderKind::S3).unwrap();
        assert_eq!(backend.locate("a.md"), ("notes.s3.us-east-1.amazonaws.com".into(), "/a.md".into()));
    }

    /// RFC 4231 测试向量 2
    #[test]
    fn hmac_matches_rfc4231() {
        let mac = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(hex::encode(mac), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    }

    /// AWS 文档中的签名密钥派生示例
    #[test]
    fn signing_key_matches_aws_example() {
        let k_date = hmac_sha256(b"AWS4wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", b"20120215");
        let k_region = hmac_sha256(&k_date, b"us-east-1");
        let k_service = hmac_sha256(&k_region, b"iam");
        let k_signing = hmac_sha256(&k_service, b"aws4_request");
        assert_eq!(hex::encode(k_signing), "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d");
    }

    /// 新增头须真实发送，x-amz-* 和内容类型参与签名，网关头不影响源站签名。
    #[test]
    fn custom_headers_are_sent_and_required_headers_are_signed() {
        let cfg: S3Config = serde_json::from_value(serde_json::json!({
            "endpoint": "https://s3.example.com", "bucket": "notes", "region": "us-east-1",
            "accessKeyId": "test-key", "secretAccessKey": "test-secret", "pathStyle": true,
            "headers": [
                { "name": "User-Agent", "value": "Custom/1" },
                { "name": "CF-Access-Client-Secret", "value": "gateway-token" },
                { "name": "X-Amz-Security-Token", "value": "session-token" },
                { "name": "X-Amz-Meta-Label", "value": "  my   notes  " },
                { "name": "Content-Type", "value": "text/plain" }
            ]
        })).unwrap();
        let backend = S3::new(reqwest::Client::new(), &cfg, ProviderKind::S3).unwrap();
        let request = backend.signed(Method::PUT, "note.md", &[], Vec::new()).build().unwrap();
        let headers = request.headers();
        assert_eq!(headers["cf-access-client-secret"], "gateway-token");
        assert_eq!(headers["user-agent"], "Custom/1");
        assert_eq!(headers.get_all("user-agent").iter().count(), 1);
        assert_eq!(headers["content-length"], "0");
        let amz_date = headers["x-amz-date"].to_str().unwrap();
        let date = &amz_date[..8];
        let payload = sha256_hex(b"");
        let names = "content-type;host;x-amz-content-sha256;x-amz-date;x-amz-meta-label;x-amz-security-token";
        // 独立重建服务端验签所需的规范请求，防止仅增加 SignedHeaders 名称却未实际签入值。
        let canonical = format!("PUT\n/notes/note.md\n\ncontent-type:text/plain\nhost:s3.example.com\nx-amz-content-sha256:{}\nx-amz-date:{}\nx-amz-meta-label:my notes\nx-amz-security-token:session-token\n\n{}\n{}", payload, amz_date, names, payload);
        let scope = format!("{}/us-east-1/s3/aws4_request", date);
        let to_sign = format!("AWS4-HMAC-SHA256\n{}\n{}\n{}", amz_date, scope, sha256_hex(canonical.as_bytes()));
        let key = hmac_sha256(b"AWS4test-secret", date.as_bytes());
        let key = hmac_sha256(&key, b"us-east-1");
        let key = hmac_sha256(&key, b"s3");
        let key = hmac_sha256(&key, b"aws4_request");
        let signature = hex::encode(hmac_sha256(&key, to_sign.as_bytes()));
        assert_eq!(headers["authorization"], format!("AWS4-HMAC-SHA256 Credential=test-key/{}, SignedHeaders={}, Signature={}", scope, names, signature));
    }

    /// 所有由程序生成的签名字段均拒绝覆盖，避免保存后才出现难以定位的认证失败。
    #[test]
    fn signing_headers_cannot_be_overridden() {
        for name in ["Authorization", "Host", "X-Amz-Date", "X-Amz-Content-Sha256"] {
            let cfg: S3Config = serde_json::from_value(serde_json::json!({
                "bucket": "notes", "accessKeyId": "test", "secretAccessKey": "test",
                "headers": [{ "name": name, "value": "override" }]
            })).unwrap();
            assert!(S3::new(reqwest::Client::new(), &cfg, ProviderKind::S3).is_err());
        }
    }
}
