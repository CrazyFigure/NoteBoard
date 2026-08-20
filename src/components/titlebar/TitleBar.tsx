// NoteBoard TitleBar
// 自绘标题栏：应用图标 + tab 栏 + 拖拽区 + 窗口控制 + 设置入口
// 详见 docs/07-UI布局与交互规范.md §2

import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Settings as SettingsIcon, RefreshCw } from 'lucide-react';
import { TabBar } from './TabBar';
import { WindowControls } from './WindowControls';
import { ThemeMenu } from './ThemeMenu';
import { useLayoutStore } from '../../stores/layoutStore';
import { useUpdateStore } from '../../stores/updateStore';

export function TitleBar() {
  const toggleSettingsModal = useLayoutStore((s) => s.toggleSettingsModal);

  const { hasUpdate, checking: checkingUpdate, checkForUpdates } = useUpdateStore();

  // 双击拖拽区 → toggleMaximize
  useEffect(() => {
    const handleDoubleClick = () => {
      getCurrentWindow().toggleMaximize();
    };

    const dragRegion = document.querySelector('[data-tauri-drag-region]');
    if (dragRegion) {
      dragRegion.addEventListener('dblclick', handleDoubleClick);
      return () => dragRegion.removeEventListener('dblclick', handleDoubleClick);
    }
  }, []);

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
      {/* 应用图标 16px，点击可打开设置中心 */}
      <div
        data-tauri-drag-region
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
        onClick={toggleSettingsModal}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--toolbar-hover)';
          e.currentTarget.style.transform = 'scale(1.05)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
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
        title="NoteBoard (点击打开设置)"
      >
        <img
          src="/logo.ico"
          alt="NoteBoard"
          width={16}
          height={16}
          style={{ pointerEvents: 'none' }}
        />
      </div>

      {/* Tab 栏 */}
      <TabBar />

      {/* 拖拽空白区 */}
      <div
        data-tauri-drag-region
        style={{
          flex: 1,
          height: '100%',
          minWidth: 0,
        }}
      />

      {/* 检测更新按钮（主动检测更新，有新版本时标上小红点） */}
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
        title={hasUpdate ? '发现新版本 NoteBoard (点击查看)' : '检测更新'}
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

      {/* 快捷主题切换菜单 */}
      <ThemeMenu />

      {/* 设置中心按钮 */}
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
        title="设置 (Ctrl+,)"
        aria-label="打开设置"
      >
        <SettingsIcon size={15} />
      </button>

      {/* 窗口控制按钮 */}
      <WindowControls />
    </div>
  );
}
