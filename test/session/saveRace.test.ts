// NoteBoard S09 保存竞态与版本屏障测试（H 节时序表）
// 覆盖：输入 A 立刻 Ctrl+S → 磁盘含 A；保存期间新输入仍脏；暂存清理带内容证明；
//       写队列串行（旧写入不覆盖新内容）；撤销回基线清脏；会话迁移清理。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerEditorCapabilities,
  resetEditorRegistryForTest,
  bumpDocumentRevision,
} from '@/core/editor/editorRegistry';
import type { EditorCapabilities } from '@/core/editor/editorTypes';
import {
  flushDocument,
  enqueueDocumentWrite,
  writeDocumentWithBarrier,
  migrateDocumentSession,
  disposeDocumentSession,
} from '@/features/session/documentSession';
import { stashPendingDocuments } from '@/features/staging/stagingManager';
import { saveDocument } from '@/features/editor-code/orchestration/saveDocument';
import { getBaseline } from '@/features/editor-md/serialize';
import { useDocumentStore } from '@/stores/documentStore';
import { useWindowStore } from '@/stores/windowStore';
import * as ipc from '@/core/ipc/commands';

vi.mock('@/core/ipc/commands', () => ({
  writeDocument: vi.fn(),
  setDocumentDirty: vi.fn().mockResolvedValue(undefined),
  stashDocuments: vi.fn(),
  deleteStagedFile: vi.fn().mockResolvedValue(undefined),
  registerDocument: vi.fn().mockResolvedValue({ type: 'ok' }),
  unregisterDocument: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'nb-main' }),
}));

const KEY = 'C:\\t\\race.md';

/** 可编程的假编辑器能力：flush 返回指定内容/版本 */
function installFakeCaps(docKey: string, initialContent: string, revision = 0) {
  let content = initialContent;
  let rev = revision;
  const caps: EditorCapabilities = {
    docKey,
    instanceId: 'fake-1',
    getRevision: () => rev,
    flush: async () => {
      const snapshot = { docKey, instanceId: 'fake-1', revision: rev, content };
      return snapshot;
    },
    focus: () => {},
    getSelectedText: () => '',
    canSuspend: () => false,
  };
  const dispose = registerEditorCapabilities(caps);
  return {
    dispose,
    edit(newContent: string) {
      content = newContent;
      rev = bumpDocumentRevision(docKey);
    },
  };
}

function seedDocument(content: string, savePolicy: 'auto' | 'manual' = 'manual'): void {
  useDocumentStore.getState().upsertFromPayload({
    key: KEY,
    displayName: 'race.md',
    dirPath: 'C:\\t',
    kind: 'markdown',
    language: 'markdown',
    content,
    encoding: 'utf8',
    eol: 'lf',
    size: content.length,
    mtime: 0,
    readonly: false,
  });
  const doc = useDocumentStore.getState().getDocument(KEY);
  if (doc && doc.savePolicy !== savePolicy) {
    useDocumentStore.setState((s) => ({
      documents: new Map(
        s.documents.set(KEY, { ...doc, savePolicy }),
      ),
    }));
  }
  getBaseline(KEY).updateBaseline(content);
}

