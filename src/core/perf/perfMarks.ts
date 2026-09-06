// NoteBoard web 端性能标记收集器（仅诊断用）
//
// 🔴 设计约束（docs/performance/启动基线.md §S01）：
//   1. 仅内存数组且有硬上限（MAX_SPANS），满后只累计 dropped 计数并停止收集。
//   2. 收集路径无 IPC、无 console 输出；只在关键里程碑低频批量上报给 Rust 统一落盘。
//   3. 只记录名称/时间戳/描述性属性，绝不记录文档正文或完整私人路径。
//   4. performance.now() 的原点是 WebView 导航开始，与 Rust 进程启动不在同一时间轴；
//      上报后由 Rust 端按 clock=web 分轴保存，不做跨进程直接相减。
//   5. js_entry 位于 main.tsx 模块体首行，它晚于入口静态依赖的求值，
//      只能作为 JS 代码开始执行的代理标记，不能代表资源加载/解析的开始。

export type WebPerfAttrs = Record<string, string | number | boolean>;

export interface WebPerfSpan {
  name: string;
  /** performance.now() 时间戳 */
  t: number;
  /** 区间时长（毫秒）；点事件省略 */
  durMs?: number;
  /** 关联打开请求 ID（S04 队列落地后填写） */
  requestId?: string;
  attrs?: Array<[string, string]>;
}

const MAX_SPANS = 256;

/** 仅供测试断言使用的上限值导出（业务代码不得依赖） */
export const MAX_SPANS_LIMIT_FOR_TEST = MAX_SPANS;

let spans: WebPerfSpan[] = [];
let dropped = 0;
/** 已成功上报的事件序号边界（支持分批上报） */
let reportedUpTo = 0;

function toAttrPairs(attrs?: WebPerfAttrs): Array<[string, string]> | undefined {
  if (!attrs) return undefined;
  const pairs: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(attrs)) {
    pairs.push([key, String(value)]);
  }
  return pairs.length > 0 ? pairs : undefined;
}

/** 记录一个时间点事件 */
export function perfMark(name: string, attrs?: WebPerfAttrs): void {
  if (spans.length >= MAX_SPANS) {
    dropped += 1;
    return;
  }
  spans.push({ name, t: performance.now(), attrs: toAttrPairs(attrs) });
}

/** 记录一个区间事件（start 为先前捕获的 performance.now 值） */
export function perfSpan(name: string, startMs: number, attrs?: WebPerfAttrs): void {
  if (spans.length >= MAX_SPANS) {
    dropped += 1;
    return;
  }
  const t = performance.now();
  spans.push({ name, t: startMs, durMs: t - startMs, attrs: toAttrPairs(attrs) });
}

/** 读取当前时钟（用于调用方自行捕获区间起点） */
export function perfNow(): number {
  return performance.now();
}

/** 当前尚未上报的 spans 快照（连同被丢弃计数） */
export function takePendingSpans(): { spans: WebPerfSpan[]; dropped: number } {
  return { spans: spans.slice(reportedUpTo), dropped };
}

/**
 * 上报完成后推进游标。
 * 🔴 N10：按实际已发送批次末尾序号确认——发送期间（await IPC）新增的事件
 *    不在本批快照内，不得被游标跳过；count 为本批实际发送的 span 数。
 */
export function markReported(count: number): void {
  reportedUpTo = Math.min(spans.length, reportedUpTo + Math.max(0, count));
}

/** 重置（仅供测试使用） */
export function resetForTest(): void {
  spans = [];
  dropped = 0;
  reportedUpTo = 0;
}
