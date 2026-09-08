// NoteBoard 🔴 N10.2 编辑器实例就绪标记测试
// 覆盖：requestId 关联登记/一次性消费、重挂载（回收恢复）不带 requestId、
//       诊断属性不记录完整路径（只保留尾部 40 字符）。

import { describe, it, expect, beforeEach } from 'vitest';
import {
  markEditorOpenRequest,
  perfMarkEditorInstanceReady,
} from '@/core/perf/editorReadyMark';
import { takePendingSpans, resetForTest } from '@/core/perf/perfMarks';

describe('🔴 N10.2 编辑器实例就绪标记（requestId 贯穿）', () => {
  beforeEach(() => {
    resetForTest();
  });

  it('打开请求建立的文档：就绪标记携带 requestId（一次性消费）', () => {
    const docKey = 'C:/users/very/long/path/to/notes/hello.md';
    markEditorOpenRequest(docKey, 'req-42');
    perfMarkEditorInstanceReady(docKey, 'cm-1');

    const spans = takePendingSpans().spans;
    const ready = spans.find((s) => s.name === 'editor_instance_ready');
    expect(ready).toBeDefined();
    const attrs = new Map(ready!.attrs ?? []);
    expect(attrs.get('requestId')).toBe('req-42');
    expect(attrs.get('instanceId')).toBe('cm-1');
    // 🔴 R3-11 隐私约束：诊断不记录任何路径内容——只携带匿名会话序号
    const sessionAttr = String(attrs.get('session'));
    expect(Number.isFinite(Number(sessionAttr))).toBe(true);
    const allKeys = [...(ready!.attrs ?? [])].map(([k]) => k);
    expect(allKeys.some((k) => k === 'docKey' || k === 'path')).toBe(false);

    // 二次标记（同 docKey 重挂载/回收恢复）不再携带 requestId（一次性消费）
    // 注：takePendingSpans 是快照不清游标——取最新一条断言
    perfMarkEditorInstanceReady(docKey, 'cm-2');
    const spans2 = takePendingSpans().spans;
    const ready2 = spans2.at(-1);
    const attrs2 = new Map(ready2!.attrs ?? []);
    expect(attrs2.has('requestId')).toBe(false);
    expect(attrs2.get('instanceId')).toBe('cm-2');
    // 同一会话的匿名标识稳定（两次标记同 session）
    expect(String(attrs2.get('session'))).toBe(sessionAttr);
  });

  it('非队列来源（恢复/回收重挂载/新建）：就绪标记无 requestId 也正常输出', () => {
    perfMarkEditorInstanceReady('C:/t/local.md', 'md-3');
    const spans = takePendingSpans().spans;
    expect(spans).toHaveLength(1);
    const attrs = new Map(spans[0].attrs ?? []);
    expect(attrs.get('instanceId')).toBe('md-3');
    expect(attrs.has('requestId')).toBe(false);
  });
});
