// 普通 HTTP 部署没有 Clipboard API；仅为网页提供用户点击触发的文本复制回退。

/** 保留浏览器原生剪贴板权限模型；缺少 API 时借助选区复制，不支持主动读取剪贴板。 */
export function installWebClipboardFallback(): void {
  if (navigator.clipboard) return;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      /** 复制前保存焦点与选区，结束后恢复，防止复制文件路径破坏正在编辑的位置。 */
      writeText: async (text: string): Promise<void> => {
        const focused = document.activeElement as HTMLElement | null;
        const selection = window.getSelection();
        const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
        const input = document.createElement('textarea');
        input.value = text;
        input.tabIndex = -1;
        input.setAttribute('aria-hidden', 'true');
        input.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
        document.body.append(input);
        try {
          input.select();
          if (!document.execCommand('copy')) throw new Error('浏览器未允许复制，请使用键盘复制或通过 HTTPS 访问');
        } finally {
          input.remove();
          focused?.focus({ preventScroll: true });
          if (selection) {
            selection.removeAllRanges();
            for (const range of ranges) selection.addRange(range);
          }
        }
      },
    },
  });
}
