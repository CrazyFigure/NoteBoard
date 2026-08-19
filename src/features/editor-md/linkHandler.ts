// NoteBoard Markdown 链接交互与跳转处理器
// 拦截外部链接（默认浏览器打开）与本地相对路径文档（在 NoteBoard 内打开）

import * as ipc from '../../core/ipc/commands';
import { useDocumentStore } from '../../stores/documentStore';
import { useExplorerStore } from '../explorer/explorerStore';
import { showToast } from '../../stores/toastStore';
import { openDocument } from '../editor-code/orchestration/openDocument';

/** 规范化相对路径并基于基准目录计算绝对路径 */
export function resolveRelativeDocPath(baseDir: string, relativePath: string): string {
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

/**
 * 统一处理 Markdown 链接点击跳转
 * @param rawHref 原始链接地址
 * @param currentDocKey 当前文档的 Key / 路径
 */
export async function handleLinkClick(rawHref: string, currentDocKey: string): Promise<boolean> {
  if (!rawHref) return false;
  const href = rawHref.trim();

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

  if (!baseDir && !/^[a-zA-Z]:[\\/]/.test(href)) {
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
        // 如果是文件，在 NoteBoard 内部打开
        await openDocument(targetPath);
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
