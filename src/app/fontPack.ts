// NoteBoard 应用级字体资源包注册与首次启动决策。

import { convertFileSrc } from '@tauri-apps/api/core';

import type { FontPackStatus, Settings, TypographySettings } from '../core/ipc/types';

/** 字体包提供的稳定族名；这里只描述能力，不能据此把尚未下载的字体误判为可用。 */
export const PACKAGED_FONT_FAMILIES = [
  'JetBrains Mono',
  'Maple Mono Normal NF CN',
] as const;

// 当前 WebView 已注册的 FontFace 必须可追踪，删除或修复资源包时才能彻底撤销旧引用。
let activeFontFaces: FontFace[] = [];
let activeApplicationFontFamilies: string[] = [];
const applicationFontListeners = new Set<(families: readonly string[]) => void>();

const publishApplicationFontFamilies = (families: string[]) => {
  activeApplicationFontFamilies = families;
  applicationFontListeners.forEach((listener) => listener(activeApplicationFontFamilies));
};

const clearActiveFontFaces = () => {
  if (typeof document !== 'undefined' && 'fonts' in document) {
    activeFontFaces.forEach((fontFace) => document.fonts.delete(fontFace));
  }
  activeFontFaces = [];
  publishApplicationFontFamilies([]);
};

/** 返回当前 WebView 已成功注册的应用字体族。 */
export const getApplicationFontFamilies = () => [...activeApplicationFontFamilies];

/** 字体下拉框订阅应用字体变化，下载完成后无需重新打开设置即可即时出现。 */
export const subscribeApplicationFontFamilies = (
  listener: (families: readonly string[]) => void,
) => {
  applicationFontListeners.add(listener);
  return () => applicationFontListeners.delete(listener);
};

/**
 * 把后端校验通过的本地文件注册到当前 WebView；不会调用 Windows 字体安装接口。
 * 先完成全部 FontFace.load 再对外发布族名，避免下拉框与实际渲染能力短暂不一致。
 */
export const activateFontPack = async (status: FontPackStatus): Promise<FontPackStatus> => {
  clearActiveFontFaces();
  if (status.state !== 'ready' || !status.faces.length || typeof document === 'undefined') {
    return status;
  }

  const pendingFaces = status.faces.map((descriptor) => {
    const assetUrl = convertFileSrc(descriptor.path);
    return new FontFace(
      descriptor.family,
      `url(${JSON.stringify(assetUrl)})`,
      {
        style: descriptor.style,
        weight: descriptor.weight,
        display: 'swap',
      },
    );
  });

  try {
    // FontFaceSet 先登记再主动加载，完成后的同一帧即可供编辑器测量和绘制。
    pendingFaces.forEach((fontFace) => document.fonts.add(fontFace));
    await Promise.all(pendingFaces.map((fontFace) => fontFace.load()));
    activeFontFaces = pendingFaces;
    publishApplicationFontFamilies(
      Array.from(new Set(status.faces.map((face) => face.family))),
    );
    return status;
  } catch (error) {
    pendingFaces.forEach((fontFace) => document.fonts.delete(fontFace));
    publishApplicationFontFamilies([]);
    throw error;
  }
};

const packagedFontLookup = new Set(
  PACKAGED_FONT_FAMILIES.map((fontFamily) => fontFamily.toLowerCase()),
);

