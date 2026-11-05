// NoteBoard 标题栏拖拽空白区
// 有菜单打开时临时解除拖动，点击直接关闭菜单且避免触发原生窗口拖动。
// 常规模式：沿用 data-tauri-drag-region（系统拖动，双击最大化）。
// 极窄模式：不挂 data-tauri-drag-region（其内置双击最大化会突破极窄宽度），改由 Rust 驱动拖动：
//   不走系统拖动循环，从而不触发系统贴靠 / 平铺改写窗口尺寸；开启自动贴边时还不允许拖出桌面。

import { useCallback, useEffect, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { emit } from '../../core/emitter';
import { beginDockDrag, endDockDrag } from '../../core/ipc/commands';
import { useLayoutStore } from '../../stores/layoutStore';
import { IS_WEB } from '../../core/platform';

interface TitleBarDragRegionProps {
  /** 固定宽度（左侧留白、macOS 红绿灯占位）；不传时占满剩余空间 */
  width?: number;
  /** 最小宽度：极窄模式下标签可能占满，保留保底拖拽区确保窗口始终可移动 */
  minWidth?: number;
  /** 常规模式双击是否额外切换最大化（macOS 红绿灯占位只依赖 Tauri 内置处理，保持原样） */
  maximizeOnDoubleClick?: boolean;
}

export function TitleBarDragRegion({ width, minWidth = 0, maximizeOnDoubleClick = true }: TitleBarDragRegionProps) {
  // 当前是否有打开的标题栏/标签页菜单
  const hasActiveMenu = useLayoutStore((s) => s.activeMenuCount > 0);
  const compactMode = useLayoutStore((s) => s.compactMode);
  const edgeDockEnabled = useLayoutStore((s) => s.edgeDockEnabled);
  // 是否正在由 Rust 驱动拖动，用于只发送一次结束通知
  const dockDraggingRef = useRef(false);

  const finishDockDrag = useCallback(() => {
    if (!dockDraggingRef.current) return;
    dockDraggingRef.current = false;
    void endDockDrag().catch(() => {});
  }, []);

  // 卸载或窗口失焦时兜底结束拖动（例如拖动中切换了模式）
  useEffect(() => {
    window.addEventListener('blur', finishDockDrag);
    return () => {
      window.removeEventListener('blur', finishDockDrag);
      finishDockDrag();
    };
  }, [finishDockDrag]);

  return (
    <div
      {...(!hasActiveMenu && !compactMode ? { 'data-tauri-drag-region': '' } : {})}
      style={{
        flex: width === undefined ? 1 : 'none',
        width,
        height: '100%',
        minWidth,
      }}
      onMouseDown={(e) => {
        // 若当前有菜单打开，阻止默认拖动行为并通知关闭所有标题栏浮层菜单
        if (hasActiveMenu) {
          e.preventDefault();
          emit('close-titlebar-menus', undefined);
        }
      }}
      onPointerDown={(e) => {
        if (!compactMode || IS_WEB || hasActiveMenu || e.button !== 0) return;
        e.preventDefault();
        // 捕获指针：光标被桌面边缘挡在窗口外时仍能收到松开事件
        e.currentTarget.setPointerCapture(e.pointerId);
        dockDraggingRef.current = true;
        void beginDockDrag(edgeDockEnabled).catch(() => {
          dockDraggingRef.current = false;
        });
      }}
      onPointerUp={finishDockDrag}
      onPointerCancel={finishDockDrag}
      onLostPointerCapture={finishDockDrag}
      onDoubleClick={() => {
        if (!IS_WEB && !compactMode && maximizeOnDoubleClick) getCurrentWindow().toggleMaximize();
      }}
    />
  );
}
