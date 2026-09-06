// NoteBoard S14 调度与监听模块测试
// 覆盖：视口任务身份队列（同身份替换/不同身份各有结果/时间片让出/取消指定身份），
//       中心 watcher 引用计数（多订阅共用/归零停止/重复注销安全）。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  scheduleTask,
  cancelTask,
  hasPending,
  debugPendingIdentities,
  cancel,
} from '@/features/editor-md/viewportWorkScheduler';

// directoryWatcher 依赖 plugin-fs（测试环境 mock）
vi.mock('@tauri-apps/plugin-fs', () => {
  const unwatchFns: Array<() => void> = [];
  return {
    watchImmediate: vi.fn(async () => {
      const fn = vi.fn();
      unwatchFns.push(fn);
      return fn;
    }),
    __unwatchFns: unwatchFns,
  };
});
import { watchDirectory, debugWatchRefs } from '@/features/explorer/directoryWatcher';

describe('S14 视口任务身份队列', () => {
  beforeEach(() => {
    cancel();
  });

  it('不同身份的任务各有最终结果（旧单槽实现会互相覆盖）', async () => {
    const executed: string[] = [];
    scheduleTask('node-a', () => executed.push('a'));
    scheduleTask('node-b', () => executed.push('b'));
    scheduleTask('node-c', () => executed.push('c'));
    await flushTasks();
    expect(executed.sort()).toEqual(['a', 'b', 'c']);
  });

  it('同一身份的新任务替换旧任务（同节点新 revision 覆盖）', async () => {
    const executed: string[] = [];
    scheduleTask('node-a', () => executed.push('旧'));
    scheduleTask('node-a', () => executed.push('新'));
    await flushTasks();
    expect(executed).toEqual(['新']);
  });

  it('取消指定身份不影响其它任务', async () => {
    const executed: string[] = [];
    scheduleTask('node-a', () => executed.push('a'));
    scheduleTask('node-b', () => executed.push('b'));
    cancelTask('node-a');
    expect(debugPendingIdentities()).toEqual(['node-b']);
    await flushTasks();
    expect(executed).toEqual(['b']);
  });

  it('时间片预算：超预算任务让出到下一帧（所有任务最终执行）', async () => {
    const executed: string[] = [];
    // 首个任务耗尽预算（伪 performance.now 已被任务内的 busy wait 模拟不可行——
    // 用慢任务测试：真实时钟下 8ms 预算被长任务超出）
    scheduleTask('slow', () => {
      executed.push('slow');
      const start = Date.now();
      while (Date.now() - start < 12) {
        /* 占满 12ms 超出预算 */
      }
    });
    scheduleTask('after', () => executed.push('after'));
    await flushTasks();
    // 两个任务都被执行（after 可能被让出到下一帧，但最终完成）
    expect(executed).toContain('slow');
    expect(executed).toContain('after');
  });

  it('hasPending 反映队列状态', async () => {
    expect(hasPending()).toBe(false);
    scheduleTask('x', () => {});
    expect(hasPending()).toBe(true);
    await flushTasks();
    expect(hasPending()).toBe(false);
  });
});

/** 排空任务队列（rAF 在 vitest 环境为 setTimeout 0） */
async function flushTasks(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe('S14 中心目录监听（引用计数）', () => {
  it('多订阅共用同一监听；归零停止；重复注销安全', async () => {
    const dir = 'C:\\t\\docs';
    const releaseA = watchDirectory(dir);
    await new Promise((r) => setTimeout(r, 5));
    // B 订阅：引用计数 2，不重复建监听
    const releaseB = watchDirectory(dir);
    await new Promise((r) => setTimeout(r, 5));
    expect(debugWatchRefs().get(dir)).toBe(2);

    // A 释放：仍有一份引用（不误停 B）
    releaseA();
    await new Promise((r) => setTimeout(r, 5));
    expect(debugWatchRefs().get(dir)).toBe(1);

    // B 释放：归零（记录移除）；重复调用安全
    releaseB();
    releaseB(); // 重复注销幂等
    await new Promise((r) => setTimeout(r, 5));
    expect(debugWatchRefs().get(dir)).toBeUndefined();
  });
});
