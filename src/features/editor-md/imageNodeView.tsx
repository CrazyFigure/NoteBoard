// NoteBoard Markdown 现代图片扩展与交互组件
// 支持本地相对路径动态解析、悬停工具栏、大图预览查看器、多级缩放与拖拽拉伸、居左/居中/居右对齐，
// 以及图片专属右键菜单（复制图片 / 复制为文件 / 另存为 / 重命名文件 / 编辑说明 / 删除等）

import React, { useState, useEffect, useRef } from 'react';
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import {
  Maximize2,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Trash2,
  AlertCircle,
  RefreshCw,
  Link2,
  Link,
  Copy,
  Files,
  Download,
  ExternalLink,
  FolderOpen,
  Globe,
  Share2,
  Captions,
  PenLine,
} from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import * as ipc from '../../core/ipc/commands';
import { IS_NATIVE_MOBILE, TARGET_PLATFORM } from '../../core/platform';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
import { showToast } from '../../stores/toastStore';
import { showPrompt } from '../../stores/promptDialogStore';
import { useExplorerStore } from '../explorer/explorerStore';
import { basenameOf } from '../explorer/pathUtils';
import { stopReactPropagation } from '../bitable/bitableUtils';
import { handleLinkClick, isAbsoluteLocalPath, resolveRelativeDocPath } from './linkHandler';
import { openDocument } from '../editor-code/orchestration/openDocument';
import { Tooltip } from '../../components/Tooltip';
import { EnhancedImageBlockCore } from './imageCore';
import { ImagePreviewOverlay } from '../image-viewer/ImagePreviewOverlay';
import {
  CAN_COPY_IMAGE_FILE,
  copyImageFileToClipboard,
  copyImageLocation,
  copyImageToClipboard,
  describeError,
  saveImageAs,
  type ImageSource,
} from '../image-viewer/imageClipboard';
import { ImageContextMenu, type ImageAlign, type ImageMenuItem, type ImageMenuSection } from './ImageContextMenu';
import { renameImageFile, splitFileName, validateFileStem } from './imageActions';

// 保留既有导出入口，界面和调用方继续使用同一份核心规则。
export { parseLinkedImageToken, normalizeImageWidth, normalizeImageAlign, renderImageMarkdown, formatMarkdownDestination } from './imageCore';

/** 图片节点视图根元素标记：右键插件据此识别点击是否落在图片上 */
const IMAGE_VIEW_ATTRIBUTE = 'data-nb-image-view';

/** 是否为打开右键菜单的点击：右键，或 macOS 上的 Control+左键 */
function isContextClick(event: MouseEvent): boolean {
  return event.button === 2 || (TARGET_PLATFORM === 'macos' && event.button === 0 && event.ctrlKey);
}

/** 事件目标是否位于当前编辑器内的图片节点视图中 */
function isInImageView(view: EditorView, target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  const imageView = element?.closest(`[${IMAGE_VIEW_ATTRIBUTE}]`);
  return Boolean(imageView && view.dom.contains(imageView));
}

/** 菜单信息头显示的名称：本地图片取文件名，网络图片取地址末段，内嵌图片统一称呼 */
function describeImageName(rawSrc: string, absPath: string | null): string {
  if (absPath) return basenameOf(absPath);
  if (rawSrc.startsWith('data:')) return '内嵌图片';
  try {
    const url = new URL(rawSrc);
    const segment = url.pathname.split('/').filter(Boolean).pop();
    return segment ? decodeURIComponent(segment) : url.host;
  } catch {
    return rawSrc || '图片';
  }
}

