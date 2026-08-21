import { useEffect } from 'react';
import { AppShell } from './components/AppShell';
import { SettingsModal } from './components/settings/SettingsModal';
import { UpdateModal } from './components/UpdateModal';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useSettingsStore } from './stores/settingsStore';
import { useLayoutStore } from './stores/layoutStore';
import { useWindowStore } from './stores/windowStore';
import { useUpdateStore } from './stores/updateStore';
import { initShortcuts, registerShortcut } from './core/shortcuts';
import { initWindow, startEventListeners, stopEventListeners, newEmptyWindow } from './features/window/windowManager';
import {
  openFileDialog,
  openFolderDialog,
  newMarkdown,
} from './features/welcome/welcomeActions';
import { saveAs, saveDocument } from './features/editor-code/orchestration/saveDocument';
import { startStagingManager } from './features/staging/stagingManager';
import { checkActiveDocumentStillExists } from './features/external/missingFileGuard';
import {
  restoreLastClosedWindow,
  startClosedWindowSessionTracker,
} from './features/session/closedWindowSession';

export default function App() {
  const { init, initialized } = useSettingsStore();
  const { settingsModalVisible, setSettingsModalVisible, toggleSettingsModal } = useLayoutStore();
  const activeKey = useWindowStore((s) => s.activeKey);
  const {
    modalOpen: updateModalOpen,
    closeModal: closeUpdateModal,
    updateResult,
    checkError,
    checking: checkingUpdate,
    checkForUpdates,
    initAutoUpdateTimer,
  } = useUpdateStore();

  useEffect(() => {
    let disposed = false;
    // 启动自动检测更新定时任务（启动 3 秒后首次检测，随后每 5 分钟轮询一次）
    const stopAutoUpdate = initAutoUpdateTimer();
    const cleanup = initShortcuts();
    // 增量暂存覆盖任务管理器直接终止进程、来不及执行关闭回调的系统边界。
    const stopStagingManager = startStagingManager();
    const stopClosedWindowSessionTracker = startClosedWindowSessionTracker();
    // 先加载设置和窗口意图；普通空启动才自动恢复最近文件，显式打开文件时不抢占用户操作。
    const initializeWindow = async () => {
      await init();
      if (disposed) return;
      const intent = await initWindow();
      if (!disposed && intent.type === 'empty' && useSettingsStore.getState().settings.file.restoreSession) {
        try {
          await restoreLastClosedWindow();
        } catch (error) {
          console.error('自动恢复最近文件失败:', error);
        }
      }
      if (!disposed) startEventListeners();
    };
    initializeWindow();

    // 全局禁用原生浏览器右键菜单
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };
    window.addEventListener('contextmenu', handleContextMenu);

    // 全局捕获阶段拦截所有 a 标签的原生默认行为，防止 WebView2 底层触发新窗口或导航
    const handleGlobalAnchorClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest('a');
      if (anchor) {
        e.preventDefault();
      }
    };
    window.addEventListener('click', handleGlobalAnchorClick, true);
    window.addEventListener('auxclick', handleGlobalAnchorClick, true);

    // 从其他软件或任务切回 NoteBoard 时检查活动文件是否在运行期间被删除。
    const handleWindowFocus = () => {
      checkActiveDocumentStillExists(true).catch(() => {});
    };
    window.addEventListener('focus', handleWindowFocus);

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
      disposed = true;
      stopAutoUpdate();
      cleanup();
      stopStagingManager();
      stopClosedWindowSessionTracker();
      window.removeEventListener('contextmenu', handleContextMenu);
      window.removeEventListener('click', handleGlobalAnchorClick, true);
      window.removeEventListener('auxclick', handleGlobalAnchorClick, true);
      window.removeEventListener('focus', handleWindowFocus);
      stopEventListeners();
      unregNewWindow();
      unregOpenFile();
      unregOpenFolder();
      unregNewMarkdown();
    };
  }, [init, initAutoUpdateTimer]);

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
        {/* 全局更新模态弹窗（供标题栏与关于页面共享） */}
        <UpdateModal
          isOpen={updateModalOpen}
          onClose={closeUpdateModal}
          result={updateResult}
          checkError={checkError}
          checking={checkingUpdate}
          onRecheck={() => checkForUpdates(false)}
        />
      </div>
    </ErrorBoundary>
  );
}
