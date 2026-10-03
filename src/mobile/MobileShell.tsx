// NoteBoard 移动端外壳
// 替代桌面 AppShell：首页 / 编辑页栈式导航 + 设置全屏页。启动流程、文档模型、编辑器全部复用。
// 负责移动端系统集成：Android 返回键、进入后台自动保存、回到前台刷新与接收外部文件、"另存为"命名。

import { useEffect, useRef } from 'react';
import { onBackButtonPress } from '@tauri-apps/api/app';
import * as ipc from '../core/ipc/commands';
import { IS_NATIVE_MOBILE } from '../core/platform';
import { useWindowStore } from '../stores/windowStore';
import { useSearchStore } from '../stores/searchStore';
import { useLayoutStore } from '../stores/layoutStore';
import { useSettingsStore } from '../stores/settingsStore';
import { showToast } from '../stores/toastStore';
import { ToastContainer } from '../components/Toast';
import { UnsavedGuardDialog } from '../features/editor-code/UnsavedGuardDialog';
import { MissingFileDialog } from '../features/external/MissingFileDialog';
import { checkActiveDocumentStillExists } from '../features/external/missingFileGuard';
import { saveDocument, setSaveAsPathPicker } from '../features/editor-code/orchestration/saveDocument';
import { useCloseGuardHandlers, useMarkdownEditorRegistry, useRestoredTabLoader } from '../components/shell/shellHooks';
import { PromptDialog } from './components';
import { MobileHome } from './MobileHome';
import { MobileEditorPage } from './MobileEditorPage';
import { consumeIncomingFiles, navigateUp, refreshCurrentFolder, switchLocation, validateFileName } from './mobileFiles';
import { readRememberedLocation, useMobileStore } from './mobileStore';
import { cancelSaveAs, mobileSaveAsPicker, resolveSaveAs, useMobileSaveAsStore } from './mobileSaveAs';

/** 两次返回键退出的判定间隔 */
const EXIT_CONFIRM_MS = 2000;

/** 进入后台时保存所有已有路径的脏文档（未命名文档由暂存机制保护，不弹命名框） */
async function saveDirtyDocumentsSilently(): Promise<void> {
  const dirtyTabs = useWindowStore.getState().tabs.filter((tab) => tab.isDirty && tab.path && !tab.isDetached);
  for (const tab of dirtyTabs) {
    try {
      await saveDocument(tab.key);
    } catch (error) {
      console.error('后台自动保存失败:', error);
    }
  }
}

/** 刷新平台信息（权限可能在系统设置中改变） */
async function refreshPlatformInfo(): Promise<void> {
  try {
    const info = await ipc.getPlatformInfo();
    useMobileStore.getState().setPlatform(info);
  } catch (error) {
    console.error('获取平台信息失败:', error);
  }
}

/** 初始化存储位置：确保默认工作区，恢复上次浏览位置（权限失效时回退到"我的笔记"） */
async function initializeStorage(): Promise<void> {
  const info = await ipc.getPlatformInfo();
  const workspace = await ipc.ensureDefaultWorkspace();
  useMobileStore.getState().setPlatform({ ...info, defaultWorkspace: workspace });
  const remembered = readRememberedLocation();
  const location = remembered.location === 'device' && info.allFilesAccess && info.externalRoot ? 'device' : 'workspace';
  await switchLocation(location, remembered.folder);
}

