// NoteBoard 图片粘贴落盘
// assets/{时间戳}_{安全化原名}，相对路径引用（FR-313）
// 详见 docs/09-开发路线图.md 7.11

import type { Editor } from '@tiptap/core';
import * as ipc from '../../core/ipc/commands';

/** 安全化文件名：只保留字母数字汉字和常见分隔符 */
function sanitizeFileName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100);
}

/**
 * 处理粘贴的图片
 * 将图片保存到 assets/ 目录，返回相对路径
 */
export async function handlePastedImage(
  editor: Editor,
  file: File,
  docDirPath: string,
  imageDirName: string,
): Promise<void> {
  // 生成文件名：时间戳_安全化原名
  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'png';
  const safeName = sanitizeFileName(file.name.replace(/\.[^.]+$/, ''));
  const timestamp = Date.now();
  const fileName = `${timestamp}_${safeName || 'image'}.${ext}`;

  // 构建目标路径：docDir/assets/fileName
  const targetDir = `${docDirPath}\\${imageDirName}`;
  const targetPath = `${targetDir}\\${fileName}`;

  try {
    // 确保目录存在
    try {
      await ipc.createDir(docDirPath, imageDirName);
    } catch {
      // 目录可能已存在，忽略
    }

    // 读取图片数据
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    // 写入文件（使用 write_document 写二进制）
    // 注意：write_document 期望字符串，图片是二进制
    // 这里用 base64 编码写入，但更好的方式是直接写文件
    // 暂时用 writeDocument 写文本方式（后续改进）
    const base64 = btoa(String.fromCharCode(...bytes));
    await ipc.writeDocument(targetPath, base64, 'utf8', 'lf');

    // 构建相对路径引用
    const relativePath = `./${imageDirName}/${fileName}`;

    // 在编辑器中插入图片
    editor.chain().focus().setImage({ src: relativePath, alt: safeName }).run();
  } catch (e) {
    console.error('图片粘贴落盘失败:', e);
  }
}

/**
 * 处理粘贴事件
 * 注册到 TipTap 编辑器的 editorProps
 */
export function createPasteHandler(
  editor: Editor,
  docDirPath: string,
  imageDirName: string,
) {
  return {
    handlePaste: (view: unknown, event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) return false;

      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            handlePastedImage(editor, file, docDirPath, imageDirName);
            event.preventDefault();
            return true;
          }
        }
      }
      return false;
    },
  };
}
