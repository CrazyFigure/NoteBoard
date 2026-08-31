// NoteBoard 图表导出统一工具
// 为 Mermaid / PlantUML / Infographic 的独立文件编辑器与 Markdown 内嵌块提供一致的
// 「复制 / 导出 SVG 与 PNG」能力。
//
// 设计要点：
// 1. Tauri WebView2 不会接管 blob URL 下载，直接构造游离 <a download> 会静默失效，
//    因此保存统一走「系统另存为对话框 + Rust save_binary_file」，浏览器环境才回退到 <a> 下载。
// 2. 图表来源分两类：现成的 SVG 字符串（Mermaid / PlantUML）与已渲染的 DOM 节点（Infographic）。
//    DOM 节点走 foreignObject 包裹方案：foreignObject 内不继承页面样式表与 CSS 变量，
//    必须逐个把 computedStyle 内联到克隆节点上，否则导出结果是一片白。
// 3. SVG → PNG 走「data URL 载入 <img> → 绘制到 canvas」，data URL 用 encodeURIComponent
//    而非 btoa，避免中文标签触发 InvalidCharacterError。

import { isTauri } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import * as ipc from '../../core/ipc/commands';
import type { WriteError } from '../../core/ipc/types';

/** 可导出的图片格式 */
export type ChartImageFormat = 'svg' | 'png';

/** SVG 命名空间 */
const SVG_NS = 'http://www.w3.org/2000/svg';
/** XLink 命名空间（部分 PlantUML / Mermaid 图会用 xlink:href 引用内部元素） */
const XLINK_NS = 'http://www.w3.org/1999/xlink';
/** XHTML 命名空间（foreignObject 内嵌 HTML 必须声明） */
const XHTML_NS = 'http://www.w3.org/1999/xhtml';

/** 无法从 SVG 中解析出尺寸时的兜底画布大小 */
const FALLBACK_SIZE = { width: 800, height: 600 };

/** PNG 默认导出倍数：2 倍保证粘贴到文档后文字不糊 */
const DEFAULT_PNG_SCALE = 2;
/** PNG 默认背景：多数图表自身透明，落到白色更符合粘贴到文档/聊天窗口的预期 */
const DEFAULT_PNG_BACKGROUND = '#ffffff';

/**
 * 图表导出来源
 * - svg：Mermaid / PlantUML 渲染得到的 SVG 文本
 * - element：Infographic 这类纯 HTML 渲染结果，导出时抓取实时 DOM 快照
 */
export type ChartImageSource =
  | { kind: 'svg'; svg: string }
  | { kind: 'element'; element: HTMLElement | null; background?: string };

export interface ChartSize {
  width: number;
  height: number;
}

/** PNG 栅格化参数 */
export interface ChartRasterOptions {
  /** 放大倍数，默认 2 */
  scale?: number;
  /** 背景填充色，默认白色 */
  background?: string;
}

// ── SVG 尺寸解析与归一化 ──

/**
 * 取出根 `<svg>` 的开始标签，避免匹配到内嵌子 `<svg>`（Mermaid 图标会嵌套）
 */
function readSvgOpenTag(svgText: string): string {
  const match = /<svg\b[^>]*>/i.exec(svgText);
  return match ? match[0] : '';
}

/**
 * 读取根 `<svg>` 标签上的数值型属性（忽略 100% / auto 这类非像素值）
 */
