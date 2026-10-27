// NoteBoard 沉浸阅读模式控制（各格式共用）
// 只切换窗口临时布局状态与原生全屏，不触碰文档内容与撤销历史
// 外壳隐藏逻辑见 AppShell，退出胶囊与 Esc 处理见 ReadingModeOverlay，插件经 mount 上下文的 reading 接入

import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { IS_MOBILE_UI } from '../../core/platform';
import { useLayoutStore } from '../../stores/layoutStore';
import { useWindowStore, type Tab } from '../../stores/windowStore';
import { showToast } from '../../stores/toastStore';

/** 用户最新期望值：异步全屏请求排队执行，过期请求据此跳过 */
let desiredReadingMode = false;
/** 串行化原生窗口全屏请求，避免快速连点时较晚完成的旧请求覆盖最新状态 */
let fullscreenOperation: Promise<void> = Promise.resolve();

/** 进入或退出沉浸阅读：先更新布局（即时生效），再排队切换系统全屏 */
export function requestReadingMode(enabled: boolean): void {
  if (desiredReadingMode === enabled && useLayoutStore.getState().readingMode === enabled) return;
  // 沉浸阅读需要系统全屏，与极窄模式互斥
  if (enabled && useLayoutStore.getState().compactMode) {
    showToast('极窄模式下不支持沉浸阅读', 'info');
    return;
  }
  desiredReadingMode = enabled;
  useLayoutStore.getState().setReadingMode(enabled);

  fullscreenOperation = fullscreenOperation
    .catch(() => undefined)
    .then(async () => {
      if (desiredReadingMode !== enabled) return;
      try {
        // 移动端应用本身即全屏，只隐藏外壳 chrome（窗口全屏为桌面专属 API）
        if (!IS_MOBILE_UI) await getCurrentWindow().setFullscreen(enabled);
      } catch (error) {
        // 全屏失败不影响阅读排版，外壳隐藏仍然生效
        console.error(enabled ? '进入沉浸阅读全屏失败:' : '退出沉浸阅读全屏失败:', error);
      }
    });
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
