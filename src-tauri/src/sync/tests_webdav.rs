// WebDAV 集成测试：使用回环 HTTP 服务运行真实同步引擎，覆盖首次配对与更新确认。
use super::{backend::{Backend, webdav::WebDav}, config::{SyncSettings, WebDavConfig}, engine, runtime, state};
use std::{collections::{BTreeMap, BTreeSet}, io::{Read, Write}, net::{TcpListener, TcpStream}, sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, Ordering}}, thread, time::Duration};

#[derive(Default)]
struct Store {
    files: BTreeMap<String, Vec<u8>>,
    dirs: BTreeSet<String>,
    forced_get: BTreeMap<String, (u16, Vec<u8>)>,
    forced_listing: Option<Vec<u8>>,
    requests: Vec<(String, String)>,
    /// 记录真实网络请求中的头，用于校验网关凭证覆盖全部 WebDAV 方法。
    headers: Vec<(String, BTreeMap<String, String>)>,
    redirects: BTreeMap<String, String>,
}

struct Dav {
    url: String,
    store: Arc<Mutex<Store>>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Dav {
    /// 只绑定回环地址；所有远端内容均在内存中，不访问真实账号。
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let store = Arc::new(Mutex::new(Store::default()));
        store.lock().unwrap().dirs.insert("notes".into());
        let stop = Arc::new(AtomicBool::new(false));
        let shared = store.clone();
        let stopping = stop.clone();
        let worker = thread::spawn(move || {
            while !stopping.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => Self::serve(stream, &shared),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(2)),
                    Err(error) => panic!("模拟服务失败：{}", error),
                }
            }
        });
        Self { url, store, stop, worker: Some(worker) }
    }

    /// 按坚果云缺失父目录返回 409 的规则响应，并记录实际读取和覆盖行为。
    fn serve(mut stream: TcpStream, shared: &Arc<Mutex<Store>>) {
        // Windows 接收的连接可能继承监听器的非阻塞状态，读请求前显式恢复阻塞。
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
        let method = first.next().unwrap().to_string();
        let path = percent_encoding::percent_decode_str(first.next().unwrap()).decode_utf8_lossy().trim_matches('/').to_string();
        let length: usize = header.lines().filter_map(|line| line.split_once(':')).find(|(key, _)| key.eq_ignore_ascii_case("content-length")).map(|(_, value)| value.trim().parse().unwrap()).unwrap_or(0);
        while request.len() < end + length {
            let count = stream.read(&mut buf).unwrap();
            if count == 0 { break; }
            request.extend_from_slice(&buf[..count]);
        }
        let parent = path.rsplit_once('/').map(|(part, _)| part).unwrap_or("");
        let mut store = shared.lock().unwrap();
        store.requests.push((method.clone(), path.clone()));
        store.headers.push((method.clone(), header.lines().skip(1).filter_map(|line| line.split_once(':'))
            .map(|(key, value)| (key.to_ascii_lowercase(), value.trim().to_string())).collect()));
        // 模拟网关重定向，验证自定义令牌不会被自动发送到其他源。
        if let Some(target) = store.redirects.get(&path) {
            write!(stream, "HTTP/1.1 302 Found\r\nLocation: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", target).unwrap();
            return;
        }
        let (status, body) = match method.as_str() {
            "GET" => {
                if let Some(response) = store.forced_get.get(&path) { response.clone() }
                else if let Some(bytes) = store.files.get(&path) { (200, bytes.clone()) }
                else if !parent.is_empty() && !store.dirs.contains(parent) { (409, b"AncestorsNotFound".to_vec()) }
                else { (404, Vec::new()) }
            },
            "MKCOL" => {
                if store.files.contains_key(&path) { (405, b"ResourceAlreadyExists".to_vec()) }
                else if !parent.is_empty() && !store.dirs.contains(parent) { (409, b"AncestorsNotFound".to_vec()) }
                else if store.dirs.insert(path.clone()) { (201, Vec::new()) }
                else { (405, Vec::new()) }
            },
            "PUT" => {
                if !parent.is_empty() && !store.dirs.contains(parent) { (409, b"AncestorsNotFound".to_vec()) }
                else { store.files.insert(path.clone(), request[end..end + length].to_vec()); (201, Vec::new()) }
            },
            "DELETE" => { store.files.remove(&path); (204, Vec::new()) },
            "PROPFIND" => {
                if let Some(body) = &store.forced_listing { (207, body.clone()) }
                else if !store.dirs.contains(&path) { (404, Vec::new()) }
                else {
                    let prefix = format!("{}/", path);
                    let mut xml = String::from("<d:multistatus xmlns:d=\"DAV:\">");
                    // 模拟常见 WebDAV：响应同时包含当前目录、文件与直接子目录。
                    xml.push_str(&format!("<d:response><d:href>/{}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>", path));
                    for (file, bytes) in &store.files {
                        if file.strip_prefix(&prefix).is_some_and(|name| !name.contains('/')) {
                            xml.push_str(&format!("<d:response><d:href>/{}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>{}</d:getcontentlength><d:getlastmodified>Sun, 25 Oct 2026 00:00:00 GMT</d:getlastmodified></d:prop></d:propstat></d:response>", super::backend::encode_path(file), bytes.len()));
                        }
                    }
                    for dir in &store.dirs {
                        if dir.strip_prefix(&prefix).is_some_and(|name| !name.is_empty() && !name.contains('/')) {
                            xml.push_str(&format!("<d:response><d:href>/{}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>", super::backend::encode_path(dir)));
                        }
                    }
                    xml.push_str("</d:multistatus>");
                    (207, xml.into_bytes())
                }
            },
            _ => (500, b"Unexpected method".to_vec()),
        };
        drop(store);
        write!(stream, "HTTP/1.1 {} Response\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", status, body.len()).unwrap();
        stream.write_all(&body).unwrap();
    }

    fn backend(&self) -> Backend {
        let client = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(10)).build().unwrap();
        Backend::WebDav(WebDav::new(client, &WebDavConfig { url: self.url.clone(), remote_dir: "notes".into(), ..Default::default() }).unwrap())
    }

    fn sync(&self, root: &std::path::Path, id: &str) -> engine::SyncOutcome {
        let mut cfg = SyncSettings { enabled: true, root_dir: root.to_string_lossy().into(), device_name: id.into(), ..Default::default() };
        cfg.provider.webdav.url = self.url.clone();
        cfg.provider.webdav.remote_dir = "notes".into();
        runtime::block_on(engine::run_sync_with(&cfg, id, "review", Ok(self.backend())))
    }
}

