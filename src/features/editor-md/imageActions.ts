// NoteBoard Markdown 图片文件操作
// 右键菜单「重命名文件」：改磁盘文件名，并同步当前文档中所有引用该图片的地址、
// 已在独立标签页打开的图片、资源管理器目录与双向链接（与资源管理器重命名一致）。

import type { Editor } from '@tiptap/core';
import * as ipc from '../../core/ipc/commands';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useExplorerStore } from '../explorer/explorerStore';
import { basenameOf, dirnameOf, joinPath } from '../explorer/pathUtils';

/** Windows 文件名禁用字符（各平台统一按最严格规则校验，保证文档在 Windows 上也能打开） */
const INVALID_FILE_NAME_CHARS = '\\/:*?"<>|';

/** 拆分文件名为主名与扩展名（扩展名含点；隐藏文件 .gitignore 视为无扩展名） */
export function splitFileName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/** 校验新文件主名，返回错误文案；合法返回 null */
export function validateFileStem(stem: string): string | null {
  const trimmed = stem.trim();
  if (!trimmed) return '文件名不能为空';
  if (Array.from(trimmed).some((char) => char.charCodeAt(0) < 0x20 || INVALID_FILE_NAME_CHARS.includes(char))) {
    return '不能包含 \\ / : * ? " < > |';
  }
  // Windows 会静默去掉末尾的点与空格，导致实际文件名与文档引用不一致
  if (/[. ]$/.test(trimmed)) return '不能以点或空格结尾';
  if (trimmed.length > 200) return '文件名过长';
  return null;
}

/**
 * 把图片地址中的文件名替换为新名称，保留原有目录写法（./img/、../assets/、绝对路径等）。
 * 原文件名经过百分号编码（如 my%20pic.png）或新名称含 % 时，新名称同样编码，
 * 保证按地址解码后仍指向新文件。
 */
export function replaceSrcFileName(rawSrc: string, newFileName: string): string {
  const separator = Math.max(rawSrc.lastIndexOf('/'), rawSrc.lastIndexOf('\\'));
  const prefix = rawSrc.slice(0, separator + 1);
  const oldSegment = rawSrc.slice(separator + 1);
  const wasEncoded = /%[0-9a-f]{2}/i.test(oldSegment);
  const segment = wasEncoded || newFileName.includes('%') ? encodeURIComponent(newFileName) : newFileName;
  return prefix + segment;
}

/** 更新文档中所有引用同一地址的图片节点（同一事务，一次撤销即可还原） */
export function updateImageSources(editor: Editor, oldSrc: string, newSrc: string): number {
  const { state } = editor;
  const tr = state.tr;
  let count = 0;
  state.doc.descendants((node, pos) => {
    if (node.type.name === 'image' && node.attrs.src === oldSrc) {
      // 只改属性不改结构，位置不会偏移
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: newSrc });
      count += 1;
    }
  });
  if (count > 0) editor.view.dispatch(tr);
  return count;
}

/** 资源管理器已加载过该目录时重新读取，未展开的目录展开时自然是最新的 */
async function refreshExplorerDir(dir: string): Promise<void> {
  const explorer = useExplorerStore.getState();
  if (!explorer.getChildren(dir)) return;
  const showHidden = useSettingsStore.getState().settings.file.showHiddenFiles;
  try {
    explorer.updateChildren(dir, await ipc.readDir(dir, showHidden));
  } catch {
    // 刷新失败不影响重命名结果，文件监听稍后会再次同步
  }
}

/**
 * 重命名图片文件（扩展名保持不变）并同步引用。
 * @returns 新文件名；名称未变化返回 null
 * @throws 同名文件已存在或磁盘重命名失败
 */
export async function renameImageFile(
  editor: Editor,
  options: { absPath: string; rawSrc: string; newStem: string },
): Promise<string | null> {
  const { absPath, rawSrc } = options;
  const oldName = basenameOf(absPath);
  const newName = `${options.newStem.trim()}${splitFileName(oldName).ext}`;
  if (newName === oldName) return null;

  const parentDir = dirnameOf(absPath);
  const newPath = joinPath(parentDir, newName);
  // 仅大小写变化时（Windows / macOS 文件系统不区分大小写）存在性检查会命中文件自身，需跳过；
  // 其余情况必须先检查：系统重命名遇到同名文件会直接覆盖
  const caseOnly = newPath.toLowerCase() === absPath.toLowerCase();
  if (!caseOnly && (await ipc.pathExists(newPath)).exists) {
    throw new Error(`已存在同名文件：${newName}`);
  }

  // 重命名前收集指向该图片的双链嵌入（如 ![[图片.png]]），按需加载
  const wikiLinks = await import('../wikilink/renameLinks');
  const linkPlan = await wikiLinks.planWikiLinkRenameSafely(absPath, false);

  await ipc.renamePath(absPath, newPath);

  // 图片已在独立标签页中打开时迁移路径
  useDocumentStore.getState().renameDocument(absPath, newPath, newName, parentDir);
  useWindowStore.getState().updateTabPath(absPath, newPath, newName);
  void refreshExplorerDir(parentDir);

  if (!editor.isDestroyed) updateImageSources(editor, rawSrc, replaceSrcFileName(rawSrc, newName));
  // 文档内引用改完后再询问是否更新其他笔记中的双链
  if (linkPlan) void wikiLinks.applyWikiLinkRename(linkPlan, newPath);
  return newName;
}
