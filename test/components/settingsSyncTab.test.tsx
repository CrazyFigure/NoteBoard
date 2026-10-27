// 设置页同步与备份首次切换回归测试。
// 保留真实面板和缓存配置；同步提交后立即检查 DOM，避免异步等待掩盖加载占位闪烁。

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsModal } from '../../src/components/settings/SettingsModal';
import { TooltipProvider } from '../../src/components/Tooltip';
import type { SyncConfigFile, SyncProviderConfig } from '../../src/core/ipc/types';
import { useSyncStore } from '../../src/stores/syncStore';
import { ProviderForm } from '../../src/features/sync/SyncControls';
import * as ipc from '../../src/core/ipc/commands';

// 字体设置与本次页签切换无关，不触发原生字体接口或字体包检查。
vi.mock('../../src/components/settings/FontSelect', () => ({ FontSelect: () => null }));
vi.mock('../../src/components/settings/FontPackSettingsCard', () => ({ FontPackSettingsCard: () => null }));

/** 提供完整的服务配置，确保实际表单能够读取不同服务的缓存输入。 */
function createProvider(): SyncProviderConfig {
  const git = { baseUrl: '', owner: '', repo: '', branch: 'main', token: '', remoteDir: 'NoteBoard' };
  return {
    kind: 'webdav',
    webdav: { url: '', username: '', password: '', headers: [], remoteDir: 'NoteBoard' },
    s3: { endpoint: '', region: '', bucket: '', accessKeyId: '', secretAccessKey: '', prefix: '', pathStyle: true, headers: [] },
    github: { ...git },
    gitee: { ...git },
    gitcode: { ...git },
    gitlab: { ...git },
  };
}

/** 模拟应用启动时已缓存的同步配置，不启用同步或备份，也不访问原生后端。 */
function createConfig(): SyncConfigFile {
  return {
    version: 1,
    deviceId: 'settings-test',
    sync: {
      enabled: false,
      rootDir: 'C:\\Notes',
      deviceName: '测试设备',
      provider: createProvider(),
      syncOnSave: true,
      intervalEnabled: false,
      intervalMinutes: 5,
      syncOnStartup: false,
      notifyNoChange: false,
      trashEnabled: true,
      trashDays: 30,
    },
    backup: {
      autoEnabled: false,
      intervalHours: 24,
      keepCount: 10,
      target: 'local',
      localDir: '',
      provider: createProvider(),
    },
  };
}

