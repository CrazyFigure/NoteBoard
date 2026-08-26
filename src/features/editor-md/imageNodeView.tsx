// NoteBoard Markdown 现代图片扩展与交互组件
// 支持本地相对路径动态解析、悬停工具栏、大图预览查看器、多级缩放与拖拽拉伸、居左/居中/居右对齐

import React, { useState, useEffect } from 'react';
import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Trash2,
  ExternalLink,
  FolderOpen,
  RotateCw,
  X,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import * as ipc from '../../core/ipc/commands';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
import { useExplorerStore } from '../explorer/explorerStore';
import { resolveRelativeDocPath } from './linkHandler';
import { openDocument } from '../editor-code/orchestration/openDocument';

/** 大图预览 Lightbox 模态框组件 */
function ImageLightboxModal({
  src,
  alt,
  onClose,
  onOpenInTab,
  onRevealInDir,
}: {
  src: string;
  alt?: string;
  onClose: () => void;
  onOpenInTab?: () => void;
  onRevealInDir?: () => void;
}) {
  const [scale, setScale] = useState(1);
  const [rotate, setRotate] = useState(0);

  // 监听 Esc 键快速关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 9999,
        background: 'rgba(0, 0, 0, 0.82)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        userSelect: 'none',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* 顶部悬浮控制栏 */}
      <div
        style={{
          position: 'absolute',
          top: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          background: 'rgba(30, 41, 59, 0.85)',
          padding: '6px 14px',
          borderRadius: 24,
          boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
          color: '#ffffff',
          zIndex: 10000,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          title="缩小 (Zoom Out)"
          onClick={() => setScale((s) => Math.max(0.2, s - 0.2))}
          style={modalBtnStyle}
        >
          <ZoomOut size={16} />
        </button>
        <span style={{ fontSize: 12, minWidth: 44, textAlign: 'center' }}>
          {Math.round(scale * 100)}%
        </span>
        <button
          type="button"
          title="放大 (Zoom In)"
          onClick={() => setScale((s) => Math.min(4, s + 0.2))}
          style={modalBtnStyle}
        >
          <ZoomIn size={16} />
        </button>
        <button
          type="button"
          title="顺时针旋转 90°"
          onClick={() => setRotate((r) => (r + 90) % 360)}
          style={modalBtnStyle}
        >
          <RotateCw size={16} />
        </button>
        <button
          type="button"
          title="还原 100%"
          onClick={() => {
            setScale(1);
            setRotate(0);
          }}
          style={modalBtnStyle}
        >
          <Maximize2 size={16} />
        </button>

        {onOpenInTab && (
          <button
            type="button"
            title="在独立图片标签页中打开"
            onClick={onOpenInTab}
            style={modalBtnStyle}
          >
            <ExternalLink size={16} />
          </button>
        )}

        {onRevealInDir && (
          <button
            type="button"
            title="在文件夹中显示原图"
            onClick={onRevealInDir}
            style={modalBtnStyle}
          >
            <FolderOpen size={16} />
          </button>
        )}

        <button
          type="button"
          title="关闭 (Esc)"
          onClick={onClose}
          style={{ ...modalBtnStyle, color: '#f87171' }}
        >
          <X size={18} />
        </button>
      </div>

      {/* 图片主视图 */}
      <div
        style={{
          maxWidth: '90vw',
          maxHeight: '85vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          transition: 'transform 120ms ease',
          transform: `scale(${scale}) rotate(${rotate}deg)`,
        }}
      >
        {/* 禁用 Referer 携带，防止防盗链拦截 */}
        <img
          src={src}
          alt={alt || 'Image Preview'}
          referrerPolicy="no-referrer"
          style={{
            maxWidth: '100%',
            maxHeight: '85vh',
            objectFit: 'contain',
            borderRadius: 4,
            boxShadow: '0 12px 36px rgba(0, 0, 0, 0.5)',
          }}
        />
      </div>

      {/* 底部信息 */}
      {alt && (
        <div
          style={{
            position: 'absolute',
            bottom: 20,
            color: 'rgba(255, 255, 255, 0.75)',
            fontSize: 13,
            background: 'rgba(0, 0, 0, 0.5)',
            padding: '4px 12px',
            borderRadius: 12,
          }}
        >
          {alt}
        </div>
      )}
    </div>
  );
}

const modalBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#ffffff',
  cursor: 'pointer',
  padding: '4px 6px',
  borderRadius: 4,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'background 120ms ease',
};

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
    } else if (/^[a-zA-Z]:[\\/]/.test(rawSrc)) {
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
            <button
              type="button"
              title="查看大图 / 放大预览"
              onClick={() => setLightboxOpen(true)}
              style={actionBtnStyle}
            >
              <Maximize2 size={14} color="var(--accent-strong)" />
            </button>

            <div style={{ width: 1, height: 14, background: 'var(--editor-border)' }} />

            {/* 对齐方式 */}
            <button
              type="button"
              title="居左对齐"
              onClick={() => updateAttributes({ align: 'left' })}
              style={{
                ...actionBtnStyle,
                background: align === 'left' ? 'var(--toolbar-active)' : 'transparent',
              }}
            >
              <AlignLeft size={14} />
            </button>
            <button
              type="button"
              title="居中对齐"
              onClick={() => updateAttributes({ align: 'center' })}
              style={{
                ...actionBtnStyle,
                background: align === 'center' ? 'var(--toolbar-active)' : 'transparent',
              }}
            >
              <AlignCenter size={14} />
            </button>
            <button
              type="button"
              title="居右对齐"
              onClick={() => updateAttributes({ align: 'right' })}
              style={{
                ...actionBtnStyle,
                background: align === 'right' ? 'var(--toolbar-active)' : 'transparent',
              }}
            >
              <AlignRight size={14} />
            </button>

            <div style={{ width: 1, height: 14, background: 'var(--editor-border)' }} />

            {/* 快速缩放预设 */}
            <button
              type="button"
              title="缩放为 50%"
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
            <button
              type="button"
              title="缩放为 75%"
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
            <button
              type="button"
              title="缩放为 100%"
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

            <div style={{ width: 1, height: 14, background: 'var(--editor-border)' }} />

            {/* 删除图片 */}
            <button
              type="button"
              title="删除图片"
              onClick={deleteNode}
              style={{ ...actionBtnStyle, color: '#ef4444' }}
            >
              <Trash2 size={14} />
            </button>
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
                border: '1px solid var(--editor-border)',
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
          <div
            onMouseDown={handleResizeStart}
            title="拖拽拉伸调节图片尺寸"
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

      {/* 大图预览 Lightbox 模态框 */}
      {lightboxOpen && resolvedDisplaySrc && (
        <ImageLightboxModal
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
export const EnhancedImageBlock = Node.create({
  name: 'image',
  group: 'block',
  inline: false,
  draggable: true,
  selectable: true,
  isolating: true,

  addAttributes() {
    return {
      src: {
        default: null,
      },
      alt: {
        default: null,
      },
      title: {
        default: null,
      },
      width: {
        default: '100%',
      },
      align: {
        default: 'center',
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'img[src]',
        getAttrs: (dom) => {
          if (typeof dom === 'string') return {};
          const el = dom as HTMLImageElement;
          return {
            src: el.getAttribute('data-raw-src') || el.getAttribute('src'),
            alt: el.getAttribute('alt'),
            title: el.getAttribute('title'),
            width: el.getAttribute('data-width') || '100%',
            align: el.getAttribute('data-align') || 'center',
          };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    // 渲染 HTML 时默认添加 referrerpolicy，确保导出或预览时不被防盗链拦截
    return ['img', mergeAttributes({ referrerpolicy: 'no-referrer' }, HTMLAttributes)];
  },

  parseMarkdown: (token, helpers) => {
    return helpers.createNode('image', {
      src: token.href,
      title: token.title,
      alt: token.text,
      width: '100%',
      align: 'center',
    });
  },

  renderMarkdown: (node) => {
    const src = node.attrs?.src ?? '';
    const alt = node.attrs?.alt ?? '';
    const title = node.attrs?.title ?? '';
    return title ? `![${alt}](${src} "${title}")` : `![${alt}](${src})`;
  },

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
  },
});

