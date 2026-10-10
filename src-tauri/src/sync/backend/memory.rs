// 仅测试：内存远端（多台「设备」共享同一个 Arc，模拟同一个云端）

use super::RemoteFile;
use crate::sync::error::SyncResult;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub struct Memory {
    pub files: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
}

impl Memory {
    pub async fn read(&mut self, rel: &str) -> SyncResult<Option<Vec<u8>>> {
        Ok(self.files.lock().unwrap().get(rel).cloned())
    }

    pub async fn put(&mut self, rel: &str, data: Vec<u8>) -> SyncResult<()> {
        self.files.lock().unwrap().insert(rel.to_string(), data);
        Ok(())
    }

    pub async fn delete(&mut self, rel: &str) -> SyncResult<()> {
        self.files.lock().unwrap().remove(rel);
        Ok(())
    }

    pub async fn list(&mut self, dir: &str) -> SyncResult<Vec<RemoteFile>> {
        let prefix = format!("{}/", dir.trim_end_matches('/'));
        Ok(self
            .files
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(k, v)| {
                let rest = k.strip_prefix(&prefix)?;
                if rest.contains('/') {
                    return None;
                }
                Some(RemoteFile { name: rest.to_string(), size: v.len() as u64 })
            })
            .collect())
    }
}
