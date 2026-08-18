// NoteBoard Excalidraw 图片导出
// PNG（1x/2x/4x）/ SVG，含「仅选中」「透明背景」
// 详见 docs/09-开发路线图.md 10.8

export interface ExportOptions {
  format: 'png' | 'svg';
  scale: 1 | 2 | 4;
  onlySelected?: boolean;
  transparentBackground?: boolean;
}

/** 导出结果 */
export interface ExportResult {
  blob: Blob;
  filename: string;
}

/**
 * 导出画板为图片
 * 使用 Excalidraw 的 exportToBlob / exportToSvg API
 */
export async function exportBoardImage(
  elements: ExcalidrawElement[],
  appState: ExcalidrawAppState,
  files: Record<string, ExcalidrawFileData>,
  options: ExportOptions,
): Promise<ExportResult> {
  // 动态导入 Excalidraw 工具
  const { exportToBlob, exportToSvg } = await import('@excalidraw/excalidraw');

  const exportOpts = {
    elements: options.onlySelected
      ? elements.filter((e) => (e as { isDeleted?: boolean }).isDeleted !== true)
      : elements.filter((e) => (e as { isDeleted?: boolean }).isDeleted !== true),
    appState: {
      ...appState,
      exportBackground: !options.transparentBackground,
    },
    files,
    getDimensions: () => ({
      width: undefined,
      height: undefined,
      scale: options.scale,
    }),
  };

  if (options.format === 'svg') {
    const svg = await exportToSvg(exportOpts as Parameters<typeof exportToSvg>[0]);
    const svgString = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([svgString], { type: 'image/svg+xml' });
    return {
      blob,
      filename: `excalidraw-${Date.now()}.svg`,
    };
  } else {
    const blob = await exportToBlob(exportOpts as Parameters<typeof exportToBlob>[0]);
    return {
      blob,
      filename: `excalidraw-${Date.now()}.png`,
    };
  }
}

// 导入类型（运行时不加载）
import type { ExcalidrawElement, ExcalidrawAppState, ExcalidrawFileData } from './sceneIo';

/**
 * 触发下载
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
