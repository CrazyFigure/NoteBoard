// NoteBoard 编辑器能力注册表测试（S02/S03：按 docKey+instanceId 注册）
// 覆盖：多标签各自实例不串线、卸载清理、旧实例清理不误删新实例（代际保护）、
//       双标签保存时 syncDocumentContent 经统一 flush 取到各自权威内容

import { describe, it, expect, beforeEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CodeEditor } from '@/features/editor-code/CodeEditor';
import { syncDocumentContent } from '@/features/editor-code/orchestration/syncDocumentContent';
import {
  getEditorCapabilities,
  resetEditorRegistryForTest,
} from '@/core/editor/editorRegistry';
import { useDocumentStore } from '@/stores/documentStore';
import { useWindowStore } from '@/stores/windowStore';

// CodeEditor 挂载路径会用到的 IPC 调用全部 mock，测试不触碰真实后端
vi.mock('@/core/ipc/commands', () => ({
  setDocumentDirty: vi.fn().mockResolvedValue(undefined),
  writeDocument: vi.fn().mockResolvedValue({ ok: true, mtime: 0, size: 0, error: null }),
}));

// React act 环境标记
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY_A = 'C:\\test\\a.json';
const KEY_B = 'C:\\test\\b.txt';

function mountEditor(docKey: string): { root: Root; host: HTMLDivElement } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<CodeEditor docKey={docKey} />);
  });
  return { root, host };
}

function unmountEditor(root: Root, host: HTMLDivElement): void {
  act(() => {
    root.unmount();
  });
  host.remove();
}

/** 构造一个可保存的 code 文档 payload 并写入 documentStore */
function seedDocument(key: string, content: string): void {
  useDocumentStore.getState().upsertFromPayload({
    key,
    displayName: key.split('\\').pop() ?? key,
    dirPath: key.substring(0, key.lastIndexOf('\\')) || key,
    kind: 'code',
    language: key.endsWith('.json') ? 'json' : 'plaintext',
    content,
    encoding: 'utf8',
    eol: 'lf',
    size: content.length,
    mtime: 0,
    readonly: false,
  });
}

describe('编辑器能力注册表（code 实例）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWindowStore.setState({ tabs: [], activeKey: null });
    useDocumentStore.setState({ documents: new Map() });
    resetEditorRegistryForTest();
    seedDocument(KEY_A, '{"a":1}');
    seedDocument(KEY_B, 'hello b');
  });

  it('两个代码标签各自注册能力，flush 取到互不串线的权威内容', async () => {
    const a = mountEditor(KEY_A);
    const b = mountEditor(KEY_B);
    try {
      const capsA = getEditorCapabilities(KEY_A);
      const capsB = getEditorCapabilities(KEY_B);
      expect(capsA).not.toBeNull();
      expect(capsB).not.toBeNull();
      expect(capsA!.instanceId).not.toBe(capsB!.instanceId);

      const capturedA = await capsA!.flush('save');
      const capturedB = await capsB!.flush('save');
      // 🔴 修复前的全局单例会指向最后挂载的实例，导致 A 拿到 B 的内容
      expect(capturedA!.content).toBe('{"a":1}');
      expect(capturedB!.content).toBe('hello b');
    } finally {
      unmountEditor(a.root, a.host);
      unmountEditor(b.root, b.host);
    }
  });

  it('卸载其中一个标签后其能力注销，另一个不受影响', async () => {
    const a = mountEditor(KEY_A);
    const b = mountEditor(KEY_B);
    unmountEditor(a.root, a.host);
    try {
      expect(getEditorCapabilities(KEY_A)).toBeNull();
      const capsB = getEditorCapabilities(KEY_B);
      expect(capsB).not.toBeNull();
      expect((await capsB!.flush('save'))!.content).toBe('hello b');
    } finally {
      unmountEditor(b.root, b.host);
    }
  });

  it('同 key 重挂载后旧实例的清理不得误删新实例（代际保护）', async () => {
    // rootA 挂载 KEY_A（instance 1）
    const a = mountEditor(KEY_A);
    // rootB 再挂载同一 KEY_A（instance 2，覆盖注册表）
    const b = mountEditor(KEY_A);
    const capsAfterRemount = getEditorCapabilities(KEY_A);
    expect(capsAfterRemount).not.toBeNull();

    // 旧实例（rootA）此时才卸载：其 disposer 必须发现注册表已是新实例而不删除
    unmountEditor(a.root, a.host);
    expect(getEditorCapabilities(KEY_A)).toBe(capsAfterRemount);
    expect((await capsAfterRemount!.flush('save'))!.content).toBe('{"a":1}');

    // 新实例卸载后注册表清空
    unmountEditor(b.root, b.host);
    expect(getEditorCapabilities(KEY_A)).toBeNull();
  });

  it('两个代码标签保存时 syncDocumentContent 经统一 flush 取到各自权威内容', async () => {
    const a = mountEditor(KEY_A);
    const b = mountEditor(KEY_B);
    try {
      const capsA = getEditorCapabilities(KEY_A)!;
      const capsB = getEditorCapabilities(KEY_B)!;
      const revA0 = capsA.getRevision();
      const revB0 = capsB.getRevision();

      // 后台标签 B 也要能取到权威内容（不再依赖 activeKey 校验与滞后镜像）
      useWindowStore.setState({ activeKey: KEY_A });
      const docB = await syncDocumentContent(KEY_B);
      const docA = await syncDocumentContent(KEY_A);
      expect(docA?.content).toBe('{"a":1}');
      expect(docB?.content).toBe('hello b');

      // 未发生新编辑时 revision 不变（递增逻辑由 editorRegistry 单测覆盖）
      expect(capsA.getRevision()).toBe(revA0);
      expect(capsB.getRevision()).toBe(revB0);
    } finally {
      unmountEditor(a.root, a.host);
      unmountEditor(b.root, b.host);
    }
  });
});
