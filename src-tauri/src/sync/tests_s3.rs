// 对象存储回环集成测试：真实 HTTP 经过厂商路由、S3 签名、同步引擎与 ZIP 备份恢复。
use super::{backend::Backend, backup, config::{BackupTarget, ProviderConfig, ProviderKind, S3Config, SyncConfigFile}, engine, runtime, state};
use std::{collections::BTreeMap, io::{Read, Write}, net::{TcpListener, TcpStream}, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, thread, time::Duration};

#[derive(Default)]
struct Store {
    objects: BTreeMap<String, Vec<u8>>,
    requests: Vec<(String, BTreeMap<String, String>, Vec<u8>)>,
    /// 模拟旧版列表、无列表权限或损坏分页；错误不得被当作空备份列表。
    listing: &'static str,
}

struct ObjectServer {
    endpoint: String,
    store: Arc<Mutex<Store>>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl ObjectServer {
    /// 仅监听回环地址，数据放在内存，不使用任何真实账号或对象存储资源。
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let store = Arc::new(Mutex::new(Store::default()));
        let stop = Arc::new(AtomicBool::new(false));
        let shared = store.clone();
        let stopping = stop.clone();
        let worker = thread::spawn(move || {
            while !stopping.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => Self::serve(stream, &shared),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(2)),
                    Err(error) => panic!("对象存储模拟服务失败：{}", error),
                }
            }
        });
        Self { endpoint, store, stop, worker: Some(worker) }
    }

    /// 解析实际请求并按对象接口响应；固定每页两项，强制覆盖列表翻页而非只测第一页。
    fn serve(mut stream: TcpStream, shared: &Arc<Mutex<Store>>) {
        stream.set_nonblocking(false).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut request = Vec::new();
        let mut buf = [0u8; 4096];
        let end = loop {
            let count = stream.read(&mut buf).unwrap();
            if count == 0 { return; }
            request.extend_from_slice(&buf[..count]);
            if let Some(pos) = request.windows(4).position(|part| part == b"\r\n\r\n") { break pos + 4; }
        };
        let header = String::from_utf8_lossy(&request[..end]).to_string();
        let mut first = header.lines().next().unwrap().split_whitespace();
        let method = first.next().unwrap();
        let url = url::Url::parse(&format!("http://loopback{}", first.next().unwrap())).unwrap();
        let headers: BTreeMap<String, String> = header.lines().skip(1).filter_map(|line| line.split_once(':'))
            .map(|(key, value)| (key.to_ascii_lowercase(), value.trim().to_string())).collect();
        let length = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0usize);
        while request.len() < end + length {
            let count = stream.read(&mut buf).unwrap();
            if count == 0 { break; }
            request.extend_from_slice(&buf[..count]);
        }
        let body = request[end..end + length].to_vec();
        let key = percent_encoding::percent_decode_str(url.path().trim_start_matches('/')).decode_utf8().unwrap().to_string();
        let query: BTreeMap<String, String> = url.query_pairs().into_owned().collect();
        let mut store = shared.lock().unwrap();
        store.requests.push((method.into(), headers, body.clone()));
        let (status, response) = if method == "GET" && query.contains_key("prefix") {
            match store.listing {
                "forbidden" => (403, b"<Error><Code>AccessDenied</Code></Error>".to_vec()),
                "invalid" => (200, b"<html>wrong endpoint</html>".to_vec()),
                "v1" if query.contains_key("list-type") => (501, b"<Error><Code>NotImplemented</Code></Error>".to_vec()),
                _ => {
                    let prefix = &query["prefix"];
                    let marker = query.get("continuation-token").or_else(|| query.get("marker")).map(String::as_str).unwrap_or("");
                    let rows: Vec<_> = store.objects.iter().filter(|(name, _)| name.starts_with(prefix) && !name[prefix.len()..].contains('/') && name.as_str() > marker).collect();
                    let mut xml = String::from("<ListBucketResult>");
                    for (name, data) in rows.iter().take(2) {
                        let escaped = name.replace('&', "&amp;").replace('<', "&lt;");
                        xml.push_str(&format!("<Contents><Key>{}</Key><Size>{}</Size></Contents>", escaped, data.len()));
                    }
                    let truncated = rows.len() > 2;
                    xml.push_str(&format!("<IsTruncated>{}</IsTruncated>", truncated));
                    if truncated && store.listing != "missing-token" {
                        let tag = if query.contains_key("list-type") { "NextContinuationToken" } else { "NextMarker" };
                        let marker = rows[1].0.replace('&', "&amp;").replace('<', "&lt;");
                        xml.push_str(&format!("<{0}>{1}</{0}>", tag, marker));
                    }
                    xml.push_str("</ListBucketResult>");
                    (200, xml.into_bytes())
                }
            }
        } else {
            match method {
                "PUT" => { store.objects.insert(key, body); (200, Vec::new()) },
                "GET" => store.objects.get(&key).map(|data| (200, data.clone())).unwrap_or((404, b"<Error><Code>NoSuchKey</Code></Error>".to_vec())),
                "DELETE" => { store.objects.remove(&key); (204, Vec::new()) },
                _ => (400, Vec::new()),
            }
        };
        drop(store);
        write!(stream, "HTTP/1.1 {} Response\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", status, response.len()).unwrap();
        stream.write_all(&response).unwrap();
    }

    /// CNAME 模式将回环服务直接视为已绑定桶域名，覆盖真实地址拼接并避免外部 DNS。
    fn provider(&self, kind: ProviderKind) -> ProviderConfig {
        // 使用序列化入口构造，额外验证 IPC 的小写厂商类型与字段名能够被实际后端读取。
        let name = serde_json::to_value(kind).unwrap().as_str().unwrap().to_string();
        let storage = S3Config { endpoint: self.endpoint.clone(), region: "test-region".into(), bucket: "notes".into(), access_key_id: format!("{}-key", name), secret_access_key: "test-secret".into(), prefix: "资料 & notes".into(), custom_domain: true, ..Default::default() };
        let mut json = serde_json::json!({ "kind": name });
        json[&name] = serde_json::to_value(storage).unwrap();
        serde_json::from_value(json).unwrap()
    }
}

