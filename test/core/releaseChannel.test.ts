// 更新渠道：设置值归一化、备选渠道与错误文案中的渠道名

import { describe, it, expect, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { RELEASE_CHANNELS, alternateUpdateChannel, normalizeUpdateChannel } from '../../src/core/releaseChannel';
import { checkForUpdates } from '../../src/core/ipc/commands';
import { translateUpdateCheckError } from '../../src/core/updates';

// 验证渠道参数穿过真实 IPC 封装，避免 Store 测试中的命令 Mock 掩盖参数遗漏。
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

describe('更新渠道', () => {
  it('显式传递探测渠道，并兼容未指定渠道的旧调用', async () => {
    vi.mocked(invoke).mockResolvedValue({});
    await checkForUpdates('github');
    await checkForUpdates('cnb');
    await checkForUpdates();
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['check_for_updates', { channel: 'github' }],
      ['check_for_updates', { channel: 'cnb' }],
      ['check_for_updates', { channel: undefined }],
    ]);
  });

  it('缺失或未知设置回到默认 GitHub', () => {
    expect(normalizeUpdateChannel(undefined)).toBe('github');
    expect(normalizeUpdateChannel('gitee')).toBe('github');
    expect(normalizeUpdateChannel('cnb')).toBe('cnb');
  });

  it('检测失败时建议另一渠道', () => {
    expect(alternateUpdateChannel('github')).toBe('cnb');
    expect(alternateUpdateChannel('cnb')).toBe('github');
    expect(RELEASE_CHANNELS.cnb.repoUrl).toBe('https://cnb.cool/crazy-figure/NoteBoard');
  });

  it('错误提示使用当前渠道名称', () => {
    expect(translateUpdateCheckError('update_error:rate_limited', '腾讯云 CNB')).toContain('腾讯云 CNB 访问频次已达上限');
    expect(translateUpdateCheckError('update_error:forbidden')).toContain('GitHub 访问被拒绝');
  });
});
