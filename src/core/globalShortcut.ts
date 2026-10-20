// NoteBoard 全局唤起快捷键：键盘事件 ↔ 加速键字符串
// 加速键格式与 Rust 侧 global-hotkey 解析一致：修饰键按 Ctrl/Alt/Shift/Super 排序，主键在末尾（如 Ctrl+Alt+N）

import { USES_COMMAND_KEY } from './platform';

type KeyLike = Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>;

// global-hotkey 可识别、且不依赖键盘布局的物理按键名
const NAMED_KEYS = new Set([
  'Space', 'Enter', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Backquote', 'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash',
  'Semicolon', 'Quote', 'Comma', 'Period', 'Slash',
  'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide', 'NumpadDecimal', 'NumpadEnter',
]);

/** 物理按键码 → 加速键主键名；修饰键或不支持的按键返回 null */
export function mainKeyFromCode(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1];
  if (/^F([1-9]|1\d|2[0-4])$/.test(code) || /^Numpad\d$/.test(code) || NAMED_KEYS.has(code)) return code;
  return null;
}

/** 功能键可单独作为全局快捷键，其余按键必须带 Ctrl / Alt / Super，避免劫持普通输入 */
function isFunctionKey(key: string): boolean {
  return /^F\d+$/.test(key);
}

/**
 * 键盘事件转加速键。
 * 返回 null 表示仍在等待主键（只按了修饰键或按键不支持）；'needs-modifier' 表示缺少必要修饰键。
 */
export function keyEventToAccelerator(e: KeyLike): string | 'needs-modifier' | null {
  const key = mainKeyFromCode(e.code);
  if (!key) return null;
  if (!e.ctrlKey && !e.altKey && !e.metaKey && !isFunctionKey(key)) return 'needs-modifier';
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Super');
  parts.push(key);
  return parts.join('+');
}

/** 加速键显示文本：Super 在 Mac 显示为 Cmd，其余系统为 Win */
export function formatAccelerator(accelerator: string): string {
  return accelerator
    .split('+')
    .map((part) => {
      if (part === 'Super') return USES_COMMAND_KEY ? 'Cmd' : 'Win';
      if (part === 'Alt' && USES_COMMAND_KEY) return 'Option';
      return part.replace(/^Arrow/, '');
    })
    .join(' + ');
}