impl Drop for Dav {
    /// 每个用例结束时关闭本次启动的服务线程。
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = self.worker.take().unwrap().join();
    }
}

/// 用真实回环请求验证读取、建目录、上传、列表和删除都携带 Service Token，同时保留 Basic 认证。
#[test]
fn custom_headers_reach_every_webdav_method() {
    let dav = Dav::new();
    let cfg: WebDavConfig = serde_json::from_value(serde_json::json!({
        "url": dav.url, "username": "test-user", "password": "test-pass", "remoteDir": "notes",
        "headers": [
            { "name": "User-Agent", "value": "CustomDAV/1" },
            { "name": "CF-Access-Client-Id", "value": "client-id" },
            { "name": "CF-Access-Client-Secret", "value": "client-secret" }
        ]
    })).unwrap();
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let mut backend = WebDav::new(client, &cfg).unwrap();
    runtime::block_on(async {
        backend.put("folder/note.md", b"hello".to_vec()).await.unwrap();
        assert_eq!(backend.read("folder/note.md").await.unwrap().unwrap(), b"hello");
        backend.list("folder").await.unwrap();
        backend.delete("folder/note.md").await.unwrap();
    });
    let store = dav.store.lock().unwrap();
    for method in ["GET", "MKCOL", "PUT", "PROPFIND", "DELETE"] {
        assert!(store.headers.iter().any(|(actual, _)| actual == method));
    }
    for (_, headers) in &store.headers {
        assert_eq!(headers["user-agent"], "CustomDAV/1");
        assert_eq!(headers["cf-access-client-id"], "client-id");
        assert_eq!(headers["cf-access-client-secret"], "client-secret");
        assert!(headers["authorization"].starts_with("Basic "));
    }
}

