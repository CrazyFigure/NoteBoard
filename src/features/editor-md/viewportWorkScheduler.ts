// NoteBoard 视口工作调度器
// 单槽 rAF 队列：同帧内多次 schedule 只执行最后一次
// 详见 docs/09-开发路线图.md 8.2

type WorkItem = () => void;

/** 当前待执行任务 */
let pendingWork: WorkItem | null = null;

/** rAF 句柄 */
let rafId: number | null = null;

/** 执行待执行任务 */
function flush(): void {
  rafId = null;
  const work = pendingWork;
  pendingWork = null;
  if (work) {
    try {
      work();
    } catch (e) {
      console.error('[viewportWorkScheduler] 任务执行失败:', e);
    }
  }
}

/**
 * 调度一个任务到下一帧
 * 如果已有待执行任务，替换之（单槽：只保留最后一次）
 */
export function schedule(work: WorkItem): void {
  pendingWork = work;

  if (rafId !== null) return;

  if (typeof requestAnimationFrame === 'undefined') {
    // 无 rAF 环境（如测试），用 setTimeout 0 替代
    rafId = setTimeout(flush, 0) as unknown as number;
  } else {
    rafId = requestAnimationFrame(flush);
  }
}

/**
 * 取消待执行任务
 */
export function cancel(): void {
  pendingWork = null;
  if (rafId !== null) {
    if (typeof requestAnimationFrame === 'undefined') {
      clearTimeout(rafId);
    } else {
      cancelAnimationFrame(rafId);
    }
    rafId = null;
  }
}

/**
 * 检查是否有待执行任务
 */
export function hasPending(): boolean {
  return pendingWork !== null;
}
