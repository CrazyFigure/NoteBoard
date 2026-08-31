// NoteBoard 图表导出工具的单元测试
// 覆盖 SVG 尺寸解析、SVG 归一化与导出文件名生成三条纯函数链路

import { describe, expect, test } from 'vitest';
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
  test('非 Tauri 浏览器环境下调用 exportBlobWithDialog 触发浏览器下载并返回 true', async () => {
    const blob = new Blob(['test content'], { type: 'text/plain' });
    const result = await exportBlobWithDialog(blob, 'test.txt', [
      { name: '文本文件 (*.txt)', extensions: ['txt'] },
    ]);
    expect(result).toBe(true);
  });
});