/// 同源跳转保留凭证，跨端口跳转视为跨源，必须在连接目标前停止。
#[test]
fn custom_headers_only_follow_same_origin_redirects() {
    let dav = Dav::new();
    let target = TcpListener::bind("127.0.0.1:0").unwrap();
    target.set_nonblocking(true).unwrap();
    {
        let mut store = dav.store.lock().unwrap();
        store.files.insert("notes/final.md".into(), b"hello".to_vec());
        store.redirects.insert("notes/same.md".into(), format!("{}notes/final.md", dav.url));
        store.redirects.insert("notes/cross.md".into(), format!("http://{}/", target.local_addr().unwrap()));
    }
    let cfg: super::config::ProviderConfig = serde_json::from_value(serde_json::json!({
        "webdav": { "url": dav.url, "remoteDir": "notes", "headers": [{ "name": "X-Token", "value": "secret" }] }
    })).unwrap();
    let mut backend = Backend::new(&cfg).unwrap();
    runtime::block_on(async {
        assert_eq!(backend.read("same.md").await.unwrap().unwrap(), b"hello");
        assert!(backend.read("cross.md").await.is_err());
    });
    assert_eq!(target.accept().unwrap_err().kind(), std::io::ErrorKind::WouldBlock);
}

/// 全部同步用例共用临时应用数据根目录，防止状态落入真实 NoteBoard 配置。
fn init_data() {
    static DATA: OnceLock<tempfile::TempDir> = OnceLock::new();
    crate::app_dirs::set_data_root(DATA.get_or_init(|| tempfile::tempdir().unwrap()).path().to_path_buf());
    state::swap_for_test(state::LocalState::default());
}

/// 使用弹窗确认过的内容指纹执行，不绕开生产同步引擎。
fn approve(dav: &Dav, root: &std::path::Path, approved: &[String]) -> engine::SyncOutcome {
    let mut cfg = SyncSettings { enabled: true, root_dir: root.to_string_lossy().into(), device_name: "A".into(), ..Default::default() };
    cfg.provider.webdav.url = dav.url.clone();
    cfg.provider.webdav.remote_dir = "notes".into();
    runtime::block_on(engine::run_sync_with_approval(&cfg, "A", "manual", Ok(dav.backend()), approved))
}

#[test]
fn get_only_treats_explicit_missing_ancestors_as_absent() {
    let dav = Dav::new();
    for (code, body, absent) in [(409, "AncestorsNotFound", true), (409, "<d:error><code>AncestorsNotFound</code></d:error>", true), (409, "ResourceConflict", false), (409, "NotAncestorsNotFound", false), (401, "error", false), (403, "error", false), (412, "error", false), (429, "error", false), (500, "error", false)] {
        dav.store.lock().unwrap().forced_get.insert("notes/file.md".into(), (code, body.as_bytes().to_vec()));
        let result = runtime::block_on(dav.backend().read("file.md"));
        if absent { assert!(matches!(result, Ok(None))); } else { assert!(result.is_err(), "HTTP {}：{}", code, body); }
    }
}

#[test]
fn directory_listing_supports_relative_links_and_rejects_successful_html() {
    let dav = Dav::new();
    dav.store.lock().unwrap().forced_listing = Some(b"<d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>file.md</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>3</d:getcontentlength></d:prop></d:propstat></d:response></d:multistatus>".to_vec());
    let Backend::WebDav(mut backend) = dav.backend() else { unreachable!() };
    let files = runtime::block_on(backend.list("")).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].name, "file.md");
    // 网关或登录页即使错误返回成功状态，也不能被解释为空目录。
    dav.store.lock().unwrap().forced_listing = Some(b"<html>Login required</html>".to_vec());
    assert!(runtime::block_on(backend.entries("")).is_err());
}

