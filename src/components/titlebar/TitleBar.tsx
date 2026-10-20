// NoteBoard TitleBar
// 自绘标题栏：应用图标 + tab 栏 + 拖拽区 + 窗口控制 + 设置入口
// 详见 docs/07-UI布局与交互规范.md §2

import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Settings as SettingsIcon, RefreshCw } from 'lucide-react';
import { TabBar } from './TabBar';
import { WindowControls } from './WindowControls';
import { ThemeMenu } from './ThemeMenu';
import { Tooltip } from '../Tooltip';
import { emit } from '../../core/emitter';
import { useLayoutStore } from '../../stores/layoutStore';
import { useUpdateStore } from '../../stores/updateStore';
import { IS_WEB, USES_MAC_TRAFFIC_LIGHTS } from '../../core/platform';

// macOS 红绿灯按钮占位宽度：左边距 14 + 三个按钮及间距约 54 + 右侧留白
const MAC_TRAFFIC_LIGHTS_WIDTH = 76;

/** macOS 红绿灯占位区：可拖拽窗口；全屏时系统隐藏红绿灯，占位随之收起 */
function MacTrafficLightsSpacer() {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    const sync = () => {
      win.isFullscreen().then(setIsFullscreen).catch(() => {});
    };
    sync();
    // 进入/退出全屏都会触发尺寸变化，借此同步全屏状态
    const unlisten = win.onResized(sync);
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  if (isFullscreen) return null;
  return (
    <div
      data-tauri-drag-region=""
      style={{ width: MAC_TRAFFIC_LIGHTS_WIDTH, height: '100%', flexShrink: 0 }}
    />
  );
}

// 应用图标长按判定时长与拖动判定位移
const ICON_LONG_PRESS_MS = 250;
const ICON_DRAG_THRESHOLD_PX = 4;

/** 恢复应用图标的常态样式（拖动窗口后不会收到 mouseup/mouseleave，需主动复位） */
function resetIconStyle(el: HTMLElement) {
  el.style.background = 'transparent';
  el.style.transform = 'scale(1)';
  el.style.cursor = 'pointer';
}

