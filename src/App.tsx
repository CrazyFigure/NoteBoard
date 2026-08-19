import { useEffect } from 'react';
import { AppShell } from './components/AppShell';
import { SettingsModal } from './components/settings/SettingsModal';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useSettingsStore } from './stores/settingsStore';
import { useLayoutStore } from './stores/layoutStore';
import { useWindowStore } from './stores/windowStore';
import { initShortcuts, registerShortcut } from './core/shortcuts';
import { initWindow, startEventListeners, stopEventListeners, newEmptyWindow } from './features/window/windowManager';
import {
  openFileDialog,
  openFolderDialog,
  newMarkdown,
} from './features/welcome/welcomeActions';
import { saveAs, saveDocument } from './features/editor-code/orchestration/saveDocument';

export default function App() {
  const { init, initialized } = useSettingsStore();
  const { settingsModalVisible, setSettingsModalVisible, toggleSettingsModal } = useLayoutStore();
  const activeKey = useWindowStore((s) => s.activeKey);

  useEffect(() => {
    init();
    const cleanup = initShortcuts();
    // 窗口握手 + 事件监听
    initWindow().then(() => {
      startEventListeners();
    });

    // 全局禁用原生浏览器右键菜单
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };
    window.addEventListener('contextmenu', handleContextMenu);

    // Ctrl+Shift+N 新建空窗口
    const unregNewWindow = registerShortcut({
      key: 'Ctrl+Shift+N',
      action: () => {
        newEmptyWindow();
      },
      scope: 'global',
      description: '新建窗口',
    });

    // 欢迎页与全局文件动作
    const unregOpenFile = registerShortcut({
      key: 'Ctrl+O',
      action: () => {
        openFileDialog();
      },
      scope: 'global',
      description: '打开文件',
    });

    // Ctrl+Shift+O 打开文件夹
    const unregOpenFolder = registerShortcut({
      key: 'Ctrl+Shift+O',
      action: () => {
        openFolderDialog();
      },
      scope: 'global',
      description: '打开文件夹',
    });

    const unregNewMarkdown = registerShortcut({
      key: 'Ctrl+N',
      action: () => {
        newMarkdown();
      },
      scope: 'global',
      description: '新建 Markdown',
    });

    return () => {
      cleanup();
      window.removeEventListener('contextmenu', handleContextMenu);
      stopEventListeners();
      unregNewWindow();
      unregOpenFile();
      unregOpenFolder();
      unregNewMarkdown();
    };
  }, [init]);

  // Ctrl+Shift+S 另存为
  useEffect(() => {
    const unregSaveAs = registerShortcut({
      key: 'Ctrl+Shift+S',
      action: () => {
        if (activeKey) {
          const doc = useWindowStore.getState().getTab(activeKey);
          if (doc) {
            saveAs(activeKey, '');
          }
        }
      },
      scope: 'global',
      description: '另存为当前文档',
    });
    return () => unregSaveAs();
  }, [activeKey]);

  if (!initialized) {
    return (
      <div
        style={{
          display: 'flex',
          height: '100vh',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--editor-bg)',
          color: 'var(--editor-text)',
          fontFamily: 'var(--content-font-family)',
        }}
      >
        <span style={{ color: 'var(--editor-text-muted)', fontSize: 13 }}>NoteBoard 加载中…</span>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', position: 'relative' }}>
        <AppShell />
        <SettingsModal
          isOpen={settingsModalVisible}
          onClose={() => setSettingsModalVisible(false)}
        />
      </div>
    </ErrorBoundary>
  );
}
