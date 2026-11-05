// NoteBoard 本地图片粘贴与拖拽落盘系统
// 自动在 Markdown 文档所在目录同一层创建 /img 目录（名称可在设置修改）
// 兼容新建未保存文档的 Base64 即时显示与提示，支持从本地对话框选择图片导入
// 保存期间在插入位置显示图片预览与加载动画（imageUploadPlaceholder），完成后原位替换为正式图片

import type { Editor } from '@tiptap/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import * as ipc from '../../core/ipc/commands';
import { beginImageInsertion } from './imageUploadPlaceholder';
import { useDocumentStore } from '../../stores/documentStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useExplorerStore } from '../explorer/explorerStore';
import { joinPath } from '../explorer/pathUtils';
import { showToast } from '../../stores/toastStore';
import { open } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';
import { formatShortcut } from '../../core/shortcuts';

// Windows 文件名禁止字符与 ASCII 控制字符上限，用于生成可安全落盘的图片文件名。
const WINDOWS_INVALID_FILENAME_CHARS = new Set('<>:"/\\|?*');
const ASCII_CONTROL_CHARACTER_MAX = 0x1f;

/** 安全化文件名：将 Windows 禁止字符和 ASCII 控制字符统一替换为下划线。 */
function sanitizeFileName(name: string): string {
  const sanitized = Array.from(name, (character) =>
    character.charCodeAt(0) <= ASCII_CONTROL_CHARACTER_MAX || WINDOWS_INVALID_FILENAME_CHARS.has(character)
      ? '_'
      : character,
  ).join('');

  return sanitized
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

/** 将 File 转换为 Base64 Data URL */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(file);
  });
}

/** 最多等待新图片预解码的时长：超时也照常插入，只是可能闪一下 */
const PRELOAD_TIMEOUT_MS = 1500;

/**
 * 预先解码刚保存的图片：图片节点随后以同一地址加载时直接命中页面内的已解码图片，
 * 占位替换为正式图片时不出现空白闪烁。失败或超时都直接返回。
 */
function preloadSavedImage(path: string): Promise<void> {
  let url: string;
  try {
    url = convertFileSrc(path);
  } catch {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, PRELOAD_TIMEOUT_MS);
    const done = () => {
      window.clearTimeout(timer);
      resolve();
    };
    const image = new Image();
    // 与图片节点的 <img> 保持一致的请求方式，确保复用同一份已加载图片
    image.referrerPolicy = 'no-referrer';
    image.src = url;
    image.decode().then(done, done);
  });
}

/**
 * 处理粘贴/拖入的单个图片文件
 * 将图片保存到 Markdown 文档同级的 img/ 目录，或未保存时使用 Base64 兼容
 */
export async function handlePastedImageFile(
  editor: Editor,
  file: File,
  docKey: string,
): Promise<void> {
  const settings = useSettingsStore.getState().settings;
  const imageDirName = (settings.file.imageDirName || 'img').trim() || 'img';

  const currentDoc = useDocumentStore.getState().getDocument(docKey);
  const docDirPath = currentDoc?.dirPath || useExplorerStore.getState().root;

  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'png';
  const rawBaseName = file.name.replace(/\.[^.]+$/, '');
  const safeName = sanitizeFileName(rawBaseName) || 'image';
  const timestamp = Date.now();
  const fileName = `${timestamp}_${safeName}.${ext}`;

  // 立即在插入位置显示这张图的预览与加载动画，用户能确认粘贴已被接收
  const insertion = beginImageInsertion(editor, file);

  // 1. 若文档已保存（拥有物理目录），直接写入本地磁盘图片目录
  if (docDirPath) {
    // 按平台分隔符拼接（Windows 反斜杠 / Android 正斜杠）
    const targetDir = joinPath(docDirPath, imageDirName);
    const targetPath = joinPath(targetDir, fileName);

    try {
      // 读取图片二进制字节流
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);

      // 调用 Rust 端以二进制正文写入（内部会自动 create_dir_all）
      const result = await ipc.saveBinaryFile(targetPath, bytes);

      if (result.ok) {
        // 构建标准 Markdown 相对路径引用；先预解码再替换占位，避免闪烁
        const relativePath = `./${imageDirName}/${fileName}`;
        await preloadSavedImage(targetPath);
        insertion.commit({ src: relativePath, alt: safeName });
        showToast(`图片已保存至 /${imageDirName} 并插入`, 'success');
      } else {
        const errMsg = typeof result.error === 'string' ? result.error : JSON.stringify(result.error) || '保存图片失败';
        throw new Error(errMsg);
      }
    } catch (e) {
      console.error('图片落盘失败，回退到 Base64:', e);
      // 写入失败时优雅回退到 Base64
      try {
        const base64Url = await fileToBase64(file);
        insertion.commit({ src: base64Url, alt: safeName });
        showToast('图片落盘失败，已临时以 Base64 嵌入', 'warning');
      } catch {
        insertion.cancel();
        showToast('图片插入失败', 'error');
      }
    }
  } else {
    // 2. 新建文档尚未保存时的兼容方案：采用 Base64 即时预览，并提醒保存
    try {
      const base64Url = await fileToBase64(file);
      insertion.commit({ src: base64Url, alt: safeName });
      showToast(formatShortcut(`图片已插入。当前文档尚未保存，建议按 Ctrl+S 保存文档以自动管理 /${imageDirName} 目录`), 'info');
    } catch (e) {
      console.error('Base64 转换失败:', e);
      insertion.cancel();
      showToast('插入图片失败', 'error');
    }
  }
}

