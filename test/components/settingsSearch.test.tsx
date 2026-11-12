// 设置中心整理与设置搜索回归测试
// 覆盖：搜索跳转与高亮、Esc 只清空查询、索引与页面锚点一致、老用户设置在新布局中原样显示。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsModal } from '../../src/components/settings/SettingsModal';
import { TooltipProvider } from '../../src/components/Tooltip';
import { SETTINGS_SEARCH_INDEX, TAB_LABELS, isTabVisible, type TabType } from '../../src/components/settings/settingsSearchIndex';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../src/stores/settingsStore';

// 字体选择与字体包检查与本测试无关，不触发原生字体接口。
vi.mock('../../src/components/settings/FontSelect', () => ({ FontSelect: () => null }));
vi.mock('../../src/components/settings/FontPackSettingsCard', () => ({ FontPackSettingsCard: () => null }));

// 页面内联渲染的栏目；同步、历史、插件、账号等外部面板依赖各自的 store，不在一致性校验范围内
const INLINE_TABS: TabType[] = ['general', 'appearance', 'typography', 'editor', 'file', 'shortcuts', 'about'];

describe('设置搜索与布局整理', () => {
  let host: HTMLDivElement;
  let root: Root;
  let onClose: ReturnType<typeof vi.fn>;
  let previous: ReturnType<typeof useSettingsStore.getState>['settings'];

  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    previous = useSettingsStore.getState().settings;
    await act(async () => useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS) }));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    onClose = vi.fn();
    act(() => root.render(<TooltipProvider><SettingsModal isOpen onClose={onClose} /></TooltipProvider>));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    await act(async () => useSettingsStore.setState({ settings: previous }));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function switchTab(label: string) {
    const button = Array.from(host.querySelectorAll<HTMLButtonElement>('.nb-settings-nav button'))
      .find((item) => item.textContent === label);
    expect(button).toBeDefined();
    act(() => button!.click());
  }

  /** 原生 setter 与 input 事件模拟用户输入，使 React 的受控更新正常执行 */
  function typeQuery(text: string) {
    const input = host.querySelector<HTMLInputElement>('input[aria-label="搜索设置"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    return input;
  }

  /** 等待下一帧的定位与高亮 */
  async function nextFrame() {
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
  }

  function activeNavLabel() {
    return Array.from(host.querySelectorAll<HTMLButtonElement>('.nb-settings-nav button'))
      .find((button) => button.style.fontWeight === '600')?.textContent;
  }

  it('导航以「通用」开头并默认进入通用页', () => {
    const labels = Array.from(host.querySelectorAll('.nb-settings-nav button')).map((button) => button.textContent);
    expect(labels.slice(0, 5)).toEqual(['通用', '外观', '排版与字体', '编辑器', '文件与保存']);
    expect(activeNavLabel()).toBe('通用');
    expect(host.querySelector('[data-setting-id="restoreSession"]')).not.toBeNull();
  });

  it('搜索「行号」跳到编辑器页并高亮该设置项', async () => {
    typeQuery('行号');
    const result = Array.from(host.querySelectorAll<HTMLButtonElement>('.nb-settings-search-result'))
      .find((button) => button.textContent?.includes('显示行号'));
    expect(result).toBeDefined();
    expect(result!.textContent).toContain('编辑器 › 代码与纯文本');
    act(() => result!.click());
    await nextFrame();
    expect(activeNavLabel()).toBe('编辑器');
    expect(host.querySelector<HTMLInputElement>('input[aria-label="搜索设置"]')!.value).toBe('');
    expect(host.querySelector('[data-setting-id="showLineNumbers"]')!.classList.contains('nb-setting-flash')).toBe(true);
  });

  it('搜索「回车」能找到已移到编辑器页的 Enter 互换，回车直接跳到第一条', async () => {
    const input = typeQuery('回车');
    expect(host.querySelector('.nb-settings-search-result')!.textContent).toContain('Enter 与 Shift + Enter 互换');
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await nextFrame();
    expect(activeNavLabel()).toBe('编辑器');
    expect(host.querySelector('[data-setting-id="swapEnterKeys"] input[type="checkbox"]')).not.toBeNull();
  });

  it('没有匹配时显示空状态', () => {
    typeQuery('不存在的设置项xyz');
    expect(host.textContent).toContain('没有匹配的设置');
  });

  it('有查询内容时 Esc 只清空搜索，不关闭设置；再按 Esc 才关闭', () => {
    const input = typeQuery('托盘');
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(input.value).toBe('');
    expect(onClose).not.toHaveBeenCalled();
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('索引中每个可用条目都能在对应页面找到 data-setting-id 锚点', () => {
    for (const tab of INLINE_TABS) {
      if (!isTabVisible(tab)) continue;
      switchTab(TAB_LABELS[tab]);
      const missing = SETTINGS_SEARCH_INDEX
        .filter((entry) => entry.tab === tab && (entry.available?.() ?? true))
        .filter((entry) => !host.querySelector(`[data-setting-id="${entry.id}"]`))
        .map((entry) => entry.id);
      expect(missing, `${TAB_LABELS[tab]} 缺少锚点`).toEqual([]);
    }
  });

  it('老用户的非默认设置在新布局中原样显示', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.file.restoreSession = false;
    settings.file.restoreReadingPosition = false;
    settings.file.showHiddenFiles = true;
    settings.file.explorerOpenMode = 'single';
    settings.editor.swapEnterKeys = true;
    settings.layout.titleBarButtons = { ...settings.layout.titleBarButtons, theme: false };
    await act(async () => useSettingsStore.setState({ settings }));

    const checkbox = (id: string) => host.querySelector<HTMLInputElement>(`[data-setting-id="${id}"] input[type="checkbox"]`)!;
    switchTab('通用');
    expect(checkbox('restoreSession').checked).toBe(false);
    expect(checkbox('restoreReadingPosition').checked).toBe(false);

    switchTab('文件与保存');
    expect(checkbox('showHiddenFiles').checked).toBe(true);
    expect(host.querySelector('[data-setting-id="explorerOpenMode"] [aria-label="打开文件的方式"]')!.textContent).toContain('单击打开');

    switchTab('编辑器');
    expect(checkbox('swapEnterKeys').checked).toBe(true);

    switchTab('外观');
    expect(host.querySelector<HTMLInputElement>('input[aria-label="标题栏显示切换主题"]')!.checked).toBe(false);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="标题栏显示回到主界面"]')!.checked).toBe(true);

    // 快捷键页的回车类按键随互换设置显示
    switchTab('快捷键');
    const paragraph = Array.from(host.querySelectorAll('kbd')).find((kbd) => kbd.parentElement?.textContent?.includes('换段落'));
    expect(paragraph!.textContent).toBe('Shift + Enter');
  });

  it('关于页显示「自动检查更新」：旧设置缺字段视为开启，可手动关闭', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    // 模拟加该开关之前的旧设置文件
    delete (settings.system as { autoCheckUpdate?: boolean }).autoCheckUpdate;
    await act(async () => useSettingsStore.setState({ settings }));
    const setSystem = vi.spyOn(useSettingsStore.getState(), 'setSystem').mockResolvedValue(undefined);
    switchTab('关于');
    const toggle = host.querySelector<HTMLInputElement>('[data-setting-id="autoCheckUpdate"] input[aria-label="自动检查更新"]')!;
    expect(toggle).not.toBeNull();
    expect(toggle.checked).toBe(true);
    await act(async () => toggle.click());
    expect(setSystem).toHaveBeenCalledWith({ autoCheckUpdate: false });
  });

  it('编辑器页恢复默认会一并重置 Enter 互换', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.editor.swapEnterKeys = true;
    await act(async () => useSettingsStore.setState({ settings }));
    const setEditor = vi.spyOn(useSettingsStore.getState(), 'setEditor').mockResolvedValue(undefined);
    switchTab('编辑器');
    const reset = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.includes('恢复默认'))!;
    expect(reset.disabled).toBe(false);
    act(() => reset.click());
    const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).filter((button) => button.textContent === '恢复默认').at(-1)!;
    await act(async () => confirm.click());
    expect(setEditor).toHaveBeenCalledWith(expect.objectContaining({ swapEnterKeys: false }));
  });
});
