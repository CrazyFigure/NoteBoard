// 原生落点与 DOM 标签几何分离：不同窗口必须使用各自的 DPI 和可见标签位置。

/** 标签中线决定插入锚点；拖到正文区域时追加，不误命中被横向滚出视口的标签。 */
export function tabInsertionAnchor(x: number, y: number, excludeKey?: string): string | null {
  const bar = document.querySelector<HTMLElement>('[role="tablist"]');
  if (!bar) return null;
  const bounds = bar.getBoundingClientRect();
  if (y < bounds.top || y > bounds.bottom) return null;
  for (const element of bar.querySelectorAll<HTMLElement>('[data-tab-key]')) {
    const rect = element.getBoundingClientRect();
    if (element.dataset.tabKey !== excludeKey && rect.right > bounds.left
      && rect.left < bounds.right && x < (rect.left + rect.right) / 2) return element.dataset.tabKey ?? null;
  }
  return null;
}

/** 原生物理像素按目标窗口当前缩放换回 CSS 坐标。 */
export function nativeTabInsertionAnchor(point: { x: number; y: number }, excludeKey?: string): string | null {
  return tabInsertionAnchor(point.x / window.devicePixelRatio, point.y / window.devicePixelRatio, excludeKey);
}
