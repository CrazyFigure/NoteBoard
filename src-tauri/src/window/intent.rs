// NoteBoard 窗口意图 — 暂存与取走（拉取模型）
// 关键设计：建窗后前端挂载完成主动调用 window_ready 取走意图
// 不用「建窗后 emit 事件」——前端还没注册监听会丢事件

use crate::dto::WindowIntent;
use crate::state::AppState;
use std::sync::Mutex;
use tauri::State;

/// 暂存意图
pub fn put_intent(state: &State<'_, Mutex<AppState>>, label: String, intent: WindowIntent) {
    let mut s = state.lock().unwrap();
    s.intents.insert(label, intent);
}

/// 取走意图（取走即删）
pub fn take_intent(state: &State<'_, Mutex<AppState>>, label: &str) -> Option<WindowIntent> {
    let mut s = state.lock().unwrap();
    s.intents.remove(label)
}
