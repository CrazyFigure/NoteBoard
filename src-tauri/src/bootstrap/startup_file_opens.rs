// Finder 的文件打开事件可能早于 Tauri Ready；此时配置主窗口尚未创建，必须暂存而非新建窗口。

/// 冷启动文件请求在 Ready 后统一交给已有窗口队列，运行中的请求立即转交。
#[derive(Default)]
pub struct StartupFileOpens {
    ready: bool,
    pending: Vec<String>,
}

impl StartupFileOpens {
    /// 初始化前只积累路径，不触碰尚未创建的窗口；保留多次 Finder 事件的原始顺序。
    pub fn opened(&mut self, paths: Vec<String>) -> Vec<String> {
        if self.ready {
            paths
        } else {
            self.pending.extend(paths);
            Vec::new()
        }
    }

    /// 主窗口完成 setup 后只释放一次暂存；后续请求可直接复用主窗口。
    pub fn ready(&mut self) -> Vec<String> {
        self.ready = true;
        std::mem::take(&mut self.pending)
    }
}

#[cfg(test)]
mod tests {
    use super::StartupFileOpens;

    #[test]
    fn finder_cold_start_waits_for_configured_main_window() {
        let mut opens = StartupFileOpens::default();
        assert!(opens.opened(vec!["/notes/首个.md".into()]).is_empty());
        assert!(opens.opened(vec!["/notes/第二个.md".into()]).is_empty());
        assert_eq!(opens.ready(), vec!["/notes/首个.md", "/notes/第二个.md"]);
        assert!(opens.ready().is_empty());
    }

    #[test]
    fn running_app_dispatches_without_waiting_again() {
        let mut opens = StartupFileOpens::default();
        assert!(opens.ready().is_empty());
        assert_eq!(opens.opened(vec!["/notes/已启动.md".into()]), vec!["/notes/已启动.md"]);
        assert!(opens.opened(Vec::new()).is_empty());
    }
}
