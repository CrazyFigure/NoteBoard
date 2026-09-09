// NoteBoard Markdown 自动保存（S09：统一走每文档写队列）
// visual（TipTap）与 source（CodeMirror）两条输入链共用；
// 本函数为兼容薄封装，实际语义见 session/documentSession.queuedAutoSave：
// 每文档写盘串行、基线只更新实际写入文本、flush-and-compare 脏态、带证明暂存清理。

export { queuedAutoSave as autoSaveDocument } from '../session/documentSession';