function readNumericAttribute(openTag: string, attr: string): number {
  const match = new RegExp(`${attr}\\s*=\\s*["']\\s*([\\d.]+)\\s*(?:px)?\\s*["']`, 'i').exec(openTag);
  if (!match) return 0;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * 解析 SVG 的固有尺寸：优先 viewBox，其次根标签的 width / height
 * Mermaid 常输出 width="100%" + viewBox，只有 viewBox 能拿到真实像素尺寸
 */
export function parseSvgSize(svgText: string): ChartSize {
  const openTag = readSvgOpenTag(svgText);
  const viewBox = /viewBox\s*=\s*["']\s*(-?[\d.]+)[,\s]+(-?[\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)\s*["']/i.exec(
    openTag,
  );
  if (viewBox) {
    const width = Number(viewBox[3]);
    const height = Number(viewBox[4]);
    if (width > 0 && height > 0) return { width, height };
  }

  const width = readNumericAttribute(openTag, 'width');
  const height = readNumericAttribute(openTag, 'height');
  if (width > 0 && height > 0) return { width, height };

  return { ...FALLBACK_SIZE };
}

/**
 * 在根 `<svg>` 开始标签上补齐命名空间声明
 * 必须在 DOMParser 之前做：XML 解析器遇到未声明的 xlink 前缀会直接报
 * "unbound namespace prefix"，整份 SVG 都会解析失败
 */
function ensureSvgNamespaces(svgText: string): string {
  const match = /<svg\b[^>]*>/i.exec(svgText);
  if (!match) return svgText;

  let openTag = match[0];
  if (!/\sxmlns\s*=/i.test(openTag)) {
    openTag = openTag.replace(/<svg\b/i, `<svg xmlns="${SVG_NS}"`);
  }
  if (svgText.includes('xlink:href') && !/\sxmlns:xlink\s*=/i.test(openTag)) {
    openTag = openTag.replace(/<svg\b/i, `<svg xmlns:xlink="${XLINK_NS}"`);
  }
  return svgText.slice(0, match.index) + openTag + svgText.slice(match.index + match[0].length);
}

/**
 * 归一化 SVG 文本，使其成为合法的独立 SVG 图片源：
 * 1. 补齐 xmlns / xmlns:xlink
 * 2. 把百分比或缺失的 width / height 落成 viewBox 像素值
 * 3. 去掉根标签的 max-width / max-height（会让 <img> 固有尺寸退化，导致 PNG 模糊）
 */
export function normalizeSvg(svgText: string): string {
  const trimmed = svgText.trim();
  if (!trimmed) return trimmed;

  const doc = new DOMParser().parseFromString(ensureSvgNamespaces(trimmed), 'image/svg+xml');
  const root = doc.documentElement;
  // 解析失败（如 SVG 内含有 XML 未定义实体）时原样返回，交由下游按原文本处理
  if (!root || root.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) {
    return trimmed;
  }

  if (!root.getAttribute('xmlns')) root.setAttribute('xmlns', SVG_NS);
  if (trimmed.includes('xlink:href') && !root.getAttribute('xmlns:xlink')) {
    root.setAttribute('xmlns:xlink', XLINK_NS);
  }

  const size = parseSvgSize(trimmed);
  const width = root.getAttribute('width');
  const height = root.getAttribute('height');
  const isPixel = (value: string | null): boolean => !!value && /^[\d.]+(px)?$/.test(value.trim());
  if (!isPixel(width)) root.setAttribute('width', String(size.width));
  if (!isPixel(height)) root.setAttribute('height', String(size.height));

  const style = root.getAttribute('style');
  if (style) {
    const kept = style
      .split(';')
      .map((decl) => decl.trim())
      .filter((decl) => decl && !/^(max-width|max-height)\s*:/i.test(decl));
    if (kept.length > 0) {
      root.setAttribute('style', kept.join(';'));
    } else {
      root.removeAttribute('style');
    }
  }

  return new XMLSerializer().serializeToString(root);
}

// ── DOM → SVG（foreignObject 方案）──

/** 内联样式时需要跳过的属性：交互态与动画类属性在静态导出中无意义且可能干扰布局 */
const SKIPPED_STYLE_PROPS = new Set(['transition', 'animation', 'cursor', 'pointer-events']);

/**
 * 取元素布局尺寸
 * 用 offsetWidth / offsetHeight 而非 getBoundingClientRect：后者会被预览区的
 * CSS scale 缩放污染，导出的画布会跟着缩放系数变大变小
 */
function measureElement(element: Element): ChartSize {
  const htmlEl = element as HTMLElement;
  const width = htmlEl.offsetWidth;
  const height = htmlEl.offsetHeight;
  if (typeof width === 'number' && typeof height === 'number' && (width > 0 || height > 0)) {
    return { width, height };
  }
  // 退化路径（display:contents 等无盒模型节点）：退回视口矩形兜底，避免整图塌成 1px
  const rect = element.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

/**
 * 把 computedStyle 逐个内联到克隆节点及其子节点上
 * foreignObject 内部是独立文档环境，拿不到页面样式表，也解析不了 var(--xxx)，
 * 因此必须在 DOM 树里把「已经解析成具体值」的样式写死
 */
function inlineComputedStyles(source: Element, target: Element): void {
  const computed = window.getComputedStyle(source);
  const declarations: string[] = [];
  for (let i = 0; i < computed.length; i += 1) {
    const prop = computed[i];
    if (SKIPPED_STYLE_PROPS.has(prop)) continue;
    const value = computed.getPropertyValue(prop);
    if (!value) continue;
    declarations.push(`${prop}:${value}`);
  }

  // SVG 子元素（lucide 图标等）靠属性定位，强行覆写 width / height 会让图标变形
  const isSvgNode = source.namespaceURI === SVG_NS;
  if (isSvgNode) {
    target.setAttribute('style', declarations.join(';'));
  } else {
    // 统一改成 border-box，配合下面写入的边框盒尺寸，避免 padding/border 再把盒子撑大
    declarations.push('box-sizing:border-box');
    const size = measureElement(source);
    if (size.width > 0) declarations.push(`width:${size.width}px`);
    if (size.height > 0) declarations.push(`height:${size.height}px`);
    target.setAttribute('style', declarations.join(';'));
  }

  const sourceChildren = source.children;
  const targetChildren = target.children;
  const count = Math.min(sourceChildren.length, targetChildren.length);
  for (let i = 0; i < count; i += 1) {
    inlineComputedStyles(sourceChildren[i], targetChildren[i]);
  }
}

/**
 * 把已渲染的 DOM 节点序列化为 SVG 图片源（foreignObject 包裹）
 */
export function elementToSvgString(
  element: HTMLElement,
  options: { background?: string } = {},
): string {
  const size = measureElement(element);
  const width = Math.max(1, Math.round(size.width));
  const height = Math.max(1, Math.round(size.height));

  const clone = element.cloneNode(true) as HTMLElement;
  inlineComputedStyles(element, clone);
  clone.setAttribute('xmlns', XHTML_NS);
  clone.style.margin = '0';

  const serialized = new XMLSerializer().serializeToString(clone);
  const backdrop = options.background
    ? `<rect width="100%" height="100%" fill="${options.background}"/>`
    : '';

  return (
    `<svg xmlns="${SVG_NS}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    backdrop +
    `<foreignObject x="0" y="0" width="${width}" height="${height}">` +
    serialized +
    '</foreignObject></svg>'
  );
}

// ── SVG → PNG ──

/**
 * 把 SVG 文本栅格化为 PNG
 * @param scale 放大倍数，2 倍可在高 DPI 下保持清晰
 * @param background 背景填充色，留空则保留透明通道
 */
export async function svgToPngBlob(
  svgText: string,
  options: { scale?: number; background?: string } = {},
): Promise<Blob> {
  const scale = options.scale && options.scale > 0 ? options.scale : DEFAULT_PNG_SCALE;
  const size = parseSvgSize(svgText);
  const width = Math.max(1, Math.round(size.width * scale));
  const height = Math.max(1, Math.round(size.height * scale));

  // data URL 不能用 btoa：中文标签会抛 InvalidCharacterError，改用百分号编码
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
  const image = new Image();
  image.decoding = 'sync';

  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('SVG 无法作为图片加载，可能包含不受支持的语法'));
    image.src = dataUrl;
  });

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 绘图上下文');

  if (options.background) {
    ctx.fillStyle = options.background;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(image, 0, 0, width, height);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('PNG 编码失败'))),
      'image/png',
    );
  });
}

// ── 剪贴板与文件落盘 ──

/** 复制纯文本，Clipboard API 不可用时回退到 execCommand */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    const ok = document.execCommand('copy');
    if (!ok) throw new Error('execCommand 复制失败');
  } finally {
    document.body.removeChild(textarea);
  }
}

/** 复制图片二进制到系统剪贴板（仅 PNG 有意义） */
export async function copyImage(blob: Blob): Promise<void> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    throw new Error('当前环境不支持复制图片，请改用导出 PNG');
  }
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
}

/** 浏览器环境（非 Tauri）下的兜底下载：必须挂到 DOM 上，否则 WebView 不触发 */
function downloadBlob(blob: Blob, filename: string): void {
  if (typeof URL.createObjectURL !== 'function') {
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 撤销必须延后，同步撤销会让下载在真正开始前就失去数据源
  setTimeout(() => {
    if (typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(url);
    }
  }, 1000);
}

/** 对话框文件类型过滤器类型 */
export interface DialogFilter {
  name: string;
  extensions: string[];
}

/**
 * 弹系统另存为对话框并保存二进制 Blob 文件
 * 支持 Tauri WebView2 本地文件系统直写，以及浏览器环境下的 Blob 链接下载兜底
 * @returns 用户取消时返回 false，成功保存返回 true
 */
export async function exportBlobWithDialog(
  blob: Blob,
  defaultFilename: string,
  filters: DialogFilter[],
): Promise<boolean> {
  // 浏览器非 Tauri 环境下走 <a> 链接模拟点击下载
  if (!isTauri()) {
    downloadBlob(blob, defaultFilename);
    return true;
  }

  // 唤起系统原生保存文件对话框
  const selectedPath = await save({ defaultPath: defaultFilename, filters });
  if (!selectedPath) return false;

  // 将 Blob 转为二进制数组并通过 Rust IPC 写入本地文件
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const result = await ipc.saveBinaryFile(selectedPath, bytes);
  if (!result.ok) {
    throw new Error(result.error ? describeWriteError(result.error) : '写入文件失败');
  }
  return true;
}

/**
 * 弹系统另存为对话框并写入图片文件
 * Tauri 环境下必须走这条路径：WebView 不处理 blob 下载，按钮会「点了没反应」
 * @returns 用户取消时返回 false，不视为错误
 */
export async function saveBlobToFile(
  blob: Blob,
  defaultName: string,
  format: ChartImageFormat,
): Promise<boolean> {
  const extension = format;
  const filename = defaultName.endsWith(`.${extension}`)
    ? defaultName
    : `${defaultName}.${extension}`;
  const filters: DialogFilter[] =
    format === 'svg'
      ? [
          { name: 'SVG 矢量图 (*.svg)', extensions: ['svg'] },
          { name: '全部文件 (*.*)', extensions: ['*'] },
        ]
      : [
          { name: 'PNG 图片 (*.png)', extensions: ['png'] },
          { name: '全部文件 (*.*)', extensions: ['*'] },
        ];

  // 复用统一的文件另存为对话框与写盘逻辑
  return await exportBlobWithDialog(blob, filename, filters);
}

/** 把 Rust 侧返回的写盘错误翻译成用户能看懂的提示 */
function describeWriteError(error: WriteError): string {
  switch (error.kind) {
    case 'permission-denied':
      return `没有权限写入：${error.path}`;
    case 'disk-full':
      return '磁盘空间不足';
    case 'file-locked':
      return `文件被其他程序占用：${error.path}`;
    case 'readonly':
      return `文件是只读的：${error.path}`;
    case 'path-not-found':
      return `路径不存在：${error.path}`;
    case 'io':
      return error.message;
  }
}

// ── 面向调用方的高层接口 ──

/**
 * 把来源解析为可直接导出的 SVG 文本
 * @throws 图表尚未渲染完成时抛出，由上层转成 Toast 提示
 */
export function resolveChartSvg(source: ChartImageSource): string {
  if (source.kind === 'svg') {
    if (!source.svg.trim()) throw new Error('图表尚未渲染完成，请稍后再试');
    return normalizeSvg(source.svg);
  }
  if (!source.element) throw new Error('图表尚未渲染完成，请稍后再试');
  return elementToSvgString(source.element, { background: source.background });
}

/** 生成指定格式的图片二进制 */
export async function chartToBlob(
  source: ChartImageSource,
  format: ChartImageFormat,
  options: ChartRasterOptions = {},
): Promise<Blob> {
  const svg = resolveChartSvg(source);
  if (format === 'svg') {
    return new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  }
  return svgToPngBlob(svg, {
    scale: options.scale ?? DEFAULT_PNG_SCALE,
    background: options.background ?? DEFAULT_PNG_BACKGROUND,
  });
}

/** 导出图表到文件（弹另存为对话框） */
export async function exportChartImage(
  source: ChartImageSource,
  format: ChartImageFormat,
  defaultName: string,
  options: ChartRasterOptions = {},
): Promise<boolean> {
  const blob = await chartToBlob(source, format, options);
  return await saveBlobToFile(blob, defaultName, format);
}

/** 复制图表到剪贴板（SVG 复制源码文本，PNG 复制位图） */
export async function copyChartImage(
  source: ChartImageSource,
  format: ChartImageFormat,
  options: ChartRasterOptions = {},
): Promise<void> {
  const blob = await chartToBlob(source, format, options);
  if (format === 'svg') {
    await copyText(await blob.text());
    return;
  }
  await copyImage(blob);
}

// ── 文件名工具 ──

/** 去掉文件名扩展名，用作导出默认名 */
export function stripExtension(name: string): string {
  if (!name) return '';
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * 生成导出默认文件名：优先用文档名，未命名时回退到「前缀-时间戳」
 */
export function buildExportFileName(displayName: string | undefined, fallbackPrefix: string): string {
  const stripped = stripExtension(displayName ?? '');
  // 文档名可能含 Windows 非法字符，统一替换掉，避免另存为对话框报错
  const safe = stripped.replace(/[\\/:*?"<>|]/g, '-').trim();
  return safe || `${fallbackPrefix}-${Date.now()}`;
}
