// 规范化弹窗决策回归：取消与会话记忆独立，源码 / 规范化仍保留原有选择语义。
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownNormalizeDialog } from '../../src/features/editor-md/MarkdownNormalizeDialog';

vi.mock('../../src/features/editor-md/markdownNormalization', async (original) => ({
  ...await original<typeof import('../../src/features/editor-md/markdownNormalization')>(),
  computeNormalizationDiff: async () => ({ hunks: [], categories: [] }),
}));

describe('Markdown 规范化弹窗', () => {
  let root: Root;
  let host: HTMLDivElement;
  const onChoose = vi.fn();

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    onChoose.mockClear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<MarkdownNormalizeDialog displayName="测试.md" original="* a" normalized="- a" onChoose={onChoose} />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('取消位于操作区首位，勾选记忆后仍只取消本次打开', async () => {
    const actions = host.querySelectorAll<HTMLButtonElement>('.nb-md-normalize-actions button');
    expect(Array.from(actions, (button) => button.textContent?.trim())).toEqual(['取消', '保持源码模式', '规范化并进入可视化']);
    await act(async () => host.querySelector<HTMLInputElement>('input')!.click());
    await act(async () => actions[0].click());
    expect(onChoose).toHaveBeenCalledExactlyOnceWith('cancel', false);
  });

  it.each([
    ['保持源码模式', 'source', 1],
    ['规范化并进入可视化', 'normalize', 2],
  ])('%s 继续传递会话记忆选择', async (_name, choice, index) => {
    await act(async () => host.querySelector<HTMLInputElement>('input')!.click());
    await act(async () => host.querySelectorAll<HTMLButtonElement>('.nb-md-normalize-actions button')[index].click());
    expect(onChoose).toHaveBeenCalledExactlyOnceWith(choice, true);
  });

  it('Esc 等同取消，并阻止同一按键继续触发宿主快捷键', async () => {
    const key = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await act(async () => window.dispatchEvent(key));
    expect(key.defaultPrevented).toBe(true);
    expect(onChoose).toHaveBeenCalledExactlyOnceWith('cancel', false);
  });
});
