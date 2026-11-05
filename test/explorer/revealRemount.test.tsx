// NoteBoard 侧栏收起时打开文件夹测试
// 覆盖：侧栏收起（Explorer 卸载）期间打开文件夹 → 自动展开侧栏，重新挂载后跟随逻辑不覆盖新根目录；
//       收起期间切换标签 → 展开后仍跟随到新活动文件。

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readDirMock = vi.fn().mockResolvedValue([]);
vi.mock('@/core/ipc/commands', () => ({
  readDir: (...args: unknown[]) => readDirMock(...args),
  pushRecent: vi.fn().mockResolvedValue(undefined),
}));

// 文件夹选择对话框替身：返回预设目录
const dialogOpenMock = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (...args: unknown[]) => dialogOpenMock(...args),
}));

import { useReveal } from '@/features/explorer/useReveal';
import { useExplorerStore } from '@/features/explorer/explorerStore';
import { useDocumentStore } from '@/stores/documentStore';
import { useWindowStore } from '@/stores/windowStore';
import { useLayoutStore } from '@/stores/layoutStore';
import { openFolderDialog } from '@/features/welcome/welcomeActions';

const DIR_A = 'C:\\t\\a';
const DIR_B = 'C:\\t\\b';
const FOLDER = 'C:\\t\\picked';

/** 建立已打开的文档并激活其标签 */
function openFile(dir: string, name: string): void {
  const key = `${dir}\\${name}`;
  useDocumentStore.getState().upsertFromPayload({
    key,
    displayName: name,
    dirPath: dir,
    kind: 'markdown',
    language: 'markdown',
    content: '',
    encoding: 'utf8',
    eol: 'lf',
    size: 0,
    mtime: 1,
    readonly: false,
  });
  useWindowStore.getState().openTab({
    key,
    displayName: name,
    path: key,
    kind: 'markdown',
    language: 'markdown',
    isDirty: false,
    isPreview: false,
    viewMode: null,
    externalStatus: null,
    isDetached: false,
  });
}

const revealRender = vi.fn();
function RevealProbe() {
  revealRender();
  useReveal();
  return null;
}

let container: HTMLDivElement;
let root: Root | null = null;

async function mountExplorer(): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root!.render(<RevealProbe />);
  });
}

async function unmountExplorer(): Promise<void> {
  await act(async () => {
    root?.unmount();
  });
  root = null;
}

describe('侧栏收起时打开文件夹', () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    useExplorerStore.getState().clear();
    useLayoutStore.getState().setExplorerVisible(true);
  });

  afterEach(async () => {
    await unmountExplorer();
    container.remove();
  });

  it('收起后打开文件夹：自动展开侧栏且重新挂载不改回活动文件目录', async () => {
    openFile(DIR_A, 'a.md');
    await mountExplorer();
    expect(useExplorerStore.getState().root).toBe(DIR_A);

    // 收起侧栏（Explorer 卸载）后打开文件夹
    useLayoutStore.getState().setExplorerVisible(false);
    await unmountExplorer();
    dialogOpenMock.mockResolvedValueOnce(FOLDER);
    await openFolderDialog();

    expect(useLayoutStore.getState().explorerVisible).toBe(true);
    await mountExplorer();
    expect(useExplorerStore.getState().root).toBe(FOLDER);
  });

  it('收起期间切换标签：展开后仍跟随新活动文件', async () => {
    openFile(DIR_A, 'a.md');
    await mountExplorer();
    await unmountExplorer();

    openFile(DIR_B, 'b.md');
    await mountExplorer();
    expect(useExplorerStore.getState().root).toBe(DIR_B);
  });

  it('连续输入只更新正文，文件树跟随组件不随正文或脏态重绘', async () => {
    openFile(DIR_A, 'typing.md');
    await mountExplorer();
    const key = useWindowStore.getState().activeKey!;
    revealRender.mockClear();
    readDirMock.mockClear();
    for (let i = 0; i < 10; i += 1) {
      await act(async () => {
        useDocumentStore.getState().setDirty(key, true);
        useDocumentStore.getState().setContent(key, `输入 ${i}`);
      });
    }
    expect(revealRender).not.toHaveBeenCalled();
    expect(readDirMock).not.toHaveBeenCalled();
    expect(useExplorerStore.getState().root).toBe(DIR_A);
  });
});
