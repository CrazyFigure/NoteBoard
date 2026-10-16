// 验证非安全上下文的网页文本复制，以及复制后编辑器焦点与选区保护。
import { afterEach, expect, it, vi } from 'vitest';
import { installWebClipboardFallback } from '../../src/web/clipboard';

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const originalCopy = Object.getOwnPropertyDescriptor(document, 'execCommand');
afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
  if (originalCopy) Object.defineProperty(document, 'execCommand', originalCopy);
  else Reflect.deleteProperty(document, 'execCommand');
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it('已有 Clipboard API 时保留浏览器实现', () => {
  const clipboard = { writeText: vi.fn() };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
  installWebClipboardFallback();
  expect(navigator.clipboard).toBe(clipboard);
});

it('HTTP 回退复制中文，随后恢复焦点与选区并清理临时输入框', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  const input = document.createElement('button'); input.textContent = '原编辑位置'; document.body.append(input); input.focus();
  const range = document.createRange(); range.selectNodeContents(input);
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  const copy = vi.fn(() => {
    expect(document.querySelector('textarea')?.value).toBe('中文路径 /workspace/笔记.md');
    return true;
  });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: copy });
  installWebClipboardFallback();
  await navigator.clipboard.writeText('中文路径 /workspace/笔记.md');
  expect(copy).toHaveBeenCalledWith('copy');
  expect(document.activeElement).toBe(input);
  expect(window.getSelection()?.toString()).toBe('原编辑位置');
  expect(document.querySelector('textarea')).toBeNull();
});
