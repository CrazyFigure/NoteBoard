// NoteBoard 思维导图通用操作辅助函数
// 提供节点自定义宽度判断/重置，以及 XMind / Markdown / 图片的导入导出能力，供独立导图编辑器与 Markdown 内嵌导图共用

import type {
  MindNode,
  MindmapEdgeStyle,
  MindmapImageFit,
  MindmapLayout,
  MindmapTextAlign,
} from './mindmapTypes';
import type { MindmapTheme } from './mindmapTheme';
import { exportToXmindZip, markdownToMindNode, mindNodeToMarkdown } from './mindmapConverter';
import { exportMindmapImageBlob, type MindmapImageFormat } from './mindmapImageExport';
import { cloneMindmapTree, getMindmapTreeStats, walkMindNodes } from './mindmapTree';
import { confirmMindmapImport, requestMindmapChoice } from './MindmapImportDialog';
import { exportBlobWithDialog } from '../export/chartExport';
import { showExportError, showExportSuccess } from '../../stores/exportResultStore';
import { showToast } from '../../stores/toastStore';

/** 树中是否存在手动拉伸过宽度的节点 */
export function hasCustomNodeWidth(node: MindNode): boolean {
  for (const current of walkMindNodes(node)) {
    if (typeof current.width === 'number') return true;
  }
  return false;
}

/** 返回移除所有手动宽度后的新树（不修改原树） */
export function clearNodeWidths(node: MindNode): MindNode {
  const cloned = cloneMindmapTree(node);
  for (const current of walkMindNodes(cloned)) {
    delete current.width;
  }
  return cloned;
}

/** 导出为 .xmind 文件（弹系统另存为对话框） */
export async function exportMindmapAsXmind(root: MindNode, baseName: string): Promise<void> {
  try {
    const blob = await exportToXmindZip(root);
    const defaultFilename = `${baseName}.xmind`;
    const filters = [
      { name: 'XMind 思维导图 (*.xmind)', extensions: ['xmind'] },
      { name: '全部文件 (*.*)', extensions: ['*'] },
    ];
    const saved = await exportBlobWithDialog(blob, defaultFilename, filters);
    if (saved) {
      showExportSuccess(saved, '已导出 XMind 文件');
    }
  } catch (err) {
    console.error('导出 XMind 失败:', err);
    showExportError(err, '导出 XMind 失败');
  }
}

/** 导出为 Markdown 大纲（弹系统另存为对话框） */
export async function exportMindmapAsMarkdown(root: MindNode, baseName: string): Promise<void> {
  try {
    const md = mindNodeToMarkdown(root);
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const defaultFilename = `${baseName}.md`;
    const filters = [
      { name: 'Markdown 大纲 (*.md)', extensions: ['md'] },
      { name: '全部文件 (*.*)', extensions: ['*'] },
    ];
    const saved = await exportBlobWithDialog(blob, defaultFilename, filters);
    if (saved) {
      showExportSuccess(saved, '已导出 Markdown 大纲');
    }
  } catch (err) {
    console.error('导出 Markdown 失败:', err);
    showExportError(err, '导出 Markdown 失败');
  }
}

export interface ExportMindmapImageOptions {
  root: MindNode;
  displayedRoot: MindNode;
  layout: MindmapLayout;
  theme: MindmapTheme;
  edgeStyle: MindmapEdgeStyle;
  maxNodeWidth: number;
  defaultTextAlign: MindmapTextAlign;
  defaultImageFit: MindmapImageFit;
  fontFamily: string;
  format: MindmapImageFormat;
  baseName: string;
}

/** 导出为 PNG / JPG 图片：按当前布局与配色独立排版绘制，内容自动居中 */
export async function exportMindmapAsImage(options: ExportMindmapImageOptions): Promise<void> {
  const {
    root,
    displayedRoot,
    layout,
    theme,
    edgeStyle,
    maxNodeWidth,
    defaultTextAlign,
    defaultImageFit,
    fontFamily,
    format,
    baseName,
  } = options;
  try {
    const scope = await requestMindmapChoice('选择图片导出范围', [
      { value: 'current', label: '按当前展开／折叠状态导出' },
      { value: 'all', label: '临时展开全部节点后导出' },
    ], '导出图片');
    if (scope === null) return;
    // 图片范围独立于视口裁剪；临时展开副本，不改变文件正文与当前画布状态
    const imageRoot = scope === 'all' ? cloneMindmapTree(root) : displayedRoot;
    if (scope === 'all') {
      for (const node of walkMindNodes(imageRoot)) node.isExpanded = true;
    }
    const blob = await exportMindmapImageBlob({
      root: imageRoot,
      layout,
      theme,
      edgeStyle,
      maxNodeWidth,
      defaultTextAlign,
      defaultImageFit,
      fontFamily,
      format,
    });
    const extension = format === 'jpeg' ? 'jpg' : 'png';
    const filters = [
      format === 'jpeg'
        ? { name: 'JPG 图片 (*.jpg)', extensions: ['jpg', 'jpeg'] }
        : { name: 'PNG 图片 (*.png)', extensions: ['png'] },
      { name: '全部文件 (*.*)', extensions: ['*'] },
    ];
    const saved = await exportBlobWithDialog(blob, `${baseName}.${extension}`, filters);
    if (saved) {
      showExportSuccess(saved, `已导出 ${extension.toUpperCase()} 图片`);
    }
  } catch (err) {
    console.error('导出图片失败:', err);
    showExportError(err, '导出图片失败');
  }
}

/** 读取 File 内容为 ArrayBuffer 或文本 */
function readFileContent(file: File, asBinary: boolean): Promise<ArrayBuffer | string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer | string);
    reader.onerror = () => reject(new Error('读取导入文件失败'));
    if (asBinary) reader.readAsArrayBuffer(file);
    else reader.readAsText(file);
  });
}

/**
 * 解析并校验本地导入的 .xmind 或 Markdown 大纲文件
 * 包含大文件提示、XMind 画布选择与节点数量/深度二次确认；取消或失败返回 null
 */
export async function readMindmapImportFile(file: File): Promise<{ root: MindNode; isXmind: boolean } | null> {
  const isXmind = /\.xmind$/i.test(file.name);
  if (
    !isXmind &&
    file.size > 20 * 1024 * 1024 &&
    !(await confirmMindmapImport(['Markdown 正文超过 20 MB，继续解析可能耗时较长并占用较多内存']))
  ) {
    return null;
  }

  try {
    const content = await readFileContent(file, isXmind);
    const importedRoot = isXmind
      ? await (await import('./xmindImportFlow')).importXmindWithDialogs(content as ArrayBuffer)
      : markdownToMindNode(String(content ?? ''));
    if (!importedRoot) return null;

    if (!isXmind) {
      const stats = getMindmapTreeStats(importedRoot);
      const risks: string[] = [];
      if (stats.nodeCount > 50_000) risks.push(`节点数为 ${stats.nodeCount}，超过 50,000 个，继续可能耗时较长`);
      if (stats.maxDepth > 500) risks.push(`层级深度为 ${stats.maxDepth}，超过 500 层，继续可能耗时较长`);
      if (!(await confirmMindmapImport(risks))) return null;
    }

    return { root: importedRoot, isXmind };
  } catch (err) {
    console.error('导入失败:', err);
    showToast(err instanceof Error ? err.message : '导入失败，文件格式可能不支持', 'error');
    return null;
  }
}
