// 统一保护应用内链接导航，同时让导出下载走各平台实际支持的保存流程。
// 画板使用的 browser-fs-access 会点击未挂到 DOM 的下载链接，因此原生端还需接管程序化 click。
import { isTauri } from '@tauri-apps/api/core';
import { showToast } from '../stores/toastStore';
import { dataUrlToBlob } from './dataUrl';

/** 仅接管应用生成的 Blob / data 下载，不把普通文档链接或外部网址当成导出。 */
function isGeneratedDownload(anchor: HTMLAnchorElement): boolean {
  return anchor.hasAttribute('download') && /^(blob:|data:)/i.test(anchor.href);
}

/** 立即读取下载源，防止调用方在 click 返回后撤销 Blob URL；保存与错误处理保持异步。 */
async function saveGeneratedDownload(anchor: HTMLAnchorElement): Promise<void> {
  const filename = anchor.download || '未命名';
  try {
    let blob: Blob;
    if (/^data:/i.test(anchor.href)) {
      // data: 未列入原生 connect-src，直接解码，不依赖 fetch 或额外网络权限。
      blob = dataUrlToBlob(anchor.href);
    } else {
      const response = await fetch(anchor.href);
      if (!response.ok) throw new Error('无法读取导出文件');
      blob = await response.blob();
    }
    // 首次导出才装载保存模块，不增加应用首屏依赖。
    const { exportBlobWithDialog } = await import('../features/export/chartExport');
    const extension = /\.([a-z0-9]+)$/i.exec(filename)?.[1].toLowerCase();
    await exportBlobWithDialog(blob, filename, [
      { name: '导出文件', extensions: [extension || '*'] },
    ]);
  } catch (error) {
    showToast(`导出失败：${error instanceof Error ? error.message : String(error)}`, 'error');
  }
}

/** 安装导航保护和原生下载桥；卸载时恢复监听器及原来的 click 实现。 */
export function installAnchorNavigationGuard(): () => void {
  // 同一次事件可能先经过窗口捕获，再到达链接本身；只允许导出一次。
  const handled = new WeakSet<Event>();
  const handleClick = (event: MouseEvent, explicitAnchor?: HTMLAnchorElement) => {
    const target = event.target instanceof Element ? event.target : null;
    const anchor = explicitAnchor ?? target?.closest('a');
    if (!anchor) return;

    const download = event.type === 'click' && event.button === 0
      && anchor instanceof HTMLAnchorElement && isGeneratedDownload(anchor);
    // 浏览器下载必须保留默认行为；原来的全局 preventDefault 会让导出静默失效。
    if (download && !isTauri()) return;
    event.preventDefault();
    if (download && !handled.has(event)) {
      handled.add(event);
      void saveGeneratedDownload(anchor);
    }
  };
  const onClick = (event: MouseEvent) => handleClick(event);
  window.addEventListener('click', onClick, true);
  window.addEventListener('auxclick', onClick, true);

  const prototype = HTMLAnchorElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'click');
  const originalClick = prototype.click;
  const nativeClick = function (this: HTMLAnchorElement): void {
    if (!isGeneratedDownload(this)) return originalClick.call(this);
    // 不跳过原 click：第三方依赖其事件来释放 URL 等资源，脱离 DOM 的链接也需执行这些回调。
    const onDownload = (event: MouseEvent) => handleClick(event, this);
    this.addEventListener('click', onDownload, { capture: true, once: true });
    try {
      originalClick.call(this);
    } finally {
      this.removeEventListener('click', onDownload, true);
    }
  };
  // 只在真实原生环境补齐脱离 DOM 的下载，网页继续使用浏览器自身能力。
  if (isTauri()) prototype.click = nativeClick;

  return () => {
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('auxclick', onClick, true);
    if (prototype.click === nativeClick) {
      if (descriptor) Object.defineProperty(prototype, 'click', descriptor);
      else Reflect.deleteProperty(prototype, 'click');
    }
  };
}