/** 图片格式简称（PNG / JPG / SVG …），用于菜单信息头 */
function describeImageFormat(rawSrc: string, absPath: string | null): string {
  const dataMime = /^data:image\/([a-z0-9.+-]+)[;,]/i.exec(rawSrc)?.[1];
  if (dataMime) return dataMime.replace(/\+xml$/i, '').toUpperCase();
  const name = absPath ? basenameOf(absPath) : rawSrc.split(/[?#]/)[0];
  const ext = /\.([a-z0-9]{2,5})$/i.exec(name)?.[1];
  return ext ? ext.toUpperCase() : '';
}

/**
 * 解析图片的显示地址与本地绝对路径：
 * 网络地址 / Base64 原样使用；相对路径按当前文档目录（或工作区根目录）解析为本地文件。
 */
function resolveImageSource(rawSrc: string): { display: string; absPath: string | null } {
  if (!rawSrc) return { display: '', absPath: null };

  // 1. 网络 URL 或 Base64
  if (
    rawSrc.startsWith('http://') ||
    rawSrc.startsWith('https://') ||
    rawSrc.startsWith('data:') ||
    rawSrc.startsWith('asset:')
  ) {
    return { display: rawSrc, absPath: null };
  }

  // 2. 本地相对路径或绝对路径
  const activeKey = useWindowStore.getState().activeKey;
  const currentDoc = activeKey ? useDocumentStore.getState().getDocument(activeKey) : null;
  const baseDir = currentDoc?.dirPath || useExplorerStore.getState().root;
  const absPath = baseDir ? resolveRelativeDocPath(baseDir, rawSrc) : isAbsoluteLocalPath(rawSrc) ? rawSrc : null;
  if (!absPath) return { display: rawSrc, absPath: null };
  try {
    return { display: convertFileSrc(absPath), absPath };
  } catch {
    return { display: rawSrc, absPath };
  }
}

/** TipTap 图片 NodeView 组件 */
export function ImageComponent({ node, editor, updateAttributes, deleteNode }: NodeViewProps) {
  const [hovered, setHovered] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  // 首次渲染就解析出图片地址：不再先渲染一个空 src 的 <img>（粘贴图片替换占位时会闪一下空白）
  const [initialSource] = useState(() => resolveImageSource(node.attrs.src || ''));
  const [resolvedDisplaySrc, setResolvedDisplaySrc] = useState<string>(initialSource.display);
  const [resolvedAbsPath, setResolvedAbsPath] = useState<string | null>(initialSource.absPath);
  const resolvedForRef = useRef<string>(node.attrs.src || '');
  // 右键菜单位置（视口坐标）；打开期间图片显示描边，标明菜单作用对象
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  // 原图像素尺寸，显示在右键菜单信息头
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);

  const rawSrc: string = node.attrs.src || '';
  const alt: string = node.attrs.alt || '';
  const align: 'left' | 'center' | 'right' = node.attrs.align || 'center';
  const width: string = node.attrs.width || '100%';
  const linkHref: string = node.attrs.href || '';

  // 图片地址变化（如重命名文件）时重新解析；首次解析已在初始状态中完成，
  // 不能在此重置尺寸——缓存命中的图片可能在本副作用执行前就已触发 onLoad
  useEffect(() => {
    if (resolvedForRef.current === rawSrc) return;
    resolvedForRef.current = rawSrc;
    setLoadError(false);
    setNaturalSize(null);
    const next = resolveImageSource(rawSrc);
    setResolvedDisplaySrc(next.display);
    setResolvedAbsPath(next.absPath);
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
      await ipc.revealInExplorer(resolvedAbsPath).catch((error) => {
        showToast(describeError(error, '无法打开文件夹'), 'error');
      });
    }
  };

  // ── 右键菜单 ──

  const isRemote = /^https?:\/\//i.test(rawSrc);
  // 菜单与预览中复制、另存为读取的图片来源：本地图片按磁盘路径读取原文件
  const imageSource: ImageSource = { path: resolvedAbsPath, url: resolvedDisplaySrc || rawSrc };

  /** 执行异步操作并以 Toast 反馈结果 */
  const runWithToast = async (task: () => Promise<unknown>, success: string, failure: string) => {
    try {
      await task();
      showToast(success, 'success');
    } catch (error) {
      showToast(describeError(error, failure), 'error');
    }
  };

  const handleCopyImage = () => runWithToast(() => copyImageToClipboard(imageSource), '图片已复制', '复制图片失败');

  const handleSaveAs = async () => {
    try {
      // 取消保存不提示
      if (await saveImageAs(imageSource)) showToast('图片已保存', 'success');
    } catch (error) {
      showToast(describeError(error, '保存图片失败'), 'error');
    }
  };

  // 编辑替代文本（显示在图片下方的说明文字）
  const handleEditCaption = async () => {
    const value = await showPrompt({
      title: '编辑图片说明',
      icon: <Captions size={17} />,
      defaultValue: alt,
      placeholder: '显示在图片下方，可留空',
      confirmLabel: '保存',
      allowEmpty: true,
    });
    if (value === null || editor.isDestroyed) return;
    try {
      updateAttributes({ alt: value });
    } catch {
      // 弹窗期间图片已被删除或撤销，忽略
    }
  };

  // 重命名磁盘上的图片文件（扩展名不变），并同步文档中的引用
  const handleRenameFile = async () => {
    if (!resolvedAbsPath) return;
    const absPath = resolvedAbsPath;
    const { stem, ext } = splitFileName(basenameOf(absPath));
    const value = await showPrompt({
      title: '重命名图片文件',
      icon: <PenLine size={17} />,
      description: ext ? `扩展名 ${ext} 保持不变` : undefined,
      defaultValue: stem,
      confirmLabel: '重命名',
      validate: validateFileStem,
    });
    if (value === null || editor.isDestroyed) return;
    try {
      const newName = await renameImageFile(editor, { absPath, rawSrc, newStem: value });
      if (newName) showToast(`已重命名为 ${newName}`, 'success');
    } catch (error) {
      showToast(describeError(error, '重命名失败'), 'error');
    }
  };

  // 右键（触屏长按）图片：弹出图片菜单，不再走通用的文本右键菜单
  const handleContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    // 只拦 React 树（编辑器容器的右键处理），原生事件继续冒泡，其他菜单的「点外部关闭」照常生效
    stopReactPropagation(event);
    setHovered(false);
    setContextMenu({ x: event.clientX, y: event.clientY });
  };

  /** 按图片来源、可编辑状态与平台组装菜单 */
  const buildMenuSections = (): ImageMenuSection[] => {
    const editable = editor.isEditable;
    const isLocal = Boolean(resolvedAbsPath);
    const usable = !loadError && Boolean(resolvedDisplaySrc);
    const pick = (items: Array<ImageMenuItem | false>) => items.filter((item): item is ImageMenuItem => Boolean(item));

    const sections: ImageMenuSection[] = [
      {
        kind: 'items',
        key: 'view',
        items: pick([
          usable && { key: 'preview', label: '查看大图', Icon: Maximize2, onSelect: () => setLightboxOpen(true) },
          // 移动端没有标签页，图片以单独页面打开
          isLocal && {
            key: 'open-tab',
            label: IS_NATIVE_MOBILE ? '单独打开' : '在独立标签页中打开',
            Icon: ExternalLink,
            onSelect: () => void handleOpenInTab(),
          },
          // 移动端没有可定位文件的系统文件管理器
          isLocal && !IS_NATIVE_MOBILE && { key: 'reveal', label: '在文件夹中显示', Icon: FolderOpen, onSelect: () => void handleRevealInDir() },
          isRemote && { key: 'open-url', label: '在浏览器中打开', Icon: Globe, onSelect: () => void ipc.openExternalUrl(rawSrc) },
          Boolean(linkHref) && {
            key: 'open-link',
            label: '打开图片链接',
            Icon: Link2,
            onSelect: () => void handleLinkClick(linkHref, useWindowStore.getState().activeKey ?? ''),
          },
        ]),
      },
      {
        kind: 'items',
        key: 'copy',
        items: pick([
          usable && { key: 'copy-image', label: '复制图片', Icon: Copy, onSelect: () => void handleCopyImage() },
          // 文件形式只在桌面端可用：可直接粘贴到文件管理器或聊天软件
          usable && isLocal && CAN_COPY_IMAGE_FILE && {
            key: 'copy-file',
            label: '复制为文件',
            Icon: Files,
            onSelect: () => void runWithToast(() => copyImageFileToClipboard(resolvedAbsPath!), '已复制图片文件', '复制文件失败'),
          },
          (isLocal || isRemote) && {
            key: 'copy-path',
            label: isLocal ? '复制文件路径' : '复制图片链接',
            Icon: Link,
            onSelect: () => void runWithToast(() => copyImageLocation(imageSource), isLocal ? '已复制文件路径' : '已复制图片链接', '复制失败'),
          },
          // 移动端以系统分享代替文件复制
          usable && isLocal && IS_NATIVE_MOBILE && {
            key: 'share',
            label: '分享图片',
            Icon: Share2,
            onSelect: () => void ipc.shareFile(resolvedAbsPath!).catch((error) => showToast(describeError(error, '分享失败'), 'error')),
          },
          usable && { key: 'save-as', label: '另存为…', Icon: Download, onSelect: () => void handleSaveAs() },
        ]),
      },
    ];

    // 沉浸阅读等只读状态不提供修改类操作
    if (editable) {
      sections.push(
        {
          kind: 'layout',
          key: 'layout',
          align,
          width,
          onAlign: (next: ImageAlign) => updateAttributes({ align: next }),
          onWidth: (next: string) => updateAttributes({ width: next }),
        },
        {
          kind: 'items',
          key: 'edit',
          items: pick([
            { key: 'caption', label: '编辑说明文字…', Icon: Captions, onSelect: () => void handleEditCaption() },
            // 图片加载失败时文件多半已不存在，不提供重命名
            usable && isLocal && { key: 'rename', label: '重命名文件…', Icon: PenLine, onSelect: () => void handleRenameFile() },
          ]),
        },
        {
          kind: 'items',
          key: 'delete',
          items: [{ key: 'delete', label: '删除图片', Icon: Trash2, danger: true, onSelect: deleteNode }],
        },
      );
    }
    return sections;
  };

  const format = describeImageFormat(rawSrc, resolvedAbsPath);
  const menuMeta = [format, naturalSize && `${naturalSize.width} × ${naturalSize.height}`].filter(Boolean).join(' · ');
  // 菜单打开期间以强调色描边标明作用对象（替代整块选中底板）
  const contextOutline: React.CSSProperties = contextMenu
    ? { outline: '2px solid var(--accent-500, #3b82f6)', outlineOffset: 2 }
    : {};

  return (
    <NodeViewWrapper style={alignContainerStyle} {...{ [IMAGE_VIEW_ATTRIBUTE]: '' }} onContextMenu={handleContextMenu}>
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
        {/* 悬停浮层快捷操作工具栏（右键菜单打开期间隐藏，避免与菜单重复） */}
        {hovered && !contextMenu && (
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
              ...contextOutline,
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
            onLoad={(event) => {
              const image = event.currentTarget;
              setNaturalSize(image.naturalWidth > 0 ? { width: image.naturalWidth, height: image.naturalHeight } : null);
            }}
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
              ...contextOutline,
            }}
          />
        )}

        {/* 拖拽缩放手柄（右下角） */}
        {hovered && !contextMenu && !loadError && (
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
          onCopyImage={() => copyImageToClipboard(imageSource)}
          onOpenInTab={resolvedAbsPath ? handleOpenInTab : undefined}
          // 移动端没有可定位文件的系统文件管理器
          onRevealInDir={resolvedAbsPath && !IS_NATIVE_MOBILE ? handleRevealInDir : undefined}
        />
      )}

      {/* 图片右键菜单 */}
      {contextMenu && (
        <ImageContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          title={describeImageName(rawSrc, resolvedAbsPath)}
          meta={menuMeta}
          sections={buildMenuSections()}
          onClose={() => setContextMenu(null)}
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

  addProseMirrorPlugins() {
    return [
      ...(this.parent?.() ?? []),
      new Plugin({
        key: new PluginKey('nbImageContextClick'),
        props: {
          handleDOMEvents: {
            // 右键图片时跳过 ProseMirror 的点击选中：原先图片会被选为整块（底板盖住图片），
            // 右键菜单也因此误判为「选中文本」而弹出文字格式菜单。图片菜单由节点视图自行弹出。
            mousedown: (view, event) => {
              if (!isContextClick(event) || !isInImageView(view, event.target)) return false;
              // 同时阻止浏览器默认行为：避免原生选区移动到图片两侧后又被同步为整块选中
              event.preventDefault();
              return true;
            },
          },
        },
      }),
    ];
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

