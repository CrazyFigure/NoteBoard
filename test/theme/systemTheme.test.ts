// 「跟随系统」主题映射：浅色固定晨光、深色固定墨夜，不受旧配置中 systemLightTheme / systemDarkTheme 影响

import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveTheme, SYSTEM_DARK_THEME, SYSTEM_LIGHT_THEME } from '../../src/core/theme/applyTheme';

/** 模拟系统深浅色偏好 */
function mockPrefersDark(dark: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(prefers-color-scheme: dark)' ? dark : false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

describe('跟随系统主题', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('浅色系统用晨光，深色系统用墨夜', () => {
    expect(SYSTEM_LIGHT_THEME).toBe('chen-guang');
    expect(SYSTEM_DARK_THEME).toBe('mo-ye');
    mockPrefersDark(false);
    expect(resolveTheme('system')).toBe('chen-guang');
    mockPrefersDark(true);
    expect(resolveTheme('system')).toBe('mo-ye');
  });

  it('手动选择的主题不受系统偏好影响', () => {
    mockPrefersDark(true);
    expect(resolveTheme('hu-po')).toBe('hu-po');
    expect(resolveTheme('chen-guang')).toBe('chen-guang');
  });
});
