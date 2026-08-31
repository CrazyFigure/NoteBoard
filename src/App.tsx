import { useEffect, useRef, useState } from 'react';
import { AppShell } from './components/AppShell';
import { SettingsModal } from './components/settings/SettingsModal';
import { UpdateModal } from './components/UpdateModal';
import { FontPackPromptModal } from './components/FontPackPromptModal';
import { FavoritesManagerModal } from './features/favorites/FavoritesManagerModal';
import { AddFavoriteModal } from './features/favorites/AddFavoriteModal';
import { ErrorBoundary } from './components/ErrorBoundary';
import { TooltipProvider } from './components/Tooltip';
import { useSettingsStore } from './stores/settingsStore';
import { useLayoutStore } from './stores/layoutStore';
import { useWindowStore } from './stores/windowStore';
import { useUpdateStore } from './stores/updateStore';
import { useFontPackStore } from './stores/fontPackStore';
import { useFavoritesStore } from './features/favorites/favoritesStore';
import * as ipc from './core/ipc/commands';
import { resolveSystemFontFallbackPatch, shouldPromptForFontPack } from './app/fontPack';
import { initShortcuts, registerShortcut } from './core/shortcuts';
import { initWindow, startEventListeners, stopEventListeners, newEmptyWindow } from './features/window/windowManager';
import {
  openFileDialog,
  openFolderDialog,
} from './features/welcome/welcomeActions';
import { saveAs } from './features/editor-code/orchestration/saveDocument';
import { startStagingManager } from './features/staging/stagingManager';
import { checkActiveDocumentStillExists } from './features/external/missingFileGuard';
import {
  restoreLastClosedWindow,
  startClosedWindowSessionTracker,
} from './features/session/closedWindowSession';

export default function App() {
  const { init, initialized, settings, setTypography } = useSettingsStore();
  const fontPackInitialized = useFontPackStore((s) => s.initialized);
  const fontPackStatus = useFontPackStore((s) => s.status);
  const [fontPackPromptOpen, setFontPackPromptOpen] = useState(false);
  const [fontPackPromptSystemFonts, setFontPackPromptSystemFonts] = useState<string[]>([]);
  // 每个窗口只主动询问一次；拒绝会保存系统字体，下次启动不会再次打扰。
  const fontPackPromptEvaluatedRef = useRef(false);
  const { settingsModalVisible, setSettingsModalVisible } = useLayoutStore();
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
      // 初始化加载收藏夹数据
      useFavoritesStore.getState().loadFavorites().catch((err) => {
        console.error('加载收藏夹失败:', err);
      });
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
    };
  }, [init, initAutoUpdateTimer]);

  useEffect(() => {
    if (!initialized || !fontPackInitialized || fontPackPromptEvaluatedRef.current) return;
    fontPackPromptEvaluatedRef.current = true;
    let cancelled = false;

    // 字体包完整时静默使用；缺失或损坏时只在当前配置确实依赖它的情况下提示。
    const evaluateFontPackPrompt = async () => {
      if (fontPackStatus?.state === 'ready') return;
      let installedFamilies: string[] = [];
      try {
        const installed = await ipc.listSystemFonts();
        installedFamilies = installed.map((font) => font.family);
      } catch (error) {
        console.error('检测系统字体失败:', error);
      }
      if (cancelled) return;
      setFontPackPromptSystemFonts(installedFamilies);
      if (shouldPromptForFontPack(settings, installedFamilies)) {
        setFontPackPromptOpen(true);
      }
    };
    evaluateFontPackPrompt();
    return () => {
      cancelled = true;
    };
  }, [fontPackInitialized, fontPackStatus, initialized, settings]);

  // 其它窗口完成字体安装时，本窗口注册成功后同步关闭仍显示的首次提示。
  useEffect(() => {
    if (fontPackStatus?.state === 'ready') setFontPackPromptOpen(false);
  }, [fontPackStatus]);

  /** 用户拒绝下载时立即切换并保存真实存在的系统字体，避免后续每次启动重复询问。 */
  const handleUseSystemFonts = async () => {
    const patch = resolveSystemFontFallbackPatch(settings.typography, fontPackPromptSystemFonts);
    if (Object.keys(patch).length) await setTypography(patch);
    setFontPackPromptOpen(false);
  };

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

  if (!initialized || !fontPackInitialized) {
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
        <span style={{ color: 'var(--editor-text-muted)', fontSize: 13 }}>NoteBoard 加载中</span>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <TooltipProvider delayDuration={100} skipDelayDuration={300}>
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
          <FontPackPromptModal
            open={fontPackPromptOpen}
            onEnabled={() => setFontPackPromptOpen(false)}
            onUseSystem={handleUseSystemFonts}
          />
          {/* 全局收藏夹管理弹窗 */}
          <FavoritesManagerModal />
          {/* 全局添加/编辑收藏弹窗 */}
          <AddFavoriteModal />
        </div>
      </TooltipProvider>
    </ErrorBoundary>
  );
}