export function TitleBar() {
  const toggleSettingsModal = useLayoutStore((s) => s.toggleSettingsModal);
  const toggleExplorer = useLayoutStore((s) => s.toggleExplorer);
  const explorerVisible = useLayoutStore((s) => s.explorerVisible);
  // 应用图标按压状态：长按或按住移动即拖动窗口，此时不再触发点击切换侧栏
  const iconPressRef = useRef<{ x: number; y: number; timer: number; longPressed: boolean } | null>(null);
  const suppressIconClickRef = useRef(false);

  // 卸载时清理未触发的长按计时器
  useEffect(() => () => {
    if (iconPressRef.current) window.clearTimeout(iconPressRef.current.timer);
  }, []);

  const endIconPress = () => {
    if (iconPressRef.current) window.clearTimeout(iconPressRef.current.timer);
    iconPressRef.current = null;
  };

  const handleIconPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    endIconPress();
    suppressIconClickRef.current = false;
    const el = e.currentTarget;
    el.style.background = 'var(--toolbar-active)';
    el.style.transform = 'scale(0.92)';
    const press = {
      x: e.clientX,
      y: e.clientY,
      longPressed: false,
      // 长按达到阈值：切换为抓手光标提示可拖动，松开时不再切换侧栏
      timer: window.setTimeout(() => {
        press.longPressed = true;
        suppressIconClickRef.current = true;
        el.style.cursor = 'grabbing';
      }, ICON_LONG_PRESS_MS),
    };
    iconPressRef.current = press;
  };

  const handleIconPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const press = iconPressRef.current;
    if (!press || (e.buttons & 1) === 0) return;
    const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y) >= ICON_DRAG_THRESHOLD_PX;
    if (!press.longPressed && !moved) return;
    // 在鼠标移动事件内启动原生拖动，macOS 需依赖当前鼠标事件才能开始拖动窗口
    endIconPress();
    suppressIconClickRef.current = true;
    resetIconStyle(e.currentTarget);
    if (!IS_WEB) getCurrentWindow().startDragging().catch(() => {});
  };

  const handleIconClick = () => {
    // 长按或拖动窗口后的点击不切换侧栏
    if (suppressIconClickRef.current) {
      suppressIconClickRef.current = false;
      return;
    }
    toggleExplorer();
  };
  // 当前是否有打开的标题栏/标签页菜单
  const hasActiveMenu = useLayoutStore((s) => s.activeMenuCount > 0);

  const { hasUpdate, checking: checkingUpdate, checkForUpdates } = useUpdateStore();

  const titleBarStyle: React.CSSProperties = {
    height: 36,
    display: 'flex',
    alignItems: 'center',
    background: 'var(--titlebar-bg)',
    borderBottom: '1px solid var(--editor-border)',
    userSelect: 'none',
    flexShrink: 0,
    fontFamily: 'var(--ui-font-family, inherit)',
    fontSize: 'var(--ui-font-size, 13px)',
  };

  return (
    <div style={titleBarStyle} role="banner">
      {/* macOS 原生红绿灯叠加在标题栏左侧，需预留位置 */}
      {USES_MAC_TRAFFIC_LIGHTS && <MacTrafficLightsSpacer />}

      {/* 应用图标 16px，点击收起/展开左侧栏；长按或按住移动可拖动窗口（标签页占满标题栏时仍可移动窗口） */}
      <Tooltip
        content={`${explorerVisible ? '收起侧栏' : '展开侧栏'}${IS_WEB ? '' : '，按住可拖动窗口'}`}
        side="bottom"
        sideOffset={6}
      >
        <div
          style={{
            width: 36,
            height: 36,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            cursor: 'pointer',
            transition: 'all var(--transition-fast)',
          }}
          onClick={handleIconClick}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--toolbar-hover)';
            e.currentTarget.style.transform = 'scale(1.05)';
          }}
          onMouseLeave={(e) => {
            // 移出图标区域时取消未完成的长按
            if (!iconPressRef.current?.longPressed) endIconPress();
            resetIconStyle(e.currentTarget);
          }}
          onPointerDown={IS_WEB ? (e) => {
            e.currentTarget.style.background = 'var(--toolbar-active)';
            e.currentTarget.style.transform = 'scale(0.92)';
          } : handleIconPointerDown}
          onPointerMove={IS_WEB ? undefined : handleIconPointerMove}
          onPointerUp={(e) => {
            endIconPress();
            e.currentTarget.style.background = 'var(--toolbar-hover)';
            e.currentTarget.style.transform = 'scale(1.05)';
            e.currentTarget.style.cursor = 'pointer';
          }}
          onPointerCancel={(e) => {
            endIconPress();
            resetIconStyle(e.currentTarget);
          }}
          role="button"
          aria-label={explorerVisible ? '收起侧栏' : '展开侧栏'}
          aria-pressed={explorerVisible}
        >
          <img
            src="/logo.ico"
            alt="NoteBoard"
            width={16}
            height={16}
            style={{ pointerEvents: 'none' }}
          />
        </div>
      </Tooltip>

      {/* Tab 栏 */}
      <TabBar />

      {/* 拖拽空白区：当有菜单打开时临时解除 drag-region，点击直接关闭菜单且避免触发原生窗口拖动；无菜单时保留原生拖拽，双击最大化 */}
      <div
        {...(!hasActiveMenu ? { 'data-tauri-drag-region': '' } : {})}
        style={{
          flex: 1,
          height: '100%',
          minWidth: 0,
        }}
        onMouseDown={(e) => {
          // 若当前有菜单打开，阻止默认拖动行为并通知关闭所有标题栏浮层菜单
          if (hasActiveMenu) {
            e.preventDefault();
            emit('close-titlebar-menus', undefined);
          }
        }}
        onDoubleClick={() => {
          if (!IS_WEB) getCurrentWindow().toggleMaximize();
        }}
      />

      {/* 检测更新按钮（主动检测更新，有新版本时标上小红点） */}
      {!IS_WEB && <Tooltip content={hasUpdate ? '发现新版本 NoteBoard (点击查看)' : '检测更新'} side="bottom" sideOffset={6}>
        <button
          type="button"
          onClick={() => checkForUpdates(false)}
          style={{
            width: 36,
            height: 36,
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            background: 'transparent',
            color: hasUpdate ? 'var(--accent-strong)' : 'var(--editor-text-secondary)',
            cursor: checkingUpdate ? 'not-allowed' : 'pointer',
            flexShrink: 0,
            transition: 'all var(--transition-fast)',
          }}
          onMouseEnter={(e) => {
            if (!checkingUpdate) {
              e.currentTarget.style.background = 'var(--toolbar-hover)';
              e.currentTarget.style.color = 'var(--editor-text)';
              e.currentTarget.style.transform = 'scale(1.05)';
            }
          }}
          onMouseLeave={(e) => {
            if (!checkingUpdate) {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = hasUpdate
                ? 'var(--accent-strong)'
                : 'var(--editor-text-secondary)';
              e.currentTarget.style.transform = 'scale(1)';
            }
          }}
          onMouseDown={(e) => {
            if (!checkingUpdate) {
              e.currentTarget.style.background = 'var(--toolbar-active)';
              e.currentTarget.style.transform = 'scale(0.92)';
            }
          }}
          onMouseUp={(e) => {
            if (!checkingUpdate) {
              e.currentTarget.style.background = 'var(--toolbar-hover)';
              e.currentTarget.style.transform = 'scale(1.05)';
            }
          }}
          aria-label="检测更新"
        >
          <RefreshCw
            size={14}
            className={checkingUpdate ? 'spin' : ''}
            style={checkingUpdate ? { animation: 'spin 1s linear infinite' } : undefined}
          />
          {/* 新版本小红点提示 */}
          {hasUpdate && (
            <span
              style={{
                position: 'absolute',
                top: 7,
                right: 7,
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: '#ef4444',
                boxShadow: '0 0 0 1.5px var(--titlebar-bg)',
                pointerEvents: 'none',
              }}
            />
          )}
        </button>
      </Tooltip>}

      {/* 快捷主题切换菜单 */}
      <ThemeMenu />

      {/* 设置中心按钮 */}
      <Tooltip content="设置" side="bottom" sideOffset={6}>
        <button
          type="button"
          onClick={toggleSettingsModal}
          style={{
            width: 36,
            height: 36,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            background: 'transparent',
            color: 'var(--editor-text-secondary)',
            cursor: 'pointer',
            flexShrink: 0,
            transition: 'all var(--transition-fast)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--toolbar-hover)';
            e.currentTarget.style.color = 'var(--editor-text)';
            e.currentTarget.style.transform = 'scale(1.05)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'var(--editor-text-secondary)';
            e.currentTarget.style.transform = 'scale(1)';
          }}
          onMouseDown={(e) => {
            e.currentTarget.style.background = 'var(--toolbar-active)';
            e.currentTarget.style.transform = 'scale(0.92)';
          }}
          onMouseUp={(e) => {
            e.currentTarget.style.background = 'var(--toolbar-hover)';
            e.currentTarget.style.transform = 'scale(1.05)';
          }}
          aria-label="打开设置"
        >
          <SettingsIcon size={15} />
        </button>
      </Tooltip>

      {/* 窗口控制按钮 */}
      {!IS_WEB && !USES_MAC_TRAFFIC_LIGHTS && <WindowControls />}
    </div>
  );
}
