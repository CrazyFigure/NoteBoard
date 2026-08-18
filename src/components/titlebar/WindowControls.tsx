// NoteBoard WindowControls
// 最小化/最大化/关闭按钮
// 详见 docs/07-UI布局与交互规范.md §2.2

import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Minus, Square, Copy, X } from 'lucide-react';
import { useWindowStore } from '../../stores/windowStore';
import { performWindowClose } from '../../features/window/windowManager';

export function WindowControls() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    win.isMaximized().then(setIsMaximized);

    const unlisten = win.onResized(() => {
      win.isMaximized().then(setIsMaximized);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const handleMinimize = () => getCurrentWindow().minimize();
  const handleMaximize = () => getCurrentWindow().toggleMaximize();
  const handleClose = async () => {
    const tabStore = useWindowStore.getState();
    const label = getCurrentWindow().label;
    const dirtyTabs = tabStore.tabs.filter((t) => t.isDirty);
    if (dirtyTabs.length > 0) {
      tabStore.requestCloseBatch(dirtyTabs.map((t) => t.key));
      return;
    }
    await performWindowClose(label);
  };

  const btnStyle: React.CSSProperties = {
    width: 46,
    height: 36,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    cursor: 'pointer',
    transition: 'background var(--transition-fast)',
    color: 'var(--editor-text-secondary)',
  };

  const closeBtnStyle: React.CSSProperties = {
    ...btnStyle,
    color: 'var(--editor-text-secondary)',
  };

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <button
        onClick={handleMinimize}
        style={btnStyle}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--toolbar-hover)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
        }}
        aria-label="最小化"
      >
        <Minus size={16} />
      </button>
      <button
        onClick={handleMaximize}
        style={btnStyle}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--toolbar-hover)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
        }}
        aria-label={isMaximized ? '还原' : '最大化'}
      >
        {isMaximized ? <Copy size={14} /> : <Square size={14} />}
      </button>
      <button
        onClick={handleClose}
        style={closeBtnStyle}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = '#e81123';
          e.currentTarget.style.color = '#ffffff';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = 'var(--editor-text-secondary)';
        }}
        aria-label="关闭"
      >
        <X size={16} />
      </button>
    </div>
  );
}
