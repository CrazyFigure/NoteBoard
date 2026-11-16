// 多行文本弹层回归：保存草稿的全局快捷键只属于当前活动表格。
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BitableLongTextPopover } from '@/features/bitable/BitableLongTextPopover';
import { EditorActivityContext } from '@/core/editor/EditorActivityContext';

vi.mock('@/components/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

let root: Root;
let host: HTMLDivElement;
const onCommit = vi.fn(), onClose = vi.fn();

/** 保留同一个弹层实例，只切换其所属文档的活动状态。 */
async function render(active: boolean): Promise<void> {
  await act(async () => {
    root.render(<EditorActivityContext.Provider value={active}>
      <BitableLongTextPopover column={{ id: 'note', key: 'note', name: '备注', type: 'longText' }}
        value="原草稿" config={{ displayMode: 'full', markdown: false }} onCommit={onCommit} onClose={onClose} />
    </EditorActivityContext.Provider>);
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await render(true);
  // 使用原生 setter 绕过 React 值跟踪器，按真实 input 事件写入未提交草稿。
  const input = document.querySelector('textarea')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(input, '未提交的新草稿'); input.dispatchEvent(new Event('input', { bubbles: true })); });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.unstubAllGlobals();
});

it.each([{ ctrlKey: true }, { metaKey: true }])('后台不保存草稿，返回前台后原草稿仍可正常保存：%j', async (modifier) => {
  await render(false);
  const backgroundEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...modifier });
  await act(async () => { document.body.dispatchEvent(backgroundEvent); });
  expect(backgroundEvent.defaultPrevented).toBe(false);
  expect(onCommit).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  await render(true);
  await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...modifier })); });
  expect(onCommit).toHaveBeenCalledExactlyOnceWith('未提交的新草稿');
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('其它文件的 Escape 不关闭后台弹层', async () => {
  await render(false);
  await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  expect(onClose).not.toHaveBeenCalled();
});
