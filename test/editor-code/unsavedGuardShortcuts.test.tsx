// NoteBoard 关闭拦截对话框快捷键测试
// Esc 取消、N 不保存、S 暂存、Enter 保存；按键不再传给下层编辑器。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../src/components/Tooltip';
import { UnsavedGuardDialog } from '../../src/features/editor-code/UnsavedGuardDialog';
import type { Tab } from '../../src/stores/windowStore';

const dirtyTab = { key: 'a', displayName: 'a.md', isDirty: true } as Tab;

// jsdom 不提供布局观察，空实现足以支持 Tooltip 内容挂载与卸载。
class ResizeObserverStub {
  observe() { /* 测试不依赖布局尺寸。 */ }
  unobserve() { /* 测试不依赖布局尺寸。 */ }
  disconnect() { /* 无实际观察资源需要释放。 */ }
}

describe('关闭拦截对话框快捷键', () => {
  let host: HTMLDivElement;
  let root: Root;
  const handlers = {
    onSave: vi.fn(async () => undefined),
    onStash: vi.fn(async () => undefined),
    onDiscard: vi.fn(),
    onCancel: vi.fn(),
  };

  // 模拟在下层编辑器聚焦时按键
  function press(key: string, init: KeyboardEventInit = {}) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    act(() => {
      document.body.dispatchEvent(event);
    });
    return event;
  }

  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    Object.values(handlers).forEach((fn) => fn.mockClear());
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        <TooltipProvider>
          <UnsavedGuardDialog visible dirtyTabs={[dirtyTab]} {...handlers} />
        </TooltipProvider>,
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('四个按键分别触发对应操作', async () => {
    press('Escape');
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
    press('N');
    expect(handlers.onDiscard).toHaveBeenCalledWith(['a']);
    await act(async () => {
      press('s');
    });
    expect(handlers.onStash).toHaveBeenCalledWith(['a']);
    await act(async () => {
      press('Enter');
    });
    expect(handlers.onSave).toHaveBeenCalledWith(['a']);
  });

  it('按键不再冒泡给编辑器，组合键与长按重复不触发', () => {
    const editorListener = vi.fn();
    document.addEventListener('keydown', editorListener);
    const event = press('n');
    expect(event.defaultPrevented).toBe(true);
    expect(editorListener).not.toHaveBeenCalled();
    handlers.onDiscard.mockClear();
    press('s', { ctrlKey: true });
    press('n', { repeat: true });
    expect(handlers.onStash).not.toHaveBeenCalled();
    expect(handlers.onDiscard).not.toHaveBeenCalled();
    document.removeEventListener('keydown', editorListener);
  });

  it('焦点在其他按钮上时 Enter 仍然保存', async () => {
    const discardButton = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === '不保存')!;
    // 聚焦会打开按钮 Tooltip，需包在 act 中
    act(() => discardButton.focus());
    await act(async () => {
      press('Enter');
    });
    expect(handlers.onSave).toHaveBeenCalledWith(['a']);
    expect(handlers.onDiscard).not.toHaveBeenCalled();
  });
});
