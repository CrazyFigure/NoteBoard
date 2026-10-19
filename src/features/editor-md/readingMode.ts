// NoteBoard Markdown 沉浸阅读模式控制
// 只切换窗口临时布局状态与原生全屏，不触碰文档内容与撤销历史
// 外壳隐藏逻辑见 AppShell，阅读排版与退出按钮见 ReadingModeOverlay

import { getCurrentWindow } from '@tauri-apps/api/window';
import { IS_MOBILE_UI } from '../../core/platform';
import { useLayoutStore } from '../../stores/layoutStore';

/** 用户最新期望值：异步全屏请求排队执行，过期请求据此跳过 */
let desiredReadingMode = false;
/** 串行化原生窗口全屏请求，避免快速连点时较晚完成的旧请求覆盖最新状态 */
let fullscreenOperation: Promise<void> = Promise.resolve();

/** 进入或退出沉浸阅读：先更新布局（即时生效），再排队切换系统全屏 */
export function requestMarkdownReadingMode(enabled: boolean): void {
  if (desiredReadingMode === enabled && useLayoutStore.getState().markdownReadingMode === enabled) return;
  desiredReadingMode = enabled;
  useLayoutStore.getState().setMarkdownReadingMode(enabled);

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
