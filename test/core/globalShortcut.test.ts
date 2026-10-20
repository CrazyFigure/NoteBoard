// NoteBoard 全局唤起快捷键：键盘事件 → 加速键转换测试

import { describe, test, expect } from 'vitest';
import { formatAccelerator, keyEventToAccelerator, mainKeyFromCode } from '@/core/globalShortcut';

// 辅助构造按键事件（只需物理按键码与修饰键）
function makeKey(code: string, modifiers: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean } = {}) {
  return {
    code,
    ctrlKey: Boolean(modifiers.ctrlKey),
    shiftKey: Boolean(modifiers.shiftKey),
    altKey: Boolean(modifiers.altKey),
    metaKey: Boolean(modifiers.metaKey),
  };
}

describe('globalShortcut 加速键录制', () => {
  test('修饰键按固定顺序拼接，主键取物理按键', () => {
    expect(keyEventToAccelerator(makeKey('KeyN', { shiftKey: true, altKey: true, ctrlKey: true }))).toBe('Ctrl+Alt+Shift+N');
    expect(keyEventToAccelerator(makeKey('Digit1', { metaKey: true }))).toBe('Super+1');
    expect(keyEventToAccelerator(makeKey('Space', { altKey: true }))).toBe('Alt+Space');
  });

  test('只按修饰键或不支持的按键时继续等待', () => {
    expect(keyEventToAccelerator(makeKey('ControlLeft', { ctrlKey: true }))).toBeNull();
    expect(mainKeyFromCode('IntlBackslash')).toBeNull();
  });

  test('普通按键缺少 Ctrl / Alt / Super 时拒绝，功能键可单独使用', () => {
    expect(keyEventToAccelerator(makeKey('KeyA'))).toBe('needs-modifier');
    expect(keyEventToAccelerator(makeKey('KeyA', { shiftKey: true }))).toBe('needs-modifier');
    expect(keyEventToAccelerator(makeKey('F9'))).toBe('F9');
  });

  test('显示文本使用空格分隔并简化方向键名', () => {
    expect(formatAccelerator('Ctrl+Alt+ArrowUp')).toBe('Ctrl + Alt + Up');
  });
});
