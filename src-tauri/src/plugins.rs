//! 官方插件服务：固定 GitHub 来源、版本协议、摘要校验与原子激活。
use std::{fs, io::Write, path::{Path, PathBuf}, sync::OnceLock, time::{Duration, Instant}};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use sha2::{Digest, Sha256};

const IDS: &[&str] = &["word", "excel", "powerpoint", "pdf", "cad", "workbench"];
const BASE: &str = "https://github.com/CrazyFigure/NoteBoard/releases/download/plugins/";
const MAX_BYTES: usize = 32 * 1024 * 1024;
static OPERATIONS: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
const PROGRESS_EVENT: &str = "nb://plugin-download-progress";
const PROGRESS_THROTTLE: Duration = Duration::from_millis(100);

/// 插件版本只接受三段非负整数，所有版本路径均由校验后的数字构成。
fn version(value: &str) -> Result<[u32; 3], String> {
    let parts: Vec<_> = value.split('.').collect();
    if parts.len() != 3 { return Err("插件版本号无效".into()); }
    let mut result = [0; 3];
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() || part.len() > 5 || !part.bytes().all(|c| c.is_ascii_digit()) { return Err("插件版本号无效".into()); }
        result[i] = part.parse().map_err(|_| "插件版本号无效")?;
    }
    Ok(result)
}

/// 校验官方标识、宿主协议和代码摘要；插件包是单个 JSON，不解压外部路径。
fn validate(pkg: &Value, id: &str) -> Result<(), String> {
    let m = &pkg["manifest"];
    if !IDS.contains(&id) || m["id"].as_str() != Some(id) || m["apiVersion"].as_u64() != Some(1) { return Err("插件协议或标识无效".into()); }
    version(m["version"].as_str().unwrap_or(""))?;
    if version(m["minAppVersion"].as_str().unwrap_or(""))? > version(env!("CARGO_PKG_VERSION"))? { return Err("请先升级 NoteBoard 再安装此插件".into()); }
    let code = pkg["code"].as_str().ok_or("插件正文缺失")?;
    if code.is_empty() || code.len() > MAX_BYTES || m["codeSha256"].as_str() != Some(format!("{:x}", Sha256::digest(code.as_bytes())).as_str()) { return Err("插件完整性校验失败".into()); }
    Ok(())
}

