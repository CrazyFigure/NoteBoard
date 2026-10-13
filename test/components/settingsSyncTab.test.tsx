// 设置页同步与备份首次切换回归测试。
// 保留真实面板和缓存配置；同步提交后立即检查 DOM，避免异步等待掩盖加载占位闪烁。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsModal } from '../../src/components/settings/SettingsModal';
import { TooltipProvider } from '../../src/components/Tooltip';
import type { SyncConfigFile, SyncProviderConfig } from '../../src/core/ipc/types';
import { useSyncStore } from '../../src/stores/syncStore';

// 字体设置与本次页签切换无关，不触发原生字体接口或字体包检查。
vi.mock('../../src/components/settings/FontSelect', () => ({ FontSelect: () => null }));
vi.mock('../../src/components/settings/FontPackSettingsCard', () => ({ FontPackSettingsCard: () => null }));

/** 提供完整的服务配置，确保实际表单能够读取不同服务的缓存输入。 */
function createProvider(): SyncProviderConfig {
  const git = { baseUrl: '', owner: '', repo: '', branch: 'main', token: '', remoteDir: 'NoteBoard' };
  return {
    kind: 'webdav',
    webdav: { url: '', username: '', password: '', userAgent: '', remoteDir: 'NoteBoard' },
    s3: { endpoint: '', region: '', bucket: '', accessKeyId: '', secretAccessKey: '', prefix: '', pathStyle: true, userAgent: '' },
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
});
