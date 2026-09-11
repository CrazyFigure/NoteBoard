// 编辑器内搜索跳转事务的跨模块标记。
// 搜索命中会改变正文选区以驱动编辑区滚动，但不应被右侧大纲当成用户移动光标，
// 否则大纲会跟着滚动并抢走视觉注意力，让 Ctrl+F 看起来像在搜索侧栏。
export const EDITOR_SEARCH_NAVIGATION_META = 'noteboard-editor-search-navigation';