#[test]
fn first_sync_imports_remote_tree_and_identical_files_without_confirmation() {
    let _guard = state::TEST_STATE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    init_data();
    let dav = Dav::new();
    {
        let mut store = dav.store.lock().unwrap();
        store.dirs.insert("notes/已有 笔记".into());
        store.files.insert("notes/已有 笔记/remote.md".into(), b"remote".to_vec());
        store.files.insert("notes/same.md".into(), b"same".to_vec());
        // 内部历史目录必须交给专用历史协议处理，不能作为笔记导入。
        store.dirs.insert("notes/.nb-history".into());
        store.files.insert("notes/.nb-history/private".into(), b"ignored".to_vec());
    }
    let local = tempfile::tempdir().unwrap();
    std::fs::write(local.path().join("same.md"), "same").unwrap();
    std::fs::write(local.path().join("local.md"), "local").unwrap();
    let out = dav.sync(local.path(), "A");
    assert!(out.report.ok, "{:?}", out.report.errors);
    assert!(out.updates.is_empty());
    assert_eq!(std::fs::read(local.path().join("已有 笔记/remote.md")).unwrap(), b"remote");
    assert!(!local.path().join(".nb-history/private").exists());
    let manifest = super::manifest::Manifest::parse(&dav.store.lock().unwrap().files["notes/.noteboard-sync/manifest.json"]).unwrap();
    assert_eq!(manifest.entries.len(), 3);
    let unchanged = dav.sync(local.path(), "A");
    assert!(unchanged.report.ok);
    assert_eq!(unchanged.report.upload.total() + unchanged.report.download.total(), 0);
    state::swap_for_test(state::LocalState::default());
    let second = tempfile::tempdir().unwrap();
    let out = dav.sync(second.path(), "B");
    assert!(out.report.ok, "{:?}", out.report.errors);
    assert_eq!(std::fs::read(second.path().join("已有 笔记/remote.md")).unwrap(), b"remote");
}

#[test]
fn update_confirmation_binds_content_and_uses_newer_version_in_each_direction() {
    let _guard = state::TEST_STATE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    init_data();
    let dav = Dav::new();
    dav.store.lock().unwrap().files.insert("notes/upload.md".into(), b"remote old".to_vec());
    dav.store.lock().unwrap().files.insert("notes/download.md".into(), b"remote new".to_vec());
    let local = tempfile::tempdir().unwrap();
    std::fs::write(local.path().join("upload.md"), "local new").unwrap();
    std::fs::write(local.path().join("download.md"), "local old").unwrap();
    // 明确设定两端时间，测试不依赖运行当天的系统时钟。
    let remote_time = chrono::DateTime::parse_from_rfc2822("Sun, 25 Oct 2026 00:00:00 GMT").unwrap().timestamp() as u64;
    for (name, seconds) in [("upload.md", remote_time + 60), ("download.md", remote_time - 60)] {
        std::fs::File::options().write(true).open(local.path().join(name)).unwrap().set_modified(std::time::UNIX_EPOCH + Duration::from_secs(seconds)).unwrap();
    }
    let waiting = dav.sync(local.path(), "A");
    assert!(!waiting.report.ok);
    assert_eq!(waiting.updates.len(), 2);
    assert_eq!(waiting.updates[0].direction, "download");
    assert_eq!(waiting.updates[1].direction, "upload");
    assert_eq!(std::fs::read(local.path().join("download.md")).unwrap(), b"local old");
    assert_eq!(dav.store.lock().unwrap().files["notes/upload.md"], b"remote old");
    assert!(!dav.store.lock().unwrap().files.contains_key("notes/.noteboard-sync/manifest.json"));
    let fingerprints: Vec<_> = waiting.updates.iter().map(|file| file.fingerprint.clone()).collect();
    // 同名路径的内容发生变化，即使用户确认过旧列表，也必须再次询问。
    dav.store.lock().unwrap().files.insert("notes/upload.md".into(), b"remote changed".to_vec());
    let stale = approve(&dav, local.path(), &fingerprints);
    assert!(!stale.report.ok);
    assert_eq!(stale.updates.len(), 2);
    let fresh: Vec<_> = stale.updates.iter().map(|file| file.fingerprint.clone()).collect();
    let done = approve(&dav, local.path(), &fresh);
    assert!(done.report.ok, "{:?}", done.report.errors);
    assert_eq!(std::fs::read(local.path().join("download.md")).unwrap(), b"remote new");
    assert_eq!(dav.store.lock().unwrap().files["notes/upload.md"], b"local new");
    // 远端较新时沿用原来的冲突副本保护，不依赖文档历史开关。
    assert!(super::trash::list_items(local.path(), 30, true).iter().any(|item| item.name.contains("本机冲突版本")));
}

