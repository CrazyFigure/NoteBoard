// S3 兼容对象存储后端（AWS S3、阿里云 OSS、腾讯云 COS、Cloudflare R2、MinIO 等）
// 使用 AWS Signature V4 签名；对象键 = 前缀 + 与本地一致的相对路径。

use super::{clean_dir, encode_component, encode_path, join_remote, request_headers, xml, RemoteFile};
use crate::sync::config::S3Config;
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
    /// 网关认证等自定义头；程序生成的签名字段不能被覆盖。
    headers: header::HeaderMap,
}

impl S3 {
    /// 校验存储桶、密钥与请求头，预先拒绝会覆盖 SigV4 或 HTTP 传输字段的配置。
    pub fn new(client: reqwest::Client, cfg: &S3Config) -> SyncResult<Self> {
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
            headers: request_headers(&cfg.http, SERVICE, &["authorization", "x-amz-date", "x-amz-content-sha256"])?,
        })
    }

    /// 计算请求的主机与规范 URI（key 为空表示存储桶根）
    fn locate(&self, key: &str) -> (String, String) {
        let encoded = encode_path(key);
        if self.path_style {
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
        let payload_hash = sha256_hex(&body);

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
        let code = xml::first_text(&body, "Code").unwrap_or_default();
        match code.as_str() {
            "NoSuchBucket" => SyncError::new(SyncErrorKind::NotFound, "S3 存储桶不存在，请检查 Bucket 名称与区域"),
            "InvalidAccessKeyId" => SyncError::new(SyncErrorKind::Auth, "S3 Access Key ID 不存在或已停用"),
            "SignatureDoesNotMatch" => SyncError::new(SyncErrorKind::Auth, "S3 签名校验失败：Secret Access Key 不正确，或区域（Region）填写有误"),
            "AccessDenied" => SyncError::new(SyncErrorKind::Forbidden, "S3 拒绝访问：该密钥没有此存储桶的读写权限"),
            "AuthorizationHeaderMalformed" => SyncError::new(SyncErrorKind::Config, "S3 区域（Region）填写不正确"),
            "PermanentRedirect" | "IllegalLocationConstraintException" => {
                SyncError::new(SyncErrorKind::Config, "S3 存储桶不在当前端点/区域，请改用存储桶所在区域的端点")
            }
            _ => from_status(status, SERVICE, "存储桶或对象不存在", &body),
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
        loop {
            let mut query = vec![
                ("list-type".to_string(), "2".to_string()),
                ("prefix".to_string(), prefix.clone()),
                ("delimiter".to_string(), "/".to_string()),
            ];
            if let Some(t) = &token {
                query.push(("continuation-token".to_string(), t.clone()));
            }
            let resp = self.send(self.signed(Method::GET, "", &query, Vec::new())).await?;
            if !resp.status().is_success() {
                return Err(Self::fail(resp).await);
            }
            let text = resp.text().await.map_err(|e| from_reqwest(e, SERVICE))?;
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
            token = xml::first_text(&text, "NextContinuationToken");
            if !truncated || token.is_none() {
                break;
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
        let backend = S3::new(reqwest::Client::new(), &cfg).unwrap();
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
            assert!(S3::new(reqwest::Client::new(), &cfg).is_err());
        }
    }
}