const normalizeFontFamily = (fontFamily: string) =>
  fontFamily.trim().replace(/^['"]|['"]$/g, '').toLowerCase();

export const isPackagedFontFamily = (fontFamily: string) =>
  packagedFontLookup.has(normalizeFontFamily(fontFamily));

const buildInstalledFontLookup = (installedFonts: readonly string[]) =>
  new Map(installedFonts.map((fontFamily) => [fontFamily.toLowerCase(), fontFamily]));

/** 只有当前配置依赖字体包且系统中没有同名字体时才提示，避免打扰已自定义字体的用户。 */
export const shouldPromptForFontPack = (
  settings: Settings,
  installedFonts: readonly string[],
) => {
  const installed = buildInstalledFontLookup(installedFonts);
  const typography = settings.typography;
  const configured = [
    typography.contentFontFamily,
    typography.contentFontFamilyZh,
    typography.monoFontFamily,
    typography.monoFontFamilyZh,
    typography.explorerFontFamily,
    typography.explorerFontFamilyZh,
    typography.uiFontFamily,
    typography.uiFontFamilyZh,
  ].filter((fontFamily): fontFamily is string => Boolean(fontFamily));
  return configured.some((fontFamily) => {
    const normalized = normalizeFontFamily(fontFamily);
    return packagedFontLookup.has(normalized) && !installed.has(normalized);
  });
};

const chooseInstalledFont = (
  installed: Map<string, string>,
  candidates: readonly string[],
  genericFallback: string,
) => {
  for (const candidate of candidates) {
    const match = installed.get(candidate.toLowerCase());
    if (match) return match;
  }
  return genericFallback;
};

/**
 * 用户拒绝或删除字体包时，只替换“字体包提供但系统未安装”的配置项。
 * 不覆盖其它自定义字体；代码、西文 UI 与中文内容分别选择真实存在的常用系统兜底。
 */
export const resolveSystemFontFallbackPatch = (
  typography: TypographySettings,
  installedFonts: readonly string[],
): Partial<TypographySettings> => {
  const installed = buildInstalledFontLookup(installedFonts);
  const monoLatin = chooseInstalledFont(installed, ['Cascadia Mono', 'Consolas', 'Courier New'], 'monospace');
  const uiLatin = chooseInstalledFont(installed, ['Segoe UI', 'Arial'], 'sans-serif');
  const cjk = chooseInstalledFont(
    installed,
    ['Microsoft YaHei UI', 'Microsoft YaHei', 'Microsoft JhengHei UI', 'SimSun'],
    'sans-serif',
  );
  const patch: Partial<TypographySettings> = {};

  const replaceIfUnavailable = (
    key: keyof TypographySettings,
    fallback: string,
  ) => {
    const value = typography[key];
    if (typeof value !== 'string') return;
    const normalized = normalizeFontFamily(value);
    if (packagedFontLookup.has(normalized) && !installed.has(normalized)) {
      (patch as Record<string, unknown>)[key] = fallback;
    }
  };

  replaceIfUnavailable('monoFontFamily', monoLatin);
  replaceIfUnavailable('monoFontFamilyZh', cjk);
  replaceIfUnavailable('contentFontFamily', uiLatin);
  replaceIfUnavailable('contentFontFamilyZh', cjk);
  replaceIfUnavailable('explorerFontFamily', uiLatin);
  replaceIfUnavailable('explorerFontFamilyZh', cjk);
  replaceIfUnavailable('uiFontFamily', uiLatin);
  replaceIfUnavailable('uiFontFamilyZh', cjk);
  return patch;
};

/** 将稳定后端错误码翻译为可直接展示的中文，不泄露实现细节。 */
export const translateFontPackError = (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const prefix = 'font_pack_error:';
  if (!message.startsWith(prefix)) return `字体包操作失败：${message}`;
  const payload = message.slice(prefix.length);
  const separator = payload.indexOf(':');
  const code = separator >= 0 ? payload.slice(0, separator) : payload;
  const detail = separator >= 0 ? payload.slice(separator + 1) : '';
  switch (code) {
    case 'download':
      return `字体包下载失败，请检查网络后重试${detail ? `：${detail}` : ''}`;
    case 'archive_size':
    case 'invalid_archive':
    case 'missing_file':
    case 'invalid_file':
      return '字体包不完整、已损坏或版本不兼容，请重新下载官方字体包。';
    case 'read':
    case 'write':
    case 'install':
    case 'remove':
      return `字体包存储操作失败${detail ? `：${detail}` : ''}`;
    default:
      return `字体包操作失败${detail ? `：${detail}` : ''}`;
  }
};
