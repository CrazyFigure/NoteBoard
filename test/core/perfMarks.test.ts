// NoteBoard web 性能标记收集器测试
// 覆盖：上限丢弃计数、分批上报游标、区间时长记录

import { describe, test, expect, beforeEach } from 'vitest';
import {
  perfMark,
  perfSpan,
  perfNow,
  takePendingSpans,
  markReported,
  resetForTest,
  MAX_SPANS_LIMIT_FOR_TEST,
} from '@/core/perf/perfMarks';

describe('perfMarks web 性能标记收集', () => {
  beforeEach(() => {
    resetForTest();
  });

  test('点事件按时间顺序记录且携带属性', () => {
    const t0 = perfNow();
    perfMark('js_entry', { htmlTs: 1.5 });
    perfMark('settings_init_done');
    const pending = takePendingSpans();
    expect(pending.spans).toHaveLength(2);
    expect(pending.spans[0].name).toBe('js_entry');
    // 属性统一转为字符串键值对，避免正文之外的结构化数据
    expect(pending.spans[0].attrs).toEqual([['htmlTs', '1.5']]);
    expect(pending.spans[1].t).toBeGreaterThanOrEqual(pending.spans[0].t);
    expect(pending.spans[1].t).toBeGreaterThanOrEqual(t0);
    expect(pending.dropped).toBe(0);
  });

  test('区间事件记录起点与时长', () => {
    const start = perfNow();
    perfSpan('settings_init', start);
    const { spans } = takePendingSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].durMs).toBeGreaterThanOrEqual(0);
    expect(spans[0].t).toBe(start);
  });

  test('超过硬上限后停止收集并累计 dropped', () => {
    for (let i = 0; i < MAX_SPANS_LIMIT_FOR_TEST + 5; i++) {
      perfMark(`evt-${i}`);
    }
    const pending = takePendingSpans();
    expect(pending.spans).toHaveLength(MAX_SPANS_LIMIT_FOR_TEST);
    expect(pending.dropped).toBe(5);
  });

  test('markReported 按批次数量推进游标，后续 take 只返回新事件', () => {
    perfMark('a');
    expect(takePendingSpans().spans).toHaveLength(1);
    markReported(1);
    expect(takePendingSpans().spans).toHaveLength(0);
    perfMark('b');
    const pending = takePendingSpans();
    expect(pending.spans).toHaveLength(1);
    expect(pending.spans[0].name).toBe('b');
  });

  test('🔴 N10：markReported 不得跳过上报期间新增的事件（按实际发送批次确认）', () => {
    perfMark('a');
    perfMark('b');
    // 模拟上报流程：快照 2 条 → await 期间新增第 3 条 → 仅按快照数量确认
    const snapshot = takePendingSpans();
    expect(snapshot.spans).toHaveLength(2);
    perfMark('c');
    // 发送失败场景：不确认（游标不动），下一批仍从 a 开始
    expect(takePendingSpans().spans).toHaveLength(3);
    // 发送成功：只确认快照内的 2 条
    markReported(2);
    const remaining = takePendingSpans();
    expect(remaining.spans).toHaveLength(1);
    expect(remaining.spans[0].name).toBe('c');
  });
});
