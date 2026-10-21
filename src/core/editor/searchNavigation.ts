// 编辑器内搜索跳转事务的跨模块标记。
// 搜索命中会改变正文选区以驱动编辑区滚动，但不应被右侧大纲当成用户移动光标；
// 命中项已在可视区内时大纲保持不动，只有页面被滚走时才由大纲的滚动联动跟随。
export const EDITOR_SEARCH_NAVIGATION_META = 'noteboard-editor-search-navigation';
