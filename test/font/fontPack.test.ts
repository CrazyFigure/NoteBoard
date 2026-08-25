// NoteBoard 字体包决策单元测试：覆盖首次提示与拒绝下载后的系统字体兜底规则。

import { describe, expect, it, vi } from 'vitest';

import type { Settings, TypographySettings } from '../../src/core/ipc/types';
import {
  resolveSystemFontFallbackPatch,
  shouldPromptForFontPack,
} from '../../src/app/fontPack';

// 本组测试只验证纯决策逻辑，不访问 Tauri 本地资源协议。
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: vi.fn((path: string) => path),
}));

const defaultTypography = (): TypographySettings => ({
  contentFontFamily: '',
  contentFontFamilyZh: '',
  monoFontFamily: 'JetBrains Mono',
  monoFontFamilyZh: 'Maple Mono Normal NF CN',
  contentFontSize: 16,
  monoFontSize: 14,
  contentLineHeight: 1.7,
  monoLineHeight: 1.5,
  contentWidth: 'wide',
  monoContentWidth: 'full',
  explorerFontFamily: '',
  explorerFontFamilyZh: '',
  explorerFontSize: 13,
  explorerLineHeight: 24,
  uiFontFamily: '',
  uiFontFamilyZh: '',
  uiFontSize: 13,
});

const settingsWithTypography = (typography: TypographySettings) => ({ typography }) as Settings;

describe('字体包首次提示规则', () => {
  it('默认配置依赖字体包且系统未安装时提示下载', () => {
    expect(shouldPromptForFontPack(settingsWithTypography(defaultTypography()), ['Segoe UI', 'Consolas'])).toBe(true);
  });

  it('系统已经安装两套同名字体时静默使用，不提示下载', () => {
    expect(shouldPromptForFontPack(
      settingsWithTypography(defaultTypography()),
      ['JetBrains Mono', 'Maple Mono Normal NF CN'],
    )).toBe(false);
  });

  it('用户已选择其它系统字体时不制造无关提示', () => {
    const typography = defaultTypography();
    typography.monoFontFamily = 'Cascadia Mono';
    typography.monoFontFamilyZh = 'Microsoft YaHei UI';
    expect(shouldPromptForFontPack(settingsWithTypography(typography), [])).toBe(false);
  });
});

describe('拒绝或删除字体包后的系统字体兜底', () => {
  it('只替换不可用的字体包字段，并优先选择真实存在的常用系统字体', () => {
    const typography = defaultTypography();
    typography.contentFontFamily = 'Georgia';
    const patch = resolveSystemFontFallbackPatch(
      typography,
      ['Cascadia Mono', 'Microsoft YaHei UI', 'Georgia'],
    );
    expect(patch).toEqual({
      monoFontFamily: 'Cascadia Mono',
      monoFontFamilyZh: 'Microsoft YaHei UI',
    });
  });

  it('系统已安装的同名字体继续保留，只替换另一套缺失字体', () => {
    const patch = resolveSystemFontFallbackPatch(
      defaultTypography(),
      ['JetBrains Mono', 'Microsoft YaHei'],
    );
    expect(patch).toEqual({ monoFontFamilyZh: 'Microsoft YaHei' });
  });
});
