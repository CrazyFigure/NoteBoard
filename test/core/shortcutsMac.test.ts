// NoteBoard Mac 快捷键测试
// 验证 Mac 上的快捷键显示文本（Cmd / Option）与 Option 组合键的注册表匹配

import { afterEach, describe, expect, test, vi } from 'vitest';

// 模拟 Mac：主修饰键为 Command
vi.mock('@/core/platform', () => ({ USES_COMMAND_KEY: true }));

import { formatShortcut, initShortcuts, registerShortcut } from '@/core/shortcuts';

describe('formatShortcut（Mac）', () => {
  test('Ctrl 显示为 Cmd，Alt 显示为 Option', () => {
    expect(formatShortcut('Ctrl + S')).toBe('Cmd + S');
    expect(formatShortcut('Shift + Alt + F / Ctrl + Alt + L')).toBe('Shift + Option + F / Cmd + Option + L');
    expect(formatShortcut('有未保存的修改，点击或按 Ctrl+S 保存')).toBe('有未保存的修改，点击或按 Cmd+S 保存');
  });

  test('重做显示为 Cmd + Shift + Z', () => {
    expect(formatShortcut('Ctrl + Y')).toBe('Cmd + Shift + Z');
    expect(formatShortcut('Ctrl+Y')).toBe('Cmd+Shift+Z');
  });

  test('无修饰键的文本保持不变', () => {
    expect(formatShortcut('Shift + Tab')).toBe('Shift + Tab');
    expect(formatShortcut('Esc')).toBe('Esc');
  });
});

describe('快捷键注册表（Mac）', () => {
  let dispose: (() => void) | null = null;
  afterEach(() => {
    dispose?.();
    dispose = null;
  });

  test('Option + 字母按物理键位匹配（e.key 为特殊字符）', () => {
    dispose = initShortcuts();
    const action = vi.fn();
    const unregister = registerShortcut({ key: 'Shift+Alt+F', action, scope: 'global', description: '测试' });
    // Mac 上 Shift + Option + F 输入的字符为 Ï
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Ï', code: 'KeyF', shiftKey: true, altKey: true }));
    expect(action).toHaveBeenCalledTimes(1);
    unregister();
  });

  test('Cmd 映射为注册表中的 Ctrl', () => {
    dispose = initShortcuts();
    const action = vi.fn();
    const unregister = registerShortcut({ key: 'Ctrl+Alt+L', action, scope: 'global', description: '测试' });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '¬', code: 'KeyL', metaKey: true, altKey: true }));
    expect(action).toHaveBeenCalledTimes(1);
    unregister();
  });
});
