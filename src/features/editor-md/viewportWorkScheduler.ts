// NoteBoard 视口工作调度器（S14 K 节改造）
//
// 🔴 设计（docs/启动性能与低内存根治计划.md §K）：
//   1. 不再是模块共享单槽（旧实现同帧后来的任务直接覆盖前一个，不同节点的
//      渲染工作会被静默丢弃）——改为按任务身份（调用方拼 docKey+nodeId+taskKind）
//      的有界队列：同一节点旧 revision 被新任务替代，不同节点各有最终结果。
//   2. 每帧以时间片预算处理并让出主线程；Promise 包装的同步图表渲染不会自动
//      变得可抢占，长任务单独测。
//   3. 队列有上限：达到上限时丢弃最旧任务（backpressure），不无界增长。
//   4. 取消只取消指定身份（所属节点/文档），不影响其它任务。

type WorkItem = () => void;

/** 每帧时间片预算（毫秒） */
const FRAME_TIME_BUDGET_MS = 8;
/** 待执行任务上限（超出丢弃最旧） */
const MAX_PENDING_TASKS = 256;

/** 待执行任务表：身份 → 任务（同身份新任务替换旧任务） */
const pendingTasks = new Map<string, WorkItem>();
/** 每帧按入队顺序处理（Map 保持插入序；同身份替换不改变位置） */
let rafId: number | null = null;

/** 执行时间片内的任务（超预算让出，剩余下帧继续） */
function flushSlice(): void {
  rafId = null;
  const sliceStart = now();
  while (pendingTasks.size > 0) {
    const [identity, work] = nextEntry();
    pendingTasks.delete(identity);
    try {
      work();
    } catch (e) {
      console.error('[viewportWorkScheduler] 任务执行失败:', identity, e);
    }
    if (now() - sliceStart >= FRAME_TIME_BUDGET_MS && pendingTasks.size > 0) {
      scheduleFrame();
      return;
    }
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** 取第一个任务（Map 迭代首项即最旧） */
function nextEntry(): [string, WorkItem] {
  for (const entry of pendingTasks.entries()) return entry;
  throw new Error('unreachable');
}

/** 安排下一帧处理 */
function scheduleFrame(): void {
  if (rafId !== null) return;
  if (typeof requestAnimationFrame === 'undefined') {
    // 无 rAF 环境（如测试），用 setTimeout 0 替代
    rafId = setTimeout(flushSlice, 0) as unknown as number;
  } else {
    rafId = requestAnimationFrame(flushSlice);
  }
}

/**
 * 按身份调度任务到下一帧时间片。
 * 同一身份的旧任务被新任务替代（同节点新 revision 覆盖）；
 * 不同身份互不影响，各自保证最终结果。
 */
export function scheduleTask(identity: string, work: WorkItem): void {
  // 同身份替换（保持原插入位置：先删后插会改变顺序——保持即可，新任务语义优先）
  if (pendingTasks.has(identity)) {
    pendingTasks.set(identity, work);
    scheduleFrame();
    return;
  }
  // 上限背压：丢弃最旧
  if (pendingTasks.size >= MAX_PENDING_TASKS) {
    const [oldest] = nextEntry();
    pendingTasks.delete(oldest);
  }
  pendingTasks.set(identity, work);
  scheduleFrame();
}

/**
 * 取消指定身份的待执行任务（只取消所属节点/文档，不影响其它任务）。
 */
export function cancelTask(identity: string): void {
  pendingTasks.delete(identity);
}

/**
 * 兼容旧调用（无身份）：以调用栈位置无关的默认身份调度——
 * 语义为"匿名单槽"（新任务替换上一个匿名任务），仅供过渡期使用。
 */
export function schedule(work: WorkItem): void {
  scheduleTask('__anonymous__', work);
}

/** 取消全部待执行任务 */
export function cancel(): void {
  pendingTasks.clear();
  if (rafId !== null) {
    if (typeof requestAnimationFrame === 'undefined') {
      clearTimeout(rafId);
    } else {
      cancelAnimationFrame(rafId);
    }
    rafId = null;
  }
}

/** 是否有待执行任务（全部身份） */
export function hasPending(): boolean {
  return pendingTasks.size > 0;
}

/** 仅测试：读取待执行身份集合 */
export function debugPendingIdentities(): string[] {
  return [...pendingTasks.keys()];
}
