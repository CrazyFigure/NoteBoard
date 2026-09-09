// NoteBoard 🔴 N10.2 编辑器实例就绪标记（requestId 贯穿到可交互终点）
//
// 打开请求的完整链路：open_request_start（drain）→ 打开编排 → 编辑器实例挂载
// → editor_instance_ready（本次新增的终点代理：实例+能力注册完成，同步事务锁
// 保证首笔输入入历史）。requestId 经 docKey 关联登记/消费，可与 Rust spans 对齐。
//
// 🔴 隐私约束（N10.4）：诊断不记录完整 docKey/路径——只保留尾部 40 字符与 requestId。

import { perfMark } from './perfMarks';

/** 🔴 R3-11：docKey → 匿名会话标识（短路径仍是完整路径——不满足隐私要求；
 *    改为匿名递增序号，诊断不记录任何路径内容） */
const pendingRequestByDocKey = new Map<string, string>();
const anonymousSessionIds = new Map<string, number>();
let nextAnonymousSessionId = 0;

/** drain 处理打开请求时登记关联（编辑器挂载完成的标记据此携带 requestId） */
export function markEditorOpenRequest(docKey: string, requestId: string): void {
  pendingRequestByDocKey.set(docKey, requestId);
}

/**
 * 🔴 N10.2：编辑器实例就绪终点标记（各类型编辑器在实例+能力注册完成时调用）。
 * 若该文档由打开请求队列建立，requestId 随标记输出（一次性消费——重挂载
 * 回收恢复不带 requestId，属正常路径）。
 * 🔴 R3-11 隐私：诊断只携带**匿名会话序号**（每 docKey 稳定分配）与 requestId，
 *    不记录路径尾部（短路径的尾部即完整路径）。
 */
export function perfMarkEditorInstanceReady(docKey: string, instanceId: string): void {
  const requestId = pendingRequestByDocKey.get(docKey);
  if (requestId !== undefined) pendingRequestByDocKey.delete(docKey);
  let session = anonymousSessionIds.get(docKey);
  if (session === undefined) {
    session = ++nextAnonymousSessionId;
    anonymousSessionIds.set(docKey, session);
  }
  perfMark('editor_instance_ready', {
    session,
    instanceId,
    ...(requestId !== undefined ? { requestId } : {}),
  });
}
