// NoteBoard Markdown 导出 PDF 单元测试
// 覆盖 Windows / macOS / Linux 原生直出路径、取消与失败清理，以及网页端打印框的标题同步、不误报与快速失败

import type { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/** 构造最小可用的编辑器 DOM 桩对象 */
function createFakeEditor(html = '<p>测试正文</p>'): Editor {
  const dom = document.createElement('div');
  dom.className = 'ProseMirror';
  dom.innerHTML = html;
  document.body.appendChild(dom);
  return { view: { dom } } as unknown as Editor;
}

/** 构造可模拟异步加载完成的最小字体环境 */
function stubDocumentFonts(ready: Promise<unknown>): void {
  Object.defineProperty(document, 'fonts', {
    value: { ready },
    configurable: true,
  });
}

describe('markdownPdfExport 平台判定与路径推导', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  test('supportsDirectPdfExport：Windows / macOS / Linux 桌面端走直出，网页与移动端回退打印对话框', async () => {
    const { supportsDirectPdfExport } = await import('../../src/features/export/markdownPdfExport');

    expect(supportsDirectPdfExport(true, 'windows')).toBe(true);
    expect(supportsDirectPdfExport(true, 'macos')).toBe(true);
    expect(supportsDirectPdfExport(true, 'linux')).toBe(true);
    expect(supportsDirectPdfExport(true, 'android')).toBe(false);
    expect(supportsDirectPdfExport(false, 'macos')).toBe(false);
    expect(supportsDirectPdfExport(false, 'linux')).toBe(false);
    expect(supportsDirectPdfExport(false, 'web')).toBe(false);
  });

  test('defaultPdfPath 正确保留 macOS / Linux 目录并替换扩展名', async () => {
    const { defaultPdfPath } = await import('../../src/features/export/markdownPdfExport');

    expect(defaultPdfPath('计划.md', '/Users/demo/Notes/计划.md')).toBe('/Users/demo/Notes/计划.pdf');
    expect(defaultPdfPath('周报.md', '/home/demo/notes/周报.md')).toBe('/home/demo/notes/周报.pdf');
    expect(defaultPdfPath('笔记.markdown', null)).toBe('笔记.pdf');
    expect(defaultPdfPath('', null)).toBe('未命名.pdf');
  });
});

