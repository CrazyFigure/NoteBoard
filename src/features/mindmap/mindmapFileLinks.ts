// NoteBoard 思维导图节点文件链接：选择与打开
// 桌面端与网页端通过文件选择器取得路径，工作区内的文件写成相对导图的路径；
// 安卓系统选择器只返回 content:// 临时授权地址，复制到导图同级附件目录后再链接。
// 打开链接复用 Markdown 链接跳转：相对路径基于导图所在目录解析，文件在应用内打开、文件夹在系统中定位。

import { open } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';
import * as ipc from '../../core/ipc/commands';
import { IS_MOBILE_UI, USES_COMMAND_KEY } from '../../core/platform';
import { formatShortcut } from '../../core/shortcuts';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
import { showToast } from '../../stores/toastStore';
import { useExplorerStore } from '../explorer/explorerStore';
import { joinPath } from '../explorer/pathUtils';
import { handleLinkClick } from '../editor-md/linkHandler';
import { toFileLinkPath } from './mindmapAttachments';

/** 安卓选择器文件复制到导图同级的目录名 */
const ANDROID_ATTACHMENT_DIR = 'attachments';

/** 打开文件链接的修饰键：Mac 用 Cmd，其余平台用 Ctrl；触屏界面没有修饰键，直接点按即打开 */
export function isFileLinkOpenGesture(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  if (IS_MOBILE_UI) return true;
  return USES_COMMAND_KEY ? e.metaKey : e.ctrlKey;
}

/** 文件链接悬停提示中的打开方式说明 */
export const FILE_LINK_OPEN_HINT = IS_MOBILE_UI ? '点按打开' : formatShortcut('Ctrl+单击打开');

/** 当前导图所在目录（未保存时为空） */
function docDirOf(docKey?: string): string | undefined {
  return docKey ? useDocumentStore.getState().getDocument(docKey)?.dirPath || undefined : undefined;
}

/** 在应用内打开文件链接；未传 docKey 时以当前激活文档为基准解析相对路径 */
export function openFileLink(path: string, docKey?: string): void {
  void handleLinkClick(path, docKey ?? useWindowStore.getState().activeKey ?? '');
}

/** 从 content:// 地址推断文件名（DocumentsProvider 形如 primary:Download/a.md，取最后一段） */
function nameFromContentUri(uri: string): string {
  let last = uri.split('/').pop() ?? '';
  try {
    last = decodeURIComponent(last);
  } catch {
    // 保持原样
  }
  return last.split(/[:/]/).filter(Boolean).pop() || 'file';
}

/** 安卓：把系统选择器返回的文件复制到导图同级附件目录，返回新文件绝对路径 */
async function copyContentUri(uri: string, docDir: string): Promise<string | null> {
  try {
    const bytes = await readFile(uri);
    const target = joinPath(joinPath(docDir, ANDROID_ATTACHMENT_DIR), `${Date.now()}_${nameFromContentUri(uri)}`);
    const result = await ipc.saveBinaryFile(target, bytes);
    return result.ok ? target : null;
  } catch (error) {
    console.error('复制链接文件失败:', error);
    return null;
  }
}

/**
 * 弹出文件选择器选择要链接的文件（可多选），返回可直接写入节点的链接路径
 */
export async function pickFileLinks(docKey?: string): Promise<string[]> {
  let picked: string | string[] | null;
  try {
    picked = await open({ title: '选择要链接的文件', multiple: true });
  } catch (error) {
    showToast(`选择文件失败: ${error instanceof Error ? error.message : String(error)}`, 'error');
    return [];
  }
  const list = picked == null ? [] : Array.isArray(picked) ? picked : [picked];
  if (list.length === 0) return [];

  const docDir = docDirOf(docKey);
  const workspaceRoot = useExplorerStore.getState().root;
  const links: string[] = [];
  for (const source of list) {
    let path: string | null = source;
    if (source.startsWith('content://')) {
      // 临时授权地址无法长期按路径打开：需要导图已保存，才能把文件复制到它旁边
      if (!docDir) {
        showToast('请先保存导图，再链接系统中的文件', 'warning');
        return links;
      }
      path = await copyContentUri(source, docDir);
      if (!path) {
        showToast('无法读取所选文件', 'error');
        continue;
      }
    }
    links.push(toFileLinkPath(path, docDir, workspaceRoot));
  }
  return links;
}
