// NoteBoard 图片复制与另存
// Markdown 图片右键菜单、大图预览浮层与图片查看器共用。
//
// 平台差异：
// - 桌面端（Windows / macOS / Linux）：由原生端解码并以系统原生格式写入剪贴板。
//   WebView2 经 IPC 传大块二进制只有约 60 MB/s（4K 图的 RGBA 像素光传输就要 0.5~0.7 秒），
//   因此按代价从低到高选择：本地图片只传路径 → 网络 / 内嵌图片传原始压缩字节 →
//   原生端解不了的格式（SVG、AVIF 等）才由前端解码后传像素。
//   注意不能把 asset 协议加载的 <img> 直接画进画布再导出：跨域资源会污染画布导致导出失败，
//   此前图片查看器的「复制图片」因此回退成了复制路径。前端解码一律先 fetch 原始字节再解码。
//   例外：发版 CSP 的 connect-src 不含 data: 与 http(s)，内嵌图片直接解码，网络图片改走跨域 <img>。
// - 网页 / 移动端：使用浏览器 Clipboard API 写入 PNG；ClipboardItem 直接接收 Promise，
//   先同步发起写入再异步准备数据，避免 WebKit 等引擎因等待读取而判定用户手势失效。

import { convertFileSrc } from '@tauri-apps/api/core';
import * as ipc from '../../core/ipc/commands';
import { IS_NATIVE_MOBILE, IS_WEB } from '../../core/platform';
import { dataUrlToBlob } from '../../core/dataUrl';
import { copyText, exportBlobWithDialog } from '../export/chartExport';

export interface ImageSource {
  /** 本地图片的绝对路径；存在时直接读取原文件 */
  path?: string | null;
  /** 可直接加载的地址（网络图片、data URL 等），没有本地路径时使用 */
  url?: string | null;
}

/** 桌面端可以把文件本身放入剪贴板（在文件管理器、聊天软件中粘贴为文件） */
export const CAN_COPY_IMAGE_FILE = !IS_WEB && !IS_NATIVE_MOBILE;

/** 位图解码器无法给出尺寸的矢量图（无 width / height 的 SVG）按该边长栅格化 */
const VECTOR_FALLBACK_SIZE = 1024;

/** 原生端解码失败的错误前缀（与 src-tauri/src/clipboard.rs 的 DECODE_ERROR 一致）：出现时改由前端解码 */
const NATIVE_DECODE_ERROR = '无法解码该图片格式';

/** 原生端可解码的图片类型；其余格式直接走前端解码，省去一次注定失败的调用 */
const NATIVE_DECODABLE_EXT = /\.(png|jpe?g|jfif|gif|webp|bmp|ico)$/i;
const NATIVE_DECODABLE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon']);

function isNativeDecodeError(error: unknown): boolean {
  return describeError(error, '').startsWith(NATIVE_DECODE_ERROR);
}

/** 常见图片 MIME 对应的扩展名，用于另存为时补全文件名 */
const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/avif': 'avif',
};