describe('exportMarkdownPdf 桌面直出与网页端打印容错', () => {
  const invoke = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    invoke.mockReset();
    document.body.innerHTML = '';
    document.documentElement.className = '';
    document.title = 'NoteBoard';
    stubDocumentFonts(Promise.resolve());
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(performance.now());
      return 1;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = '';
    document.documentElement.className = '';
    document.title = 'NoteBoard';
  });

  test.each([
    ['darwin', '/Users/demo/Desktop/文档.pdf', '/Users/demo/文档.pdf'],
    ['linux', '/home/demo/Documents/文档.pdf', '/home/demo/文档.pdf'],
  ])('%s 桌面端走原生 print_window_to_pdf 直出，不调用 window.print()', async (platform, target, defaultPath) => {
    vi.stubGlobal('__NB_TARGET_PLATFORM__', platform);
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
    vi.stubGlobal('isTauri', true);
    const printSpy = vi.fn();
    vi.stubGlobal('print', printSpy);

    invoke.mockImplementation(async (command: string) => {
      if (command === 'plugin:dialog|save') return target;
      if (command === 'print_window_to_pdf') {
        // 导出期间打印容器与标记类必须已经就位
        expect(document.getElementById('nb-pdf-root')).not.toBeNull();
        expect(document.documentElement.classList.contains('nb-pdf-exporting')).toBe(true);
        return;
      }
      throw new Error(`意外命令：${command}`);
    });

    const { exportMarkdownPdf } = await import('../../src/features/export/markdownPdfExport');
    const editor = createFakeEditor('<h1>标题</h1><p>正文</p>');

    const result = await exportMarkdownPdf(editor, { defaultPath });

    expect(result).toEqual({ path: target, fileName: '文档.pdf' });
    expect(printSpy).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('print_window_to_pdf', { path: target }, undefined);
    // 导出完成后必须卸载打印容器并清理标记类
    expect(document.getElementById('nb-pdf-root')).toBeNull();
    expect(document.documentElement.classList.contains('nb-pdf-exporting')).toBe(false);
  });

  test('macOS 用户取消另存为对话框时立即返回 null，不触发渲染与打印', async () => {
    vi.stubGlobal('__NB_TARGET_PLATFORM__', 'macos');
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
    vi.stubGlobal('isTauri', true);
    invoke.mockResolvedValueOnce(null);

    const { exportMarkdownPdf } = await import('../../src/features/export/markdownPdfExport');
    const editor = createFakeEditor();

    await expect(exportMarkdownPdf(editor, { defaultPath: '文档.pdf' })).resolves.toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(document.getElementById('nb-pdf-root')).toBeNull();
  });

  test('原生导出失败时抛出错误并清理打印容器', async () => {
    vi.stubGlobal('__NB_TARGET_PLATFORM__', 'macos');
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
    vi.stubGlobal('isTauri', true);

    invoke.mockImplementation(async (command: string) => {
      if (command === 'plugin:dialog|save') return '/Users/demo/fail.pdf';
      if (command === 'print_window_to_pdf') throw new Error('写入 PDF 失败，请确认目标位置可写');
      throw new Error(`意外命令：${command}`);
    });

    const { exportMarkdownPdf } = await import('../../src/features/export/markdownPdfExport');
    const editor = createFakeEditor();

    await expect(exportMarkdownPdf(editor, { defaultPath: 'fail.pdf' })).rejects.toThrow(
      '写入 PDF 失败，请确认目标位置可写',
    );
    expect(document.getElementById('nb-pdf-root')).toBeNull();
    expect(document.documentElement.classList.contains('nb-pdf-exporting')).toBe(false);
  });

  test('回退路径中 window.print() 返回被拒 Promise 时立即失败并恢复标题与容器，不再死等 60 秒', async () => {
    vi.stubGlobal('__NB_TARGET_PLATFORM__', 'web');
    vi.stubGlobal('isTauri', false);
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    document.title = 'note.md - NoteBoard';

    const denied = new Error('webview.print not allowed');
    vi.stubGlobal('print', vi.fn(() => Promise.reject(denied)));

    const { exportMarkdownPdf } = await import('../../src/features/export/markdownPdfExport');
    const editor = createFakeEditor();

    const start = performance.now();
    await expect(exportMarkdownPdf(editor, { defaultPath: 'note.pdf' })).rejects.toThrow(
      'webview.print not allowed',
    );
    // 必须快速失败，绝不能等到 60 秒兜底超时
    expect(performance.now() - start).toBeLessThan(5000);
    expect(document.title).toBe('note.md - NoteBoard');
    expect(document.getElementById('nb-pdf-root')).toBeNull();
    expect(document.documentElement.classList.contains('nb-pdf-exporting')).toBe(false);
  });

  test('网页端打印期间临时设置文档标题与 @page A4 样式，afterprint 后恢复并返回 null（不误报成功）', async () => {
    vi.stubGlobal('__NB_TARGET_PLATFORM__', 'web');
    vi.stubGlobal('isTauri', false);
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    document.title = '会议纪要.md - NoteBoard';

    let titleDuringPrint = '';
    vi.stubGlobal(
      'print',
      vi.fn(() => {
        titleDuringPrint = document.title;
        setTimeout(() => window.dispatchEvent(new Event('afterprint')), 10);
      }),
    );

    const { exportMarkdownPdf } = await import('../../src/features/export/markdownPdfExport');
    const editor = createFakeEditor();

    const result = await exportMarkdownPdf(editor, { defaultPath: '/notes/会议纪要.pdf' });

    expect(titleDuringPrint).toBe('会议纪要');
    expect(document.title).toBe('会议纪要.md - NoteBoard');
    // 网页端交由浏览器打印对话框处理，返回 null 避免取消打印时误弹成功提示
    expect(result).toBeNull();
    const styleText = document.getElementById('nb-pdf-print-style')?.textContent ?? '';
    expect(styleText).toContain('@page');
    expect(styleText).toContain('size: A4 portrait');
    expect(document.getElementById('nb-pdf-root')).toBeNull();
    expect(document.documentElement.classList.contains('nb-pdf-exporting')).toBe(false);
  });

  test('网页端在不触发 afterprint 但 print 媒体查询切回 false 时同样立即结束并恢复标题', async () => {
    vi.stubGlobal('__NB_TARGET_PLATFORM__', 'web');
    vi.stubGlobal('isTauri', false);
    document.title = 'webkit-doc.md - NoteBoard';

    let mediaChangeListener: ((event: MediaQueryListEvent) => void) | null = null;
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: false,
      addEventListener: vi.fn((_event: string, listener: (event: MediaQueryListEvent) => void) => {
        if (query === 'print') mediaChangeListener = listener;
      }),
      removeEventListener: vi.fn(),
    })));
    vi.stubGlobal(
      'print',
      vi.fn(() => {
        setTimeout(() => {
          mediaChangeListener?.({ matches: true } as MediaQueryListEvent);
          mediaChangeListener?.({ matches: false } as MediaQueryListEvent);
        }, 10);
      }),
    );

    const { exportMarkdownPdf } = await import('../../src/features/export/markdownPdfExport');
    const editor = createFakeEditor();

    const result = await exportMarkdownPdf(editor, { defaultPath: 'webkit-doc.pdf' });

    expect(result).toBeNull();
    expect(document.title).toBe('webkit-doc.md - NoteBoard');
    expect(document.getElementById('nb-pdf-root')).toBeNull();
    expect(document.documentElement.classList.contains('nb-pdf-exporting')).toBe(false);
  });

  test('字体加载长期不就绪时命中超时上限并继续完成导出', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('__NB_TARGET_PLATFORM__', 'macos');
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
    vi.stubGlobal('isTauri', true);
    // 模拟永不 resolve 的字体加载
    stubDocumentFonts(new Promise(() => {}));

    invoke.mockImplementation(async (command: string) => {
      if (command === 'plugin:dialog|save') return '/Users/demo/font-timeout.pdf';
      if (command === 'print_window_to_pdf') return;
      throw new Error(`意外命令：${command}`);
    });

    const { exportMarkdownPdf } = await import('../../src/features/export/markdownPdfExport');
    const editor = createFakeEditor();

    const exportPromise = exportMarkdownPdf(editor, { defaultPath: 'font-timeout.pdf' });
    await vi.advanceTimersByTimeAsync(4000);

    await expect(exportPromise).resolves.toEqual({
      path: '/Users/demo/font-timeout.pdf',
      fileName: 'font-timeout.pdf',
    });
    expect(document.getElementById('nb-pdf-root')).toBeNull();
  });
});
