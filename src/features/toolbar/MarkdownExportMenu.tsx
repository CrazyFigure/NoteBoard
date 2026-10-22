// NoteBoard Markdown 顶部操作栏「导出」下拉菜单
// 当前提供导出 PDF；导出基于可视化模式的渲染结果，源码模式下提示切换

import React, { useCallback, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { Download, FileText, Loader2 } from 'lucide-react';
import type { Tab } from '../../stores/windowStore';
import { showToast } from '../../stores/toastStore';
import { getMdTipTapEditor } from '../editor-md/editorInstances';
import { defaultPdfPath, exportMarkdownPdf } from '../export/markdownPdfExport';
import { ToolbarButton, ToolbarDropdown, ToolbarDropdownItem } from './ToolbarComponents';

interface MarkdownExportMenuProps {
  tab: Tab;
  editor: Editor | null;
}

export function MarkdownExportMenu({ tab, editor: propEditor }: MarkdownExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const handleExportPdf = useCallback(async () => {
    setOpen(false);
    if (exporting) return;

    // 导出依赖可视化模式已渲染的正文 DOM
    const editor = propEditor || getMdTipTapEditor(tab.key) || null;
    if (tab.viewMode === 'source' || !editor || editor.isDestroyed) {
      showToast('请切换到可视化模式后导出 PDF', 'info');
      return;
    }

    setExporting(true);
    try {
      const saved = await exportMarkdownPdf(editor, { defaultPath: defaultPdfPath(tab.displayName, tab.path) });
      if (saved) showToast('已导出 PDF', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast(`导出 PDF 失败：${message}`, 'error');
    } finally {
      setExporting(false);
    }
  }, [exporting, propEditor, tab.displayName, tab.key, tab.path, tab.viewMode]);

  return (
    <ToolbarDropdown
      isOpen={open}
      onOpenChange={(next) => setOpen(exporting ? false : next)}
      align="right"
      trigger={
        <ToolbarButton
          icon={
            exporting ? (
              <Loader2 size={15} strokeWidth={2.2} style={{ animation: 'nb-prompt-spin 0.9s linear infinite' }} />
            ) : (
              <Download size={15} strokeWidth={2.2} />
            )
          }
          title={exporting ? '正在导出' : '导出'}
          active={open}
          disabled={exporting}
          hasDropdown
        />
      }
    >
      <ToolbarDropdownItem
        icon={<FileText size={14} />}
        label="导出 PDF"
        onClick={() => void handleExportPdf()}
      />
    </ToolbarDropdown>
  );
}
