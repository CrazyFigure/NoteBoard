// NoteBoard 图表「复制 / 导出」下拉菜单
// Mermaid / PlantUML / Infographic 的独立文件编辑器与 Markdown 内嵌块共用，
// 统一提供「SVG 矢量图」与「PNG 位图」两种产出。
//
// 菜单必须 Portal 到 body：Markdown 内嵌块容器带 overflow:hidden 与 CSS transform，
// 在内部绝对定位会被裁剪、且 z-index 会失效。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Download, Check, ChevronDown, FileImage, Loader2, Image as ImageIcon } from 'lucide-react';
import { showToast } from '../../stores/toastStore';
import {
  copyChartImage,
  exportChartImage,
  type ChartImageFormat,
  type ChartImageSource,
  type ChartRasterOptions,
} from './chartExport';

/** 按钮视觉变体：ghost 用于块内工具条，outline 用于分屏工具栏，primary 用于主操作 */
export type ChartExportVariant = 'ghost' | 'outline' | 'primary';

interface ChartExportMenuProps {
  /** copy = 复制到剪贴板；download = 另存为文件 */
  action: 'copy' | 'download';
  /** 图表来源，为 null 时按钮禁用（图表尚未渲染完成） */
  source: ChartImageSource | null;
  /** 导出默认文件名（不含扩展名） */
  fileName: string;
  /** 按钮文案，默认按 action 取「复制」/「导出」 */
  label?: string;
  /** 是否只显示图标（Markdown 块内空间有限时使用） */
  compact?: boolean;
  variant?: ChartExportVariant;
  /** PNG 放大倍数，默认 2 */
  scale?: number;
  /** PNG 背景色，默认白色 */
  background?: string;
  disabled?: boolean;
  title?: string;
}

/** 菜单宽度，用于贴边时的位置收敛 */
const MENU_WIDTH = 168;

/** 菜单项样式表只注入一次，避免每个实例重复插入 <style> */
const STYLE_ID = 'nb-chart-export-styles';
const STYLE_TEXT = `
.nb-chart-export-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border-radius: 5px;
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease, opacity 120ms ease;
}
.nb-chart-export-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.nb-chart-export-btn[data-variant='ghost'] {
  padding: 3px 6px;
  border: none;
  background: transparent;
  color: var(--editor-text-muted, #64748b);
  font-size: 11px;
}
.nb-chart-export-btn[data-variant='ghost']:hover:not(:disabled) {
  background: var(--toolbar-hover, rgba(59,130,246,0.12));
  color: var(--editor-text, #1e293b);
}
.nb-chart-export-btn[data-variant='outline'] {
  padding: 4px 8px;
  border: 1px solid var(--editor-border, #e2e8f0);
  background: var(--editor-bg, #ffffff);
  color: var(--editor-text, #1e293b);
}
.nb-chart-export-btn[data-variant='outline']:hover:not(:disabled) {
  background: var(--toolbar-hover, rgba(59,130,246,0.12));
  border-color: var(--editor-border-focus, #93c5fd);
}
.nb-chart-export-btn[data-variant='primary'] {
  padding: 4px 10px;
  border: 1px solid transparent;
  background: var(--editor-accent, #3b82f6);
  color: #ffffff;
  font-weight: 500;
}
.nb-chart-export-btn[data-variant='primary']:hover:not(:disabled) { opacity: 0.88; }
.nb-chart-export-caret { flex-shrink: 0; opacity: 0.7; }

.nb-chart-export-menu {
  position: fixed;
  z-index: 100000;
  min-width: 168px;
  padding: 4px;
  background: var(--editor-surface, #ffffff);
  border: 1px solid var(--editor-border, #e2e8f0);
  border-radius: 6px;
  box-shadow: var(--shadow-md, 0 8px 24px rgba(0,0,0,0.12));
}
.nb-chart-export-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--editor-text, #1e293b);
  cursor: pointer;
  font-size: 12px;
  text-align: left;
  transition: background 120ms ease;
}
.nb-chart-export-item:hover { background: var(--toolbar-hover, rgba(59,130,246,0.12)); }
.nb-chart-export-item:active { background: var(--toolbar-active, rgba(59,130,246,0.20)); }
.nb-chart-export-item:disabled { opacity: 0.5; cursor: wait; }

@keyframes nb-chart-export-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.nb-spin { animation: nb-chart-export-spin 0.8s linear infinite; }
`;

function ensureStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE_TEXT;
  document.head.appendChild(style);
}

export function ChartExportMenu({
  action,
  source,
  fileName,
  label,
  compact = false,
  variant = 'outline',
  scale,
  background,
  disabled = false,
  title,
}: ChartExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(ensureStyles, []);

  // 关闭菜单：点击外部、按 Esc、窗口尺寸变化或页面滚动（锚点位置会漂移）
  useEffect(() => {
    if (!open) return;

    const close = () => setOpen(false);
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as globalThis.Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  // 打开时按锚点位置定位，并收敛到视口内
  useEffect(() => {
    if (!open || !anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const left = Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8);
    const top = rect.bottom + 4;
    setMenuPos({ left: Math.max(8, left), top });
  }, [open]);

  const handleToggle = (e: React.MouseEvent) => {
    // 阻止冒泡，避免 TipTap 把点击当成选区变更或触发块拖拽
    e.stopPropagation();
    e.preventDefault();
    setOpen((prev) => !prev);
  };

  // 栅格化参数按引用稳定化，避免每次渲染都重新生成 run 回调
  const rasterOptions = useMemo<ChartRasterOptions>(
    () => ({ scale, background }),
    [scale, background],
  );

  const run = useCallback(
    async (format: ChartImageFormat) => {
      if (!source) return;
      setBusy(true);
      try {
        if (action === 'copy') {
          await copyChartImage(source, format, rasterOptions);
          setCopied(true);
          showToast(format === 'png' ? 'PNG 图片已复制到剪贴板' : 'SVG 源码已复制到剪贴板', 'success');
          setTimeout(() => setCopied(false), 2000);
        } else {
          const saved = await exportChartImage(source, format, fileName, rasterOptions);
          // 用户主动取消另存为对话框不算失败，不提示
          if (saved) {
            showToast(`已导出 ${format.toUpperCase()} 图片`, 'success');
          }
        }
        setOpen(false);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        showToast(`${action === 'copy' ? '复制' : '导出'}失败：${message}`, 'error');
      } finally {
        setBusy(false);
      }
    },
    [action, fileName, source, rasterOptions],
  );

  const isDisabled = disabled || !source || busy;
  const defaultLabel = action === 'copy' ? '复制' : '导出';
  const shownLabel = label ?? defaultLabel;
  const Icon = busy ? Loader2 : copied && !open ? Check : action === 'copy' ? Copy : Download;
  const buttonTitle =
    title ?? (action === 'copy' ? '复制为 SVG 矢量图或 PNG 图片' : '导出为 SVG 矢量图或 PNG 图片');

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="nb-chart-export-btn"
        data-variant={variant}
        disabled={isDisabled}
        title={isDisabled && !busy ? '图表尚未渲染完成' : buttonTitle}
        onClick={handleToggle}
        // mousedown 阶段就拦截，防止 Markdown 编辑器把这次点击处理成拖拽/选区变更
        onMouseDown={(e) => e.stopPropagation()}
      >
        <Icon size={variant === 'ghost' ? 12 : 13} className={busy ? 'nb-spin' : undefined} />
        {!compact && <span>{busy ? '处理中' : copied && !open ? '已复制' : shownLabel}</span>}
        <ChevronDown size={variant === 'ghost' ? 10 : 12} className="nb-chart-export-caret" />
      </button>

      {open &&
        menuPos &&
        createPortal(
          <div
            ref={menuRef}
            className="nb-chart-export-menu"
            style={{ top: menuPos.top, left: menuPos.left, width: MENU_WIDTH }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="nb-chart-export-item"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                void run('svg');
              }}
            >
              <FileImage size={13} />
              <span>{action === 'copy' ? '复制 SVG 源码' : '导出 SVG 矢量图'}</span>
            </button>
            <button
              type="button"
              className="nb-chart-export-item"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                void run('png');
              }}
            >
              <ImageIcon size={13} />
              <span>{action === 'copy' ? '复制 PNG 图片' : '导出 PNG 图片'}</span>
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
