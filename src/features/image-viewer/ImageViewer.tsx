// NoteBoard 现代化图片查看器组件
// 支持常见及特殊图片格式：PNG, JPG, JPEG, SVG, BMP, GIF, WEBP, ICO 等
// 功能：平移拖拽、无级缩放（自适应/1:1/自定义）、旋转/翻转、棋盘网格背景切换、元数据展示及快捷操作

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  RotateCw,
  RotateCcw,
  FlipHorizontal,
  ExternalLink,
  FolderOpen,
  Copy,
  Check,
  Sparkles,
  Grid,
} from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import * as ipc from '../../core/ipc/commands';
import { extFromPath } from '../../core/docKind';
import { showToast } from '../../stores/toastStore';

interface ImageViewerProps {
  filePath: string;
  fileName?: string;
  fileSize?: number;
}

type BgMode = 'grid' | 'dark' | 'light' | 'black';

/** 格式化文件大小 */
function formatFileSize(bytes?: number): string {
  if (bytes === undefined || bytes === null || bytes <= 0) return '未知大小';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** 计算最大公约数以得出宽高比 */
function getAspectRatio(w: number, h: number): string {
  if (!w || !h) return '';
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const r = gcd(w, h);
  const rw = w / r;
  const rh = h / r;
  // 如果比例数字过大，显示近似浮点
  if (rw > 30 || rh > 30) {
    return (w / h).toFixed(2) + ':1';
  }
  return `${rw}:${rh}`;
}

export function ImageViewer({ filePath, fileName, fileSize }: ImageViewerProps) {
  const name = fileName || filePath.split(/[\\/]/).pop() || filePath;
  const ext = extFromPath(filePath).toUpperCase() || 'IMAGE';

  // 将本地路径转换为 asset: / webview 协议 URL
  const [imgSrc, setImgSrc] = useState<string>('');
  useEffect(() => {
    try {
      const url = convertFileSrc(filePath);
      setImgSrc(url);
    } catch {
      // 降级为原生路径
      setImgSrc(filePath);
    }
  }, [filePath]);

  // 图像元数据
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [copied, setCopied] = useState(false);

  // 查看器变换状态：缩放比例、平移位移 (tx, ty)、旋转角度 (0/90/180/270)、水平/垂直翻转
  const [scale, setScale] = useState<number>(1);
  const [translate, setTranslate] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [rotation, setRotation] = useState<number>(0);
  const [flipH, setFlipH] = useState(false);
  const [bgMode, setBgMode] = useState<BgMode>('grid');

  // 拖拽相关
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ startX: number; startY: number; initTx: number; initTy: number }>({
    startX: 0,
    startY: 0,
    initTx: 0,
    initTy: 0,
  });

  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // 自适应窗口缩放
  const fitToWindow = useCallback(() => {
    if (!containerRef.current || !naturalSize) {
      setScale(1);
      setTranslate({ x: 0, y: 0 });
      return;
    }

    const { clientWidth: cw, clientHeight: ch } = containerRef.current;
    const padding = 48;
    const availW = Math.max(cw - padding, 100);
    const availH = Math.max(ch - padding, 100);

    // 计算旋转后的宽高
    const isRotated = rotation % 180 !== 0;
    const curW = isRotated ? naturalSize.height : naturalSize.width;
    const curH = isRotated ? naturalSize.width : naturalSize.height;

    const scaleX = availW / curW;
    const scaleY = availH / curH;
    const fitScale = Math.min(scaleX, scaleY, 1); // 默认最大不超过 100%

    setScale(Math.max(Number(fitScale.toFixed(3)), 0.1));
    setTranslate({ x: 0, y: 0 });
  }, [naturalSize, rotation]);

  // 当图片首次加载完成时
  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth, naturalHeight } = e.currentTarget;
    setNaturalSize({ width: naturalWidth, height: naturalHeight });
    setLoadError(false);

    // 初始自适应窗口
    if (containerRef.current) {
      const { clientWidth: cw, clientHeight: ch } = containerRef.current;
      const padding = 48;
      const scaleX = (cw - padding) / naturalWidth;
      const scaleY = (ch - padding) / naturalHeight;
      const fitScale = Math.min(scaleX, scaleY, 1);
      setScale(Math.max(Number(fitScale.toFixed(3)), 0.1));
      setTranslate({ x: 0, y: 0 });
    }
  };

  // 1:1 实际尺寸
  const resetToActual = () => {
    setScale(1);
    setTranslate({ x: 0, y: 0 });
  };

  // 缩放步进调节
  const zoomIn = () => {
    setScale((prev) => Math.min(Number((prev * 1.25).toFixed(3)), 20));
  };

  const zoomOut = () => {
    setScale((prev) => Math.max(Number((prev / 1.25).toFixed(3)), 0.05));
  };

  // 旋转
  const rotateCw = () => setRotation((prev) => (prev + 90) % 360);
  const rotateCcw = () => setRotation((prev) => (prev + 270) % 360);

  // 水平翻转
  const toggleFlipH = () => setFlipH((prev) => !prev);

  // 滚轮缩放与以鼠标指针为中心平移
  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.15 : 0.87;
    setScale((prevScale) => {
      const newScale = Math.min(Math.max(prevScale * zoomFactor, 0.05), 20);
      return Number(newScale.toFixed(3));
    });
  };

  // 拖拽平移事件处理
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 && e.button !== 1) return; // 仅响应左键与中键拖拽
    e.preventDefault();
    setIsDragging(true);
    dragStartRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      initTx: translate.x,
      initTy: translate.y,
    };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStartRef.current.startX;
    const dy = e.clientY - dragStartRef.current.startY;
    setTranslate({
      x: dragStartRef.current.initTx + dx,
      y: dragStartRef.current.initTy + dy,
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // 复制图片到系统剪贴板（绘制到 Canvas 并通过 Clipboard API 写入）
  const handleCopyImage = async () => {
    if (!imgRef.current || !naturalSize) return;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = naturalSize.width;
      canvas.height = naturalSize.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('无法创建 2D 上下文');
      ctx.drawImage(imgRef.current, 0, 0);

      canvas.toBlob(async (blob) => {
        if (!blob) {
          showToast('复制图片失败', 'error');
          return;
        }
        try {
          await navigator.clipboard.write([
            new ClipboardItem({ [blob.type]: blob }),
          ]);
          setCopied(true);
          showToast('图片已复制到剪贴板', 'success');
          setTimeout(() => setCopied(false), 2000);
        } catch {
          // 若浏览器权限限制，则复制文件路径
          navigator.clipboard.writeText(filePath);
          showToast('已复制图片文件完整路径', 'info');
        }
      }, 'image/png');
    } catch {
      navigator.clipboard.writeText(filePath);
      showToast('已复制图片文件路径', 'info');
    }
  };

  // 背景风格样式
  const getBgStyle = (): React.CSSProperties => {
    switch (bgMode) {
      case 'grid':
        return {
          backgroundImage: `
            linear-gradient(45deg, rgba(128,128,128,0.12) 25%, transparent 25%),
            linear-gradient(-45deg, rgba(128,128,128,0.12) 25%, transparent 25%),
            linear-gradient(45deg, transparent 75%, rgba(128,128,128,0.12) 75%),
            linear-gradient(-45deg, transparent 75%, rgba(128,128,128,0.12) 75%)
          `,
          backgroundSize: '16px 16px',
          backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
          backgroundColor: 'var(--editor-bg)',
        };
      case 'dark':
        return { backgroundColor: '#18181b' };
      case 'light':
        return { backgroundColor: '#f4f4f5' };
      case 'black':
        return { backgroundColor: '#000000' };
    }
  };

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        overflow: 'hidden',
        userSelect: 'none',
        ...getBgStyle(),
      }}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      {/* 顶部悬浮控制工具栏 */}
      <div
        style={{
          position: 'absolute',
          top: 14,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 20,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '4px 8px',
          background: 'var(--editor-surface, rgba(255, 255, 255, 0.85))',
          backdropFilter: 'blur(8px)',
          border: '1px solid var(--editor-border)',
          borderRadius: 8,
          boxShadow: 'var(--shadow-md, 0 4px 6px -1px rgba(0, 0, 0, 0.1))',
          color: 'var(--editor-text)',
        }}
      >
        {/* 缩小 */}
        <button
          type="button"
          onClick={zoomOut}
          style={btnStyle}
          title="缩小 (滚轮下滑)"
          aria-label="缩小"
        >
          <ZoomOut size={15} />
        </button>

        {/* 缩放百分比 / 1:1 快捷切换 */}
        <button
          type="button"
          onClick={resetToActual}
          style={{
            ...btnStyle,
            minWidth: 48,
            fontSize: 12,
            fontWeight: 500,
            fontFamily: 'var(--mono-font-family, monospace)',
          }}
          title="点击重置为 100% 实际大小"
        >
          {Math.round(scale * 100)}%
        </button>

        {/* 放大 */}
        <button
          type="button"
          onClick={zoomIn}
          style={btnStyle}
          title="放大 (滚轮上滑)"
          aria-label="放大"
        >
          <ZoomIn size={15} />
        </button>

        {/* 自适应窗口 */}
        <button
          type="button"
          onClick={fitToWindow}
          style={btnStyle}
          title="自适应窗口大小"
          aria-label="自适应窗口"
        >
          <Maximize2 size={15} />
        </button>

        <div style={{ width: 1, height: 16, background: 'var(--editor-border)', margin: '0 4px' }} />

        {/* 逆时针旋转 */}
        <button
          type="button"
          onClick={rotateCcw}
          style={btnStyle}
          title="逆时针旋转 90°"
          aria-label="逆时针旋转 90°"
        >
          <RotateCcw size={15} />
        </button>

        {/* 顺时针旋转 */}
        <button
          type="button"
          onClick={rotateCw}
          style={btnStyle}
          title="顺时针旋转 90°"
          aria-label="顺时针旋转 90°"
        >
          <RotateCw size={15} />
        </button>

        {/* 水平翻转 */}
        <button
          type="button"
          onClick={toggleFlipH}
          style={{
            ...btnStyle,
            background: flipH ? 'var(--toolbar-hover)' : 'transparent',
          }}
          title="水平翻转"
          aria-label="水平翻转"
        >
          <FlipHorizontal size={15} />
        </button>

        <div style={{ width: 1, height: 16, background: 'var(--editor-border)', margin: '0 4px' }} />

        {/* 棋盘/纯色背景切换 */}
        <button
          type="button"
          onClick={() => {
            const nextMode: Record<BgMode, BgMode> = {
              grid: 'dark',
              dark: 'light',
              light: 'black',
              black: 'grid',
            };
            setBgMode(nextMode[bgMode]);
          }}
          style={btnStyle}
          title={`切换查看背景 (当前: ${bgMode})`}
          aria-label="切换背景"
        >
          <Grid size={15} />
        </button>

        <div style={{ width: 1, height: 16, background: 'var(--editor-border)', margin: '0 4px' }} />

        {/* 复制图片 */}
        <button
          type="button"
          onClick={handleCopyImage}
          style={btnStyle}
          title="复制图片到剪贴板"
          aria-label="复制图片"
        >
          {copied ? <Check size={15} color="var(--success-600)" /> : <Copy size={15} />}
        </button>

        {/* 在文件管理器中定位 */}
        <button
          type="button"
          onClick={() => ipc.revealInExplorer(filePath)}
          style={btnStyle}
          title="在文件管理器中定位"
          aria-label="在文件管理器中定位"
        >
          <FolderOpen size={15} />
        </button>

        {/* 用系统默认应用打开 */}
        <button
          type="button"
          onClick={() => ipc.openWithDefaultApp(filePath)}
          style={btnStyle}
          title="用系统默认程序打开"
          aria-label="用系统默认程序打开"
        >
          <ExternalLink size={15} />
        </button>
      </div>

      {/* 图片主视口渲染画布 */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          cursor: isDragging ? 'grabbing' : 'grab',
          position: 'relative',
        }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onDoubleClick={fitToWindow}
      >
        {loadError ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 12,
              color: 'var(--editor-text-muted)',
              textAlign: 'center',
            }}
          >
            <Sparkles size={32} />
            <div>无法预览图片，文件可能已损坏或路径不可访问</div>
            <button
              type="button"
              onClick={() => ipc.openWithDefaultApp(filePath)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 12px',
                borderRadius: 6,
                border: '1px solid var(--editor-border)',
                background: 'var(--editor-surface)',
                color: 'var(--editor-text)',
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              <ExternalLink size={13} />
              <span>用系统默认程序打开</span>
            </button>
          </div>
        ) : (
          <img
            ref={imgRef}
            src={imgSrc}
            alt={name}
            onLoad={handleImageLoad}
            onError={() => setLoadError(true)}
            draggable={false}
            style={{
              transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale}) rotate(${rotation}deg) scaleX(${flipH ? -1 : 1})`,
              transformOrigin: 'center center',
              transition: isDragging ? 'none' : 'transform 0.08s ease-out',
              maxWidth: 'none',
              maxHeight: 'none',
              boxShadow: '0 4px 20px rgba(0, 0, 0, 0.15)',
              borderRadius: 2,
              pointerEvents: 'none', // 确保鼠标事件穿透由容器捕获处理
              // 动图、ico 与位图渲染优化
              imageRendering: ext === 'ICO' ? 'auto' : 'auto',
            }}
          />
        )}
      </div>

      {/* 底部优雅信息条 */}
      <div
        style={{
          height: 28,
          background: 'var(--statusbar-bg, var(--editor-surface))',
          borderTop: '1px solid var(--editor-border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 12px',
          fontSize: 11,
          color: 'var(--editor-text-secondary)',
          zIndex: 10,
          fontFamily: 'var(--mono-font-family, monospace)',
        }}
      >
        {/* 左侧：格式标签与文件名 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              padding: '1px 6px',
              borderRadius: 4,
              background: 'var(--editor-accent, #3b82f6)',
              color: '#ffffff',
              fontWeight: 600,
              fontSize: 10,
              letterSpacing: '0.5px',
            }}
          >
            {ext}
          </span>
          <span
            style={{
              maxWidth: 240,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={name}
          >
            {name}
          </span>
        </div>

        {/* 右侧：分辨率、宽高比、大小与缩放率 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          {naturalSize && (
            <>
              <span>
                {naturalSize.width} × {naturalSize.height} px
              </span>
              <span>{getAspectRatio(naturalSize.width, naturalSize.height)}</span>
            </>
          )}
          {fileSize !== undefined && fileSize > 0 && <span>{formatFileSize(fileSize)}</span>}
          <span>{Math.round(scale * 100)}%</span>
        </div>
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  padding: 0,
  border: 'none',
  borderRadius: 4,
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  transition: 'background var(--transition-fast)',
};
