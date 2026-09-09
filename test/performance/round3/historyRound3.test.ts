// 三轮复审反例（正式迁入自 test-results/performance/review-20260906-round3/）——断言为整改后正确行为。
// 三轮复审：真实快照暂存和历史实现；只替换 visual 序列化适配器以控制不可变输入。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Text } from '@codemirror/state';
import { useDocumentStore } from '@/stores/documentStore';
import { useWindowStore } from '@/stores/windowStore';
import { disposeDocumentSession } from '@/features/session/documentSession';
import { getBaseline } from '@/features/editor-md/serialize';
import { stagePendingSourceSnapshot, flushPendingSourceSnapshot, stagePendingVisualSnapshot, flushPendingVisualSnapshot } from '@/features/editor-md/visualSnapshot';
import { clearAllDocumentHistories, initializeDocumentHistory, recordDocumentChange, registerDocumentHistoryAdapter, registerHistoryMaterializeHook, undoDocumentHistory, getCurrentDocumentHistoryContent } from '@/features/history/documentHistory';
vi.mock('@/features/editor-md/serialize', async original => ({ ...await original<typeof import('@/features/editor-md/serialize')>(), serializeMarkdownFromDoc: (_m: unknown, _s: unknown, doc: { text: string }) => doc.text }));

// 只创建内存中的文件状态，假路径不参与真实文件 I/O。
function seed(key: string, text: string): void {
  useDocumentStore.getState().upsertFromPayload({ key, displayName: 'review.md', dirPath: 'C:/round3', kind: 'markdown', language: 'markdown', content: text, encoding: 'utf8', eol: 'lf', size: text.length, mtime: 0, readonly: false });
  getBaseline(key).updateBaseline(text);
}

describe('三轮复审：历史快照组合语义', () => {
  beforeEach(() => { clearAllDocumentHistories(); useDocumentStore.setState({ documents: new Map() }); useWindowStore.setState({ tabs: [], activeKey: null }); });

  it.each(['visual', 'source'] as const)('C01：%s 第二历史组内连续两次输入不得抹掉组边界', mode => {
    const key = `C:/round3/groups-${mode}.md`;
    seed(key, 'base'); initializeDocumentHistory(key, 'base', mode);
    recordDocumentChange(key, 'group-one', { mode, startsNewGroup: true });
    const stage = (text: string, isNewGroup: boolean) => {
      if (mode === 'source') stagePendingSourceSnapshot(key, { text: Text.of([text]), revision: 1, isNewGroup });
      else stagePendingVisualSnapshot(key, { doc: { text } as never, manager: {} as never, schema: {} as never, revision: 1, isNewGroup });
    };
    // 真实 onUpdate 在新组首事务传 true，后续同组事务传 false。
    stage('group-two-a', true); stage('group-two-ab', false);
    if (mode === 'source') flushPendingSourceSnapshot(key); else flushPendingVisualSnapshot(key);
    const applied: string[] = [];
    registerDocumentHistoryAdapter(key, { applyEntry: entry => { applied.push(entry.content); } });
    expect(undoDocumentHistory(key)).toBe(true);
    expect(applied.at(-1)).toBe('group-one');
  });

  it('C02：两个实例注册同一物化函数，卸载一个不能取消另一个的屏障', () => {
    const key = 'C:/round3/shared-hook.md';
    seed(key, 'base'); initializeDocumentHistory(key, 'base', 'source');
    const releaseA = registerHistoryMaterializeHook(flushPendingSourceSnapshot);
    const releaseB = registerHistoryMaterializeHook(flushPendingSourceSnapshot);
    try {
      releaseA();
      stagePendingSourceSnapshot(key, { text: Text.of(['pending-edit']), revision: 1, isNewGroup: true });
      expect(getCurrentDocumentHistoryContent(key)).toBe('pending-edit');
    } finally { releaseB(); flushPendingSourceSnapshot(key); }
  });

  it('C03：旧 source pending 在同路径重开后不得绕过会话屏障写回新正文', () => {
    const key = 'C:/round3/pending-generation.md';
    seed(key, 'old-base'); initializeDocumentHistory(key, 'old-base', 'source');
    stagePendingSourceSnapshot(key, { text: Text.of(['old-pending']), revision: 9, isNewGroup: true });
    disposeDocumentSession(key); useDocumentStore.getState().remove(key);
    seed(key, 'new-session'); initializeDocumentHistory(key, 'new-session', 'source');
    flushPendingSourceSnapshot(key);
    expect(useDocumentStore.getState().getDocument(key)?.content).toBe('new-session');
  });
});