/** 统一转换 Rust 字符串错误与 JS 异常 */
export function describeError(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error) return error;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function isRemoteUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** 本地文件的 asset 地址（Windows / 安卓为 http(s)://asset.localhost），在 connect-src 白名单内 */
function isAssetUrl(url: string): boolean {
  return /^https?:\/\/asset\.localhost(?:[/:?#]|$)/i.test(url);
}

/** 图片的加载地址：本地文件优先按路径转换，保证读取的是磁盘上的原文件 */
function resolveLoadUrl(source: ImageSource): string {
  if (source.path) return convertFileSrc(source.path);
  if (source.url) return source.url;
  throw new Error('图片地址为空');
}

/** 经画布转码得到的 PNG（非原始字节），另存为时需把扩展名改为 .png */
const transcodedBlobs = new WeakSet<Blob>();

/**
 * 原生端读取网络图片：发版 CSP 的 connect-src 不含 http(s)，fetch 必被拦截（开发态无 CSP 不会暴露）；
 * img-src 放开了网络图片，改用跨域 <img> 加载后经画布转为 PNG。服务器未开放 CORS 时同样无法读取。
 */
async function loadRemoteImageAsPng(url: string): Promise<Blob> {
  let image: HTMLImageElement;
  try {
    image = await loadImageElement(url, true);
  } catch {
    throw new Error('该网络图片不允许读取，可改为复制图片链接');
  }
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth || VECTOR_FALLBACK_SIZE;
  canvas.height = image.naturalHeight || VECTOR_FALLBACK_SIZE;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('图片尺寸过大，无法复制');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await canvasToPng(canvas);
  transcodedBlobs.add(blob);
  return blob;
}

/** 读取图片原始字节（保持原格式，不重新编码；原生端网络图片例外，见 loadRemoteImageAsPng） */
export async function loadImageBlob(source: ImageSource): Promise<Blob> {
  const url = resolveLoadUrl(source);
  // 内嵌图片直接解码：原生 CSP 的 connect-src 不含 data:，fetch 会被拦截
  if (/^data:/i.test(url)) return dataUrlToBlob(url);
  if (!IS_WEB && isRemoteUrl(url) && !isAssetUrl(url)) return await loadRemoteImageAsPng(url);
  let response: Response;
  try {
    // 网络图片不携带 Referer，与页面显示时的防盗链处理一致
    response = await fetch(url, { referrerPolicy: 'no-referrer' });
  } catch {
    // 网络图片未开放跨域读取时浏览器直接拒绝，只能复制链接
    throw new Error(isRemoteUrl(url) ? '该网络图片不允许读取，可改为复制图片链接' : '读取图片失败，文件可能已被移动或删除');
  }
  if (!response.ok) {
    throw new Error(response.status === 404 ? '图片文件不存在' : `读取图片失败（${response.status}）`);
  }
  return await response.blob();
}

/** 用 <img> 加载同源地址（blob:），用于位图解码器不支持的格式；crossOrigin 用于网络图片，避免污染画布 */
function loadImageElement(url: string, crossOrigin = false): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    if (crossOrigin) {
      image.crossOrigin = 'anonymous';
      // 与页面显示时的防盗链处理一致，不携带 Referer
      image.referrerPolicy = 'no-referrer';
    }
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('无法解码该图片'));
    image.src = url;
  });
}

/** 解码图片并按原始尺寸绘制到画布 */
async function drawToCanvas(blob: Blob): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  // 绘制后只读取一次像素，使用软件画布省去 GPU 回读
  const getContext = () => {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('图片尺寸过大，无法复制');
    return context;
  };

  // 1. 位图解码器：覆盖 PNG / JPEG / GIF / WebP / BMP / ICO 等，按 EXIF 方向输出
  let bitmap: ImageBitmap | null = null;
  if (typeof createImageBitmap === 'function' && !blob.type.includes('svg')) {
    // 解码失败（如格式不受支持）再交给 <img> 尝试
    bitmap = await createImageBitmap(blob).catch(() => null);
  }
  if (bitmap) {
    try {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      getContext().drawImage(bitmap, 0, 0);
      return canvas;
    } finally {
      bitmap.close();
    }
  }

  // 2. SVG 等：经 blob 地址（同源，不污染画布）载入 <img> 再绘制
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = await loadImageElement(objectUrl);
    canvas.width = image.naturalWidth || VECTOR_FALLBACK_SIZE;
    canvas.height = image.naturalHeight || VECTOR_FALLBACK_SIZE;
    getContext().drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** 画布导出 PNG */
function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('图片编码失败'))), 'image/png');
  });
}

/** 浏览器剪贴板只接受 PNG：原图是 PNG 时原样写入，其余格式先转码 */
async function loadAsPng(source: ImageSource): Promise<Blob> {
  const blob = await loadImageBlob(source);
  if (blob.type === 'image/png') return blob;
  return await canvasToPng(await drawToCanvas(blob));
}

