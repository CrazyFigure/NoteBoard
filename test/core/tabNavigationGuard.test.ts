// 全局 Tab 守卫只取消浏览器遍历，不抢占编辑器和画布的业务快捷键。
import { afterEach, describe, expect, it } from 'vitest';
import { installTabNavigationGuard } from '../../src/core/tabNavigationGuard';

installTabNavigationGuard();
afterEach(() => { document.body.replaceChildren(); });

/** 向指定控件派发可取消的 Tab 事件。 */
function tab(target: HTMLElement, modifiers: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true, ...modifiers });
  target.dispatchEvent(event);
  return event;
}

describe('全应用取消浏览器式 Tab 遍历', () => {
  it.each(['button', 'input', 'textarea', 'select', 'a', 'div'])('%s 的正反向 Tab 均取消默认遍历', (tag) => {
    const element = document.createElement(tag);
    document.body.append(element);
    expect(tab(element).defaultPrevented).toBe(true);
    expect(tab(element, { shiftKey: true }).defaultPrevented).toBe(true);
  });

  it('先让 ProseMirror / CodeMirror 处理按键，再取消任何剩余默认动作', () => {
    for (const className of ['ProseMirror', 'cm-content']) {
      const element = document.createElement('div');
      element.className = className;
      document.body.append(element);
      let alreadyCancelled: boolean | undefined;
      element.addEventListener('keydown', (event) => { alreadyCancelled = event.defaultPrevented; });
      expect(tab(element).defaultPrevented).toBe(true);
      expect(alreadyCancelled).toBe(false);
    }
  });

  it('画布的窗口级 Tab 业务快捷键仍能收到未消费的按键', () => {
    let handled = false;
    const handler = (event: KeyboardEvent) => { if (!event.defaultPrevented) handled = true; };
    window.addEventListener('keydown', handler);
    try {
      expect(tab(document.body).defaultPrevented).toBe(true);
      expect(handled).toBe(true);
    } finally { window.removeEventListener('keydown', handler); }
  });

  it('保留带 Ctrl / Cmd / Alt 的系统组合键', () => {
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      expect(tab(document.body, modifiers).defaultPrevented).toBe(false);
    }
  });
});