/**
 * 弹出系统文件选择器选择本地图片，自动保存到当前文档同级 img 目录并返回图片路径与描述
 */
export async function pickAndSaveLocalImage(
  docKey: string,
  /** 选定文件后、开始复制前回调（用于立即显示插入占位） */
  onPicked?: (filePath: string) => void,
): Promise<{ src: string; alt: string } | null> {
  try {
    const selected = await open({
      title: '选择要插入的图片',
      multiple: false,
      filters: [
        {
          name: '图片文件 (*.png, *.jpg, *.jpeg, *.webp, *.gif, *.svg, *.bmp)',
          extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp'],
        },
      ],
    });

    if (!selected || typeof selected !== 'string') {
      return null;
    }

    const filePath = selected;
    onPicked?.(filePath);
    const currentDoc = useDocumentStore.getState().getDocument(docKey);
    const docDirPath = currentDoc?.dirPath || useExplorerStore.getState().root;
    const settings = useSettingsStore.getState().settings;
    const imageDirName = (settings.file.imageDirName || 'img').trim() || 'img';

    // 若文档有物理路径，复制到文档所在的 /img 目录
    if (docDirPath) {
      const sourceFileName = filePath.split(/[\\/]/).pop() || 'image.png';
      const ext = sourceFileName.split('.').pop()?.toLowerCase() ?? 'png';
      const safeBaseName = sanitizeFileName(sourceFileName.replace(/\.[^.]+$/, '')) || 'image';
      const newFileName = `${Date.now()}_${safeBaseName}.${ext}`;

      const targetPath = joinPath(joinPath(docDirPath, imageDirName), newFileName);

      try {
        // 读取本地文件二进制字节并写入目标位置
        const fileBytes = await readFile(filePath);
        await ipc.saveBinaryFile(targetPath, fileBytes);
      } catch (e) {
        // 复制失败时直接引用源文件，而不是插入一个并不存在的相对路径
        console.warn('复制本地图片失败，改为以源文件路径插入:', e);
        showToast(`图片未能导入 /${imageDirName}，已引用原文件`, 'warning');
        return { src: filePath, alt: safeBaseName };
      }

      const relativePath = `./${imageDirName}/${newFileName}`;
      await preloadSavedImage(targetPath);
      showToast(`图片已导入至 /${imageDirName}`, 'success');
      return { src: relativePath, alt: safeBaseName };
    } else {
      // 未保存文档直接使用选择的文件路径
      const fileName = filePath.split(/[\\/]/).pop() || 'image';
      showToast(formatShortcut('图片已选择。建议按 Ctrl+S 保存文档'), 'info');
      return { src: filePath, alt: fileName };
    }
  } catch (err) {
    console.error('选择本地图片失败:', err);
    showToast(`选择图片失败: ${err instanceof Error ? err.message : String(err)}`, 'error');
    return null;
  }
}

/**
 * 弹出系统文件选择器选择本地图片并导入到当前文档同级 img 目录
 */
export async function insertLocalImageWithDialog(
  editor: Editor,
  docKey: string,
): Promise<void> {
  let insertion: ReturnType<typeof beginImageInsertion> | null = null;
  const imageInfo = await pickAndSaveLocalImage(docKey, (filePath) => {
    // 选定文件后立即显示占位：预览直接加载源文件，复制完成后原位替换
    let previewUrl: string | null = null;
    try {
      previewUrl = convertFileSrc(filePath);
    } catch {
      // 无法转换地址时只显示加载徽标
    }
    insertion = beginImageInsertion(editor, previewUrl);
  });
  const pending = insertion as ReturnType<typeof beginImageInsertion> | null;
  if (imageInfo) {
    if (pending) pending.commit(imageInfo);
    else editor.chain().focus().setImage(imageInfo).run();
  } else {
    pending?.cancel();
  }
}

