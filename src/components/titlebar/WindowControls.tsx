// NoteBoard WindowControls
// 最小化/最大化/关闭按钮
// 详见 docs/07-UI布局与交互规范.md §2.2

import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Minus, Square, Copy, X } from 'lucide-react';
import { Tooltip } from '../Tooltip';
import { requestCurrentWindowClose } from '../../features/window/windowManager';

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
  // 标题栏关闭与系统关闭事件共用同一入口，确保确认保存或丢弃后继续关闭软件。
  const handleClose = () => requestCurrentWindowClose();

  // 窗口控制按钮统一样式：尺寸 36x36，与左侧功能按钮保持完全一致
  const btnStyle: React.CSSProperties = {
    width: 36,
    height: 36,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    flexShrink: 0,
    transition: 'all var(--transition-fast)',
    color: 'var(--editor-text-secondary)',
  };

  const closeBtnStyle: React.CSSProperties = {
    ...btnStyle,
    color: 'var(--editor-text-secondary)',
  };

  return (
    <div style={{ display: 'flex', height: '100%', alignItems: 'center' }}>
      {/* 最小化按钮 */}
      <Tooltip content="最小化" side="bottom" sideOffset={6}>
        <button
          type="button"
          onClick={handleMinimize}
          style={btnStyle}
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
          aria-label="最小化"
        >
          <Minus size={15} />
        </button>
      </Tooltip>
      {/* 最大化 / 还原按钮 */}
      <Tooltip content={isMaximized ? '向下还原' : '最大化'} side="bottom" sideOffset={6}>
        <button
          type="button"
          onClick={handleMaximize}
          style={btnStyle}
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
          aria-label={isMaximized ? '还原' : '最大化'}
        >
          {isMaximized ? <Copy size={14} /> : <Square size={14} />}
        </button>
      </Tooltip>
      {/* 关闭窗口按钮 */}
      <Tooltip content="关闭" side="bottom" sideOffset={6}>
        <button
          type="button"
          onClick={handleClose}
          style={closeBtnStyle}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = '#e81123';
            e.currentTarget.style.color = '#ffffff';
            e.currentTarget.style.transform = 'scale(1.05)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'var(--editor-text-secondary)';
            e.currentTarget.style.transform = 'scale(1)';
          }}
          onMouseDown={(e) => {
            e.currentTarget.style.background = '#c4101e';
            e.currentTarget.style.transform = 'scale(0.92)';
          }}
          onMouseUp={(e) => {
            e.currentTarget.style.background = '#e81123';
            e.currentTarget.style.transform = 'scale(1.05)';
          }}
          aria-label="关闭"
        >
          <X size={15} />
        </button>
      </Tooltip>
    </div>
  );
}
