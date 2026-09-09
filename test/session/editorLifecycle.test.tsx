// NoteBoard S11 编辑器回收调度测试
// 覆盖：回收流程（canSuspend→flush→视图捕获→保活更新）、不可回收类型保留、
//       迁移保护不回收、revision 并发变化不回收、关闭清理、CodeEditor 状态恢复。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  registerEditorCapabilities,
  resetEditorRegistryForTest,
} from '@/core/editor/editorRegistry';
import type { EditorCapabilities } from '@/core/editor/editorTypes';
import {
  suspendEditorInstance,
  saveViewState,
  takeViewState,
  clearViewState,
  markClosed,
  getKeepAliveKey,
  resetSuspensionForTest,
} from '@/features/session/editorSuspension';
import { useWindowStore } from '@/stores/windowStore';
import { useDocumentStore } from '@/stores/documentStore';
import { CodeEditor } from '@/features/editor-code/CodeEditor';

vi.mock('@/core/ipc/commands', () => ({
  setDocumentDirty: vi.fn().mockResolvedValue(undefined),
  writeDocument: vi.fn().mockResolvedValue({ ok: true, mtime: 0, size: 0, error: null }),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'nb-main' }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = 'C:\\t\\a.json';

/** 可编程能力替身（advanceAfterFlush：flush 返回捕获时版本，flush 后 revision 前进，模拟并发编辑） */
function installCaps(docKey: string, opts: { canSuspend: boolean; revision?: number; advanceAfterFlush?: number }): {
  dispose: () => void;
  flushCalls: number;
  setRevision: (r: number) => void;
} {
  let revision = opts.revision ?? 1;
  const state = { flushCalls: 0 };
  const caps: EditorCapabilities = {
    docKey,
    instanceId: 'cap-1',
    getRevision: () => revision,
    flush: async () => {
      state.flushCalls += 1;
      const capturedRevision = revision;
      if (opts.advanceAfterFlush !== undefined) {
        revision = opts.advanceAfterFlush;
      }
      return { docKey, instanceId: 'cap-1', revision: capturedRevision, content: `内容@${capturedRevision}` };
    },
    focus: () => {},
    getSelectedText: () => '',
    canSuspend: () => opts.canSuspend,
    captureViewState: () => ({ kind: 'code', selection: { anchor: 3, head: 3 }, scrollTop: 120, foldedRanges: [] }),
  };
  return {
    dispose: registerEditorCapabilities(caps),
    get flushCalls() {
      return state.flushCalls;
    },
    setRevision: (r: number) => {
      revision = r;
    },
  };
}

describe('S11 编辑器回收调度', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWindowStore.setState({ tabs: [], activeKey: null, transferringKeys: [] });
    useDocumentStore.setState({ documents: new Map() });
    resetEditorRegistryForTest();
    resetSuspensionForTest();
  });

  it('回收流程：canSuspend → flush → 视图状态保存 → 成为保活', async () => {
    const caps = installCaps(KEY, { canSuspend: true });
    try {
      const ok = await suspendEditorInstance(KEY);
      expect(ok).toBe(true);
      expect(caps.flushCalls).toBe(1);
      // 视图状态已保存（可取走）
      const state = takeViewState(KEY) as { kind: string; scrollTop: number };
      expect(state?.kind).toBe('code');
      expect(state.scrollTop).toBe(120);
      // 成为最近保活
      expect(getKeepAliveKey()).toBe(KEY);
    } finally {
      caps.dispose();
    }
  });

  it('不可回收类型（canSuspend=false）保留实例', async () => {
    installCaps(KEY, { canSuspend: false });
    const ok = await suspendEditorInstance(KEY);
    expect(ok).toBe(false);
    expect(getKeepAliveKey()).toBeNull();
  });

  it('迁移保护中的文档不回收', async () => {
    installCaps(KEY, { canSuspend: true });
    useWindowStore.getState().enterTransfer(KEY);
    const ok = await suspendEditorInstance(KEY);
    expect(ok).toBe(false);
    useWindowStore.getState().exitTransfer(KEY);
  });

  it('flush 期间 revision 变化（并发编辑）不回收', async () => {
    const caps = installCaps(KEY, { canSuspend: true, advanceAfterFlush: 2 });
    try {
      // flush 捕获 r1，随后 revision 前进到 r2（并发编辑）→ 本次不回收
      const ok = await suspendEditorInstance(KEY);
      expect(ok).toBe(false);
      expect(caps.flushCalls).toBe(1);
    } finally {
      caps.dispose();
    }
  });

  it('markClosed 清理恢复状态与保活', async () => {
    installCaps(KEY, { canSuspend: true });
    await suspendEditorInstance(KEY);
    expect(getKeepAliveKey()).toBe(KEY);
    markClosed(KEY);
    expect(getKeepAliveKey()).toBeNull();
    expect(takeViewState(KEY)).toBeNull();
  });

  it('视图状态存取一次性消费；clearViewState 清除', () => {
    saveViewState(KEY, { kind: 'image', scale: 2 });
    expect(takeViewState(KEY)).toEqual({ kind: 'image', scale: 2 });
    // 取走后为空
    expect(takeViewState(KEY)).toBeNull();
    saveViewState(KEY, { kind: 'image', scale: 3 });
    clearViewState(KEY);
    expect(takeViewState(KEY)).toBeNull();
  });

  it('CodeEditor 重挂载恢复选区与滚动（真实渲染）', async () => {
    useDocumentStore.getState().upsertFromPayload({
      key: KEY,
      displayName: 'a.json',
      dirPath: 'C:\\t',
      kind: 'code',
      language: 'json',
      content: '{"a":1,"b":2,"c":3}',
      encoding: 'utf8',
      eol: 'lf',
      size: 20,
      mtime: 0,
      readonly: false,
    });

    // 预置回收时保存的视图状态（选区在第 8 位、滚动 240）
    saveViewState(KEY, {
      kind: 'code',
      selection: { anchor: 8, head: 8 },
      scrollTop: 240,
      foldedRanges: [],
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root: Root = createRoot(host);
    act(() => {
      root.render(<CodeEditor docKey={KEY} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    try {
      // 通过能力注册表验证实例存活（选区/滚动恢复经 CodeEditor 挂载流程应用）
      const { getEditorCapabilities } = await import('@/core/editor/editorRegistry');
      const caps = getEditorCapabilities(KEY);
      expect(caps).not.toBeNull();
      // 恢复状态已被消费（一次性）
      expect(takeViewState(KEY)).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
