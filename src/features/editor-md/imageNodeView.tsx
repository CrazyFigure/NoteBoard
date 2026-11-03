// NoteBoard Markdown 现代图片扩展与交互组件
// 支持本地相对路径动态解析、悬停工具栏、大图预览查看器、多级缩放与拖拽拉伸、居左/居中/居右对齐

import React, { useState, useEffect } from 'react';
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { Maximize2, AlignLeft, AlignCenter, AlignRight, Trash2, AlertCircle, RefreshCw, Link2 } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import * as ipc from '../../core/ipc/commands';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
import { useExplorerStore } from '../explorer/explorerStore';
import { handleLinkClick, isAbsoluteLocalPath, resolveRelativeDocPath } from './linkHandler';
import { openDocument } from '../editor-code/orchestration/openDocument';
import { Tooltip } from '../../components/Tooltip';
import { EnhancedImageBlockCore } from './imageCore';
import { ImagePreviewOverlay } from '../image-viewer/ImagePreviewOverlay';

// 保留既有导出入口，界面和调用方继续使用同一份核心规则。
export { parseLinkedImageToken, normalizeImageWidth, normalizeImageAlign, renderImageMarkdown, formatMarkdownDestination } from './imageCore';

/** TipTap 图片 NodeView 组件 */
export function ImageComponent({ node, updateAttributes, deleteNode }: NodeViewProps) {
  const [hovered, setHovered] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [resolvedDisplaySrc, setResolvedDisplaySrc] = useState<string>('');
  const [resolvedAbsPath, setResolvedAbsPath] = useState<string | null>(null);

  const rawSrc: string = node.attrs.src || '';
  const alt: string = node.attrs.alt || '';
  const align: 'left' | 'center' | 'right' = node.attrs.align || 'center';
  const width: string = node.attrs.width || '100%';
  const linkHref: string = node.attrs.href || '';

  // 动态解析图片真实 URL
  useEffect(() => {
    setLoadError(false);
    if (!rawSrc) {
      setResolvedDisplaySrc('');
      setResolvedAbsPath(null);
      return;
    }

    // 1. 网络 URL 或 Base64
    if (
      rawSrc.startsWith('http://') ||
      rawSrc.startsWith('https://') ||
      rawSrc.startsWith('data:') ||
      rawSrc.startsWith('asset:')
    ) {
      setResolvedDisplaySrc(rawSrc);
      setResolvedAbsPath(null);
      return;
    }

    // 2. 本地相对路径或绝对路径
    const activeKey = useWindowStore.getState().activeKey;
    const currentDoc = activeKey ? useDocumentStore.getState().getDocument(activeKey) : null;
    const baseDir = currentDoc?.dirPath || useExplorerStore.getState().root;

    if (baseDir) {
      const absPath = resolveRelativeDocPath(baseDir, rawSrc);
      setResolvedAbsPath(absPath);
      try {
        setResolvedDisplaySrc(convertFileSrc(absPath));
      } catch {
        setResolvedDisplaySrc(rawSrc);
      }
    } else if (isAbsoluteLocalPath(rawSrc)) {
      setResolvedAbsPath(rawSrc);
      try {
        setResolvedDisplaySrc(convertFileSrc(rawSrc));
      } catch {
        setResolvedDisplaySrc(rawSrc);
      }
    } else {
      setResolvedDisplaySrc(rawSrc);
      setResolvedAbsPath(null);
    }
  }, [rawSrc]);

  // 处理对齐样式
  const alignContainerStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent:
      align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center',
    margin: '16px 0',
    width: '100%',
    position: 'relative',
    userSelect: 'none',
  };

  // 拖拽调整宽度
  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const initialWidth = parseInt(width, 10) || 100;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const diff = moveEvent.clientX - startX;
      const step = Math.round(diff / 5);
      const newWidth = Math.max(20, Math.min(100, initialWidth + step));
      updateAttributes({ width: `${newWidth}%` });
    };

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  // 在 NoteBoard 独立标签页中打开大图
  const handleOpenInTab = async () => {
    setLightboxOpen(false);
    if (resolvedAbsPath) {
      await openDocument(resolvedAbsPath);
    }
  };

  // 在系统文件夹中显示
  const handleRevealInDir = async () => {
    if (resolvedAbsPath) {
      await ipc.revealInExplorer(resolvedAbsPath);
    }
  };

  return (
    <NodeViewWrapper style={alignContainerStyle}>
      <div
        style={{
          position: 'relative',
          display: 'inline-block',
          width: width === '100%' ? '100%' : width,
          maxWidth: '100%',
          borderRadius: 8,
          transition: 'width 150ms ease',
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {/* 悬停浮层快捷操作工具栏 */}
        {hovered && (
          <div
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              zIndex: 30,
              background: 'var(--editor-surface, rgba(255, 255, 255, 0.95))',
              border: '1px solid var(--editor-border)',
              borderRadius: 8,
              padding: '3px 6px',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              boxShadow: 'var(--shadow-md)',
              backdropFilter: 'blur(8px)',
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {/* 查看大图 */}
            <Tooltip content="查看大图 / 放大预览" side="top" sideOffset={4}>
              <button
                type="button"
                aria-label="查看大图 / 放大预览"
                onClick={() => setLightboxOpen(true)}
                style={actionBtnStyle}
              >
                <Maximize2 size={14} color="var(--accent-strong)" />
              </button>
            </Tooltip>

            {/* 图片外层链接（如 README 徽章）：按普通链接规则打开 */}
            {linkHref && (
              <Tooltip content={`打开链接：${linkHref}`} side="top" sideOffset={4}>
                <button
                  type="button"
                  aria-label="打开图片链接"
                  onClick={() => {
                    void handleLinkClick(linkHref, useWindowStore.getState().activeKey ?? '');
                  }}
                  style={actionBtnStyle}
                >
                  <Link2 size={14} color="var(--accent-strong)" />
                </button>
              </Tooltip>
            )}

            <div style={{ width: 1, height: 14, background: 'var(--editor-border)' }} />

            {/* 对齐方式 */}
            <Tooltip content="居左对齐" side="top" sideOffset={4}>
              <button
                type="button"
                aria-label="居左对齐"
                onClick={() => updateAttributes({ align: 'left' })}
                style={{
                  ...actionBtnStyle,
                  background: align === 'left' ? 'var(--toolbar-active)' : 'transparent',
                }}
              >
                <AlignLeft size={14} />
              </button>
            </Tooltip>
            <Tooltip content="居中对齐" side="top" sideOffset={4}>
              <button
                type="button"
                aria-label="居中对齐"
                onClick={() => updateAttributes({ align: 'center' })}
                style={{
                  ...actionBtnStyle,
                  background: align === 'center' ? 'var(--toolbar-active)' : 'transparent',
                }}
              >
                <AlignCenter size={14} />
              </button>
            </Tooltip>
            <Tooltip content="居右对齐" side="top" sideOffset={4}>
              <button
                type="button"
                aria-label="居右对齐"
                onClick={() => updateAttributes({ align: 'right' })}
                style={{
                  ...actionBtnStyle,
                  background: align === 'right' ? 'var(--toolbar-active)' : 'transparent',
                }}
              >
                <AlignRight size={14} />
              </button>
            </Tooltip>

            <div style={{ width: 1, height: 14, background: 'var(--editor-border)' }} />

            {/* 快速缩放预设 */}
            <Tooltip content="缩放为 50%" side="top" sideOffset={4}>
              <button
                type="button"
                aria-label="缩放为 50%"
                onClick={() => updateAttributes({ width: '50%' })}
                style={{
                  ...actionBtnStyle,
                  fontSize: 11,
                  fontWeight: 600,
                  color: width === '50%' ? 'var(--accent-strong)' : 'inherit',
                  background: width === '50%' ? 'var(--toolbar-active)' : 'transparent',
                }}
              >
                50%
              </button>
            </Tooltip>
            <Tooltip content="缩放为 75%" side="top" sideOffset={4}>
              <button
                type="button"
                aria-label="缩放为 75%"
                onClick={() => updateAttributes({ width: '75%' })}
                style={{
                  ...actionBtnStyle,
                  fontSize: 11,
                  fontWeight: 600,
                  color: width === '75%' ? 'var(--accent-strong)' : 'inherit',
                  background: width === '75%' ? 'var(--toolbar-active)' : 'transparent',
                }}
              >
                75%
              </button>
            </Tooltip>
            <Tooltip content="缩放为 100%" side="top" sideOffset={4}>
              <button
                type="button"
                aria-label="缩放为 100%"
                onClick={() => updateAttributes({ width: '100%' })}
                style={{
                  ...actionBtnStyle,
                  fontSize: 11,
                  fontWeight: 600,
                  color: width === '100%' ? 'var(--accent-strong)' : 'inherit',
                  background: width === '100%' ? 'var(--toolbar-active)' : 'transparent',
                }}
              >
                100%
              </button>
            </Tooltip>

            <div style={{ width: 1, height: 14, background: 'var(--editor-border)' }} />

            {/* 删除图片 */}
            <Tooltip content="删除图片" side="top" sideOffset={4}>
              <button
                type="button"
                aria-label="删除图片"
                onClick={deleteNode}
                style={{ ...actionBtnStyle, color: '#ef4444' }}
              >
                <Trash2 size={14} />
              </button>
            </Tooltip>
          </div>
        )}

        {/* 错误提示态 */}
        {loadError ? (
          <div
            style={{
              padding: '24px 16px',
              border: '1px dashed var(--error-500, #ef4444)',
              borderRadius: 8,
              background: 'rgba(239, 68, 68, 0.05)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              color: 'var(--editor-text)',
              fontSize: 13,
            }}
          >
            <AlertCircle size={24} color="#ef4444" />
            <div style={{ fontWeight: 500 }}>图片加载失败</div>
            <div style={{ fontSize: 11, color: 'var(--editor-text-muted)', wordBreak: 'break-all' }}>
              {rawSrc}
            </div>
            <button
              type="button"
              onClick={() => {
                setLoadError(false);
                setResolvedDisplaySrc((s) => `${s}?r=${Date.now()}`);
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '4px 10px',
                border: '1px solid var(--control-border)',
                borderRadius: 4,
                background: 'var(--editor-surface)',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              <RefreshCw size={12} />
              <span>重新加载</span>
            </button>
          </div>
        ) : (
          /* 禁用 Referer 携带，防止防盗链拦截并支持跨域图片原生渲染 */
          <img
            src={resolvedDisplaySrc}
            alt={alt}
            referrerPolicy="no-referrer"
            onError={() => setLoadError(true)}
            onDoubleClick={() => setLightboxOpen(true)}
            style={{
              width: '100%',
              height: 'auto',
              display: 'block',
              borderRadius: 8,
              cursor: 'zoom-in',
              boxShadow: hovered
                ? '0 4px 16px rgba(0, 0, 0, 0.12)'
                : '0 1px 3px rgba(0, 0, 0, 0.05)',
              border: hovered
                ? '1px solid var(--editor-border-focus)'
                : '1px solid var(--editor-border)',
              transition: 'box-shadow 150ms ease, border-color 150ms ease',
            }}
          />
        )}

        {/* 拖拽缩放手柄（右下角） */}
        {hovered && !loadError && (
          <Tooltip content="拖拽拉伸调节图片尺寸" side="left" sideOffset={6}>
            <div
              onMouseDown={handleResizeStart}
              aria-label="拖拽拉伸调节图片尺寸"
              style={{
                position: 'absolute',
                bottom: 4,
                right: 4,
                width: 14,
                height: 14,
                background: 'var(--accent-strong, #3b82f6)',
                borderRadius: '50%',
                cursor: 'ew-resize',
                border: '2px solid #ffffff',
                boxShadow: '0 2px 4px rgba(0, 0, 0, 0.25)',
                zIndex: 20,
              }}
            />
          </Tooltip>
        )}

        {/* 替代文本 Caption 说明 */}
        {alt && (
          <div
            style={{
              textAlign: align,
              fontSize: 12,
              color: 'var(--editor-text-muted)',
              marginTop: 4,
              fontStyle: 'italic',
            }}
          >
            {alt}
          </div>
        )}
      </div>

      {/* 大图预览：与思维导图图片共用浮层，支持滚轮滚动、Ctrl/⌘+滚轮缩放、拖动平移 */}
      {lightboxOpen && resolvedDisplaySrc && (
        <ImagePreviewOverlay
          src={resolvedDisplaySrc}
          alt={alt}
          onClose={() => setLightboxOpen(false)}
          onOpenInTab={resolvedAbsPath ? handleOpenInTab : undefined}
          onRevealInDir={resolvedAbsPath ? handleRevealInDir : undefined}
        />
      )}
    </NodeViewWrapper>
  );
}

const actionBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: '4px 6px',
  borderRadius: 4,
  cursor: 'pointer',
  color: 'var(--editor-text)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'background var(--transition-fast)',
};

/** TipTap 增强版 Image 扩展定义 */
export const EnhancedImageBlock = EnhancedImageBlockCore.extend({

  addNodeView() {
    return ReactNodeViewRenderer(ImageComponent);
  },

  addCommands() {
    return {
      setImage:
        (options: { src: string; alt?: string; title?: string; width?: string; align?: string }) =>
        ({ commands }: { commands: { insertContent: (content: unknown) => boolean } }) => {
          return commands.insertContent({
            type: 'image',
            attrs: options,
          });
        },
    } as never;
  }
});

