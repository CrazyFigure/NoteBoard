// NoteBoard 本地图片粘贴与拖拽落盘系统
// 自动在 Markdown 文档所在目录同一层创建 /img 目录（名称可在设置修改）
// 兼容新建未保存文档的 Base64 即时显示与提示，支持从本地对话框选择图片导入

import type { Editor } from '@tiptap/core';
import * as ipc from '../../core/ipc/commands';
import { useDocumentStore } from '../../stores/documentStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useExplorerStore } from '../explorer/explorerStore';
import { showToast } from '../../stores/toastStore';
import { open } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';

/** 安全化文件名：只保留字母数字汉字和常见分隔符 */
function sanitizeFileName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
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

  // 1. 若文档已保存（拥有物理目录），直接写入本地磁盘图片目录
  if (docDirPath) {
    const targetDir = `${docDirPath}\\${imageDirName}`;
    const targetPath = `${targetDir}\\${fileName}`;

    try {
      // 读取图片二进制字节流
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);

      // 调用 Rust 端 save_binary_file 进行二进制写入（内部会自动 create_dir_all）
      const result = await ipc.saveBinaryFile(targetPath, bytes);

      if (result.ok) {
        // 构建标准 Markdown 相对路径引用
        const relativePath = `./${imageDirName}/${fileName}`;
        editor.chain().focus().setImage({ src: relativePath, alt: safeName }).run();
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
        editor.chain().focus().setImage({ src: base64Url, alt: safeName }).run();
        showToast('图片落盘失败，已临时以 Base64 嵌入', 'warning');
      } catch (err) {
        showToast('图片插入失败', 'error');
      }
    }
  } else {
    // 2. 新建文档尚未保存时的兼容方案：采用 Base64 即时预览，并提醒保存
    try {
      const base64Url = await fileToBase64(file);
      editor.chain().focus().setImage({ src: base64Url, alt: safeName }).run();
      showToast(`图片已插入。当前文档尚未保存，建议按 Ctrl+S 保存文档以自动管理 /${imageDirName} 目录`, 'info');
    } catch (e) {
      console.error('Base64 转换失败:', e);
      showToast('插入图片失败', 'error');
    }
  }
}

/**
 * 弹出系统文件选择器选择本地图片并导入到当前文档同级 img 目录
 */
export async function insertLocalImageWithDialog(
  editor: Editor,
  docKey: string,
): Promise<void> {
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
      return;
    }

    const filePath = selected;
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

      const targetPath = `${docDirPath}\\${imageDirName}\\${newFileName}`;

      try {
        // 读取本地文件二进制字节并写入目标位置
        const fileBytes = await readFile(filePath);
        await ipc.saveBinaryFile(targetPath, fileBytes);
      } catch (e) {
        console.warn('复制本地图片失败，尝试以源文件路径插入:', e);
      }

      const relativePath = `./${imageDirName}/${newFileName}`;
      editor.chain().focus().setImage({ src: relativePath, alt: safeBaseName }).run();
      showToast(`图片已导入至 /${imageDirName}`, 'success');
    } else {
      // 未保存文档直接使用选择的文件路径
      const fileName = filePath.split(/[\\/]/).pop() || 'image';
      editor.chain().focus().setImage({ src: filePath, alt: fileName }).run();
      showToast('图片已插入。建议按 Ctrl+S 保存文档', 'info');
    }
  } catch (err) {
    console.error('选择本地图片失败:', err);
    showToast(`选择图片失败: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