describe('设置页同步与备份切换', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    useSyncStore.setState({ config: createConfig(), status: null, initialized: true });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<TooltipProvider><SettingsModal isOpen onClose={() => undefined} /></TooltipProvider>));
  });

  afterEach(async () => {
    // 异步清理同时等待面板关闭时的 flush，避免状态更新泄漏到后续用例。
    await act(async () => root.unmount());
    host.remove();
    useSyncStore.setState({ config: null, status: null, initialized: false });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** 使用同步 act 切换页签，不给动态加载留出额外等待时间。 */
  function switchTab(label: string) {
    const button = Array.from(host.querySelectorAll<HTMLButtonElement>('.nb-settings-nav button'))
      .find((item) => item.textContent === label);
    expect(button).toBeDefined();
    act(() => button!.click());
  }

  it('首次点击直接提交完整面板，不闪现模块加载占位', () => {
    expect(host.querySelector('.nb-sync-panel')).toBeNull();
    switchTab('同步与备份');
    expect(host.querySelector('.nb-sync-panel')).not.toBeNull();
    expect(host.textContent).toContain('开启多端同步');
    expect(host.textContent).toContain('立即备份');
    expect(host.textContent).not.toContain('正在加载同步设置');

    // 往返切换仍直接展示缓存表单，不因重新挂载回到加载占位。
    switchTab('外观主题');
    expect(host.querySelector('.nb-sync-panel')).toBeNull();
    switchTab('同步与备份');
    expect(host.textContent).toContain('开启多端同步');
    expect(host.textContent).not.toContain('正在加载同步设置');
  });

  it('配置确实尚未就绪时保留加载提示，缓存到达后展示表单', () => {
    // 单独控制启动初始化，避免测试向 Tauri 发出实际 IPC 请求。
    const init = vi.spyOn(useSyncStore.getState(), 'init').mockResolvedValue(undefined);
    act(() => useSyncStore.setState({ config: null, initialized: false }));
    switchTab('同步与备份');
    expect(host.textContent).toContain('正在加载同步设置');
    expect(init).toHaveBeenCalledTimes(1);
    act(() => useSyncStore.setState({ config: createConfig(), initialized: true }));
    expect(host.textContent).toContain('开启多端同步');
    expect(host.textContent).not.toContain('正在加载同步设置');
  });

  it.each(['webdav', 's3'] as const)('%s 支持多项 Header 编辑、隐藏和删除，并将新配置用于连接测试', async (kind) => {
    const testConnection = vi.spyOn(ipc, 'syncTestConnection').mockResolvedValue('连接成功');
    /** 使用真实受控表单，确保连续输入和增删后的状态能向上保存。 */
    function Form() {
      const [provider, setProvider] = useState<SyncProviderConfig>({ ...createProvider(), kind });
      return <ProviderForm value={provider} onChange={setProvider} />;
    }
    act(() => root.render(<TooltipProvider><Form /></TooltipProvider>));
    /** 按无障碍名称操作按钮，避免依赖图标或样式结构。 */
    const button = (name: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
    /** 原生 setter 与 input 事件模拟用户输入，使 React 的受控更新正常执行。 */
    const fill = (name: string, value: string) => {
      const input = host.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    act(() => button('添加 Header').click());
    fill('Header 1 名称', 'User-Agent');
    fill('Header 1 值', 'Custom/1');
    act(() => button('添加 Header').click());
    fill('Header 2 名称', 'CF-Access-Client-Secret');
    fill('Header 2 值', 'gateway-token');
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Header 2 值"]')!.type).toBe('password');
    act(() => button('显示Header 2 值').click());
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Header 2 值"]')!.type).toBe('text');
    act(() => button('删除 Header 1').click());
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Header 1 名称"]')!.value).toBe('CF-Access-Client-Secret');
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Header 1 值"]')!.type).toBe('password');
    const testButton = Array.from(host.querySelectorAll('button')).find((item) => item.textContent?.includes('测试连接'))!;
    await act(async () => testButton.click());
    expect(testConnection.mock.calls[0][0][kind].headers).toEqual([{ name: 'CF-Access-Client-Secret', value: 'gateway-token' }]);

    // 类型切换保留各自的 Header，不能把 WebDAV 网关凭证误带到 S3（或反向）。
    const other = host.querySelector<HTMLButtonElement>('button[role="radio"][aria-checked="false"]')!;
    act(() => other.click());
    expect(host.querySelector('input[aria-label="Header 1 名称"]')).toBeNull();
    const original = Array.from(host.querySelectorAll<HTMLButtonElement>('button[role="radio"]')).find((item) => item.textContent === (kind === 'webdav' ? 'WebDAV' : 'S3 对象存储'))!;
    act(() => original.click());
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Header 1 值"]')!.value).toBe('gateway-token');
  });

  it.each(['webdav', 's3'] as const)('%s 折叠帮助说明 Header、默认 UA 与 Cloudflare Access 两项凭证', (kind) => {
    const provider = { ...createProvider(), kind };
    act(() => root.render(<TooltipProvider><ProviderForm value={provider} onChange={() => undefined} /></TooltipProvider>));
    const help = Array.from(host.querySelectorAll('button')).find((item) => item.textContent?.startsWith('如何获取'))!;
    act(() => help.click());
    expect(host.textContent).toContain('自定义 Header');
    expect(host.textContent).toContain('User-Agent');
    expect(host.textContent).toContain('NoteBoard 默认标识');
    expect(host.textContent).toContain('CF-Access-Client-Id');
    expect(host.textContent).toContain('CF-Access-Client-Secret');
  });
});