/** 桌面端：按「路径 → 原始字节 → 像素」的顺序交给原生端写入，代价逐级升高 */
async function copyImageNative(source: ImageSource): Promise<void> {
  // 1. 本地图片：只传路径（零像素传输）
  if (source.path && NATIVE_DECODABLE_EXT.test(source.path)) {
    try {
      await ipc.clipboardWriteImageFile(source.path);
      return;
    } catch (error) {
      // 文件不存在、剪贴板被占用等直接报错；只有格式解不了（如扩展名与内容不符）才改由前端解码
      if (!isNativeDecodeError(error)) throw error;
    }
  }

  const blob = await loadImageBlob(source);
  // 2. 网络 / 内嵌图片：传原始压缩字节（通常只有几百 KB 到几 MB）
  if (NATIVE_DECODABLE_MIME.has(blob.type.toLowerCase())) {
    try {
      await ipc.clipboardWriteImageEncoded(new Uint8Array(await blob.arrayBuffer()));
      return;
    } catch (error) {
      if (!isNativeDecodeError(error)) throw error;
    }
  }

  // 3. 兜底：SVG、AVIF 等由前端解码，传自上而下的非预乘 RGBA 像素
  const canvas = await drawToCanvas(blob);
  // 再次取上下文返回绘制时的同一实例
  const { data } = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height);
  await ipc.clipboardWriteImagePixels(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), canvas.width, canvas.height);
}

/** 把图片位图复制到系统剪贴板，可直接粘贴到聊天软件、文档或绘图工具 */
export async function copyImageToClipboard(source: ImageSource): Promise<void> {
  if (!IS_WEB && !IS_NATIVE_MOBILE) {
    await copyImageNative(source);
    return;
  }

  // 移动端 WebView 不一定开放图片剪贴板，提示改用系统分享
  const unsupported = !IS_WEB
    ? '系统未允许复制图片，可改用「分享图片」'
    : window.isSecureContext ? '浏览器未允许写入剪贴板' : '浏览器仅在 HTTPS 下允许复制图片';
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    throw new Error(unsupported);
  }
  const pngTask = loadAsPng(source);
  // 写入失败时会单独等待该任务取出更具体的错误，这里先吞掉未处理拒绝
  pngTask.catch(() => undefined);
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngTask })]);
  } catch {
    // 读取 / 转码失败时抛出其自身的错误（如「图片文件不存在」），否则是剪贴板权限问题
    await pngTask;
    throw new Error(unsupported);
  }
}

/** 把图片文件本身放入剪贴板（仅桌面端） */
export async function copyImageFileToClipboard(path: string): Promise<void> {
  await ipc.clipboardWriteFiles([path]);
}

/** 复制图片位置：本地图片复制绝对路径，网络图片复制链接 */
export async function copyImageLocation(source: ImageSource): Promise<void> {
  const text = source.path || source.url;
  if (!text) throw new Error('图片地址为空');
  await copyText(text);
}

/** 根据来源推断文件名；data URL 等没有文件名时按 MIME 类型补全扩展名 */
export function suggestImageFileName(source: ImageSource, mimeType = ''): string {
  const fallbackExt = MIME_EXTENSIONS[mimeType.toLowerCase()] ?? 'png';
  const raw = source.path ?? (source.url && !source.url.startsWith('data:') ? source.url : '');
  // 去掉查询串与片段，只取最后一段路径
  const segment = raw.split(/[?#]/)[0].split(/[/\\]/).filter(Boolean).pop() ?? '';
  let name = segment;
  try {
    name = decodeURIComponent(segment);
  } catch {
    // 非法百分号编码保持原样
  }
  // 去掉文件名中不能落盘的字符（Windows 保留字符与控制字符）
  name = Array.from(name, (char) => (char.charCodeAt(0) < 0x20 || '\\/:*?"<>|'.includes(char) ? '_' : char)).join('').trim();
  if (!name) return `image.${fallbackExt}`;
  return /\.[a-z0-9]{2,5}$/i.test(name) ? name : `${name}.${fallbackExt}`;
}

/** 另存为：弹出保存对话框写入原始字节（格式与画质不变）；取消返回 false */
export async function saveImageAs(source: ImageSource): Promise<boolean> {
  const blob = await loadImageBlob(source);
  let fileName = suggestImageFileName(source, blob.type);
  // 已转码为 PNG 的网络图片，原扩展名（.jpg 等）与内容不符
  if (transcodedBlobs.has(blob)) fileName = fileName.replace(/\.[a-z0-9]{2,5}$/i, '.png');
  const ext = fileName.split('.').pop()?.toLowerCase() || 'png';
  const saved = await exportBlobWithDialog(blob, fileName, [
    { name: `${ext.toUpperCase()} 图片`, extensions: [ext] },
    { name: '全部文件', extensions: ['*'] },
  ]);
  return saved !== null;
}
