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
// 与 activeFontFaces 平行的描述符（family/weight/style）——过滤依据原始数据，
// 不依赖 FontFace 实例属性在不同运行时的可移植性
let activeFaceDescriptors: Array<{ family: string; weight: string; style: string }> = [];
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
  activeFaceDescriptors = [];
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
 * S06：把后端校验通过的本地文件注册到当前 WebView；不会调用 Windows 字体安装接口。
 * 🔴 不再对全部 FontFace 主动 load（旧实现一次性加载约 35 MiB 字体二进制）：
 *   - 注册（document.fonts.add）后 CSS 使用时才触发网络/磁盘加载；
 *   - 配置实际引用的族经 ensureFaces 主动 load，保证首屏排版尽快稳定；
 *   - 其余 face 保持"已登记未加载"，下拉框可见但不占解码内存。
 * 不会调用 Windows 字体安装接口。
 */
export const activateFontPack = async (
  status: FontPackStatus,
  typography?: TypographySettings | null,
): Promise<FontPackStatus> => {
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

  // FontFaceSet 登记全部 face（未加载状态）；族名立即发布供下拉框与设置页使用
  pendingFaces.forEach((fontFace) => document.fonts.add(fontFace));
  activeFontFaces = pendingFaces;
  activeFaceDescriptors = status.faces.map((face) => ({
    family: face.family,
    weight: face.weight,
    style: face.style,
  }));
  publishApplicationFontFamilies(
    Array.from(new Set(status.faces.map((face) => face.family))),
  );

  // 按当前排版需求主动加载引用族（区分"已登记"与"已可渲染"）
  await ensureFaces(typography ?? null);
  // 🔴 字体从 fallback 切换到真实字形后，CodeMirror 等自绘光标/测量缓存的组件需要重测；
  //    等待字体就绪后广播统一度量刷新事件（F 节 5）。
  if (typeof document !== 'undefined' && document.fonts) {
    void document.fonts.ready.then(() => {
      window.dispatchEvent(new CustomEvent('noteboard-fonts-settled'));
    });
  }
  return status;
};

/**
 * 按排版需求主动加载当前配置引用的字体 face（其余由 CSS 使用时触发）。
 * typography 为空时跳过（无设置场景不加载任何包字体）。
 */
export const ensureFaces = async (
  typography: TypographySettings | null | undefined,
): Promise<void> => {
  if (!typography || activeFontFaces.length === 0) return;
  const referenced = collectReferencedPackFamilies(typography);
  if (referenced.size === 0) return;
  // 🔴 R11：按具体 face 加载——只主动加载引用族的 400 normal（正文默认）；
  //    粗体/斜体等由 CSS 实际使用时触发（display:swap）。
  //    过滤依据平行描述符数组（原始数据），不依赖 FontFace 实例属性。
  const needed: FontFace[] = [];
  activeFaceDescriptors.forEach((descriptor, index) => {
    if (
      referenced.has(descriptor.family.toLowerCase())
      && String(descriptor.weight) === '400'
      && descriptor.style === 'normal'
    ) {
      const face = activeFontFaces[index];
      if (face) needed.push(face);
    }
  });
  // 主动 load 需要的 face；单个失败不阻塞其它（CSS 仍会按需重试）
  await Promise.allSettled(needed.map((fontFace) => fontFace.load()));
};

/** 收集排版配置中引用的包字体族（小写） */
const collectReferencedPackFamilies = (typography: TypographySettings): Set<string> => {
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
  const referenced = new Set<string>();
  for (const family of configured) {
    if (isPackagedFontFamily(family)) {
      referenced.add(normalizeFontFamily(family));
    }
  }
  return referenced;
};

/**
 * 配置是否引用字体包字体（纯前端判断，无需枚举系统字体）。
 * 🔴 S06 提示顺序（F 节）：先判断配置 → 再查包状态 → 按需才枚举系统字体；
 * 纯系统字体配置不得触发系统字体枚举。
 */
export const settingsReferencePackagedFonts = (settings: Settings): boolean => {
  const referenced = collectReferencedPackFamilies(settings.typography);
  return referenced.size > 0;
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