/// 每次下载均限制响应总量，错误和中断不改变已安装版本；进度回调按固定间隔节流。
async fn download(url: &str, limit: usize, mut progress: impl FnMut(u64, Option<u64>)) -> Result<Vec<u8>, String> {
    if !url.starts_with(BASE) || url[BASE.len()..].contains('/') { return Err("插件下载来源无效".into()); }
    let client = crate::updater::commands::build_update_http_client(Duration::from_secs(180))?;
    let mut response = client.get(url).send().await.map_err(|e| format!("插件下载失败：{e}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND { return Err("官方插件尚未发布，请稍后检查更新".into()); }
    if !response.status().is_success() || response.content_length().unwrap_or(0) > limit as u64 { return Err("插件下载失败或文件过大".into()); }
    let total = response.content_length();
    let mut bytes = Vec::new();
    let mut last = Instant::now();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > limit { return Err("插件文件超过大小上限".into()); }
        bytes.extend_from_slice(&chunk);
        if last.elapsed() >= PROGRESS_THROTTLE { progress(bytes.len() as u64, total); last = Instant::now(); }
    }
    progress(bytes.len() as u64, total.or(Some(bytes.len() as u64)));
    Ok(bytes)
}

/// 临时文件与目标位于同一目录，完整写入并同步后再切换指针。
fn atomic(root: &Path, target: &Path, value: &Value) -> Result<(), String> {
    let mut temp = tempfile::NamedTempFile::new_in(root).map_err(|e| e.to_string())?;
    temp.write_all(&serde_json::to_vec(value).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(target).map_err(|e| e.to_string())?;
    Ok(())
}

/// 仅从应用插件目录读取明确版本；目录不存在表示尚未安装。
fn read_package(root: &Path, id: &str, v: &str) -> Result<Value, String> {
    version(v)?;
    let path = root.join(format!("{id}-{v}.nbplugin"));
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > MAX_BYTES as u64 { return Err("插件文件过大".into()); }
    let value: Value = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    validate(&value, id)?;
    Ok(value)
}

/// 磁盘操作统一在工作线程执行；变更由外层互斥锁串行化，跨窗口不会丢失状态。
fn apply(operation: &str, id: &str, enabled: bool, package: Option<Value>) -> Result<Value, String> {
    // 与字体包使用同一平台资源根目录，覆盖升级不会重复占用配置目录。
    let root: PathBuf = crate::font_pack::font_packs_root_dir().parent().ok_or("资源目录无效")?.join("plugins");
    apply_at(&root, operation, id, enabled, package)
}

/// 列表仅核对轻量安装元数据，完整代码校验留在加载路径；根路径可注入以验证真实磁盘行为。
fn apply_at(root: &Path, operation: &str, id: &str, enabled: bool, package: Option<Value>) -> Result<Value, String> {
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let state_path = root.join("state.json");
    let mut state: Value = match fs::read(&state_path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("插件状态损坏：{e}"))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(e.to_string()),
    };
    if !state.is_object() { return Err("插件状态格式无效".into()); }
    if operation == "list" {
        let mut items = Vec::new();
        for id in IDS {
            if let Some(v) = state[id]["version"].as_str() {
                let path = root.join(format!("{id}-{v}.nbplugin"));
                // 先验证版本，不能让损坏的状态文件把列表探测变成任意路径读取。
                version(v)?;
                if state[id]["manifest"].is_object() {
                    let valid = fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() == state[id]["size"].as_u64().unwrap_or(0));
                    items.push(json!({"manifest":state[id]["manifest"],"enabled":valid && state[id]["enabled"] == true,"invalid":!valid,"error":if valid { "" } else { "插件文件缺失或大小已改变" }}));
                    continue;
                }
                match read_package(&root, id, v) {
                    Ok(pkg) => items.push(json!({"manifest":pkg["manifest"],"enabled":state[id]["enabled"]})),
                    Err(error) => items.push(json!({"manifest":{"id":id,"version":v,"licenses":"","changelog":""},"enabled":false,"invalid":true,"error":error})),
                }
            }
        }
        return Ok(json!(items));
    }
    if !IDS.contains(&id) { return Err("未知官方插件".into()); }
    match operation {
        "load" => {
            if state[id]["enabled"] != true { return Err("请先安装并启用插件".into()); }
            return read_package(&root, id, state[id]["version"].as_str().unwrap_or(""));
        }
        "install" => {
            let pkg = package.ok_or("插件下载内容缺失")?;
            validate(&pkg, id)?;
            let v = pkg["manifest"]["version"].as_str().unwrap();
            if let Some(prior) = state[id]["version"].as_str() { if version(v)? < version(prior)? { return Ok(Value::Null); } }
            atomic(&root, &root.join(format!("{id}-{v}.nbplugin")), &pkg)?;
            // 新安装必须由用户勾选启用；更新保留明确设置过的开关。
            let was_enabled = state[id]["enabled"] == true;
            let size = fs::metadata(root.join(format!("{id}-{v}.nbplugin"))).map_err(|e| e.to_string())?.len();
            state[id] = json!({"version":v,"enabled":was_enabled,"manifest":pkg["manifest"],"size":size});
        }
        "toggle" => {
            if state[id].is_null() { return Err("插件尚未安装".into()); }
            state[id]["enabled"] = json!(enabled);
        }
        "remove" => {
            state.as_object_mut().ok_or("插件状态格式无效")?.remove(id);
            atomic(&root, &state_path, &state)?;
            for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if let Some(v) = name.strip_prefix(&format!("{id}-")).and_then(|s| s.strip_suffix(".nbplugin")) {
                    if version(v).is_ok() { fs::remove_file(entry.path()).map_err(|e| e.to_string())?; }
                }
            }
            return Ok(Value::Null);
        }
        _ => return Err("未知插件操作".into()),
    }
    atomic(&root, &state_path, &state)?;
    if operation == "install" {
        // 新包和状态均落盘后才删旧包，下载或校验失败绝不影响现有版本。
        let active = state[id]["version"].as_str().unwrap_or("");
        for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(v) = name.strip_prefix(&format!("{id}-")).and_then(|s| s.strip_suffix(".nbplugin")) {
                if version(v).is_ok() && v != active { fs::remove_file(entry.path()).map_err(|e| e.to_string())?; }
            }
        }
    }
    Ok(Value::Null)
}