#[test]
fn missing_remote_directory_can_test_and_start_sync() {
    let _guard = state::TEST_STATE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    init_data();
    let dav = Dav::new();
    dav.store.lock().unwrap().dirs.clear();
    assert!(runtime::block_on(dav.backend().test()).unwrap().contains("连接成功"));
    let local = tempfile::tempdir().unwrap();
    std::fs::write(local.path().join("note.md"), "local").unwrap();
    let out = dav.sync(local.path(), "A");
    assert!(out.report.ok, "{:?}", out.report.errors);
}

#[test]
fn files_conflicting_with_directories_stop_before_updating_any_content() {
    let _guard = state::TEST_STATE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    for remote_is_dir in [false, true] {
        init_data();
        let dav = Dav::new();
        let local = tempfile::tempdir().unwrap();
        if remote_is_dir {
            dav.store.lock().unwrap().dirs.insert("notes/conflict".into());
            dav.store.lock().unwrap().files.insert("notes/conflict/remote.md".into(), b"remote".to_vec());
            std::fs::write(local.path().join("conflict"), "local").unwrap();
        } else {
            dav.store.lock().unwrap().files.insert("notes/conflict".into(), b"remote".to_vec());
            std::fs::create_dir(local.path().join("conflict")).unwrap();
            std::fs::write(local.path().join("conflict/local.md"), "local").unwrap();
        }
        let out = dav.sync(local.path(), "A");
        assert!(!out.report.ok);
        assert!(out.report.message.contains("文件夹同名"));
        assert!(!dav.store.lock().unwrap().files.contains_key("notes/.noteboard-sync/manifest.json"));
    }
}

#[test]
fn untracked_same_name_files_are_checked_even_after_manifest_was_created() {
    let _guard = state::TEST_STATE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    init_data();
    let dav = Dav::new();
    let local = tempfile::tempdir().unwrap();
    std::fs::write(local.path().join("tracked.md"), "tracked").unwrap();
    assert!(dav.sync(local.path(), "A").report.ok);
    dav.store.lock().unwrap().files.insert("notes/new.md".into(), b"remote".to_vec());
    std::fs::write(local.path().join("new.md"), "local").unwrap();
    let out = dav.sync(local.path(), "A");
    assert_eq!(out.updates.len(), 1);
    assert_eq!(out.updates[0].path, "new.md");
    assert_eq!(dav.store.lock().unwrap().files["notes/new.md"], b"remote");
    let approved: Vec<_> = out.updates.iter().map(|file| file.fingerprint.clone()).collect();
    assert!(approve(&dav, local.path(), &approved).report.ok);
}

#[test]
fn history_switch_keeps_before_sync_and_pulled_versions_and_off_stays_off() {
    use crate::history::{config::{self, HistoryConfig, Mode}, model::{Origin, Reason}, service::Service};
    let data = tempfile::tempdir().unwrap();
    let base = data.path().join("history");
    config::save(&base, &HistoryConfig { mode: Mode::Local, ..Default::default() }).unwrap();
    let service = Arc::new(Service::new(base, None, Box::new(|| Origin { device: "history-test".into(), name: "test".into() })));
    service.spawn_worker();
    let path = data.path().join("note.md");
    std::fs::write(&path, "local before update").unwrap();
    // 与引擎实际落盘前后调用的钩子一致，更新前正文必须在历史队列中独立保留。
    service.before_overwrite(&path);
    std::fs::write(&path, "remote after update").unwrap();
    service.after_pulled(&path, Origin { device: "remote".into(), name: "remote".into() }, false);
    service.flush();
    let list = service.list(&path);
    let before = list.entries.iter().find(|entry| entry.entry.reason == Reason::BeforeSync).expect("应保留更新前版本");
    assert_eq!(service.read(&path, &before.entry.id).unwrap().content, "local before update");
    assert!(list.entries.iter().any(|entry| entry.entry.reason == Reason::SyncPull));
    service.set_mode(Mode::Off).unwrap();
    service.before_overwrite(&path);
    std::fs::write(&path, "off").unwrap();
    service.after_pulled(&path, Origin { device: "remote".into(), name: "remote".into() }, false);
    service.flush();
    assert!(service.list(&path).entries.is_empty());
}

