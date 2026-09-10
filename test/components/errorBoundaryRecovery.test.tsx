// NoteBoard 全局错误恢复位置测试
// 验证异常发生后重建界面时，活动编辑器的选区和滚动位置不会回到文档开头。

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../../src/components/ErrorBoundary';
import {
  registerEditorCapabilities,
  resetEditorRegistryForTest,
} from '../../src/core/editor/editorRegistry';
import type { EditorCapabilities } from '../../src/core/editor/editorTypes';
import {
  resetSuspensionForTest,
  takeViewState,
} from '../../src/features/session/editorSuspension';
import { useWindowStore } from '../../src/stores/windowStore';

const DOCUMENT_KEY = 'C:\\recovery\\long-document.md';

beforeEach(() => {
  resetEditorRegistryForTest();
  resetSuspensionForTest();
  useWindowStore.setState({ activeKey: DOCUMENT_KEY });
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

it('点击恢复后应把错误前捕获的 Markdown 视图状态交给新编辑器', async () => {
  const expectedViewState = {
    kind: 'markdown' as const,
    selection: { anchor: 4321, head: 4388 },
    scrollTop: 9876,
    mode: 'visual' as const,
  };
  const capabilities = {
    docKey: DOCUMENT_KEY,
    instanceId: 'recovery-test',
    getRevision: () => 0,
    flush: async () => null,
    focus: () => undefined,
    getSelectedText: () => '',
    canSuspend: () => true,
    captureViewState: () => expectedViewState,
  } satisfies EditorCapabilities;
  const dispose = registerEditorCapabilities(capabilities);
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  let shouldCrash = true;

  function CrashOnce() {
    if (shouldCrash) {
      throw new Error('模拟界面异常');
    }
    const restored = takeViewState(DOCUMENT_KEY) as typeof expectedViewState | null;
    return <div data-testid="restored-position">{restored?.scrollTop ?? -1}</div>;
  }

  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(<ErrorBoundary><CrashOnce /></ErrorBoundary>);
    });
    expect(host.textContent).toContain('界面渲染异常');

    const recoverButton = host.querySelector('button');
    expect(recoverButton).not.toBeNull();
    // 模拟根因已由错误边界卸载旧树后消失，点击恢复时允许新编辑器正常挂载。
    shouldCrash = false;
    await act(async () => {
      recoverButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(host.querySelector('[data-testid="restored-position"]')?.textContent).toBe('9876');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    dispose();
    consoleError.mockRestore();
  }
});
