// NoteBoard 沉浸阅读模式控制（各格式共用）
// 只切换窗口临时布局状态，不触碰文档内容与撤销历史；进入时保持当前窗口大小，全屏由阅读内的按钮按需切换
// 外壳隐藏逻辑见 AppShell，窗口控件见 ReadingWindowControls，Esc 处理见 ReadingModeOverlay，插件经 mount 上下文的 reading 接入

import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { IS_MOBILE_UI, IS_WEB, USES_MAC_TRAFFIC_LIGHTS } from '../../core/platform';
import { useLayoutStore } from '../../stores/layoutStore';
import { useWindowStore, type Tab } from '../../stores/windowStore';
import { showToast } from '../../stores/toastStore';

/** 用户最新期望值：异步全屏请求排队执行，过期请求据此跳过 */
let desiredReadingMode = false;
/** 串行化原生窗口全屏请求，避免快速连点时较晚完成的旧请求覆盖最新状态 */
let fullscreenOperation: Promise<void> = Promise.resolve();
/** 全屏是否由阅读内的按钮打开：退出阅读只撤销这种全屏，不动用户进入阅读前自己开的全屏 */
let fullscreenOwnedByReading = false;
/** 全屏切换完成后通知订阅者：最大化窗口切全屏时尺寸可能不变（如任务栏自动隐藏），不能只靠 resize 同步 */
const fullscreenListeners = new Set<() => void>();

function enqueueFullscreenOperation(task: () => Promise<void>): Promise<void> {
  fullscreenOperation = fullscreenOperation.catch(() => undefined).then(task);
  return fullscreenOperation;
}

/** 进入或退出沉浸阅读：更新布局即时生效，退出时再排队撤销阅读内打开的全屏 */
export function requestReadingMode(enabled: boolean): void {
  if (desiredReadingMode === enabled && useLayoutStore.getState().readingMode === enabled) return;
  // 沉浸阅读可切换系统全屏，而极窄模式限制了窗口尺寸，两者互斥
  if (enabled && useLayoutStore.getState().compactMode) {
    showToast('极窄模式下不支持沉浸阅读', 'info');
    return;
  }
  desiredReadingMode = enabled;
  useLayoutStore.getState().setReadingMode(enabled);
  if (enabled) return;

  void enqueueFullscreenOperation(async () => {
    if (desiredReadingMode || !fullscreenOwnedByReading) return;
    fullscreenOwnedByReading = false;
    try {
      await getCurrentWindow().setFullscreen(false);
    } catch (error) {
      console.error('退出沉浸阅读全屏失败:', error);
    }
  });
}

/** 阅读中切换系统全屏（移动端应用本身即全屏，不提供） */
export function toggleReadingFullscreen(): Promise<void> {
  return enqueueFullscreenOperation(async () => {
    if (!desiredReadingMode || IS_MOBILE_UI) return;
    try {
      const win = getCurrentWindow();
      const next = !(await win.isFullscreen());
      await win.setFullscreen(next);
      fullscreenOwnedByReading = next;
      fullscreenListeners.forEach((listener) => listener());
    } catch (error) {
      // 全屏失败不影响阅读排版，继续留在当前窗口大小
      console.error('切换沉浸阅读全屏失败:', error);
      showToast('无法切换全屏', 'warning');
    }
  });
}

/** 是否提供全屏按钮：移动端应用本身即全屏；网页取决于浏览器是否允许（内嵌 iframe 可能被禁用） */
export function canToggleReadingFullscreen(): boolean {
  if (IS_MOBILE_UI) return false;
  return !IS_WEB || document.fullscreenEnabled;
}

/** 是否提供最小化按钮：网页无权操作浏览器窗口，移动端无此概念，macOS 原生全屏窗口无法最小化 */
export function canMinimizeReadingWindow(isFullscreen: boolean): boolean {
  if (IS_MOBILE_UI || IS_WEB) return false;
  return !(USES_MAC_TRAFFIC_LIGHTS && isFullscreen);
}

/** 窗口当前是否全屏：随阅读内切换与窗口尺寸变化同步（含系统快捷键触发的全屏）；enabled 为假时不订阅并恒为 false */
export function useWindowFullscreen(enabled: boolean): boolean {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (!enabled || IS_MOBILE_UI) {
      setIsFullscreen(false);
      return;
    }
    const win = getCurrentWindow();
    let disposed = false;
    const sync = () => {
      win.isFullscreen().then((value) => {
        if (!disposed) setIsFullscreen(value);
      }).catch(() => {});
    };
    sync();
    fullscreenListeners.add(sync);
    const unlisten = win.onResized(sync);
    return () => {
      disposed = true;
      fullscreenListeners.delete(sync);
      unlisten.then((fn) => fn());
    };
  }, [enabled]);

  return enabled && isFullscreen;
}

/** 画板另有全屏演示，文本对比与加载中的恢复标签不提供沉浸阅读 */
const READING_KINDS: ReadonlySet<Tab['kind']> = new Set(['markdown', 'code', 'image', 'mindmap', 'drawio', 'bitable', 'preview']);

/** 该标签是否支持沉浸阅读（决定入口按钮与外壳隐藏） */
export function supportsReadingMode(tab: Pick<Tab, 'kind' | 'toolKind' | 'lazySource'> | null | undefined): boolean {
  return !!tab && !tab.toolKind && !tab.lazySource && READING_KINDS.has(tab.kind);
}

/** 指定文档当前是否处于沉浸阅读（只作用于活动文档，保活的后台实例不受影响） */
export function isDocumentReading(docKey: string): boolean {
  return useLayoutStore.getState().readingMode && useWindowStore.getState().activeKey === docKey;
}

/** 订阅版 isDocumentReading，供各编辑器组件切换阅读布局 */
export function useIsReading(docKey: string): boolean {
  const enabled = useLayoutStore((s) => s.readingMode);
  const isActive = useWindowStore((s) => s.activeKey === docKey);
  return enabled && isActive;
}

/** 焦点在可输入元素中时 Esc 归输入框（如查找栏），不退出阅读；穿透 Shadow DOM 取真实目标 */
function isTypingTarget(event: KeyboardEvent): boolean {
  const target = event.composedPath()[0] ?? event.target;
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || Boolean(target.closest('input, textarea, select'));
}

/** 阅读期间按 Esc 退出：让弹窗与输入框优先处理自己的 Esc */
export function useReadingEscape(enabled: boolean, onExit: () => void = () => requestReadingMode(false)): void {
  useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isTypingTarget(event)) return;
      if (document.querySelector('[role="dialog"], [aria-modal="true"]')) return;
      event.preventDefault();
      onExit();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled, onExit]);
}
