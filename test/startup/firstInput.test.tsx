// NoteBoard S08 Markdown 运行时拆分测试（真实渲染）
// 核心判定：源码首屏不创建隐藏 TipTap 实例（source 默认模式只建 CM）
// 说明：TipTap 内核在 jsdom 全量挂载存在 prosemirror 装饰兼容问题（详见实施进度 S08），
//       visual 内核创建/切换往返的协调逻辑由 coordinatorLazyMount.test.tsx 以内核替身覆盖；
//       完整真实行为在 S15 安装版回归验证。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TipTapEditor } from '@/features/editor-md/TipTapEditor';
import { getMdTipTapEditor, getMdSourceView } from '@/features/editor-md/editorInstances';
import { useDocumentStore } from '@/stores/documentStore';
import { useWindowStore } from '@/stores/windowStore';
import { useSettingsStore } from '@/stores/settingsStore';

vi.mock('@/core/ipc/commands', () => ({
  setDocumentDirty: vi.fn().mockResolvedValue(undefined),
  writeDocument: vi.fn().mockResolvedValue({ ok: true, mtime: 0, size: 0, error: null }),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'nb-main' }),
}));
// jsdom 缺少视口相关浏览器 API：隔离与判定无关的模块
vi.mock('@/features/editor-md/viewportActivation', () => ({
  observe: () => () => {},
  unobserve: () => {},
  isInViewport: () => false,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = 'C:\\t\\doc.md';
const CONTENT = '# 标题\n\n正文段落';

function seedDocument(): void {
  useDocumentStore.getState().upsertFromPayload({
    key: KEY,
    displayName: 'doc.md',
    dirPath: 'C:\\t',
    kind: 'markdown',
    language: 'markdown',
    content: CONTENT,
    encoding: 'utf8',
    eol: 'lf',
    size: CONTENT.length,
    mtime: 0,
    readonly: false,
  });
  useWindowStore.getState().openTab({
    key: KEY,
    displayName: 'doc.md',
    path: KEY,
    kind: 'markdown',
    language: 'markdown',
    isDirty: false,
    isPreview: false,
    viewMode: null,
    externalStatus: null,
    isDetached: false,
  });
}

describe('S08 源码首屏不创建隐藏 TipTap 实例', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWindowStore.setState({ tabs: [], activeKey: null, transferringKeys: [] });
    useDocumentStore.setState({ documents: new Map() });
    seedDocument();
    const current = useSettingsStore.getState().settings;
    useSettingsStore.setState({
      settings: {
        ...current,
        editor: { ...current.editor, defaultViewMode: 'source' as const },
      },
    });
  });

  it('source 默认模式：TipTap 内核不创建，源码 CM 实例正常建立', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root: Root = createRoot(host);
    act(() => {
      root.render(<TipTapEditor docKey={KEY} />);
    });
    // 排空初始化 effect 的 setTimeout(0)
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }
    try {
      // 🔴 S08 判定：TipTap 内核未创建（未挂载 VisualKernel）
      expect(getMdTipTapEditor(KEY)).toBeUndefined();
      // 源码模式 CM 实例已创建
      expect(getMdSourceView(KEY)).toBeDefined();
      // tab.viewMode 保持 null（跟随默认模式的原语义，不强制写回）
      expect(useWindowStore.getState().getTab(KEY)?.viewMode).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
