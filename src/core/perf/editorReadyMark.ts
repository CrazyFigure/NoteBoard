// NoteBoard 🔴 N10.2 编辑器实例就绪标记（requestId 贯穿到可交互终点）
//
// 打开请求的完整链路：open_request_start（drain）→ 打开编排 → 编辑器实例挂载
// → editor_instance_ready（本次新增的终点代理：实例+能力注册完成，同步事务锁
// 保证首笔输入入历史）。requestId 经 docKey 关联登记/消费，可与 Rust spans 对齐。
//
// 🔴 隐私约束（N10.4）：诊断不记录完整 docKey/路径——只保留尾部 40 字符与 requestId。

import { perfMark } from './perfMarks';

/** docKey → 打开该文档的 requestId（编辑器就绪时一次性消费） */
const pendingRequestByDocKey = new Map<string, string>();

/** drain 处理打开请求时登记关联（编辑器挂载完成的标记据此携带 requestId） */
export function markEditorOpenRequest(docKey: string, requestId: string): void {
  pendingRequestByDocKey.set(docKey, requestId);
}

/**
 * 🔴 N10.2：编辑器实例就绪终点标记（各类型编辑器在实例+能力注册完成时调用）。
 * 若该文档由打开请求队列建立，requestId 随标记输出（一次性消费——重挂载
 * 回收恢复不带 requestId，属正常路径）。
 */
export function perfMarkEditorInstanceReady(docKey: string, instanceId: string): void {
  const requestId = pendingRequestByDocKey.get(docKey);
  if (requestId !== undefined) pendingRequestByDocKey.delete(docKey);
  perfMark('editor_instance_ready', {
    docKey: `${docKey.slice(-40)}`,
    instanceId,
    ...(requestId !== undefined ? { requestId } : {}),
  });
}