/// 真实账号测试由环境变量显式启用，只操作本次随机测试目录，退出前移除该目录。
#[test]
#[ignore = "需要显式提供 WebDAV 测试连接环境变量"]
fn live_webdav_bootstrap_and_confirmation() {
    let _guard = state::TEST_STATE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    init_data();
    let url = std::env::var("NOTEBOARD_TEST_WEBDAV_URL").expect("缺少测试地址");
    let username = std::env::var("NOTEBOARD_TEST_WEBDAV_USER").expect("缺少测试账号");
    let password = std::env::var("NOTEBOARD_TEST_WEBDAV_PASSWORD").expect("缺少测试密码");
    let remote_dir = format!("NoteBoard-test-{}", uuid::Uuid::new_v4().simple());
    let provider = super::config::ProviderConfig { webdav: WebDavConfig { url, username, password, remote_dir: remote_dir.clone(), ..Default::default() }, ..Default::default() };
    let root = tempfile::tempdir().unwrap();
    let cfg = SyncSettings { enabled: true, root_dir: root.path().to_string_lossy().into(), provider: provider.clone(), ..Default::default() };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        runtime::block_on(async {
            let mut backend = Backend::new(&provider).unwrap();
            assert!(backend.test().await.unwrap().contains("连接成功"));
            backend.put("远端已有/remote.md", b"remote-only".to_vec(), "test").await.unwrap();
            backend.put("same.md", b"remote-original".to_vec(), "test").await.unwrap();
            backend.put("download.md", b"remote-newer".to_vec(), "test").await.unwrap();
            std::fs::write(root.path().join("same.md"), "local-newer").unwrap();
            std::fs::write(root.path().join("download.md"), "local-older").unwrap();
            let now = std::time::SystemTime::now();
            std::fs::File::options().write(true).open(root.path().join("same.md")).unwrap().set_modified(now + Duration::from_secs(60)).unwrap();
            std::fs::File::options().write(true).open(root.path().join("download.md")).unwrap().set_modified(now - Duration::from_secs(86_400)).unwrap();
            let waiting = engine::run_sync_with(&cfg, "live-test", "manual", Backend::new(&provider)).await;
            assert_eq!(waiting.updates.len(), 2, "{:?}", waiting.report.errors);
            assert_eq!(waiting.updates[0].direction, "download");
            assert_eq!(waiting.updates[1].direction, "upload");
            assert_eq!(backend.read("same.md").await.unwrap().unwrap(), b"remote-original");
            let approved: Vec<_> = waiting.updates.iter().map(|file| file.fingerprint.clone()).collect();
            let done = engine::run_sync_with_approval(&cfg, "live-test", "manual", Backend::new(&provider), &approved).await;
            assert!(done.report.ok, "{:?}", done.report.errors);
            assert_eq!(std::fs::read(root.path().join("远端已有/remote.md")).unwrap(), b"remote-only");
            assert_eq!(std::fs::read(root.path().join("download.md")).unwrap(), b"remote-newer");
            assert_eq!(backend.read("same.md").await.unwrap().unwrap(), b"local-newer");
            let unchanged = engine::run_sync_with(&cfg, "live-test", "manual", Backend::new(&provider)).await;
            assert!(unchanged.report.ok, "{:?}", unchanged.report.errors);
            assert_eq!(unchanged.report.upload.total() + unchanged.report.download.total(), 0);
        });
    }));
    // 仅删除本次随机目录：认证信息不写入源码、应用配置或测试输出。
    let mut cleanup = provider.clone();
    cleanup.webdav.remote_dir.clear();
    let removed = runtime::block_on(async { Backend::new(&cleanup)?.delete(&remote_dir, "test cleanup").await });
    assert!(removed.is_ok(), "独立测试目录清理失败");
    assert!(result.is_ok(), "真实 WebDAV 场景验证失败，独立目录已清理");
}
