// NoteBoard 图表导出工具的单元测试
// 覆盖 SVG 解析、导出命名，以及浏览器下载、桌面路径和安卓 content URI 保存链路

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  buildExportFileName,
  elementToSvgString,
  exportBlobWithDialog,
  normalizeSvg,
  parseSvgSize,
  stripExtension,
} from '../../src/features/export/chartExport';

/** Mermaid 典型输出：width 为百分比，真实尺寸只能从 viewBox 取 */
const MERMAID_SVG =
  '<svg aria-roledescription="flowchart-v2" width="100%" xmlns="http://www.w3.org/2000/svg" ' +
  'style="max-width: 480px; background-color: white;" viewBox="0 0 480 240">' +
  '<g><rect width="480" height="240"/></g></svg>';

/** PlantUML 典型输出：width / height 已是像素，且带 xlink 引用 */
const PLANTUML_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" ' +
  'style="width:320px;height:160px;" viewBox="0 0 320 160">' +
  '<image xlink:href="#inner" width="10" height="10"/></svg>';

describe('parseSvgSize', () => {
  test('优先取 viewBox 的宽高，忽略百分比 width', () => {
    expect(parseSvgSize(MERMAID_SVG)).toEqual({ width: 480, height: 240 });
  });

  test('无 viewBox 时回退到根标签的像素 width / height', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200px" height="90px"></svg>';
    expect(parseSvgSize(svg)).toEqual({ width: 200, height: 90 });
  });

  test('viewBox 与 width 都缺失时返回兜底尺寸', () => {
    expect(parseSvgSize('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toEqual({
      width: 800,
      height: 600,
    });
  });

  test('只匹配根 svg 标签，不被内嵌子 svg 干扰', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 300">' +
      '<svg viewBox="0 0 24 24"></svg></svg>';
    expect(parseSvgSize(svg)).toEqual({ width: 600, height: 300 });
  });
});

describe('normalizeSvg', () => {
  test('百分比 width 落成 viewBox 像素值，保证 <img> 有固有尺寸', () => {
    const result = normalizeSvg(MERMAID_SVG);
    expect(result).toContain('width="480"');
    expect(result).toContain('height="240"');
    expect(result).not.toContain('width="100%"');
  });

  test('移除根标签的 max-width，其余样式保留', () => {
    const result = normalizeSvg(MERMAID_SVG);
    expect(result).not.toContain('max-width');
    expect(result).toContain('background-color');
  });

  test('缺失 xmlns 时自动补齐', () => {
    const result = normalizeSvg('<svg viewBox="0 0 10 20"><rect/></svg>');
    expect(result).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  test('内容含 xlink:href 时补齐 xlink 命名空间', () => {
    const result = normalizeSvg(PLANTUML_SVG);
    expect(result).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
  });

  test('非法输入原样返回，不抛异常', () => {
    expect(normalizeSvg('')).toBe('');
    expect(normalizeSvg('<svg>&nbsp;</svg>')).toBe('<svg>&nbsp;</svg>');
  });
});

describe('elementToSvgString', () => {
  /** jsdom 不做布局，offsetWidth 恒为 0，这里手动给出布局尺寸 */
  function stubLayout(el: HTMLElement, width: number, height: number): void {
    Object.defineProperty(el, 'offsetWidth', { value: width, configurable: true });
    Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true });
  }

  test('输出带 xmlns 与 foreignObject 的 SVG 外壳', () => {
    const root = document.createElement('div');
    stubLayout(root, 400, 200);
    root.innerHTML = '<span style="color:#123456">指标</span>';
    document.body.appendChild(root);

    const result = elementToSvgString(root);
    expect(result).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(result).toContain('width="400"');
    expect(result).toContain('height="200"');
    expect(result).toContain('<foreignObject');
    expect(result).toContain('xmlns="http://www.w3.org/1999/xhtml"');
    // 内容必须被克隆进 foreignObject
    expect(result).toContain('指标');
    document.body.removeChild(root);
  });

  test('把元素自身样式内联进克隆节点（foreignObject 内拿不到页面样式表）', () => {
    const root = document.createElement('div');
    stubLayout(root, 100, 50);
    root.setAttribute('style', 'color: rgb(255, 0, 0)');
    document.body.appendChild(root);

    const result = elementToSvgString(root);
    expect(result).toContain('color');
    expect(result).toContain('rgb(255, 0, 0)');
    document.body.removeChild(root);
  });

  test('传入 background 时先铺一层背景矩形', () => {
    const root = document.createElement('div');
    stubLayout(root, 100, 50);
    document.body.appendChild(root);

    const result = elementToSvgString(root, { background: '#ffffff' });
    expect(result).toContain('<rect width="100%" height="100%" fill="#ffffff"/>');
    document.body.removeChild(root);
  });
});

describe('导出文件名', () => {
  test('stripExtension 去掉扩展名并剥离路径', () => {
    expect(stripExtension('架构图.mmd')).toBe('架构图');
    expect(stripExtension('C:\\notes\\q1.infographic')).toBe('q1');
    expect(stripExtension('无扩展名')).toBe('无扩展名');
    expect(stripExtension('')).toBe('');
  });

  test('buildExportFileName 优先用文档名并替换非法字符', () => {
    expect(buildExportFileName('流程 图:mmd', 'mermaid')).toBe('流程 图-mmd');
  });

  test('文档名为空时回退到「前缀-时间戳」', () => {
    const name = buildExportFileName('', 'infographic');
    expect(name).toMatch(/^infographic-\d+$/);
  });
});

