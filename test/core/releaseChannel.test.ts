// 更新渠道：设置值归一化、备选渠道与错误文案中的渠道名

import { describe, it, expect } from 'vitest';
import { RELEASE_CHANNELS, alternateUpdateChannel, normalizeUpdateChannel } from '../../src/core/releaseChannel';
import { translateUpdateCheckError } from '../../src/core/updates';

describe('更新渠道', () => {
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
