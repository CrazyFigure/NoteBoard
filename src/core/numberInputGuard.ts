// NoteBoard 数字输入框滚轮防误改
// 浏览器中聚焦的 number 输入框会响应滚轮直接加减数值，滚动页面时极易误改设置。
// 与多维表格单元格的既有做法一致：滚轮经过已聚焦的数字输入框时让其失焦，
// 失焦后滚轮回归正常的页面滚动（被动监听，不阻止滚动、不影响性能）。

let installed = false;

/** 安装全局滚轮防误改（幂等） */
export function installNumberInputWheelGuard(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener(
    'wheel',
    (event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement && target.type === 'number' && document.activeElement === target) {
        target.blur();
      }
    },
    { capture: true, passive: true },
  );
}
