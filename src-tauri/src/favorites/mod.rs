// NoteBoard 收藏夹 — IPC 与持久化
// 存储在 %APPDATA%\NoteBoard\favorites.json
// 常规安装/卸载与升级均保留该文件，仅在用户选择清理应用数据时删除

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

fn app_data_dir() -> PathBuf {
    let base = std::env::var("APPDATA")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(base).join("NoteBoard")
}

fn favorites_path() -> PathBuf {
    app_data_dir().join("favorites.json")
}

fn default_schema_version() -> u32 {
    1
}

fn default_roots() -> Vec<FavoriteNode> {
    Vec::new()
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum FavoriteNode {
    #[serde(rename = "folder")]
    Folder {
        id: String,
        name: String,
        #[serde(default)]
        created_at: i64,
        #[serde(default)]
        children: Vec<FavoriteNode>,
    },
    #[serde(rename = "file")]
    File {
        id: String,
        name: String,
        path: String,
        #[serde(default)]
        created_at: i64,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FavoritesData {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    #[serde(default = "default_roots")]
    pub roots: Vec<FavoriteNode>,
}

impl Default for FavoritesData {
    fn default() -> Self {
        Self {
            schema_version: 1,
            roots: default_roots(),
        }
    }
}

pub mod commands {
    use super::*;

    // 收藏夹写入锁，确保多窗口串行安全落盘
    static FAVORITES_WRITE_LOCK: Mutex<()> = Mutex::new(());

    /// 加载收藏夹数据；若文件不存在则返回空的初始结构
    #[tauri::command]
    pub fn load_favorites() -> Result<FavoritesData, String> {
        let path = favorites_path();
        if !path.exists() {
            return Ok(FavoritesData::default());
        }

        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => return Err(format!("读取收藏夹文件失败: {}", e)),
        };

        let data: FavoritesData = serde_json::from_str(&content).unwrap_or_else(|_| {
            eprintln!("[favorites] 收藏夹 JSON 解析失败，回退到默认结构");
            FavoritesData::default()
        });

        Ok(data)
    }

    /// 保存收藏夹数据，使用原子写入
    #[tauri::command]
    pub fn save_favorites(favorites: FavoritesData) -> Result<(), String> {
        let _write_guard = FAVORITES_WRITE_LOCK
            .lock()
            .map_err(|_| "收藏夹写入锁损坏，请重试".to_string())?;

        let dir = app_data_dir();
        if !dir.exists() {
            std::fs::create_dir_all(&dir).map_err(|e| format!("创建应用数据目录失败: {}", e))?;
        }

        let json = serde_json::to_string_pretty(&favorites)
            .map_err(|e| format!("序列化收藏夹数据失败: {}", e))?;

        crate::fsio::write::atomic_write(&favorites_path(), json.as_bytes())
            .map_err(|e| format!("保存收藏夹失败: {:?}", e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_favorites_structure() {
        let data = FavoritesData::default();
        assert_eq!(data.schema_version, 1);
        assert_eq!(data.roots.len(), 0);
    }

    #[test]
    fn test_favorites_serialization_roundtrip() {
        let mut data = FavoritesData::default();
        data.roots.push(FavoriteNode::Folder {
            id: "folder_1".to_string(),
            name: "工作笔记".to_string(),
            created_at: 1725000000000,
            children: vec![
                FavoriteNode::File {
                    id: "fav_1".to_string(),
                    name: "项目笔记.md".to_string(),
                    path: "C:\\notes\\project.md".to_string(),
                    created_at: 1725000000000,
                },
                FavoriteNode::Folder {
                    id: "folder_sub".to_string(),
                    name: "子文件夹".to_string(),
                    created_at: 1725000000000,
                    children: Vec::new(),
                },
            ],
        });
        data.roots.push(FavoriteNode::File {
            id: "fav_root".to_string(),
            name: "根目录文件.txt".to_string(),
            path: "C:\\notes\\root.txt".to_string(),
            created_at: 1725000000000,
        });

        let json = serde_json::to_string(&data).expect("序列化应成功");
        let deserialized: FavoritesData = serde_json::from_str(&json).expect("反序列化应成功");

        assert_eq!(deserialized.roots.len(), 2);
        match &deserialized.roots[0] {
            FavoriteNode::Folder { id, name, children, .. } => {
                assert_eq!(id, "folder_1");
                assert_eq!(name, "工作笔记");
                assert_eq!(children.len(), 2);
            }
            _ => panic!("根节点 0 必须为文件夹"),
        }
        match &deserialized.roots[1] {
            FavoriteNode::File { id, name, path, .. } => {
                assert_eq!(id, "fav_root");
                assert_eq!(name, "根目录文件.txt");
                assert_eq!(path, "C:\\notes\\root.txt");
            }
            _ => panic!("根节点 1 必须为文件"),
        }
    }
}