/// 主程序只开放固定官方操作，网络与文件任务均不阻塞界面线程。
#[tauri::command]
pub async fn plugin_command(app: AppHandle, operation: String, id: Option<String>, enabled: Option<bool>) -> Result<Value, String> {
    let _guard = OPERATIONS.get_or_init(|| tokio::sync::Mutex::new(())).lock().await;
    let id = id.unwrap_or_default();
    let mut package = None;
    if operation == "catalog" || operation == "install" {
        let catalog: Value = serde_json::from_slice(&download(&format!("{BASE}catalog.json"), 1024 * 1024, |_, _| {}).await?).map_err(|e| e.to_string())?;
        if catalog["schemaVersion"] != 1 || catalog["plugins"].as_array().map_or(true, |p| p.len() > IDS.len()) { return Err("插件目录格式无效".into()); }
        if operation == "catalog" { return Ok(catalog); }
        let entry = catalog["plugins"].as_array().unwrap().iter().find(|p| p["id"].as_str() == Some(&id)).ok_or("插件暂不可下载")?;
        // 只广播插件包下载进度；目录体积很小，不单独显示。
        let bytes = download(entry["url"].as_str().ok_or("插件地址缺失")?, MAX_BYTES, |downloaded, total| {
            let _ = app.emit(PROGRESS_EVENT, json!({"id":id,"downloaded":downloaded,"total":total}));
        }).await?;
        if entry["sha256"].as_str() != Some(format!("{:x}", Sha256::digest(&bytes)).as_str()) { return Err("插件下载校验失败".into()); }
        let parsed: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if parsed["manifest"]["version"] != entry["version"] { return Err("插件版本与目录不一致".into()); }
        package = Some(parsed);
    }
    tauri::async_runtime::spawn_blocking(move || apply(&operation, &id, enabled.unwrap_or(false), package)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn versions_are_numeric_and_paths_are_rejected() {
        assert!(version("1.10.0").unwrap() > version("1.9.0").unwrap());
        for bad in ["../1.0.0", "1/2/3", "1.2", "1.2.3-beta", "1.2.3.4", "+1.2.3"] { assert!(version(bad).is_err()); }
    }
    #[test]
    fn code_and_host_contract_are_verified() {
        let mut p = json!({"manifest":{"id":"pdf","version":"1.0.0","minAppVersion":"0.5.8","apiVersion":1,"codeSha256":format!("{:x}", Sha256::digest(b"code"))},"code":"code"});
        assert!(validate(&p, "pdf").is_ok());
        p["code"] = json!("changed"); assert!(validate(&p, "pdf").is_err());
        p["code"] = json!("code"); p["manifest"]["minAppVersion"] = json!("99.0.0"); assert!(validate(&p, "pdf").is_err());
    }
    #[test]
    fn fresh_install_is_disabled_and_update_removes_previous_package() {
        let dir = tempfile::tempdir().unwrap();
        let package = |v: &str| json!({"manifest":{"id":"pdf","version":v,"minAppVersion":"0.5.8","apiVersion":1,"codeSha256":format!("{:x}", Sha256::digest(b"code"))},"code":"code"});
        apply_at(dir.path(), "install", "pdf", false, Some(package("1.0.0"))).unwrap();
        assert_eq!(apply_at(dir.path(), "list", "", false, None).unwrap()[0]["enabled"], false);
        assert!(apply_at(dir.path(), "load", "pdf", false, None).is_err());
        apply_at(dir.path(), "toggle", "pdf", true, None).unwrap();
        apply_at(dir.path(), "install", "pdf", false, Some(package("1.1.0"))).unwrap();
        assert!(!dir.path().join("pdf-1.0.0.nbplugin").exists());
        assert_eq!(apply_at(dir.path(), "load", "pdf", false, None).unwrap()["manifest"]["version"], "1.1.0");
        assert_eq!(apply_at(dir.path(), "list", "", false, None).unwrap()[0]["enabled"], true);
    }
}
