// NoteBoard Markdown 链接交互与跳转处理器
// 拦截外部链接（默认浏览器打开）与本地相对路径文档（在 NoteBoard 内打开）

import * as ipc from '../../core/ipc/commands';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
import { useExplorerStore } from '../explorer/explorerStore';
import { showToast } from '../../stores/toastStore';
import { openLinkedDocument } from '../editor-code/orchestration/openDocument';
import { USES_WINDOWS_PATHS } from '../../core/platform';

/** 是否为本地绝对路径（Windows 盘符路径或 POSIX 根路径） */
export function isAbsoluteLocalPath(path: string): boolean {
  return USES_WINDOWS_PATHS ? /^[a-zA-Z]:[\\/]/.test(path) : path.startsWith('/');
}

/** 规范化相对路径并基于基准目录计算绝对路径 */
export function resolveRelativeDocPath(baseDir: string, relativePath: string): string {
  // Android 等 POSIX 平台：正斜杠分隔，绝对路径以 / 开头
  if (!USES_WINDOWS_PATHS) {
    return resolvePosixRelativePath(baseDir, relativePath);
  }

  // 去除可能的 file:/// 协议头与 URL 编码
  let cleanRel = decodeURIComponent(relativePath.replace(/^file:[\\/]+/, '')).replace(/\//g, '\\');

  // 若已经是 Windows 绝对路径直接返回
  if (/^[a-zA-Z]:\\/.test(cleanRel)) {
    return cleanRel;
  }

  // 去除开头的 .\ 或 \
  cleanRel = cleanRel.replace(/^(\.\\|\\)+/, '');

  const parts = baseDir.replace(/\//g, '\\').split('\\').filter(Boolean);
  const relParts = cleanRel.split('\\').filter(Boolean);

  for (const part of relParts) {
    if (part === '.') {
      continue;
    } else if (part === '..') {
      if (parts.length > 1) {
        parts.pop();
      }
    } else {
      parts.push(part);
    }
  }

  if (parts.length === 0) return relativePath;
  const drive = parts[0];
  const rest = parts.slice(1).join('\\');
  return rest ? `${drive}\\${rest}` : drive;
}

/** POSIX 路径的相对解析：`/` 开头视为绝对路径，`..` 不越过根目录 */
function resolvePosixRelativePath(baseDir: string, relativePath: string): string {
  let decoded = relativePath;
  try {
    decoded = decodeURIComponent(relativePath);
  } catch {
    // 非法百分号编码时按原文处理
  }
  // file:///storage/... → /storage/...
  const cleanRel = decoded.replace(/^file:\/*/, '/').replace(/\\/g, '/');
  const isAbsolute = cleanRel.startsWith('/');
  const parts = isAbsolute ? [] : baseDir.split('/').filter(Boolean);
  for (const part of cleanRel.split('/').filter(Boolean)) {
    if (part === '.') continue;
    if (part === '..') {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return '/' + parts.join('/');
}

// 记录上一次点击时间与链接，用于短时防抖（防止连击触发多次打开）
let lastClickTime = 0;
let lastClickHref = '';

/**
 * 统一处理 Markdown 链接点击跳转
 * @param rawHref 原始链接地址
 * @param currentDocKey 当前文档的 Key / 路径
 */
export async function handleLinkClick(rawHref: string, currentDocKey: string): Promise<boolean> {
  if (!rawHref) return false;
  const href = rawHref.trim();

  // 400ms 内针对同一链接的重复点击直接拦截
  const now = Date.now();
  if (href === lastClickHref && now - lastClickTime < 400) {
    return true;
  }
  lastClickTime = now;
  lastClickHref = href;

  // 1. 外部网络协议链接：调用系统默认浏览器打开
  if (/^(https?:\/\/|mailto:|ftp:|tel:)/i.test(href)) {
    try {
      await ipc.openExternalUrl(href);
    } catch (e) {
      console.error('打开外部链接失败:', e);
      showToast(`无法打开外部链接: ${href}`, 'error');
    }
    return true;
  }

  // 2. 锚点链接：在当前文档内部查找并滚动
  if (href.startsWith('#')) {
    const anchorId = href.slice(1);
    const targetElement = document.getElementById(anchorId);
    if (targetElement) {
      targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    return true;
  }

  // 3. 本地文件 / 相对路径链接处理
  const docStore = useDocumentStore.getState();
  const currentDoc = docStore.getDocument(currentDocKey);
  const baseDir = currentDoc?.dirPath || useExplorerStore.getState().root;

  if (!baseDir && !isAbsoluteLocalPath(href)) {
    showToast('当前文档尚未保存到磁盘，无法解析相对路径链接', 'warning');
    return true;
  }

  // 计算目标绝对路径
  let targetPath = baseDir ? resolveRelativeDocPath(baseDir, href) : href;

  try {
    let existsResult = await ipc.pathExists(targetPath);

    // 若原路径不存在，尝试自动补充 .md 扩展名再进行检查
    if (!existsResult.exists && !targetPath.toLowerCase().endsWith('.md')) {
      const mdCandidate = `${targetPath}.md`;
      const mdCheck = await ipc.pathExists(mdCandidate);
      if (mdCheck.exists) {
        targetPath = mdCandidate;
        existsResult = mdCheck;
      }
    }

    if (existsResult.exists) {
      if (existsResult.isDir) {
        // 如果是文件夹，在资源管理器中定位
        await ipc.revealInExplorer(targetPath);
      } else {
        // 如果是文件，在 NoteBoard 内部打开（HTML 按「HTML 链接打开方式」设置可交给系统浏览器）
        await openLinkedDocument(targetPath);
      }
      return true;
    } else {
      const fileName = targetPath.split(/[\\/]/).pop() || targetPath;
      showToast(`无法打开链接：文件不存在 (${fileName})`, 'warning');
      return true;
    }
  } catch (err) {
    console.error('解析本地文件链接失败:', err);
    showToast(`打开本地链接失败: ${err instanceof Error ? err.message : String(err)}`, 'error');
    return true;
  }
}

/** 渲染后原始 HTML 中链接点击所需的事件字段（原生事件与 React 合成事件通用） */
interface RenderedLinkMouseEvent {
  target: EventTarget | null;
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  preventDefault(): void;
  /** React 合成事件的原生事件 */
  nativeEvent?: Event;
  composedPath?(): EventTarget[];
}

/** 事件的实际目标：Shadow DOM（隔离渲染的 HTML 块）内的点击在外层会被重定向到宿主元素，需从事件路径取原始节点 */
function renderedEventOrigin(event: RenderedLinkMouseEvent): EventTarget | null {
  const native = event.nativeEvent ?? event;
  const path = typeof native.composedPath === 'function' ? native.composedPath() : [];
  return path[0] ?? event.target;
}

/**
 * 处理 HTML 块 / 行内 HTML 渲染内容中的链接点击（click 与 auxclick 共用），返回是否点在链接上。
 * 一律拦截原生跳转：否则 webview 自身会被导航走，target="_blank" 等写法还可能弹出应用内新窗口。
 * Ctrl/Cmd + 单击或鼠标中键单击时按普通链接规则打开：外部链接交给系统默认浏览器，本地文件在 NoteBoard 内打开。
 */
export function handleRenderedHtmlLinkClick(event: RenderedLinkMouseEvent): boolean {
  const origin = renderedEventOrigin(event);
  const anchor = origin instanceof Element ? origin.closest('a') : null;
  if (!anchor) return false;
  event.preventDefault();
  // SVG 中的链接可能使用旧式 xlink:href
  const href = anchor.getAttribute('href') ?? anchor.getAttribute('xlink:href');
  const shouldOpen = (event.button === 0 && (event.ctrlKey || event.metaKey)) || event.button === 1;
  const activeKey = useWindowStore.getState().activeKey;
  if (shouldOpen && href && activeKey) void handleLinkClick(href, activeKey);
  return true;
}
