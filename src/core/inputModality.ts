// NoteBoard 输入方式追踪
// 触屏点击会在 touch 事件之后补发一组兼容鼠标事件（mouseover/mouseenter → mousedown → click）。
// 依赖 hover 展开的菜单若同时响应 mouseenter 与 click，会出现"刚展开就被点击收起"的问题。
// 这里在捕获阶段记录最近一次指针类型，供 hover 逻辑判断是否应忽略兼容鼠标事件。

let lastPointerType: string = 'mouse';
let installed = false;

/** 安装全局指针类型监听（幂等） */
export function installInputModalityTracking(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const record = (event: PointerEvent) => {
    lastPointerType = event.pointerType || 'mouse';
  };
  // pointerover 先于触屏兼容鼠标事件触发，pointerdown 覆盖无悬停阶段的输入设备
  window.addEventListener('pointerover', record, { capture: true, passive: true });
  window.addEventListener('pointerdown', record, { capture: true, passive: true });
}

/** 最近一次交互是否来自触屏/触控笔（此时应忽略由其补发的 mouseenter/mouseleave） */
export function isTouchInteraction(): boolean {
  return lastPointerType === 'touch' || lastPointerType === 'pen';
}
