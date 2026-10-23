// NoteBoard 文档历史记录：文档身份（路径 → 文档标识）
//
// 本机模式下文档没有稳定 ID，用 identity.json 记录「路径比较键 → docId」：
//   - 应用内改名/移动：按路径前缀批量改映射（目录改名时其中所有文档的历史一起跟随）
//   - 删除：映射移入 trashed（保留一段时间后清除），同一路径重新出现内容一致的文件时恢复关联
// 路径比较键统一用 `/` 分隔，Windows 下不区分大小写。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Trashed {
    pub key: String,
    pub at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Identity {
    pub map: BTreeMap<String, String>,
    pub trashed: BTreeMap<String, Trashed>,
}

/// 路径比较键
pub fn path_key(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    let s = s.trim_end_matches('/').to_string();
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

fn under(key: &str, prefix: &str) -> bool {
    key == prefix || key.strip_prefix(prefix).is_some_and(|rest| rest.starts_with('/'))
}

impl Identity {
    pub fn load(path: &Path) -> Self {
        std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let json = serde_json::to_vec(self).map_err(std::io::Error::other)?;
        super::store::write_atomic(path, &json)
    }

    pub fn lookup(&self, key: &str) -> Option<String> {
        self.map.get(key).cloned()
    }

    /// 为路径分配新文档标识
    pub fn assign(&mut self, key: &str) -> String {
        let id = uuid::Uuid::new_v4().simple().to_string();
        self.map.insert(key.to_string(), id.clone());
        id
    }

    /// 绑定指定标识（重新关联、迁移导入）
    pub fn bind(&mut self, key: &str, id: &str) {
        self.trashed.remove(id);
        self.map.insert(key.to_string(), id.to_string());
    }

    /// 改名/移动：返回受影响的（新路径键, 文档标识）
    pub fn rename(&mut self, from: &str, to: &str) -> Vec<(String, String)> {
        let moved: Vec<(String, String)> =
            self.map.iter().filter(|(k, _)| under(k, from)).map(|(k, v)| (k.clone(), v.clone())).collect();
        let mut out = Vec::new();
        for (old, id) in moved {
            self.map.remove(&old);
            let new_key = format!("{}{}", to, &old[from.len()..]);
            // 目标位置原有映射被覆盖：旧文档的历史转入待清理
            if let Some(prev) = self.map.insert(new_key.clone(), id.clone()) {
                if prev != id {
                    self.trashed.insert(prev, Trashed { key: new_key.clone(), at: super::now_ms() });
                }
            }
            out.push((new_key, id));
        }
        out
    }

    /// 删除：路径（或目录下全部路径）的映射移入待清理，返回受影响的文档标识
    pub fn trash(&mut self, key: &str, now: i64) -> Vec<String> {
        let hit: Vec<(String, String)> =
            self.map.iter().filter(|(k, _)| under(k, key)).map(|(k, v)| (k.clone(), v.clone())).collect();
        for (k, id) in &hit {
            self.map.remove(k);
            self.trashed.insert(id.clone(), Trashed { key: k.clone(), at: now });
        }
        hit.into_iter().map(|(_, id)| id).collect()
    }

    /// 同一路径上待清理的历史（按删除时间倒序）
    pub fn trashed_at(&self, key: &str) -> Vec<String> {
        let mut v: Vec<(&String, &Trashed)> = self.trashed.iter().filter(|(_, t)| t.key == key).collect();
        v.sort_by_key(|x| std::cmp::Reverse(x.1.at));
        v.into_iter().map(|(id, _)| id.clone()).collect()
    }

    /// 清除超过保留期的已删除文档，返回其标识
    pub fn purge(&mut self, now: i64, keep_ms: i64) -> Vec<String> {
        let expired: Vec<String> =
            self.trashed.iter().filter(|(_, t)| now - t.at > keep_ms).map(|(id, _)| id.clone()).collect();
        for id in &expired {
            self.trashed.remove(id);
        }
        expired
    }

    /// 移除某个标识的全部映射
    pub fn forget(&mut self, id: &str) {
        self.map.retain(|_, v| v != id);
        self.trashed.remove(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rename_follows_directory_prefix() {
        let mut idt = Identity::default();
        let a = idt.assign("c:/notes/项目/a.md");
        let b = idt.assign("c:/notes/项目/子/b.md");
        let c = idt.assign("c:/notes/项目x/c.md");
        let moved = idt.rename("c:/notes/项目", "c:/notes/归档/项目");
        assert_eq!(moved.len(), 2);
        assert_eq!(idt.lookup("c:/notes/归档/项目/a.md"), Some(a));
        assert_eq!(idt.lookup("c:/notes/归档/项目/子/b.md"), Some(b));
        assert_eq!(idt.lookup("c:/notes/项目x/c.md"), Some(c));
    }

    #[test]
    fn trash_then_purge() {
        let mut idt = Identity::default();
        let a = idt.assign("/n/a.md");
        assert_eq!(idt.trash("/n", 100), vec![a.clone()]);
        assert_eq!(idt.lookup("/n/a.md"), None);
        assert_eq!(idt.trashed_at("/n/a.md"), vec![a.clone()]);
        assert!(idt.purge(150, 100).is_empty());
        assert_eq!(idt.purge(300, 100), vec![a]);
    }
}
