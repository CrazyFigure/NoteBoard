// 覆盖网页导出被全局导航保护误拦截，以及原生画板使用脱离 DOM 的下载链接。
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { installAnchorNavigationGuard } from '@/core/anchorNavigation';
import { exportBlobWithDialog } from '@/features/export/chartExport';
import { showExportError, showExportSuccess } from '@/stores/exportResultStore';

vi.mock('@/features/export/chartExport', () => ({ exportBlobWithDialog: vi.fn() }));
vi.mock('@/stores/exportResultStore', () => ({ showExportSuccess: vi.fn(), showExportError: vi.fn() }));

let stop: (() => void) | undefined;
const blob = new Blob(['导出内容'], { type: 'text/plain' });
const savedFile = { path: 'C:/导出/画板.excalidraw.png', fileName: '画板.excalidraw.png' };

/** 构造与画板第三方下载器相同的链接；默认不挂到 DOM。 */
function downloadLink(href = 'blob:board-export', filename = '画板.excalidraw.png'): HTMLAnchorElement {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  return anchor;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(exportBlobWithDialog).mockResolvedValue(savedFile);
  vi.stubGlobal('isTauri', true);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => blob }));
});

afterEach(() => {
  stop?.();
  stop = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('跨平台导出链接', () => {
  test.each(['blob:board-export', 'data:image/svg+xml,%3Csvg/%3E'])('浏览器保留 %s 下载默认行为', (href) => {
    vi.stubGlobal('isTauri', false);
    const originalClick = HTMLAnchorElement.prototype.click;
    stop = installAnchorNavigationGuard();
    const anchor = downloadLink(href);
    document.body.append(anchor);
    // 在目标节点记录窗口捕获阶段的处理结果，然后取消真实导航，避免 jsdom 启动下载。
    let blocked: boolean | undefined;
    anchor.addEventListener('click', (event) => { blocked = event.defaultPrevented; event.preventDefault(); });
    anchor.click();

    expect(blocked).toBe(false);
    expect(HTMLAnchorElement.prototype.click).toBe(originalClick);
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([false, true])('原生端保存下载（挂到 DOM：%s），且保留第三方清理回调', async (attached) => {
    stop = installAnchorNavigationGuard();
    const anchor = downloadLink();
    if (attached) document.body.append(anchor);
    const cleanup = vi.fn();
    anchor.addEventListener('click', cleanup);
    anchor.click();

    // 读取必须在 click 返回前启动，调用方此后即使撤销 URL 也不会丢失数据源。
    expect(fetch).toHaveBeenCalledExactlyOnceWith('blob:board-export');
    expect(cleanup).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(exportBlobWithDialog).toHaveBeenCalledExactlyOnceWith(
      blob, '画板.excalidraw.png', [{ name: '导出文件', extensions: ['png'] }],
    ));
    // 保存成功后弹出导出结果窗，携带磁盘路径供打开文件与定位
    await vi.waitFor(() => expect(showExportSuccess).toHaveBeenCalledExactlyOnceWith(savedFile, '已导出 PNG 文件'));
    expect(showExportError).not.toHaveBeenCalled();
  });

  test('data URL 导出原始场景文件时保留文件名与扩展名', async () => {
    stop = installAnchorNavigationGuard();
    downloadLink('data:application/json,%7B%7D', '画板.excalidraw').click();

    await vi.waitFor(() => expect(exportBlobWithDialog).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'application/json', size: 2 }),
      '画板.excalidraw', [{ name: '导出文件', extensions: ['excalidraw'] }],
    ));
    expect(fetch).not.toHaveBeenCalled();
  });

  test('用户取消原生保存时不报错', async () => {
    vi.mocked(exportBlobWithDialog).mockResolvedValue(null);
    stop = installAnchorNavigationGuard();
    downloadLink().click();

    await vi.waitFor(() => expect(exportBlobWithDialog).toHaveBeenCalledOnce());
    expect(showExportSuccess).not.toHaveBeenCalled();
    expect(showExportError).not.toHaveBeenCalled();
  });

  test('读取或写入失败会显示错误，不会成为未处理的 Promise', async () => {
    vi.mocked(exportBlobWithDialog).mockRejectedValue(new Error('磁盘空间不足'));
    stop = installAnchorNavigationGuard();
    downloadLink().click();

    await vi.waitFor(() => expect(showExportError).toHaveBeenCalledWith(new Error('磁盘空间不足')));
  });

  test('下载源读取失败时不弹保存对话框', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);
    stop = installAnchorNavigationGuard();
    downloadLink().click();

    await vi.waitFor(() => expect(showExportError).toHaveBeenCalledWith(new Error('无法读取导出文件')));
    expect(exportBlobWithDialog).not.toHaveBeenCalled();
  });

  test.each([false, true])('普通链接在浏览器和原生端仍然禁止默认导航（原生：%s）', (native) => {
    vi.stubGlobal('isTauri', native);
    stop = installAnchorNavigationGuard();
    const anchor = document.createElement('a');
    anchor.href = 'https://example.com';
    document.body.append(anchor);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchor.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('卸载后恢复 click 原有属性和全局监听，支持重复挂载', () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, 'click');
    const originalClick = HTMLAnchorElement.prototype.click;
    for (let index = 0; index < 2; index += 1) {
      const dispose = installAnchorNavigationGuard();
      expect(HTMLAnchorElement.prototype.click).not.toBe(originalClick);
      dispose();
      expect(HTMLAnchorElement.prototype.click).toBe(originalClick);
      expect(Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, 'click')).toEqual(originalDescriptor);
    }
  });
});
