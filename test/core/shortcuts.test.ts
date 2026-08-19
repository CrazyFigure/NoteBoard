// NoteBoard 快捷键与浏览器拦截测试

import { describe, test, expect } from 'vitest';
import { shouldPreventBrowserDefault } from '@/core/shortcuts';

describe('shortcuts 浏览器默认快捷键拦截', () => {
  // 辅助构造 KeyboardEvent
  function makeKey(
    key: string,
    modifiers: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean } = {},
    target?: HTMLElement,
  ): KeyboardEvent {
    return {
      key,
      ctrlKey: Boolean(modifiers.ctrlKey),
      shiftKey: Boolean(modifiers.shiftKey),
      altKey: Boolean(modifiers.altKey),
      metaKey: Boolean(modifiers.metaKey),
      target: target ?? document.body,
    } as unknown as KeyboardEvent;
  }

  test('正确拦截页面刷新类快捷键: F5, Ctrl+R, Ctrl+Shift+R', () => {
    expect(shouldPreventBrowserDefault(makeKey('F5'))).toBe(true);
    expect(shouldPreventBrowserDefault(makeKey('r', { ctrlKey: true }))).toBe(true);
    expect(shouldPreventBrowserDefault(makeKey('R', { ctrlKey: true }))).toBe(true);
    expect(shouldPreventBrowserDefault(makeKey('r', { ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  test('正确拦截开发者工具与源码: F12, Ctrl+U, Ctrl+Shift+I/J/C', () => {
    expect(shouldPreventBrowserDefault(makeKey('F12'))).toBe(true);
    expect(shouldPreventBrowserDefault(makeKey('u', { ctrlKey: true }))).toBe(true);
    expect(shouldPreventBrowserDefault(makeKey('I', { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(shouldPreventBrowserDefault(makeKey('J', { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(shouldPreventBrowserDefault(makeKey('C', { ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  test('正确拦截浏览器自带搜索: Ctrl+F, F3, Shift+F3, Ctrl+G', () => {
    expect(shouldPreventBrowserDefault(makeKey('f', { ctrlKey: true }))).toBe(true);
    expect(shouldPreventBrowserDefault(makeKey('F', { ctrlKey: true }))).toBe(true);
    expect(shouldPreventBrowserDefault(makeKey('F3'))).toBe(true);
    expect(shouldPreventBrowserDefault(makeKey('F3', { shiftKey: true }))).toBe(true);
    expect(shouldPreventBrowserDefault(makeKey('g', { ctrlKey: true }))).toBe(true);
  });

  test('正确拦截浏览器其他外壳功能: Ctrl+P, Ctrl+H, Ctrl+J, Ctrl+D, Ctrl+T, Ctrl+W, Ctrl+S, Ctrl+O, F7', () => {
    expect(shouldPreventBrowserDefault(makeKey('p', { ctrlKey: true }))).toBe(true);
    expect(shouldPreventBrowserDefault(makeKey('h', { ctrlKey: true }))).toBe(true);
    expect(shouldPreventBrowserDefault(makeKey('j', { ctrlKey: true }))).toBe(true);
    expect(shouldPreventBrowserDefault(makeKey('d', { ctrlKey: true }))).toBe(true);
    expect(shouldPreventBrowserDefault(makeKey('t', { ctrlKey: true }))).toBe(true);
    expect(shouldPreventBrowserDefault(makeKey('w', { ctrlKey: true }))).toBe(true);
    expect(shouldPreventBrowserDefault(makeKey('s', { ctrlKey: true }))).toBe(true);
    expect(shouldPreventBrowserDefault(makeKey('o', { ctrlKey: true }))).toBe(true);
    expect(shouldPreventBrowserDefault(makeKey('F7'))).toBe(true);
  });

  test('正确拦截 Alt+方向键导航', () => {
    expect(shouldPreventBrowserDefault(makeKey('ArrowLeft', { altKey: true }))).toBe(true);
    expect(shouldPreventBrowserDefault(makeKey('ArrowRight', { altKey: true }))).toBe(true);
  });

  test('非输入区域的 Backspace 拦截，输入区域内的 Backspace 允许', () => {
    // 非输入区域
    expect(shouldPreventBrowserDefault(makeKey('Backspace'))).toBe(true);

    // input 元素
    const inputEl = document.createElement('input');
    expect(shouldPreventBrowserDefault(makeKey('Backspace', {}, inputEl))).toBe(false);

    // textarea 元素
    const textareaEl = document.createElement('textarea');
    expect(shouldPreventBrowserDefault(makeKey('Backspace', {}, textareaEl))).toBe(false);
  });

  test('常规编辑快捷键放行不拦截: Ctrl+C, Ctrl+V, Ctrl+X, Ctrl+A, Ctrl+Z, Ctrl+Y', () => {
    expect(shouldPreventBrowserDefault(makeKey('c', { ctrlKey: true }))).toBe(false);
    expect(shouldPreventBrowserDefault(makeKey('v', { ctrlKey: true }))).toBe(false);
    expect(shouldPreventBrowserDefault(makeKey('x', { ctrlKey: true }))).toBe(false);
    expect(shouldPreventBrowserDefault(makeKey('a', { ctrlKey: true }))).toBe(false);
    expect(shouldPreventBrowserDefault(makeKey('z', { ctrlKey: true }))).toBe(false);
    expect(shouldPreventBrowserDefault(makeKey('y', { ctrlKey: true }))).toBe(false);
  });
});