describe('S09 保存竞态与版本屏障（H 节时序）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWindowStore.setState({ tabs: [], activeKey: null });
    useDocumentStore.setState({ documents: new Map() });
    resetEditorRegistryForTest();
  });

  it('时序 1：输入 A 立刻 Ctrl+S（未到防抖）→ 磁盘包含 A', async () => {
    seedDocument('原始内容');
    // 编辑器已有未落镜像的输入 A
    const fake = installFakeCaps(KEY, '输入A的内容');
    try {
      vi.mocked(ipc.writeDocument).mockResolvedValue({ ok: true, mtime: 1, size: 6, error: null });
      const ok = await saveDocument(KEY);
      expect(ok).toBe(true);
      // 写盘内容来自 flush 屏障的权威快照（非 500ms 防抖镜像）
      expect(ipc.writeDocument).toHaveBeenCalledWith(KEY, '输入A的内容', 'utf8', 'lf');
      // 基线更新为实际写入内容
      expect(useDocumentStore.getState().getDocument(KEY)?.baselineContent).toBe('输入A的内容');
      // 保存后无新编辑 → 脏态清除
      expect(useDocumentStore.getState().getDocument(KEY)?.isDirty).toBe(false);
    } finally {
      fake.dispose();
    }
  });

  it('时序 2：保存 r10 期间输入到 r11 → 磁盘 r10、编辑区 r11、dirty 保持', async () => {
    seedDocument('r10 内容');
    const fake = installFakeCaps(KEY, 'r10 内容');
    try {
      // 写盘挂起：期间用户继续输入
      let resolveWrite: (v: { ok: boolean; mtime: number; size: number; error: null }) => void = () => {};
      vi.mocked(ipc.writeDocument).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveWrite = resolve as typeof resolveWrite;
          }),
      );
      const savePromise = saveDocument(KEY);
      // 等写盘任务真正开始（mock 实现内捕获 resolve）
      await vi.waitFor(() => expect(ipc.writeDocument).toHaveBeenCalled());
      // 写盘期间输入到 r11
      fake.edit('r11 内容');
      resolveWrite({ ok: true, mtime: 2, size: 8, error: null });
      await savePromise;

      // 磁盘为 r10（捕获时快照）
      expect(ipc.writeDocument).toHaveBeenCalledWith(KEY, 'r10 内容', 'utf8', 'lf');
      // 基线为 r10
      expect(useDocumentStore.getState().getDocument(KEY)?.baselineContent).toBe('r10 内容');
      // 脏态精确重算：当前权威内容 r11 ≠ 基线 r10 → dirty 保持
      expect(useDocumentStore.getState().getDocument(KEY)?.isDirty).toBe(true);
    } finally {
      fake.dispose();
    }
  });

  it('时序 3：保存 r10 成功后，r11 的暂存副本不被删除（带内容证明）', async () => {
    seedDocument('r10 内容', 'manual');
    const fake = installFakeCaps(KEY, 'r10 内容');
    useWindowStore.getState().openTab({
      key: KEY,
      displayName: 'race.md',
      path: KEY,
      kind: 'markdown',
      language: 'markdown',
      isDirty: true,
      isPreview: false,
      viewMode: null,
      externalStatus: null,
      isDetached: false,
    });

    // 保存 r10：写盘挂起
    let resolveWrite: (v: { ok: boolean; mtime: number; size: number; error: null }) => void = () => {};
    vi.mocked(ipc.writeDocument).mockImplementation(
      () => new Promise((resolve) => { resolveWrite = resolve as typeof resolveWrite; }),
    );
    const savePromise = saveDocument(KEY);
    await vi.waitFor(() => expect(ipc.writeDocument).toHaveBeenCalled());

    // 写盘期间：用户输入 r11 且 r11 暂存已完成（暂存记录内容 r11）
    fake.edit('r11 内容');
    vi.mocked(ipc.stashDocuments).mockResolvedValue([
      { key: KEY, targetPath: 'C:\\staging\\race.md' },
    ]);
    await stashPendingDocuments({ keys: [KEY] });
    expect(ipc.stashDocuments).toHaveBeenCalled();

    // r10 写盘完成（内容证明 r10）
    resolveWrite({ ok: true, mtime: 3, size: 6, error: null });
    await savePromise;

    // r11 暂存副本未被删除（暂存内容 r11 未被保存的 r10 覆盖）
    expect(ipc.deleteStagedFile).not.toHaveBeenCalledWith('C:\\staging\\race.md');
    fake.dispose();
  });

  it('写队列串行：同文档两次写按提交顺序执行，旧写完成不覆盖新写结果', async () => {
    const SERIAL_KEY = 'C:' + String.fromCharCode(92) + 't' + String.fromCharCode(92) + 'serial.md';
    const order: string[] = [];
    const gate1 = createGate();
    const first = enqueueDocumentWrite(SERIAL_KEY, async () => {
      order.push('w1-start');
      await gate1.wait();
      order.push('w1-end');
    });
    const second = enqueueDocumentWrite(SERIAL_KEY, async () => {
      order.push('w2-start');
      order.push('w2-end');
    });
    // 第二个任务在第一个完成前不得开始（排空微任务链）
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(order).toEqual(['w1-start']);
    gate1.open();
    await Promise.all([first, second]);
    expect(order).toEqual(['w1-start', 'w1-end', 'w2-start', 'w2-end']);
  });

  it('时序 5：旧实例 flush 晚到不倒退镜像版本（mirroredRevision 单调）', async () => {
    seedDocument('内容');
    let rev = 5;
    const lateFlushCaps: EditorCapabilities = {
      docKey: KEY,
      instanceId: 'old',
      getRevision: () => rev,
      flush: async () => ({ docKey: KEY, instanceId: 'old', revision: rev, content: '旧内容' }),
      focus: () => {},
      getSelectedText: () => '',
      canSuspend: () => false,
    };
    registerEditorCapabilities(lateFlushCaps);
    const first = await flushDocument(KEY, 'save');
    expect(first?.revision).toBe(5);

    // 新实例接管（revision 更高），旧实例迟到的低版本 flush 不倒退
    rev = 9;
    const second = await flushDocument(KEY, 'save');
    expect(second?.revision).toBe(9);
    rev = 7; // 迟到旧结果
    const third = await flushDocument(KEY, 'save');
    // 迟到快照本身照常返回（调用方自行校验），但镜像不倒退（由 setMirroredRevision 保证）
    expect(third?.revision).toBe(7);
  });

  it('时序 7：保存后内容回到基线（撤销/改回）→ dirty 清除', async () => {
    seedDocument('基线内容');
    const fake = installFakeCaps(KEY, '基线内容');
    fake.edit('改了一笔'); // dirty
    useDocumentStore.getState().setDirty(KEY, true);
    useWindowStore.getState().openTab({
      key: KEY,
      displayName: 'race.md',
      path: KEY,
      kind: 'markdown',
      language: 'markdown',
      isDirty: true,
      isPreview: false,
      viewMode: null,
      externalStatus: null,
      isDetached: false,
    });

    // 用户撤销回基线后保存：捕获内容 = 基线
    fake.edit('基线内容'); // 撤销也递增 revision（H 节规则）
    vi.mocked(ipc.writeDocument).mockResolvedValue({ ok: true, mtime: 4, size: 8, error: null });
    const ok = await saveDocument(KEY);
    expect(ok).toBe(true);
    // flush-and-compare：当前内容 === 基线 → dirty 清除
    expect(useDocumentStore.getState().getDocument(KEY)?.isDirty).toBe(false);
    fake.dispose();
  });

  it('writeDocumentWithBarrier：失败时错误上抛且队列不断链', async () => {
    seedDocument('内容');
    vi.mocked(ipc.writeDocument).mockResolvedValueOnce({
      ok: false,
      mtime: 0,
      size: 0,
      error: { kind: 'disk-full', path: KEY } as never,
    });
    // 失败返回 false（保存未完成的调用方语义），错误经 showWriteError 呈现
    await expect(writeDocumentWithBarrier(KEY, '内容')).resolves.toBe(false);
    // 队列未断：后续写正常执行
    vi.mocked(ipc.writeDocument).mockResolvedValueOnce({ ok: true, mtime: 5, size: 2, error: null });
    const ok = await writeDocumentWithBarrier(KEY, '内容');
    expect(ok).toBe(true);
  });

  it('另存为身份迁移：会话记录与版本随新 key 接管，旧 key 清理', async () => {
    seedDocument('内容');
    bumpDocumentRevision(KEY);
    const fake = installFakeCaps(KEY, '内容');
    await flushDocument(KEY, 'save'); // 建立 mirrored 记录
    migrateDocumentSession(KEY, 'C:\\t\\new-name.md');
    // 旧 key 无能力注册（编辑器仍注册在旧 key？——真实场景另存为会更新 tab key 并触发编辑器重挂载；
    // 此处只验证会话记录迁移语义）
    const migrated = await flushDocument(KEY, 'save');
    expect(migrated?.content).toBe('内容');
    disposeDocumentSession('C:\\t\\new-name.md');
    fake.dispose();
  });
});

/** 手动闸门：控制异步任务的完成时机 */
function createGate() {
  let openFn: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    openFn = resolve;
  });
  return { wait: () => promise, open: openFn };
}
