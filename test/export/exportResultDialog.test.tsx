// 导出结果弹窗：成功时打开文件 / 在文件管理器中定位 / 关闭，失败时展示原因，无磁盘路径时退回 Toast
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ExportResultDialogHost } from '@/components/ExportResultDialogHost';
import { showExportError, showExportSuccess, useExportResultStore } from '@/stores/exportResultStore';
import { showToast } from '@/stores/toastStore';
import { revealInExplorer } from '@/core/ipc/commands';
import { openDocument } from '@/features/editor-code/orchestration/openDocument';

vi.mock('@/components/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/stores/toastStore', () => ({ showToast: vi.fn() }));
vi.mock('@/core/ipc/commands', () => ({ revealInExplorer: vi.fn() }));
vi.mock('@/features/editor-code/orchestration/openDocument', () => ({ openDocument: vi.fn() }));

const savedFile = { path: 'C:/导出/流程图.png', fileName: '流程图.png' };

let root: Root;
let host: HTMLDivElement;

beforeEach(async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.mocked(revealInExplorer).mockResolvedValue();
  vi.mocked(openDocument).mockResolvedValue('opened');
  useExportResultStore.setState({ request: null });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<ExportResultDialogHost />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

/** 按按钮文案查找弹窗内按钮 */
function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll<HTMLButtonElement>('.nb-export-result button'))
    .find((item) => item.textContent?.trim() === label);
  if (!found) throw new Error(`未找到按钮：${label}`);
  return found;
}

async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).click();
  });
}

describe('导出结果弹窗', () => {
  test('成功导出后展示文件名与完整路径', async () => {
    await act(async () => showExportSuccess(savedFile, '已导出 PNG 图片'));
    const dialog = document.querySelector('.nb-export-result.is-success')!;
    expect(dialog.querySelector('.nb-prompt-title')?.textContent).toBe('已导出 PNG 图片');
    expect(dialog.querySelector('.nb-prompt-desc')?.textContent).toBe('流程图.png');
    expect(dialog.querySelector('.nb-export-result-path')?.textContent).toBe(savedFile.path);
    expect(showToast).not.toHaveBeenCalled();
  });

  test('打开文件：关闭弹窗并在本软件中打开导出文件', async () => {
    await act(async () => showExportSuccess(savedFile, '已导出 PNG 图片'));
    await click('打开文件');
    await vi.waitFor(() => expect(openDocument).toHaveBeenCalledExactlyOnceWith(savedFile.path));
    expect(useExportResultStore.getState().request).toBeNull();
  });

  test('在文件管理器中定位导出文件', async () => {
    await act(async () => showExportSuccess(savedFile, '已导出 PNG 图片'));
    await click('在文件管理器中定位');
    expect(revealInExplorer).toHaveBeenCalledExactlyOnceWith(savedFile.path);
    expect(useExportResultStore.getState().request).toBeNull();
  });

  test('关闭按钮与 Esc 均关闭弹窗，不执行任何文件操作', async () => {
    await act(async () => showExportSuccess(savedFile, '已导出 PNG 图片'));
    await click('关闭');
    expect(useExportResultStore.getState().request).toBeNull();

    await act(async () => showExportSuccess(savedFile, '已导出 PNG 图片'));
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(useExportResultStore.getState().request).toBeNull();
    expect(openDocument).not.toHaveBeenCalled();
    expect(revealInExplorer).not.toHaveBeenCalled();
  });

  test('定位失败时提示错误', async () => {
    vi.mocked(revealInExplorer).mockRejectedValue('路径不存在');
    await act(async () => showExportSuccess(savedFile, '已导出 PNG 图片'));
    await click('在文件管理器中定位');
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith('无法打开文件夹：路径不存在', 'error'));
  });

  test('没有磁盘路径（浏览器下载、安卓 URI）时退回 Toast，不弹窗', async () => {
    await act(async () => showExportSuccess({ path: null, fileName: '流程图.png' }, '已导出 PNG 图片'));
    expect(showToast).toHaveBeenCalledExactlyOnceWith('已导出 PNG 图片', 'success');
    expect(useExportResultStore.getState().request).toBeNull();
    expect(document.querySelector('.nb-export-result')).toBeNull();
  });

  test('导出失败展示原因，只提供关闭', async () => {
    await act(async () => showExportError(new Error('磁盘空间不足'), '导出 CSV 失败'));
    const dialog = document.querySelector('.nb-export-result.is-error')!;
    expect(dialog.querySelector('.nb-prompt-title')?.textContent).toBe('导出 CSV 失败');
    expect(dialog.querySelector('.nb-export-result-error')?.textContent).toBe('磁盘空间不足');
    expect(() => button('打开文件')).toThrow();
    await click('关闭');
    expect(useExportResultStore.getState().request).toBeNull();
  });
});
