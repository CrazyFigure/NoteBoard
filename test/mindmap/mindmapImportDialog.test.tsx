// 真实弹窗的键盘选择与取消必须结算 Promise 并卸载，不能遗留快捷键监听或误选画布。
import { act } from 'react';
import { expect, it } from 'vitest';
import { confirmMindmapImport, requestMindmapChoice } from '@/features/mindmap/MindmapImportDialog';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('聚焦第二张画布后按 Enter 导入该画布，并清除弹窗', async () => {
  let result!: Promise<string | null>;
  await act(async () => {
    result = requestMindmapChoice('选择画布', [{ value: 'a', label: '第一张' }, { value: 'b', label: '第二张' }], '导入');
    await Promise.resolve();
  });
  const second = document.querySelectorAll<HTMLButtonElement>('[role="option"]')[1];
  act(() => second.focus());
  expect(second.getAttribute('aria-selected')).toBe('true');
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(await result).toBe('b');
  });
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
});

it('兼容性提示按 Esc 取消，后续弹窗仍能正常打开并取消', async () => {
  let result!: Promise<boolean>;
  await act(async () => {
    result = confirmMindmapImport(['关联线无法转换']);
    await Promise.resolve();
  });
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(await result).toBe(false);
  });
  let next!: Promise<string | null>;
  await act(async () => {
    next = requestMindmapChoice('导出范围', [{ value: 'all', label: '全部展开' }], '导出');
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector<HTMLButtonElement>('.nb-editor-toolbar-btn')!.click();
    expect(await next).toBeNull();
  });
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
});