describe('exportBlobWithDialog 与 saveBlobToFile 导出保存', () => {
  // 仅替换原生 IPC 边界，保留 dialog / fs 插件真实的命令名、路径编码与二进制序列化。
  const invoke = vi.fn();
  const filters = [{ name: 'PNG 图片 (*.png)', extensions: ['png'] }];
  // 包含零字节和高位字节，确保图片按二进制原样传递，而非经过文本转换。
  const bytes = new Uint8Array([0, 137, 80, 255]);

  /** jsdom 的 Blob 不提供 arrayBuffer；仅补齐读取接口，保留 Blob 类型和内容。 */
  function imageBlob(type = 'image/png'): Blob {
    const blob = new Blob([bytes], { type });
    Object.defineProperty(blob, 'arrayBuffer', { value: vi.fn().mockResolvedValue(bytes.buffer) });
    return blob;
  }

  beforeEach(() => {
    invoke.mockReset();
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
    vi.stubGlobal('isTauri', false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test('非 Tauri 浏览器环境下调用 exportBlobWithDialog 触发浏览器下载并返回 true', async () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn().mockReturnValue('blob:export-test');
    const revokeObjectURL = vi.fn();
    // URL 的静态方法在 jsdom 下缺失，仅补齐浏览器下载所需能力。
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.isConnected).toBe(true);
      expect(this.download).toBe('test.txt');
      expect(this.href).toBe('blob:export-test');
    });
    const blob = new Blob(['test content'], { type: 'text/plain' });
    const result = await exportBlobWithDialog(blob, 'test.txt', [
      { name: '文本文件 (*.txt)', extensions: ['txt'] },
    ]);
    expect(result).toBe(true);
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(click).toHaveBeenCalledOnce();
    expect(document.querySelector('a[download="test.txt"]')).toBeNull();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:export-test');
    expect(invoke).not.toHaveBeenCalled();
  });

  test.each([
    ['png', 'image/png', ['png']],
    ['jpg', 'image/jpeg', ['jpg', 'jpeg']],
    ['svg', 'image/svg+xml', ['svg']],
    ['xmind', 'application/zip', ['xmind']],
    ['md', 'text/markdown', ['md']],
    ['csv', 'text/csv', ['csv']],
  ])('安卓导出 %s：通过 fs 插件向 content URI 写入原始字节', async (extension, mime, extensions) => {
    vi.stubGlobal('isTauri', true);
    const target = `content://com.android.providers.downloads.documents/document/导图%3A1.${extension}`;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'plugin:dialog|save') return target;
      if (command === 'plugin:fs|write_file') return;
      throw new Error(`不应调用：${command}`);
    });
    const imageFilters = [{ name: '图片', extensions }];

    await expect(exportBlobWithDialog(imageBlob(mime), `导图.${extension}`, imageFilters)).resolves.toBe(true);

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenNthCalledWith(1, 'plugin:dialog|save', {
      options: { defaultPath: `导图.${extension}`, filters: imageFilters },
    }, undefined);
    expect(invoke).toHaveBeenNthCalledWith(2, 'plugin:fs|write_file', bytes, {
      headers: { path: encodeURIComponent(target), options: undefined },
    });
  });

  test.each(['C:\\Users\\测试\\导图.png', '/Users/test/导图.png', '/home/test/导图.png'])(
    'Windows / macOS / Linux 普通路径导出由 Rust 以二进制正文写盘：%s', async (target) => {
    vi.stubGlobal('isTauri', true);
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'plugin:dialog|save') return target;
      if (command === 'save_binary_file_raw') return { ok: true };
      throw new Error(`不应调用：${command}`);
    });

    await expect(exportBlobWithDialog(imageBlob(), '导图.png', filters)).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledTimes(2);
    // 原始字节作为正文、路径放在请求头，不再转换为 JSON 数字数组
    expect(invoke).toHaveBeenLastCalledWith('save_binary_file_raw', bytes, {
      headers: { 'x-nb-path': encodeURIComponent(target) },
    });
  });

  test('浏览器缺少下载能力时报告失败，不能返回成功', async () => {
    const UnsupportedURL = class extends URL {};
    Object.defineProperty(UnsupportedURL, 'createObjectURL', { value: undefined });
    vi.stubGlobal('URL', UnsupportedURL);
    await expect(exportBlobWithDialog(imageBlob(), '导图.png', filters)).rejects.toThrow('当前环境不支持下载文件');
  });

  test('取消系统保存对话框时不读取图片或写入文件', async () => {
    vi.stubGlobal('isTauri', true);
    vi.mocked(invoke).mockResolvedValue(null);
    const blob = imageBlob();

    await expect(exportBlobWithDialog(blob, '导图.png', filters)).resolves.toBe(false);
    expect(blob.arrayBuffer).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledOnce();
  });

  test('安卓 URI 写入失败时向调用方报告错误，不能回退成普通路径写盘', async () => {
    vi.stubGlobal('isTauri', true);
    const error = new Error('URI 写入权限失效');
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'plugin:dialog|save') return 'content://provider/document/1';
      throw error;
    });

    await expect(exportBlobWithDialog(imageBlob(), '导图.png', filters)).rejects.toBe(error);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(vi.mocked(invoke).mock.calls[1][0]).toBe('plugin:fs|write_file');
  });

  test('普通路径写入失败时保留现有错误提示', async () => {
    vi.stubGlobal('isTauri', true);
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'plugin:dialog|save') return 'C:\\导图.png';
      return { ok: false, error: { kind: 'disk-full' } };
    });

    await expect(exportBlobWithDialog(imageBlob(), '导图.png', filters)).rejects.toThrow('磁盘空间不足');
  });
});
