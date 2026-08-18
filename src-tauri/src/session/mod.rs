// NoteBoard 会话与草稿 — IPC 接口

use crate::dto::FontFamily;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Emitter;

fn app_data_dir() -> PathBuf {
    let base = std::env::var("APPDATA")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(base).join("NoteBoard")
}

// ── Session ──

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    #[serde(default)]
    pub schema_version: u32,
    #[serde(default)]
    pub saved_at: i64,
    #[serde(default)]
    pub windows: Vec<SessionWindow>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionWindow {
    pub seq: u32,
    #[serde(default)]
    pub explorer_root: String,
    #[serde(default)]
    pub layout: SessionLayout,
    #[serde(default)]
    pub tabs: Vec<SessionTab>,
    #[serde(default)]
    pub active_key: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionLayout {
    pub explorer_visible: bool,
    pub explorer_width: f64,
    pub outline_visible: bool,
    pub outline_width: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionTab {
    pub key: String,
    pub is_pinned: bool,
    pub view_mode: Option<String>,
}

pub mod commands {
    use super::*;

    fn session_path() -> PathBuf {
        app_data_dir().join("session.json")
    }

    fn recent_path() -> PathBuf {
        app_data_dir().join("recent.json")
    }

    fn drafts_dir() -> PathBuf {
        app_data_dir().join("drafts")
    }

    /// 读取会话
    #[tauri::command]
    pub fn load_session() -> Result<Option<Session>, String> {
        let path = session_path();
        if !path.exists() {
            return Ok(None);
        }
        let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let session: Session = serde_json::from_str(&content).unwrap_or_default();
        Ok(Some(session))
    }

    /// 保存会话
    #[tauri::command]
    pub fn save_session(session: Session) -> Result<(), String> {
        let dir = app_data_dir();
        if !dir.exists() {
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(&session).map_err(|e| e.to_string())?;
        crate::fsio::write::atomic_write(&session_path(), json.as_bytes())
            .map_err(|e| e.to_string())
    }

    /// 读取最近打开列表
    #[tauri::command]
    pub fn list_recent() -> Result<RecentList, String> {
        let path = recent_path();
        if !path.exists() {
            return Ok(RecentList::default());
        }
        let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let list: RecentList = serde_json::from_str(&content).unwrap_or_default();
        Ok(list)
    }

    /// 推入最近打开
    #[tauri::command]
    pub fn push_recent(path: String, is_dir: bool) -> Result<(), String> {
        let recent_path = recent_path();
        let dir = app_data_dir();
        if !dir.exists() {
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        }

        let mut list = {
            if recent_path.exists() {
                let content = std::fs::read_to_string(&recent_path).unwrap_or_default();
                serde_json::from_str::<RecentList>(&content).unwrap_or_default()
            } else {
                RecentList::default()
            }
        };

        let entry = RecentEntry {
            path: path.clone(),
            is_dir,
            opened_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64,
        };

        if is_dir {
            list.dirs.retain(|e| e.path != path);
            list.dirs.insert(0, entry);
            list.dirs.truncate(30);
        } else {
            list.files.retain(|e| e.path != path);
            list.files.insert(0, entry);
            list.files.truncate(30);
        }

        let json = serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?;
        crate::fsio::write::atomic_write(&recent_path, json.as_bytes())
            .map_err(|e| e.to_string())
    }

    /// 写入草稿
    #[tauri::command]
    pub fn write_draft(key: String, content: String, kind: String) -> Result<(), String> {
        let dir = drafts_dir();
        if !dir.exists() {
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        }

        let hash = sha256_hex(&key.to_lowercase());
        let path = dir.join(format!("{}.json", hash));

        let draft = Draft {
            schema_version: 1,
            key,
            kind,
            content,
            saved_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64,
            disk_mtime_when_opened: 0,
        };

        let json = serde_json::to_string_pretty(&draft).map_err(|e| e.to_string())?;
        crate::fsio::write::atomic_write(&path, json.as_bytes())
            .map_err(|e| e.to_string())
    }

    /// 删除草稿
    #[tauri::command]
    pub fn delete_draft(key: String) -> Result<(), String> {
        let hash = sha256_hex(&key.to_lowercase());
        let path = drafts_dir().join(format!("{}.json", hash));
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// 列出草稿
    #[tauri::command]
    pub fn list_drafts() -> Result<Vec<DraftEntry>, String> {
        let dir = drafts_dir();
        if !dir.exists() {
            return Ok(Vec::new());
        }

        let mut entries = Vec::new();
        for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let content = std::fs::read_to_string(entry.path()).unwrap_or_default();
            if let Ok(draft) = serde_json::from_str::<Draft>(&content) {
                // 清理超过 7 天的孤儿草稿
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as i64;
                if now - draft.saved_at > 7 * 24 * 3600 * 1000 {
                    let _ = std::fs::remove_file(entry.path());
                    continue;
                }
                entries.push(DraftEntry {
                    key: draft.key,
                    kind: draft.kind,
                    saved_at: draft.saved_at,
                });
            }
        }

        Ok(entries)
    }

    // ── helpers ──

    fn sha256_hex(input: &str) -> String {
        use std::collections::HashMap;
        // 简单 hash，实际应用应使用 sha2 crate
        // 这里用一个简单的 hash 替代
        let mut hash: u64 = 0;
        for byte in input.bytes() {
            hash = hash.wrapping_mul(31).wrapping_add(byte as u64);
        }
        format!("{:016x}", hash)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RecentList {
    #[serde(default)]
    pub schema_version: u32,
    #[serde(default)]
    pub files: Vec<RecentEntry>,
    #[serde(default)]
    pub dirs: Vec<RecentEntry>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    pub path: String,
    pub is_dir: bool,
    pub opened_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub schema_version: u32,
    pub key: String,
    pub kind: String,
    pub content: String,
    pub saved_at: i64,
    pub disk_mtime_when_opened: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DraftEntry {
    pub key: String,
    pub kind: String,
    pub saved_at: i64,
}
