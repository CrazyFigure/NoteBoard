// 全应用禁止浏览器式 Tab 焦点遍历；编辑器的缩进、表格导航和思维导图等业务快捷键仍正常分发。
let installed = false;

/** 安装一次全局守卫；桌面、网页和移动端外接键盘走同一入口。 */
export function installTabNavigationGuard(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('keydown', (event) => {
    // Ctrl/Cmd/Alt 组合保留给系统或应用快捷键，仅禁用 Tab / Shift+Tab 的控件遍历。
    if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    // 代码块工具栏等 contenteditable=false 区域仍属于普通控件，不能被编辑器外壳豁免。
    const textEditor = target?.closest('[contenteditable]')?.getAttribute('contenteditable') !== 'false'
      && target?.closest('.ProseMirror, .cm-content');
    // 普通控件提前取消默认行为，弹窗和菜单的焦点管理也能看到已取消标记。
    // 可编辑内容须先交给内核，否则 ProseMirror 会跳过已取消的按键。
    if (!textEditor && !target?.isContentEditable && target?.closest('input, textarea, button, select, a, [tabindex], [role="menuitem"], [role="tab"]')) {
      event.preventDefault();
    }
    // 捕获时追加本次事件的末尾监听：先让业务快捷键运行，再取消任何剩余的浏览器默认动作。
    // 这样不会让思维导图等通过 defaultPrevented 判断按键归属的功能失效。
    const preventTraversal = (current: KeyboardEvent) => {
      if (current === event) current.preventDefault();
    };
    window.addEventListener('keydown', preventTraversal);
    // 某些弹窗会停止事件传播；无论是否到达末尾都移除临时监听，避免累积。
    queueMicrotask(() => window.removeEventListener('keydown', preventTraversal));
  }, true);
}
