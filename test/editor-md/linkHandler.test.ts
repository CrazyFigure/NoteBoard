// NoteBoard Markdown 链接路径解析单元测试

import { beforeEach, describe, it, expect, vi } from 'vitest';
import * as ipc from '../../src/core/ipc/commands';
import { useWindowStore } from '../../src/stores/windowStore';
import { handleRenderedHtmlLinkClick, resolveRelativeDocPath } from '../../src/features/editor-md/linkHandler';

vi.mock('../../src/core/ipc/commands', async (original) => ({
  ...await original<typeof import('../../src/core/ipc/commands')>(),
  openExternalUrl: vi.fn(async () => undefined),
}));

describe('Markdown 相对路径解析 (resolveRelativeDocPath)', () => {
  it('应正确解析同级相对路径', () => {
    const base = 'C:\\Projects\\NoteBoard\\docs';
    const rel = 'agent-modules/ology-module-report.md';
    const result = resolveRelativeDocPath(base, rel);
    expect(result).toBe('C:\\Projects\\NoteBoard\\docs\\agent-modules\\ology-module-report.md');
  });

  it('应正确处理带 ./ 前缀的相对路径', () => {
    const base = 'C:\\Projects\\NoteBoard\\docs';
    const rel = './img/photo.png';
    const result = resolveRelativeDocPath(base, rel);
    expect(result).toBe('C:\\Projects\\NoteBoard\\docs\\img\\photo.png');
  });

  it('应正确处理向上层级 ../ 相对路径', () => {
    const base = 'C:\\Projects\\NoteBoard\\docs\\sub';
    const rel = '../assets/logo.png';
    const result = resolveRelativeDocPath(base, rel);
    expect(result).toBe('C:\\Projects\\NoteBoard\\docs\\assets\\logo.png');
  });

  it('若本身已是 Windows 绝对路径，应保持原样', () => {
    const base = 'C:\\Projects\\NoteBoard\\docs';
    const abs = 'D:\\other\\file.md';
    const result = resolveRelativeDocPath(base, abs);
    expect(result).toBe('D:\\other\\file.md');
  });

  it('应正确去除 file:/// 前缀并解码 URL 编码字符', () => {
    const base = 'C:\\Projects\\NoteBoard';
    const rel = 'file:///docs/my%20test.md';
    const result = resolveRelativeDocPath(base, rel);
    expect(result).toBe('C:\\Projects\\NoteBoard\\docs\\my test.md');
  });
});


describe('HTML 块 / 行内 HTML 渲染内容中的链接 (handleRenderedHtmlLinkClick)', () => {
  /** 在渲染容器中构造链接并返回其中的文字节点所在元素 */
  function renderLink(href: string): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = `<a href="${href}" target="_blank"><span>链接文字</span></a><span>普通文字</span>`;
    return host.querySelector('a span') as HTMLElement;
  }

  function mouseEvent(target: EventTarget | null, init: Partial<{ button: number; ctrlKey: boolean; metaKey: boolean }> = {}) {
    return { target, button: 0, ctrlKey: false, metaKey: false, preventDefault: vi.fn(), ...init };
  }

  beforeEach(() => {
    vi.mocked(ipc.openExternalUrl).mockClear();
    useWindowStore.setState({ activeKey: 'doc-key' });
  });

  it('普通单击只拦截原生跳转，不打开', () => {
    const event = mouseEvent(renderLink('https://example.com/plain'));
    expect(handleRenderedHtmlLinkClick(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(ipc.openExternalUrl).not.toHaveBeenCalled();
  });

  it('Ctrl + 单击用系统默认浏览器打开外部链接', () => {
    const event = mouseEvent(renderLink('https://example.com/ctrl'), { ctrlKey: true });
    expect(handleRenderedHtmlLinkClick(event)).toBe(true);
    expect(ipc.openExternalUrl).toHaveBeenCalledWith('https://example.com/ctrl');
  });

  it('中键单击用系统默认浏览器打开外部链接', () => {
    const event = mouseEvent(renderLink('https://example.com/middle'), { button: 1 });
    expect(handleRenderedHtmlLinkClick(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(ipc.openExternalUrl).toHaveBeenCalledWith('https://example.com/middle');
  });

  it('右键不打开；点在链接外不处理', () => {
    expect(handleRenderedHtmlLinkClick(mouseEvent(renderLink('https://example.com/right'), { button: 2 }))).toBe(true);
    expect(ipc.openExternalUrl).not.toHaveBeenCalled();
    const plain = renderLink('https://example.com/x').closest('div')!.lastElementChild;
    const event = mouseEvent(plain, { ctrlKey: true });
    expect(handleRenderedHtmlLinkClick(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('Shadow DOM 内的链接：外层监听按事件路径识别（隔离渲染的 HTML 块）', () => {
    const container = document.createElement('div');
    const host = document.createElement('div');
    container.appendChild(host);
    document.body.appendChild(container);
    host.attachShadow({ mode: 'open' }).innerHTML = '<a href="https://example.com/shadow"><span>链接文字</span></a>';
    const listener = vi.fn((event: MouseEvent) => handleRenderedHtmlLinkClick(event));
    container.addEventListener('click', listener);
    const span = host.shadowRoot!.querySelector('span')!;
    span.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true, ctrlKey: true }));
    expect(listener).toHaveReturnedWith(true);
    expect(ipc.openExternalUrl).toHaveBeenCalledWith('https://example.com/shadow');
    container.remove();
  });
});
