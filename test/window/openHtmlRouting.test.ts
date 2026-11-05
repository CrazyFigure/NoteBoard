// NoteBoard HTML 链接打开方式路由测试
// 覆盖：链接默认交给系统浏览器、设置为本软件时应用内打开、普通打开入口不受设置影响、非 HTML 链接不受影响、唤起失败回退

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useWindowStore } from '../../src/stores/windowStore';
import { useDocumentStore } from '../../src/stores/documentStore';
import { useSettingsStore, DEFAULT_SETTINGS } from '../../src/stores/settingsStore';
import { openDocument, openLinkedDocument, shouldOpenHtmlInBrowser } from '../../src/features/editor-code/orchestration/openDocument';
import * as ipc from '../../src/core/ipc/commands';

vi.mock('../../src/core/ipc/commands', () => ({
  prepareDocument: vi.fn(),
  registerDocument: vi.fn(),
  readDir: vi.fn().mockResolvedValue([]),
  pushRecent: vi.fn().mockResolvedValue(undefined),
  focusWindow: vi.fn().mockResolvedValue(undefined),
  openWithDefaultApp: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'nb-main' }),
}));

const PATH = 'C:\\site\\index.html';

/** 让准备阶段返回一个 HTML 文本载荷 */
function mockHtmlPayload(): void {
  vi.mocked(ipc.prepareDocument).mockResolvedValue({
    type: 'text',
    payload: { key: PATH, displayName: 'index.html', dirPath: 'C:\\site', kind: 'code', language: 'html', content: '<p>hi</p>', encoding: 'utf8', eol: 'lf', size: 9, mtime: 1, readonly: false },
  });
  vi.mocked(ipc.registerDocument).mockResolvedValue({ type: 'ok' });
}

function setHtmlOpenMode(mode: 'browser' | 'app' | undefined): void {
  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS, file: { ...DEFAULT_SETTINGS.file, htmlOpenMode: mode } },
  });
}

describe('HTML 链接打开方式', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWindowStore.setState({ tabs: [], activeKey: null, transferringKeys: [] });
    useDocumentStore.setState({ documents: new Map() });
    setHtmlOpenMode('browser');
  });

  it('只有 .html / .htm 受设置影响，缺省为系统浏览器', () => {
    setHtmlOpenMode(undefined);
    expect(shouldOpenHtmlInBrowser('C:\\a\\page.HTM')).toBe(true);
    expect(shouldOpenHtmlInBrowser('C:\\a\\note.md')).toBe(false);
    expect(shouldOpenHtmlInBrowser('C:\\a\\page.html.bak')).toBe(false);
  });

  it('点击链接默认交给系统浏览器，不建标签', async () => {
    expect(await openLinkedDocument(PATH)).toBe('opened');
    expect(ipc.openWithDefaultApp).toHaveBeenCalledWith(PATH);
    expect(ipc.prepareDocument).not.toHaveBeenCalled();
    expect(useWindowStore.getState().tabs).toHaveLength(0);
  });

  it('设置为本软件时链接在应用内打开', async () => {
    setHtmlOpenMode('app');
    mockHtmlPayload();
    expect(await openLinkedDocument(PATH)).toBe('opened');
    expect(ipc.openWithDefaultApp).not.toHaveBeenCalled();
    expect(useWindowStore.getState().getTab(PATH)?.language).toBe('html');
  });

  it('资源管理器、拖入等普通打开入口不受设置影响，始终在本软件打开', async () => {
    mockHtmlPayload();
    expect(await openDocument(PATH)).toBe('opened');
    expect(ipc.openWithDefaultApp).not.toHaveBeenCalled();
    expect(useWindowStore.getState().getTab(PATH)).not.toBeNull();
  });

  it('非 HTML 链接照常在本软件打开', async () => {
    vi.mocked(ipc.prepareDocument).mockResolvedValue({
      type: 'text',
      payload: { key: 'C:\\site\\a.md', displayName: 'a.md', dirPath: 'C:\\site', kind: 'markdown', language: 'markdown', content: '# a', encoding: 'utf8', eol: 'lf', size: 3, mtime: 1, readonly: false },
    });
    vi.mocked(ipc.registerDocument).mockResolvedValue({ type: 'ok' });
    expect(await openLinkedDocument('C:\\site\\a.md')).toBe('opened');
    expect(ipc.openWithDefaultApp).not.toHaveBeenCalled();
  });

  it('唤起浏览器失败时回退到应用内打开', async () => {
    vi.mocked(ipc.openWithDefaultApp).mockRejectedValueOnce('no handler');
    mockHtmlPayload();
    expect(await openLinkedDocument(PATH)).toBe('opened');
    expect(useWindowStore.getState().getTab(PATH)).not.toBeNull();
  });
});
