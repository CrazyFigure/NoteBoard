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

  it('内容风险明确提示且不能记住跳过，仍允许手动确认', async () => {
    // 即便同一组件此前勾选过记忆，风险确认也必须强制传递 false。
    await act(async () => host.querySelector<HTMLInputElement>('input')!.click());
    await act(async () => root.render(<MarkdownNormalizeDialog displayName="测试.md" original="**甲**和**乙**" normalized="**甲和乙**" mayChangeContent onChoose={onChoose} />));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('格式范围');
    expect(host.querySelector('h2')?.textContent).toContain('可能改变内容或格式');
    expect(host.querySelector('input')).toBeNull();
    const confirm = host.querySelectorAll<HTMLButtonElement>('.nb-md-normalize-actions button')[2];
    expect(confirm.textContent).toContain('确认差异并进入可视化');
    await act(async () => confirm.click());
    expect(onChoose).toHaveBeenCalledExactlyOnceWith('normalize', false);
  });

  it('复用后台差异，并对覆盖整篇长列表的单个差异限制预览', async () => {
    const text = '* 长列表项\n'.repeat(10_000);
    const preparedDiff = { hunks: [{ before: text, after: text.replaceAll('*', '-'), line: 1, category: 'list-marker' as const }], categories: [{ category: 'list-marker' as const, count: 1 }] };
    await act(async () => root.render(<MarkdownNormalizeDialog displayName="长列表.md" original={text} normalized={text.replaceAll('*', '-')} preparedDiff={preparedDiff} onChoose={onChoose} />));
    await act(async () => host.querySelector<HTMLButtonElement>('.nb-md-normalize-toggle')!.click());
    expect(host.querySelector('.nb-md-normalize-before')!.textContent!.length).toBeLessThanOrEqual(8_000);
    expect(host.textContent).toContain('预览各展示前 8,000 字符');
  });
});