export function MobileShell() {
  const tabs = useWindowStore((s) => s.tabs);
  const activeKey = useWindowStore((s) => s.activeKey);
  const page = useMobileStore((s) => s.page);
  const saveAsRequest = useMobileSaveAsStore((s) => s.request);

  const { activeEditor, getMarkdownEditorReadyHandler } = useMarkdownEditorRegistry(tabs, activeKey);
  const {
    dirtyPendingTabs,
    handleSaveAndClose,
    handleDiscardAndClose,
    handleStashAndClose,
    handleCancelClose,
  } = useCloseGuardHandlers(tabs);
  useRestoredTabLoader(activeKey);

  const activeTab = tabs.find((tab) => tab.key === activeKey) ?? null;

  // 启动：存储位置初始化 + 注册移动端"另存为"命名流程 + 处理冷启动时传入的外部文件
  useEffect(() => {
    setSaveAsPathPicker(mobileSaveAsPicker);
    void initializeStorage()
      .catch((error) => {
        console.error('初始化存储位置失败:', error);
        showToast('无法初始化笔记工作区', 'error');
      })
      .then(() => consumeIncomingFiles());
    return () => setSaveAsPathPicker(null);
  }, []);

  // 系统栏颜色跟随主题：取顶栏实际背景色（统一换算为 #RRGGBB 供原生解析）
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);
  useEffect(() => {
    if (!IS_NATIVE_MOBILE) return;
    const frame = requestAnimationFrame(() => {
      const probe = document.querySelector('.nb-m-topbar') ?? document.body;
      const rgb = getComputedStyle(probe).backgroundColor.match(/\d+(\.\d+)?/g);
      if (!rgb || rgb.length < 3) return;
      const [red, green, blue] = rgb.slice(0, 3).map((value) => Math.round(Number(value)));
      const hex = `#${[red, green, blue].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
      // 感知亮度低于 0.5 视为深色背景，系统栏图标改用浅色
      const dark = (0.299 * red + 0.587 * green + 0.114 * blue) / 255 < 0.5;
      void ipc.setSystemBarStyle(hex, dark).catch(() => {});
    });
    return () => cancelAnimationFrame(frame);
  }, [resolvedTheme, page]);

  // 打开新文档（文件列表、链接、外部传入等任何来源）后自动进入编辑页；全部关闭后回到首页
  const previousActiveKeyRef = useRef<string | null>(activeKey);
  useEffect(() => {
    const previous = previousActiveKeyRef.current;
    previousActiveKeyRef.current = activeKey;
    if (activeKey && activeKey !== previous) {
      useMobileStore.getState().setPage('editor');
    } else if (!activeKey && previous) {
      useMobileStore.getState().setPage('home');
    }
  }, [activeKey]);

  // 进入后台立即保存；回到前台刷新权限、文件列表、外部修改检测并接收新传入文件
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        void saveDirtyDocumentsSilently();
        return;
      }
      void refreshPlatformInfo();
      void refreshCurrentFolder();
      void checkActiveDocumentStillExists(true).catch(() => {});
      void consumeIncomingFiles();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  // Android 返回键：覆盖层 → 查找栏 → 设置 → 编辑页 → 上级文件夹 → 再按一次退到后台
  useEffect(() => {
    if (!IS_NATIVE_MOBILE) return;
    let lastBackAt = 0;
    let disposed = false;
    let unregister: (() => void) | null = null;
    const handleBack = async () => {
      const state = useMobileStore.getState();
      const topOverlay = state.overlays[state.overlays.length - 1];
      if (topOverlay) {
        topOverlay.close();
        return;
      }
      if (useMobileSaveAsStore.getState().request) {
        cancelSaveAs();
        return;
      }
      if (useWindowStore.getState().pendingCloseKeys.length > 0) {
        useWindowStore.getState().clearPendingClose();
        return;
      }
      if (useSearchStore.getState().isOpen) {
        useSearchStore.getState().closeSearch();
        return;
      }
      if (useLayoutStore.getState().settingsModalVisible) {
        useLayoutStore.getState().setSettingsModalVisible(false);
        return;
      }
      if (state.page === 'editor') {
        state.setPage('home');
        return;
      }
      // 首页非"文件"分段：返回（含系统左/右边缘返回手势）先回到上一个分段，与向右滑动的意图一致
      if (state.homeSection !== 'files') {
        const order = ['files', 'favorites', 'open'] as const;
        state.setHomeSection(order[Math.max(0, order.indexOf(state.homeSection) - 1)]);
        return;
      }
      if (await navigateUp()) return;
      const now = Date.now();
      if (now - lastBackAt < EXIT_CONFIRM_MS) {
        // 退到后台前保存，保持与系统默认返回行为一致（不销毁应用，编辑状态保留）
        await saveDirtyDocumentsSilently();
        await ipc.moveAppToBackground().catch(() => {});
        lastBackAt = 0;
        return;
      }
      lastBackAt = now;
      showToast('再按一次返回键退出', 'info', EXIT_CONFIRM_MS);
    };
    void onBackButtonPress(() => {
      void handleBack();
    })
      .then((listener) => {
        if (disposed) {
          void listener.unregister();
        } else {
          unregister = () => void listener.unregister();
        }
      })
      .catch((error) => console.error('注册返回键监听失败:', error));
    return () => {
      disposed = true;
      unregister?.();
    };
  }, []);

  return (
    <div className="nb-m-shell">
      {(page === 'home' || !activeTab) && <MobileHome />}
      {/* 编辑页常驻挂载：返回首页只隐藏，编辑器内核与撤销历史保留 */}
      <MobileEditorPage
        activeTab={activeTab}
        activeEditor={activeEditor}
        getMarkdownEditorReadyHandler={getMarkdownEditorReadyHandler}
      />

      <PromptDialog
        open={saveAsRequest !== null}
        title="保存文档"
        description={saveAsRequest ? `保存到：${saveAsRequest.folder}` : undefined}
        initialValue={saveAsRequest?.defaultName ?? ''}
        selectBaseName
        confirmLabel="保存"
        validate={validateFileName}
        onClose={cancelSaveAs}
        onConfirm={(value) => resolveSaveAs(value)}
      />

      <UnsavedGuardDialog
        dirtyTabs={dirtyPendingTabs}
        visible={dirtyPendingTabs.length > 0}
        onSave={handleSaveAndClose}
        onStash={handleStashAndClose}
        onDiscard={handleDiscardAndClose}
        onCancel={handleCancelClose}
      />
      <MissingFileDialog />
      <ToastContainer />
    </div>
  );
}
