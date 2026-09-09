// NoteBoard S08 协调器惰性挂载逻辑测试（内核替身）
// VisualKernel 与序列化以可编程替身注入，验证协调器状态机：
// source 初始不挂载 → 切 visual 挂载并以待填充内容程序化设置；
// visual 初始（含大文档 banner 强制）路径与切换往返的内容传递。
// 🔴 注：全量并行跑时本文件的动态 import（TipTapEditor 真实模块图）在 worker
//    竞争下可能超过默认 5s 超时（四轮复审记录过同样波动：首次 595/598 → 复跑
//    598/598）；单跑稳定通过。timeout 放宽为 20s 消除资源竞争误报。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Editor } from '@tiptap/core';
import { emit } from '@/core/emitter';

// ── 模块级 mock（vi.mock 提升）：内核替身与序列化替身 ──

/** 程序化内容设置（parseMarkdown 替身）的调用记录 */
const parseCalls: string[] = [];
/** 替身内核挂载计数 */
let kernelMounts = 0;

vi.mock('@/features/editor-md/VisualKernel', () => ({
  VisualKernel: ({ onReady }: { onReady: (e: Editor | null) => void }) => {
    React.useEffect(() => {
      kernelMounts += 1;
      // 替身内核：挂载即 ready；提供 prosemirrorUndoDepth 所需的最小 history 插件状态
      const fake = {
        isFakeKernel: true,
        state: { history$: { done: { eventCount: 0 }, undone: { eventCount: 0 } }, 'history$1': { done: { eventCount: 0 }, undone: { eventCount: 0 } }, 'history$2': { done: { eventCount: 0 }, undone: { eventCount: 0 } } },
      } as unknown as Editor;
      onReady(fake);
      return () => onReady(null);
      }, [onReady]);
    return React.createElement('div', { 'data-testid': 'visual-kernel-stub' });
  },
}));

vi.mock('@/features/editor-md/serialize', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/editor-md/serialize')>();
  return {
    ...actual,
    parseMarkdown: (_editor: Editor, content: string) => {
      // 替身无法真实解析：只记录程序化设置的内容
      parseCalls.push(content);
    },
    serializeMarkdown: () => {
      // 替身内核的"序列化结果"：以最近一次程序化设置内容代替
      return parseCalls[parseCalls.length - 1] ?? '';
    },
  };
});

// CM 源码视图的修改内容经 documentStore 镜像读取：保留真实实现即可（协调器从
// getCurrentDocumentHistoryContent / store 读内容，与 CM 实例无关）

vi.mock('@/core/ipc/commands', () => ({
  setDocumentDirty: vi.fn().mockResolvedValue(undefined),
  writeDocument: vi.fn().mockResolvedValue({ ok: true, mtime: 0, size: 0, error: null }),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'nb-main' }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = 'C:\\t\\doc.md';
const CONTENT = '# 标题\n\n正文段落';
const EDITED = '# 修改后的标题\n\n新正文';

async function importCoordinator() {
  return import('@/features/editor-md/TipTapEditor');
}

async function mountCoordinator(): Promise<{ root: Root; host: HTMLDivElement }> {
  const { TipTapEditor } = await importCoordinator();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(TipTapEditor, { docKey: KEY }));
  });
  return { root, host };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

async function seedDocument(mode: 'visual' | 'source'): Promise<void> {
  const [{ useDocumentStore }, { useWindowStore }, { useSettingsStore }] = await Promise.all([
    import('@/stores/documentStore'),
    import('@/stores/windowStore'),
    import('@/stores/settingsStore'),
  ]);
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
  const current = useSettingsStore.getState().settings;
  useSettingsStore.setState({
    settings: { ...current, editor: { ...current.editor, defaultViewMode: mode } },
  });
}

describe('S08 协调器惰性挂载（内核替身）', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    parseCalls.length = 0;
    kernelMounts = 0;
      const [{ useDocumentStore }, { useWindowStore }] = await Promise.all([
      import('@/stores/documentStore'),
      import('@/stores/windowStore'),
    ]);
    useWindowStore.setState({ tabs: [], activeKey: null, transferringKeys: [] });
    useDocumentStore.setState({ documents: new Map() });
  });

  it('source 初始：内核替身不挂载、无程序化内容设置', { timeout: 20000 }, async () => {
    await seedDocument('source');
    const { root, host } = await mountCoordinator();
    await settle();
    try {
      expect(kernelMounts).toBe(0);
      expect(parseCalls).toHaveLength(0);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it('source→visual 切换：内核挂载一次，并以源码内容程序化填充', { timeout: 20000 }, async () => {
    await seedDocument('source');
    const { root, host } = await mountCoordinator();
    await settle();
    // 模拟源码模式中用户修改：经真实编辑链（统一历史 + 镜像）记录 EDITED
    const { useDocumentStore } = await import('@/stores/documentStore');
    const { recordDocumentChange } = await import(
      '@/features/history/documentHistory'
    );
    recordDocumentChange(KEY, EDITED, {
      mode: 'source',
      startsNewGroup: true,
      selection: { anchor: 0, head: 0 },
    });
    useDocumentStore.getState().setContent(KEY, EDITED);
    act(() => {
      emit('toggle-md-view-mode', { key: KEY, mode: 'visual' });
    });
    await settle();
    try {
      // 内核挂载（恰好一次；display 切换不重复挂载）
      expect(kernelMounts).toBe(1);
      // 待填充内容为源码编辑后的权威内容（历史当前内容或镜像）
      expect(parseCalls).toContain(EDITED);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it('visual 初始：内核挂载并以初始内容填充', { timeout: 20000 }, async () => {
    await seedDocument('visual');
    const { root, host } = await mountCoordinator();
    await settle();
    try {
      expect(kernelMounts).toBe(1);
      expect(parseCalls).toContain(CONTENT);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