impl Drop for ObjectServer {
    /// 用例结束即回收本次创建的监听线程，不残留后台服务。
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.worker.take().unwrap().join().unwrap();
    }
}

/// 六个入口均真实收发 HTTP，验证独立凭证、中文对象、空对象、连接探测和分页列举。
#[test]
fn all_storage_providers_round_trip_over_http() {
    for kind in [ProviderKind::S3, ProviderKind::Oss, ProviderKind::Zos, ProviderKind::Oos, ProviderKind::Obs, ProviderKind::Cos] {
        let server = ObjectServer::new();
        let provider = server.provider(kind);
        runtime::block_on(async {
            let mut backend = Backend::new(&provider).unwrap();
            backend.test().await.unwrap();
            for (name, data) in [("中文 空格.md", "笔记".as_bytes()), ("b.bin", &[0u8, 255][..]), ("c.md", &[][..])] {
                backend.put(name, data.to_vec(), "test").await.unwrap();
                assert_eq!(backend.read(name).await.unwrap().unwrap(), data);
            }
            let files = backend.list("").await.unwrap();
            assert_eq!(files.len(), 3);
            assert!(files.iter().any(|file| file.name == "中文 空格.md"));
            backend.delete("中文 空格.md", "test").await.unwrap();
            assert!(backend.read("中文 空格.md").await.unwrap().is_none());
        });
        let store = server.store.lock().unwrap();
        assert!(!store.objects.keys().any(|key| key.contains("probe-")));
        for (_, headers, body) in &store.requests {
            assert!(headers["authorization"].contains(&format!("Credential={}/", provider.object_storage().unwrap().access_key_id)));
            let expected = if kind == ProviderKind::Obs { "UNSIGNED-PAYLOAD".into() } else { super::util::sha256_hex(body) };
            assert_eq!(headers["x-amz-content-sha256"], expected);
        }
    }
}

/// 旧服务可退回 V1；权限错误、无效响应和缺分页标记必须明确失败，探测对象仍需清理。
#[test]
fn listing_compatibility_and_connection_failures_are_explicit() {
    let server = ObjectServer::new();
    let provider = server.provider(ProviderKind::Oos);
    runtime::block_on(async {
        let mut backend = Backend::new(&provider).unwrap();
        for name in ["a.md", "b.md", "c.md"] { backend.put(name, vec![1], "test").await.unwrap(); }
        server.store.lock().unwrap().listing = "v1";
        assert_eq!(backend.list("").await.unwrap().len(), 3);
        for mode in ["forbidden", "invalid", "missing-token"] {
            server.store.lock().unwrap().listing = mode;
            assert!(backend.list("").await.is_err(), "{} 应失败", mode);
        }
        server.store.lock().unwrap().listing = "forbidden";
        assert!(backend.test().await.is_err());
        assert!(!server.store.lock().unwrap().objects.keys().any(|key| key.contains("probe-")));
    });
}

/// 通过真实同步引擎跨目录下载，并实际创建、列举、下载恢复及删除远端 ZIP 备份。
#[test]
fn vendor_sync_and_backup_restore_use_the_selected_storage() {
    let _guard = state::TEST_STATE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let data = tempfile::tempdir().unwrap();
    crate::app_dirs::set_data_root(data.path().to_path_buf());
    for kind in [ProviderKind::Oss, ProviderKind::Zos, ProviderKind::Oos, ProviderKind::Obs, ProviderKind::Cos] {
        let server = ObjectServer::new();
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("笔记.md"), "真实同步与备份").unwrap();
        let mut cfg = SyncConfigFile::default();
        cfg.device_id = "12345678-device".into();
        cfg.sync.root_dir = root.path().to_string_lossy().into();
        cfg.sync.provider = server.provider(kind);
        cfg.backup.target = BackupTarget::Remote;
        cfg.backup.provider = server.provider(kind);
        state::swap_for_test(Default::default());
        runtime::block_on(async {
            let uploaded = engine::run_sync(&cfg.sync, "device-a", "test").await;
            assert!(uploaded.report.ok, "{:?}", uploaded.report.errors);
            state::swap_for_test(Default::default());
            let mut other_cfg = cfg.sync.clone();
            other_cfg.root_dir = other.path().to_string_lossy().into();
            let downloaded = engine::run_sync(&other_cfg, "device-b", "test").await;
            assert!(downloaded.report.ok, "{:?}", downloaded.report.errors);
            assert_eq!(std::fs::read_to_string(other.path().join("笔记.md")).unwrap(), "真实同步与备份");
            let report = backup::run_backup(&cfg, "test").await;
            assert!(report.ok, "{}", report.message);
            assert_eq!(backup::list_backups(&cfg).await.unwrap().len(), 1);
            let restored = tempfile::tempdir().unwrap();
            // 恢复接口在所选目录下创建备份名子目录，以返回路径核对解压结果。
            let restored_dir = backup::restore_to_dir(&cfg, &report.name, restored.path()).await.unwrap();
            assert_eq!(std::fs::read_to_string(std::path::Path::new(&restored_dir).join("笔记.md")).unwrap(), "真实同步与备份");
            backup::delete_backup(&cfg, &report.name).await.unwrap();
            assert!(backup::list_backups(&cfg).await.unwrap().is_empty());
        });
    }
    state::swap_for_test(Default::default());
}
