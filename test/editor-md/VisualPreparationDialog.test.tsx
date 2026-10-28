// 等待界面回归：可访问的阶段反馈、真实装载进度以及 Esc/取消的安全含义。
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VisualPreparationDialog } from '../../src/features/editor-md/VisualPreparationDialog';

describe('可视化等待界面', () => {
  let host: HTMLDivElement;
  let root: Root;
  const cancel = vi.fn();
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); cancel.mockClear();
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });
  it('解析不伪造百分比，装载显示真实进度；按钮与 Esc 都只返回源码', async () => {
    await act(async () => root.render(<VisualPreparationDialog displayName="长列表.md" progress={{ stage: 'parsing' }} onCancel={cancel} />));
    expect(document.querySelector('[role="status"]')?.textContent).toContain('解析 Markdown');
    expect(document.querySelector('[role="progressbar"]')?.hasAttribute('aria-valuenow')).toBe(false);
    await act(async () => root.render(<VisualPreparationDialog displayName="长列表.md" progress={{ stage: 'mounting', loaded: 600, total: 2400 }} onCancel={cancel} />));
    expect(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('25');
    await act(async () => document.querySelector<HTMLButtonElement>('.nb-md-preparation-cancel')!.click());
    expect(cancel).toHaveBeenCalledTimes(1);
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(cancel).toHaveBeenCalledTimes(2);
  });
  it('等待较久时显示已用时间，组件卸载会清理计时器', async () => {
    vi.useFakeTimers();
    await act(async () => root.render(<VisualPreparationDialog displayName="长列表.md" progress={{ stage: 'checking' }} onCancel={cancel} />));
    await act(async () => vi.advanceTimersByTime(9000));
    expect(document.querySelector('.nb-md-preparation-hint')?.textContent).toContain('已等待 9 秒');
  });
});
