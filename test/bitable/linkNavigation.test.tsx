// 多维表格链接交互回归：真实点击组件，验证原生导航被拦截且复用全局链接路由。
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BitableCellEditor } from '../../src/features/bitable/BitableCellEditor';
import { BitableMarkdown } from '../../src/features/bitable/BitableMarkdown';
import * as ipc from '../../src/core/ipc/commands';
import { useDocumentStore } from '../../src/stores/documentStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../src/stores/settingsStore';
import { useWindowStore } from '../../src/stores/windowStore';

vi.mock('../../src/core/ipc/commands', () => ({
  openExternalUrl: vi.fn().mockResolvedValue(true),
  pathExists: vi.fn().mockResolvedValue({ exists: true, isDir: false }),
  openWithDefaultApp: vi.fn().mockResolvedValue(undefined),
  prepareDocument: vi.fn(),
  registerDocument: vi.fn().mockResolvedValue({ type: 'ok' }),
  readDir: vi.fn().mockResolvedValue([]),
  pushRecent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'nb-main' }) }));
// 测试路由和标签创建即可，不预加载 HTML 编辑器与布局观察器。
vi.mock('../../src/features/editor-host/editorLoaders', () => ({
  resolveEditorKind: vi.fn(),
  prefetchEditor: vi.fn(),
}));

const DOC_KEY = 'C:\\tables\\tasks.bitable';
const HTML_PATH = 'C:\\tables\\report.html';
type LinkSurface = 'cell' | 'form' | 'markdown';
let host: HTMLDivElement;
let root: Root;
let clickTime = Date.now();

/** 每次操作前推进时间，避开共享链接处理器的 400ms 连击保护。 */
function nextClickTime(): void {
  clickTime += 500;
  vi.spyOn(Date, 'now').mockReturnValue(clickTime);
}

/** 三种入口使用同一个地址，覆盖表格/甘特单元格、记录表单与 Markdown 单元格/看板。 */
async function renderLink(surface: LinkSurface, href: string): Promise<HTMLAnchorElement> {
  await act(async () => {
    root.render(surface === 'markdown'
      ? <BitableMarkdown source={`[查看链接](${href})`} />
      : <BitableCellEditor column={{ id: 'link', key: 'link', name: '链接', type: 'link' }} value={href} onChange={vi.fn()} variant={surface} />);
  });
  return host.querySelector('a')!;
}

/** 模拟可取消的点击，同时验证组件没有让事件冒泡到行/卡片。 */
async function clickLink(anchor: HTMLAnchorElement, button = 0): Promise<void> {
  nextClickTime();
  const bubbled = vi.fn();
  document.body.addEventListener(button === 0 ? 'click' : 'auxclick', bubbled, { once: true });
  const event = new MouseEvent(button === 0 ? 'click' : 'auxclick', { bubbles: true, cancelable: true, button });
  await act(async () => { anchor.dispatchEvent(event); });
  document.body.removeEventListener(button === 0 ? 'click' : 'auxclick', bubbled);
  expect(event.defaultPrevented).toBe(true);
  expect(bubbled).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipc.pathExists).mockResolvedValue({ exists: true, isDir: false });
  vi.mocked(ipc.registerDocument).mockResolvedValue({ type: 'ok' });
  vi.mocked(ipc.readDir).mockResolvedValue([]);
  vi.mocked(ipc.pushRecent).mockResolvedValue(undefined);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  useWindowStore.setState({ tabs: [], activeKey: DOC_KEY, transferringKeys: [] });
  useDocumentStore.setState({ documents: new Map() });
  useDocumentStore.getState().upsertFromPayload({
    key: DOC_KEY, displayName: 'tasks.bitable', dirPath: 'C:\\tables', kind: 'bitable', language: 'json',
    content: '{}', encoding: 'utf8', eol: 'lf', size: 2, mtime: 1, readonly: false,
  });
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, file: { ...DEFAULT_SETTINGS.file, htmlOpenMode: 'browser' } } });
  vi.mocked(ipc.prepareDocument).mockResolvedValue({
    type: 'text',
    payload: { key: HTML_PATH, displayName: 'report.html', dirPath: 'C:\\tables', kind: 'code', language: 'html', content: '<p>report</p>', encoding: 'utf8', eol: 'lf', size: 13, mtime: 1, readonly: false },
  });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each<LinkSurface>(['cell', 'form', 'markdown'])('多维表格 %s 链接入口', (surface) => {
  it('单击网页链接调用系统浏览器', async () => {
    await clickLink(await renderLink(surface, 'https://example.com/bitable'));
    expect(ipc.openExternalUrl).toHaveBeenCalledExactlyOnceWith('https://example.com/bitable');
    expect(ipc.pathExists).not.toHaveBeenCalled();
  });

  it('本地 HTML 相对路径按全局设置交给默认浏览器', async () => {
    await clickLink(await renderLink(surface, './report.html'));
    expect(ipc.pathExists).toHaveBeenCalledWith(HTML_PATH);
    expect(ipc.openWithDefaultApp).toHaveBeenCalledExactlyOnceWith(HTML_PATH);
    expect(ipc.prepareDocument).not.toHaveBeenCalled();
  });

  it('全局设置为本软件时打开 HTML 标签', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, file: { ...DEFAULT_SETTINGS.file, htmlOpenMode: 'app' } } });
    await clickLink(await renderLink(surface, './report.html'));
    expect(ipc.openWithDefaultApp).not.toHaveBeenCalled();
    expect(useWindowStore.getState().getTab(HTML_PATH)?.language).toBe('html');
  });

  it('中键点击也使用统一路由并阻止原生新窗口', async () => {
    await clickLink(await renderLink(surface, 'https://example.com/middle'), 1);
    expect(ipc.openExternalUrl).toHaveBeenCalledExactlyOnceWith('https://example.com/middle');
  });
});

it('Markdown 的自定义打开回调仍可覆盖默认路由', async () => {
  const onOpenLink = vi.fn();
  await act(async () => { root.render(<BitableMarkdown source='<a href="https://example.com/custom"><span>链接</span></a>' onOpenLink={onOpenLink} />); });
  nextClickTime();
  await act(async () => { host.querySelector('a span')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
  expect(onOpenLink).toHaveBeenCalledExactlyOnceWith('https://example.com/custom');
  expect(ipc.openExternalUrl).not.toHaveBeenCalled();
});

it('超链接文字仍支持双击编辑地址', async () => {
  await renderLink('cell', 'https://example.com/edit');
  await act(async () => { host.querySelector('span')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
  expect(host.querySelector('input')?.value).toBe('https://example.com/edit');
  expect(ipc.openExternalUrl).not.toHaveBeenCalled();
});
