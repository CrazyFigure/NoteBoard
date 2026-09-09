import { useEffect, useRef, useState } from 'react';
import { lazy, Suspense } from 'react';
import { AppShell } from './components/AppShell';
import { ErrorBoundary } from './components/ErrorBoundary';
import { TooltipProvider } from './components/Tooltip';
import { useSettingsStore } from './stores/settingsStore';
import { useLayoutStore } from './stores/layoutStore';
import { useWindowStore } from './stores/windowStore';
import { useUpdateStore } from './stores/updateStore';
import { useFontPackStore } from './stores/fontPackStore';
import { useFavoritesStore } from './features/favorites/favoritesStore';
import * as ipc from './core/ipc/commands';
import {
  resolveSystemFontFallbackPatch,
  shouldPromptForFontPack,
  settingsReferencePackagedFonts,
} from './app/fontPack';
import { initShortcuts, registerShortcut } from './core/shortcuts';
import { perfMark, perfNow } from './core/perf/perfMarks';
import { reportWebSpans } from './core/perf/reportWebSpans';
import {
  initWindow,
  requestShellReadyAndDrain,
  disposeWindowManager,
  newEmptyWindow,
} from './features/window/windowManager';
import { requestDrain } from './app/bootCoordinator';
import {
  openFileDialog,
  openFolderDialog,
} from './features/welcome/welcomeActions';
import { saveAs } from './features/editor-code/orchestration/saveDocument';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { startStagingManager } from './features/staging/stagingManager';
import { checkActiveDocumentStillExists } from './features/external/missingFileGuard';
import {
  restoreLastClosedWindow,
  startClosedWindowSessionTracker,
} from './features/session/closedWindowSession';

// 🔴 S05：全局弹窗首次触发才装载（E 节 6）——未打开时不渲染即不加载，
//    装载后保持挂载以保留关闭动画；安全关闭保护（UnsavedGuardDialog）仍轻量常驻
const SettingsModal = lazy(() =>
  import('./components/settings/SettingsModal').then((m) => ({ default: m.SettingsModal })),
);
const UpdateModal = lazy(() =>
  import('./components/UpdateModal').then((m) => ({ default: m.UpdateModal })),
);
const FontPackPromptModal = lazy(() =>
  import('./components/FontPackPromptModal').then((m) => ({ default: m.FontPackPromptModal })),
);
const FavoritesManagerModal = lazy(() =>
  import('./features/favorites/FavoritesManagerModal').then((m) => ({ default: m.FavoritesManagerModal })),
);
const AddFavoriteModal = lazy(() =>
  import('./features/favorites/AddFavoriteModal').then((m) => ({ default: m.AddFavoriteModal })),
);

/** 一旦 open 变 true 则永久返回 true（弹窗装载后保持挂载，保留关闭动画） */
function useEverOpened(open: boolean): boolean {
  const [ever, setEver] = useState(open);
  useEffect(() => {
    if (open) setEver(true);
  }, [open]);
  return ever;
}

