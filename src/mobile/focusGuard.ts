// NoteBoard 移动端自动聚焦守卫
// 手机上任何对输入框/可编辑区域的程序化 focus() 都会弹出软键盘，挤占大量可视空间。
// 打开/新建文档、多维表格选中单元格（剪贴板代理输入框）、展开记录详情等场景都会自动聚焦。
// 规则：程序化聚焦只在"用户意图明确"时放行，其余一律忽略（用户直接点按输入区域时浏览器原生聚焦不受影响）：
// 1. 目标位于对话框、搜索栏或显式标记 [data-nb-allow-autofocus] 的区域（如重命名、查找，用户就是要输入）；
// 2. 用户刚刚（1.2 秒内）点按的位置就在目标所属的聚焦范围内（如点按正文后编辑器内部再次聚焦、双击单元格进入编辑）；
// 3. 目标在 1.5 秒内刚失去焦点（输入过程中点工具栏按钮后编辑器取回焦点，保持键盘不收起）。

const TAP_WINDOW_MS = 1200;
const REFOCUS_WINDOW_MS = 1500;

// 聚焦范围：点按发生在范围内即视为该范围内的编辑意图
const FOCUS_SCOPE_SELECTOR = '[data-nb-focus-scope], .ProseMirror, .cm-editor, .excalidraw';
// 用户期望输入的区域：对话框、查找栏、显式放行标记
const ALLOW_SELECTOR = '[data-nb-allow-autofocus], [role="dialog"], [role="search"], .nb-m-dialog';
// 文本类 input（按钮、复选框等聚焦不会弹出键盘，无需拦截）
const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'number', 'password', 'tel', 'url']);

let lastTapTarget: Element | null = null;
let lastTapAt = 0;
let lastBlurTarget: Element | null = null;
let lastBlurAt = 0;
let installed = false;

/** 是否会弹出软键盘的可编辑元素 */
function isKeyboardTarget(element: HTMLElement): boolean {
  if (element.isContentEditable) return true;
  if (element instanceof HTMLTextAreaElement) return !element.readOnly;
  if (element instanceof HTMLInputElement) {
    return !element.readOnly && TEXT_INPUT_TYPES.has(element.type);
  }
  return false;
}

/** 判断一次程序化聚焦是否放行 */
function shouldAllowFocus(element: HTMLElement): boolean {
  if (!isKeyboardTarget(element)) return true;
  if (element.closest(ALLOW_SELECTOR)) return true;
  const now = Date.now();
  // 已经处于聚焦状态（例如键盘已打开时的再次聚焦）不改变现状
  if (document.activeElement === element) return true;
  if (lastBlurTarget && now - lastBlurAt < REFOCUS_WINDOW_MS) {
    const scope = element.closest(FOCUS_SCOPE_SELECTOR) ?? element;
    if (scope === lastBlurTarget || scope.contains(lastBlurTarget)) return true;
  }
  if (lastTapTarget && now - lastTapAt < TAP_WINDOW_MS) {
    const scope = element.closest(FOCUS_SCOPE_SELECTOR) ?? element;
    if (scope.contains(lastTapTarget)) return true;
  }
  return false;
}

/** 安装守卫（仅移动端调用；幂等） */
export function installMobileFocusGuard(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener(
    'pointerdown',
    (event) => {
      lastTapTarget = event.target instanceof Element ? event.target : null;
      lastTapAt = Date.now();
    },
    { capture: true, passive: true },
  );
  window.addEventListener(
    'focusout',
    (event) => {
      if (event.target instanceof HTMLElement && isKeyboardTarget(event.target)) {
        lastBlurTarget = event.target;
        lastBlurAt = Date.now();
      }
    },
    { capture: true },
  );

  const originalFocus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function guardedFocus(this: HTMLElement, options?: FocusOptions) {
    if (!shouldAllowFocus(this)) return;
    originalFocus.call(this, options);
  };
}
