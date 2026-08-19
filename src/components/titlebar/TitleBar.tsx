// NoteBoard TitleBar
// 自绘标题栏：应用图标 + tab 栏 + 拖拽区 + 窗口控制 + 设置入口
// 详见 docs/07-UI布局与交互规范.md §2

import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Settings as SettingsIcon } from 'lucide-react';
import { TabBar } from './TabBar';
import { WindowControls } from './WindowControls';
import { useLayoutStore } from '../../stores/layoutStore';

export function TitleBar() {
  const toggleSettingsModal = useLayoutStore((s) => s.toggleSettingsModal);

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