export default function App() {
  const { init, initialized, settings, setTypography } = useSettingsStore();
  const fontPackInitialized = useFontPackStore((s) => s.initialized);
  const fontPackStatus = useFontPackStore((s) => s.status);
  const [fontPackPromptOpen, setFontPackPromptOpen] = useState(false);
  const [fontPackPromptSystemFonts, setFontPackPromptSystemFonts] = useState<string[]>([]);
  // 每个窗口只主动询问一次；拒绝会保存系统字体，下次启动不会再次打扰。
  const fontPackPromptEvaluatedRef = useRef(false);
  // 🔴 S04：启动失败状态（监听/握手异常时呈现可重试错误界面）
  const [bootError, setBootError] = useState<string | null>(null);
  // 🔴 R08：错误壳重试计数（驱动启动 effect 重跑；不整页 reload）
  const [bootRetryAttempt, setBootRetryAttempt] = useState(0);
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
    // 先建立监听与握手（含关闭保护），再加载设置；显式打开文件不抢占用户操作。
    // 🔴 S04 顺序（C 节）：监听与数据保护 → listeners-ready 握手 → 设置 → 壳显示 → drain 队列
    const initializeWindow = async () => {
      // 🔴 R08：先建立监听/握手（数据保护先于一切），再加载设置——
      //    握手不依赖设置；期间到达的打开请求已在队列等待 drain
      const intentStart = perfNow();
      const boot = await initWindow();
      perfMark('window_boot_done', { intentType: boot.startupMode, bootMs: Math.round(performance.now() - intentStart) });
      if (disposed) return;
      // 设置初始化（字体服务独立，不阻塞渲染）
      await init();
      perfMark('settings_init_done');
      // 初始化加载收藏夹数据
      useFavoritesStore.getState().loadFavorites().catch((err) => {
        console.error('加载收藏夹失败:', err);
      });
      if (disposed) return;
      // 显示主题正确的壳并开始消费打开队列（设置已加载；字体不阻塞窗口显示）
      await requestShellReadyAndDrain();
      if (boot.startupMode === 'empty' && useSettingsStore.getState().settings.file.restoreSession) {
        try {
          await restoreLastClosedWindow();
          perfMark('session_restore_done');
        } catch (error) {
          console.error('自动恢复最近文件失败:', error);
        }
      }
      perfMark('listeners_subscribed');
      // 🔴 性能诊断：启动链路完成的里程碑，批量上报一次 web spans
      void reportWebSpans('boot');
    };
    // 🔴 启动失败兜底：可见、可关闭、可重试的错误界面（C 节要求）
    initializeWindow().catch((error) => {
      console.error('窗口启动失败:', error);
      if (!disposed) {
        setBootError(error instanceof Error ? error.message : String(error));
        // 🔴 R08：窗口初始隐藏时错误壳必须可见——尽力通知后端显示窗口
        void ipc.windowShellReady(getCurrentWindow().label).catch(() => {});
      }
    });

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

    // 从其他软件或任务切回 NoteBoard 时检查活动文件是否在运行期间被删除，
    // 并重新消费打开队列（窗口重新获得焦点时的恢复机制）。
    const handleWindowFocus = () => {
      // 🔴 N07：事件唤醒受业务就绪门槛——设置加载完成前仅记录待处理
      requestDrain(true);
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
      disposeWindowManager();
      unregNewWindow();
      unregOpenFile();
      unregOpenFolder();
    };
  }, [init, initAutoUpdateTimer, bootRetryAttempt]);

  useEffect(() => {
    if (!initialized || !fontPackInitialized || fontPackPromptEvaluatedRef.current) return;
    fontPackPromptEvaluatedRef.current = true;
    let cancelled = false;

    // 字体包完整时静默使用；缺失或损坏时只在当前配置确实依赖它的情况下提示。
    // 🔴 S06 提示顺序（F 节）：先判断配置是否引用包字体（纯前端）→ 再查包状态 →
    // 按需才枚举系统字体；纯系统字体配置不得触发枚举。
    const evaluateFontPackPrompt = async () => {
      if (fontPackStatus?.state === 'ready') return;
      if (fontPackStatus?.state === 'verifying') {
        // 校验未完成：不提示（校验完成的广播会重新触发本 effect）
        fontPackPromptEvaluatedRef.current = false;
        return;
      }
      if (!settingsReferencePackagedFonts(settings)) return;
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
        // 🔴 输入保护（F 节）：用户正在编辑区输入/IME 时不抢焦点，推迟提示
        const active = document.activeElement;
        const isEditing =
          active instanceof HTMLElement &&
          (active.isContentEditable ||
            active.tagName === 'TEXTAREA' ||
            active.tagName === 'INPUT');
        if (isEditing) {
          setTimeout(() => {
            if (!cancelled) setFontPackPromptOpen(true);
          }, 3000);
        } else {
          setFontPackPromptOpen(true);
        }
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

  // 🔴 S05：弹窗"曾经打开"状态（首开触发 lazy 装载；装载后保持挂载保留关闭动画）
  const favoritesManagerOpen = useFavoritesStore((s) => s.managerModalOpen);
  const addFavoriteOpen = useFavoritesStore((s) => s.addModalState.open);
  const settingsEverOpened = useEverOpened(settingsModalVisible);
  const updateModalEverOpened = useEverOpened(updateModalOpen);
  const fontPackPromptEverOpened = useEverOpened(fontPackPromptOpen);
  const favoritesManagerEverOpened = useEverOpened(favoritesManagerOpen);
  const addFavoriteEverOpened = useEverOpened(addFavoriteOpen);

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

  // 🔴 性能诊断：壳首帧可见的 rAF 代理标记（主题正确且 AppShell 已提交后的第一帧）
  useEffect(() => {
    if (!initialized || !fontPackInitialized) return;
    const raf = requestAnimationFrame(() => {
      perfMark('shell_visible_proxy');
    });
    return () => cancelAnimationFrame(raf);
  }, [initialized, fontPackInitialized]);

  if (bootError) {
    // 🔴 启动失败错误壳：可见、可关闭（显示技术详情）、可重试（不整页 reload——
    //    reload 会绕过未保存保护；重试经 bootCoordinator 重新握手/订阅）
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          height: '100vh',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--editor-bg)',
          color: 'var(--editor-text)',
          fontFamily: 'var(--ui-font-family, sans-serif)',
        }}
      >
        <span style={{ fontSize: 15 }}>窗口启动失败：{bootError}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={() => {
              // 重试：重新走监听→握手（协调器 disposed 后可重建，见 bootCoordinator R08）
              setBootError(null);
              setBootRetryAttempt((n) => n + 1);
            }}
            style={{ padding: '6px 16px', fontSize: 13, cursor: 'pointer', borderRadius: 6 }}
          >
            重试
          </button>
          <button
            type="button"
            onClick={() => {
              // 安全退出：关闭本窗口（已有未保存内容已受暂存保护）
              void ipc.closeWindow(getCurrentWindow().label).catch(() => {});
            }}
            style={{ padding: '6px 16px', fontSize: 13, cursor: 'pointer', borderRadius: 6 }}
          >
            关闭窗口
          </button>
        </div>
      </div>
    );
  }

  // 🔴 R11：渲染只等设置（initialized）——字体服务不阻塞业务界面
  //    （未验证完成前排版先用字体栈 fallback，验证完成后自动应用并重测）
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
        <span style={{ color: 'var(--editor-text-muted)', fontSize: 13 }}>NoteBoard 加载中</span>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <TooltipProvider delayDuration={100} skipDelayDuration={300}>
        <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', position: 'relative' }}>
          <AppShell />
          {/* 🔴 S05：全局弹窗按需装载；首开前不进入首屏闭包 */}
          {settingsEverOpened && (
            <Suspense fallback={null}>
              <SettingsModal
                isOpen={settingsModalVisible}
                onClose={() => setSettingsModalVisible(false)}
              />
            </Suspense>
          )}
          {/* 全局更新模态弹窗（供标题栏与关于页面共享） */}
          {updateModalEverOpened && (
            <Suspense fallback={null}>
              <UpdateModal
                isOpen={updateModalOpen}
                onClose={closeUpdateModal}
                result={updateResult}
                checkError={checkError}
                checking={checkingUpdate}
                onRecheck={() => checkForUpdates(false)}
              />
            </Suspense>
          )}
          {fontPackPromptEverOpened && (
            <Suspense fallback={null}>
              <FontPackPromptModal
                open={fontPackPromptOpen}
                onEnabled={() => setFontPackPromptOpen(false)}
                onUseSystem={handleUseSystemFonts}
              />
            </Suspense>
          )}
          {/* 全局收藏夹管理弹窗（内部以 managerModalOpen 控制开关） */}
          {favoritesManagerEverOpened && (
            <Suspense fallback={null}>
              <FavoritesManagerModal />
            </Suspense>
          )}
          {/* 全局添加/编辑收藏弹窗 */}
          {addFavoriteEverOpened && (
            <Suspense fallback={null}>
              <AddFavoriteModal />
            </Suspense>
          )}
        </div>
      </TooltipProvider>
    </ErrorBoundary>
  );
}
