// NoteBoard 思维导图共享顶部操作栏
// 供独立 .mindmap 文件编辑器与 Markdown 内嵌思维导图块共用：
// 统一缩放、重置节点宽度、概要/外框/联系线插入、布局/连线/配色切换、导入与导出交互与样式

import React, { useState } from 'react';
import {
  Braces,
  ChevronDown,
  Download,
  FileText,
  Image as ImageIcon,
  MoveHorizontal,
  Network,
  RotateCcw,
  Spline,
  SquareDashed,
  Upload,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { MindmapEdgeStyle, MindmapLayout } from './mindmapTypes';
import type { MindmapSelectionInfo } from './MindmapRenderer';
import type { MindmapImageFormat } from './mindmapImageExport';
import { Dropdown, DropdownItem, MindmapStyleControls } from './MindmapStyleControls';
import { Tooltip } from '../../components/Tooltip';
import { showToast } from '../../stores/toastStore';

export interface MindmapCanvasToolbarProps {
  /** 左侧区域内容（独立编辑器传入导图/大纲切换胶囊；Markdown 嵌入块传入紧凑标识） */
  leftSlot?: React.ReactNode;
  /** 沉浸阅读时隐藏顶栏 */
  hidden?: boolean;
  /** 是否显示画布相关控制项（如独立编辑器在大纲模式下设为 false） */
  showCanvasControls?: boolean;
  /** 只读模式（如 Markdown 沉浸阅读）：隐藏修改类控件，仅保留缩放与导出 */
  readOnly?: boolean;
  zoom: number;
  onZoomChange: (updater: (zoom: number) => number) => void;
  onResetZoom: () => void;
  hasCustomWidths: boolean;
  onResetAllWidths: () => void;
  selection: MindmapSelectionInfo;
  onAddSummary: () => void;
  onAddBoundary: () => void;
  onStartConnect: () => void;
  layout: MindmapLayout;
  themeId: string;
  edgeStyle?: MindmapEdgeStyle;
  onStyleChange: (next: { layout?: MindmapLayout; theme?: string; edgeStyle?: MindmapEdgeStyle | null }) => void;
  onImportFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onExportXmind: () => void;
  onExportMarkdown: () => void;
  onExportImage: (format: MindmapImageFormat) => void;
  /** 右侧附加操作按钮（如沉浸阅读按钮或内嵌全屏按钮） */
  extraActions?: React.ReactNode;
  className?: string;
}

/** 顶部插入按钮：条件不满足时提示选中引导，避免点击无响应 */
function runInsert(enabled: boolean, hint: string, action: () => void) {
  if (!enabled) {
    showToast(hint, 'info');
    return;
  }
  action();
}

export function MindmapCanvasToolbar({
  leftSlot,
  hidden = false,
  showCanvasControls = true,
  readOnly = false,
  zoom,
  onZoomChange,
  onResetZoom,
  hasCustomWidths,
  onResetAllWidths,
  selection,
  onAddSummary,
  onAddBoundary,
  onStartConnect,
  layout,
  themeId,
  edgeStyle,
  onStyleChange,
  onImportFile,
  onExportXmind,
  onExportMarkdown,
  onExportImage,
  extraActions,
  className,
}: MindmapCanvasToolbarProps) {
  const [exportOpen, setExportOpen] = useState(false);

  // 概要 / 外框需选中非中心主题的节点；联系线需恰好选中一个节点
  const canAddRange = selection.nodeIds.length > 0 && !selection.includesRoot;
  const canConnect = selection.nodeIds.length === 1;

  return (
    <div
      className={className ? `nb-editor-topbar ${className}` : 'nb-editor-topbar'}
      style={{
        height: 40,
        minHeight: 40,
        display: hidden ? 'none' : 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 14px',
        borderBottom: '1px solid var(--editor-border, #e2e8f0)',
        background: 'var(--editor-surface, #f8fafc)',
        userSelect: 'none',
        fontSize: 12,
      }}
    >
      {/* 左侧插槽 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{leftSlot}</div>

      {/* 右侧：缩放、结构插入、样式切换、附加按钮与导入导出 */}
      <div className="nb-mindmap-topbar-actions" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {showCanvasControls && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginRight: readOnly ? 0 : 6 }}>
            <Tooltip content="缩小画布" side="bottom" sideOffset={4}>
              <button
                type="button"
                className="nb-editor-icon-btn nb-mindmap-zoom-btn"
                onClick={() => onZoomChange((z) => Math.max(0.2, z - 0.15))}
                aria-label="缩小画布"
              >
                <ZoomOut size={15} />
              </button>
            </Tooltip>
            {/* 缩放百分比：等宽数字避免缩放时宽度抖动 */}
            <span style={{ fontSize: 12, minWidth: 36, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
              {Math.round(zoom * 100)}%
            </span>
            <Tooltip content="放大画布" side="bottom" sideOffset={4}>
              <button
                type="button"
                className="nb-editor-icon-btn nb-mindmap-zoom-btn"
                onClick={() => onZoomChange((z) => Math.min(3, z + 0.15))}
                aria-label="放大画布"
              >
                <ZoomIn size={15} />
              </button>
            </Tooltip>
            <Tooltip content="复位 100%" side="bottom" sideOffset={4}>
              <button
                type="button"
                className="nb-editor-icon-btn nb-mindmap-zoom-btn"
                onClick={onResetZoom}
                aria-label="复位 100%"
              >
                <RotateCcw size={13} />
              </button>
            </Tooltip>
            {!readOnly && (
              <Tooltip
                content={hasCustomWidths ? '重置全部节点宽度' : '没有手动调整过宽度的节点'}
                side="bottom"
                sideOffset={4}
              >
                <button
                  type="button"
                  className="nb-editor-icon-btn"
                  onClick={onResetAllWidths}
                  disabled={!hasCustomWidths}
                  aria-label="重置全部节点宽度"
                  style={{ opacity: hasCustomWidths ? 1 : 0.4, cursor: hasCustomWidths ? 'pointer' : 'default' }}
                >
                  <MoveHorizontal size={13} />
                </button>
              </Tooltip>
            )}
          </div>
        )}

        {/* 插入概要 / 外框 / 联系线（仅导图模式且可编辑，作用于选中的节点） */}
        {showCanvasControls && !readOnly && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Tooltip content="为选中节点添加概要（Shift / Ctrl 多选同层节点，可跨父节点）" side="bottom" sideOffset={4}>
              <button
                type="button"
                className="nb-editor-toolbar-btn"
                aria-disabled={!canAddRange}
                style={{ opacity: canAddRange ? 1 : 0.5 }}
                onClick={() => runInsert(canAddRange, '先选中一个或多个同层节点（中心主题除外）', onAddSummary)}
              >
                <Braces size={13} />
                <span>概要</span>
              </button>
            </Tooltip>
            <Tooltip content="为选中节点添加外框（Shift / Ctrl 多选同层节点，可跨父节点）" side="bottom" sideOffset={4}>
              <button
                type="button"
                className="nb-editor-toolbar-btn"
                aria-disabled={!canAddRange}
                style={{ opacity: canAddRange ? 1 : 0.5 }}
                onClick={() => runInsert(canAddRange, '先选中一个或多个同层节点（中心主题除外）', onAddBoundary)}
              >
                <SquareDashed size={13} />
                <span>外框</span>
              </button>
            </Tooltip>
            <Tooltip content="从选中节点拉一条联系线，再点击目标节点" side="bottom" sideOffset={4}>
              <button
                type="button"
                className="nb-editor-toolbar-btn"
                aria-disabled={!canConnect}
                style={{ opacity: canConnect ? 1 : 0.5 }}
                onClick={() => runInsert(canConnect, '先选中一个起点节点', onStartConnect)}
              >
                <Spline size={13} />
                <span>联系线</span>
              </button>
            </Tooltip>
          </div>
        )}

        {/* 布局、连线样式与配色主题切换（仅导图模式且可编辑） */}
        {showCanvasControls && !readOnly && (
          <MindmapStyleControls
            layout={layout}
            themeId={themeId}
            edgeStyle={edgeStyle}
            onLayoutChange={(nextLayout) => onStyleChange({ layout: nextLayout })}
            onThemeChange={(nextTheme) => onStyleChange({ theme: nextTheme })}
            onEdgeStyleChange={(nextEdgeStyle) => onStyleChange({ edgeStyle: nextEdgeStyle ?? null })}
          />
        )}

        {/* 扩展操作区（独立编辑器：沉浸阅读；Markdown 嵌入块：全屏编辑） */}
        {extraActions}

        {/* 导入：XMind 或 Markdown 大纲 */}
        {!readOnly && (
          <Tooltip content="导入 XMind 或 Markdown 文件" side="bottom" sideOffset={4}>
            <label className="nb-editor-toolbar-btn">
              <Upload size={13} />
              <span>导入</span>
              <input
                type="file"
                accept=".xmind,.md,.markdown"
                style={{ display: 'none' }}
                onChange={onImportFile}
              />
            </label>
          </Tooltip>
        )}

        {/* 导出：XMind / Markdown / PNG / JPG */}
        <Dropdown
          open={exportOpen}
          onOpenChange={setExportOpen}
          menuStyle={{ minWidth: 180 }}
          trigger={
            <Tooltip content="导出为其他格式" side="bottom" sideOffset={4}>
              <span className="nb-editor-primary-btn" role="button" aria-haspopup="menu" aria-expanded={exportOpen}>
                <Download size={13} />
                <span>导出</span>
                <ChevronDown size={12} style={{ opacity: 0.85 }} />
              </span>
            </Tooltip>
          }
        >
          <DropdownItem
            onClick={() => {
              setExportOpen(false);
              onExportXmind();
            }}
          >
            <Network size={14} />
            <span style={{ flex: 1 }}>XMind</span>
            <span style={{ fontSize: 11, opacity: 0.55 }}>.xmind</span>
          </DropdownItem>
          <DropdownItem
            onClick={() => {
              setExportOpen(false);
              onExportMarkdown();
            }}
          >
            <FileText size={14} />
            <span style={{ flex: 1 }}>Markdown</span>
            <span style={{ fontSize: 11, opacity: 0.55 }}>.md</span>
          </DropdownItem>
          <div style={{ height: 1, margin: '4px 6px', background: 'var(--editor-border, #e2e8f0)' }} />
          <DropdownItem
            onClick={() => {
              setExportOpen(false);
              onExportImage('png');
            }}
          >
            <ImageIcon size={14} />
            <span style={{ flex: 1 }}>PNG 图片</span>
            <span style={{ fontSize: 11, opacity: 0.55 }}>.png</span>
          </DropdownItem>
          <DropdownItem
            onClick={() => {
              setExportOpen(false);
              onExportImage('jpeg');
            }}
          >
            <ImageIcon size={14} />
            <span style={{ flex: 1 }}>JPG 图片</span>
            <span style={{ fontSize: 11, opacity: 0.55 }}>.jpg</span>
          </DropdownItem>
        </Dropdown>
      </div>
    </div>
  );
}
