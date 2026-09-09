// NoteBoard 🔴 R3-03 会话代际可清理设计与身份契约测试
// 覆盖：关闭大量不同文件后活动会话表回落（不留永久条目）；documents 重建
//       无条件换新 token（旧 token 不误碰新会话）；无活动会话 get=0。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getSessionGeneration,
  disposeDocumentSession,
  enqueueDocumentWrite,
} from '@/features/session/documentSession';
import { useDocumentStore } from '@/stores/documentStore';
import { useWindowStore } from '@/stores/windowStore';

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'nb-main' }) }));

function seed(key: string): void {
  useDocumentStore.getState().upsertFromPayload({
    key, displayName: 'a.md', dirPath: 'C:/t', kind: 'markdown', language: 'markdown',
    content: 'text', encoding: 'utf8', eol: 'lf', size: 4, mtime: 0, readonly: false,
  });
  useWindowStore.getState().openTab({
    key, displayName: 'a.md', path: key, kind: 'markdown', language: 'markdown',
    isDirty: false, isPreview: false, viewMode: 'visual', externalStatus: null, isDetached: false,
  });
}

describe('🔴 R3-03 会话代际可清理设计', () => {
  beforeEach(() => {
    useWindowStore.setState({ tabs: [], activeKey: null });
    useDocumentStore.setState({ documents: new Map() });
  });

  it('关闭大量不同文件后：活动会话表回落（无永久条目累积）', async () => {
    const keys = Array.from({ length: 30 }, (_, i) => `C:/t/doc-${i}.md`);
    for (const key of keys) seed(key);
    for (const key of keys) {
      useDocumentStore.getState().remove(key);
      disposeDocumentSession(key);
    }
    // 全部释放：get 全部为 0（无活动会话）
    for (const key of keys) {
      expect(getSessionGeneration(key)).toBe(0);
    }
  });

  it('documents 重建无条件换新 token：旧关闭事务不能以旧 token 校验通过', async () => {
    const key = 'C:/t/rebuild.md';
    seed(key);
    const oldGeneration = getSessionGeneration(key);
    // 关闭（推进 token）+ 移除 + 重开（documents 重建——无条件再分配新 token）
    disposeDocumentSession(key);
    useDocumentStore.getState().remove(key);
    seed(key);
    const newGeneration = getSessionGeneration(key);
    expect(newGeneration).not.toBe(oldGeneration);
    expect(newGeneration).toBeGreaterThan(oldGeneration);
  });

  it('写队列在途时保留活动表（drain 完成后回落）', async () => {
    const key = 'C:/t/inflight.md';
    seed(key);
    const gate = enqueueDocumentWrite(key, () => new Promise<void>((resolve) => setTimeout(resolve, 5)));
    useDocumentStore.getState().remove(key);
    disposeDocumentSession(key);
    // 在途写任务未完成——条目保留（等价于代际可查询，避免误清）
    expect(getSessionGeneration(key)).toBeGreaterThan(0);
    await gate;
    // 队尾自清理是微任务（settled.then）——排空后写队列条目已移除
    await Promise.resolve(); await Promise.resolve();
    // 触发一次 store 变化使订阅兜底执行
    useDocumentStore.getState().upsertFromPayload({
      key: 'C:/t/other.md', displayName: 'o.md', dirPath: 'C:/t', kind: 'markdown', language: 'markdown',
      content: 'x', encoding: 'utf8', eol: 'lf', size: 1, mtime: 0, readonly: false,
    });
    // inflight key 已不在 documents/队列——兜底清理后回 0
    expect(getSessionGeneration(key)).toBe(0);
  });
});
