// NoteBoard 字体生命周期测试（S06）
// 覆盖：提示顺序前置判断（配置引用包字体才继续）、verifying 不激活、按需 face 加载

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock Tauri convertFileSrc（资源协议 URL 转换）
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}));

import {
  activateFontPack,
  ensureFaces,
  settingsReferencePackagedFonts,
  shouldPromptForFontPack,
  getApplicationFontFamilies,
} from '@/app/fontPack';
import type { FontPackStatus, Settings, TypographySettings } from '@/core/ipc/types';

const baseTypography: TypographySettings = {
  contentFontFamily: 'Segoe UI',
  contentFontFamilyZh: 'Microsoft YaHei',
  contentFontSize: 15,
  contentLineHeight: 1.7,
  contentWidth: 'wide',
  monoFontFamily: 'JetBrains Mono',
  monoFontFamilyZh: 'Maple Mono Normal NF CN',
  monoFontSize: 14,
  monoLineHeight: 1.5,
  explorerFontFamily: 'Segoe UI',
  explorerFontFamilyZh: 'Microsoft YaHei',
  uiFontFamily: 'Segoe UI',
  uiFontFamilyZh: 'Microsoft YaHei',
};

const baseSettings = {
  typography: baseTypography,
} as unknown as Settings;

const readyStatus: FontPackStatus = {
  id: 'core',
  version: '1.0.0',
  state: 'ready',
  installedSizeBytes: 1,
  downloadSizeBytes: 1,
  downloadUrl: 'https://example.com/fontpack.zip',
  faces: [
    { family: 'JetBrains Mono', weight: '400', style: 'normal', path: 'C:\\f\\jb-regular.woff2' },
    { family: 'JetBrains Mono', weight: '700', style: 'normal', path: 'C:\\f\\jb-bold.woff2' },
    { family: 'Maple Mono Normal NF CN', weight: '400', style: 'normal', path: 'C:\\f\\maple-regular.ttf' },
    { family: 'Maple Mono Normal NF CN', weight: '700', style: 'normal', path: 'C:\\f\\maple-bold.ttf' },
  ],
};

/** 可编程的 FontFace 假实现：记录 load 调用 */
class FakeFontFace {
  static loadCalls: string[] = [];
  constructor(
    public family: string,
    _source: string,
    public descriptors: { style: string; weight: string; display: string },
  ) {}
  load() {
    FakeFontFace.loadCalls.push(`${this.family}:${this.descriptors.weight}`);
    return Promise.resolve(this);
  }
}

describe('字体包生命周期（S06）', () => {
  beforeEach(() => {
    FakeFontFace.loadCalls = [];
    vi.stubGlobal('FontFace', FakeFontFace);
    // 清理 document.fonts 假实现
    const added: unknown[] = [];
    vi.stubGlobal('document', {
      ...document,
      fonts: {
        add: (f: unknown) => added.push(f),
        delete: (f: unknown) => {
          const i = added.indexOf(f);
          if (i >= 0) added.splice(i, 1);
        },
        ready: Promise.resolve(),
      },
    });
  });

  it('配置引用包字体时 settingsReferencePackagedFonts 为 true；纯系统字体为 false', () => {
    expect(settingsReferencePackagedFonts(baseSettings)).toBe(true);
    const systemOnly = {
      ...baseSettings,
      typography: {
        ...baseTypography,
        monoFontFamily: 'Consolas',
        monoFontFamilyZh: 'Microsoft YaHei',
      },
    } as unknown as Settings;
    expect(settingsReferencePackagedFonts(systemOnly)).toBe(false);
  });

  it('shouldPromptForFontPack：系统已安装同名字体时不提示', () => {
    // 配置引用 JetBrains Mono，系统未安装 → 提示
    expect(shouldPromptForFontPack(baseSettings, ['Segoe UI'])).toBe(true);
    // 系统已安装 → 不提示
    expect(shouldPromptForFontPack(baseSettings, ['JetBrains Mono', 'Maple Mono Normal NF CN'])).toBe(false);
  });

  it('verifying 状态不激活任何 FontFace（未验证完成不得当 ready 使用）', async () => {
    const verifying: FontPackStatus = { ...readyStatus, state: 'verifying', faces: [] };
    await activateFontPack(verifying, baseTypography);
    expect(FakeFontFace.loadCalls).toHaveLength(0);
    expect(getApplicationFontFamilies()).toHaveLength(0);
  });

  it('ready 状态只主动 load 配置引用族的 400 normal（R11 按具体 face）', async () => {
    await activateFontPack(readyStatus, {
      ...baseTypography,
      // 只引用 JetBrains Mono（西文等宽），中文等宽用系统字体
      monoFontFamilyZh: 'Microsoft YaHei',
    });
    // 🔴 R11：只主动加载引用族的 400 normal（正文默认）；粗体/斜体由 CSS 使用时触发
    expect(FakeFontFace.loadCalls).toContain('JetBrains Mono:400');
    expect(FakeFontFace.loadCalls).not.toContain('JetBrains Mono:700');
    expect(FakeFontFace.loadCalls.some((c) => c.startsWith('Maple Mono'))).toBe(false);
    // 族名已登记（下拉框可用）
    expect(getApplicationFontFamilies()).toContain('JetBrains Mono');
    expect(getApplicationFontFamilies()).toContain('Maple Mono Normal NF CN');
  });

  it('ensureFaces 无引用族时不触发任何 load', async () => {
    await activateFontPack(readyStatus, {
      ...baseTypography,
      monoFontFamily: 'Consolas',
      monoFontFamilyZh: 'Microsoft YaHei',
    });
    FakeFontFace.loadCalls = [];
    await ensureFaces({
      ...baseTypography,
      monoFontFamily: 'Consolas',
      monoFontFamilyZh: 'Microsoft YaHei',
    });
    expect(FakeFontFace.loadCalls).toHaveLength(0);
  });
});
