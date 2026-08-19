// NoteBoard 主题应用逻辑
// 写 data-theme + 注入排版 CSS 变量
// 详见 docs/06-主题与设计规范.md §9

import type { ThemeId, ThemeMode, TypographySettings, ContentWidth } from '../ipc/types';
import { THEMES } from './themes';

// localStorage 键名
const THEME_RESOLVED_KEY = 'nb.theme.resolved';
const TYPOGRAPHY_KEY = 'nb.typography';

// ── 主题解析 ──

/**
 * 解析实际生效的主题 ID
 * 如果 themeMode === 'system'，根据 prefers-color-scheme 返回
 */
export function resolveTheme(
  themeMode: ThemeMode,
  systemLightTheme: ThemeId,
  systemDarkTheme: ThemeId,
): ThemeId {
  if (themeMode !== 'system') {
    return themeMode;
  }
  const prefersDark =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  return prefersDark ? systemDarkTheme : systemLightTheme;
}

/**
 * 应用主题到 documentElement
 * 写 data-theme 属性 + 缓存到 localStorage
 */
export function applyTheme(themeId: ThemeId): void {
  const root = document.documentElement;
  root.dataset.theme = themeId;
  // 缓存到 localStorage，供 main.tsx 防首屏闪烁读取
  try {
    localStorage.setItem(THEME_RESOLVED_KEY, themeId);
  } catch {
    // ignore
  }
}

// ── 排版变量注入 ──

// 预设宽度与 CSS 值的映射
export const CONTENT_WIDTH_MAP: Record<string, string> = {
  narrow: '65%',
  standard: '80%',
  wide: '92%',
  full: '100%',
};

// 预设宽度与百分比数值的映射（供滑动条读取）
export const CONTENT_WIDTH_PERCENT_MAP: Record<string, number> = {
  narrow: 65,
  standard: 80,
  wide: 92,
  full: 100,
};

/**
 * 将 contentWidth 解析为合法的 CSS 宽度值 (如 '80%', '75%')
 */
export function resolveContentWidth(width: string | ContentWidth | undefined): string {
  if (!width) return '80%';
  if (CONTENT_WIDTH_MAP[width]) return CONTENT_WIDTH_MAP[width];
  if (typeof width === 'string') {
    if (width.endsWith('%') || width.endsWith('px') || width.endsWith('vw') || width.endsWith('rem')) {
      return width;
    }
    const num = Number(width);
    if (!isNaN(num) && num > 0) {
      return `${num}%`;
    }
  }
  return '80%';
}

/**
 * 将 contentWidth 解析为数值百分比 (供滑动条使用，40~100)
 */
export function contentWidthToPercent(width: string | ContentWidth | undefined): number {
  if (!width) return 80;
  if (CONTENT_WIDTH_PERCENT_MAP[width] !== undefined) {
    return CONTENT_WIDTH_PERCENT_MAP[width];
  }
  if (typeof width === 'string') {
    const num = parseInt(width.replace('%', ''), 10);
    if (!isNaN(num)) {
      return Math.max(40, Math.min(100, num));
    }
  }
  return 80;
}

/**
 * 格式化单个字体名称，带有空格或特殊字符时自动添加英文引号
 */
export function quoteFontFamily(font: string): string {
  const trimmed = font.trim();
  if (!trimmed) return '';
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed;
  }
  if (/[\s,]/g.test(trimmed)) {
    return `"${trimmed.replace(/"/g, '')}"`;
  }
  return trimmed;
}

/**
 * 智能组合西文字体与中文字体，并附加高容错默认回退字体链
 * 西文字体优先匹配英文字母与符号，中文字体优先匹配汉字
 */
export function formatFontFamily(
  enFont?: string,
  zhFont?: string,
  genericFallback: 'sans-serif' | 'monospace' = 'sans-serif',
): string {
  const list: string[] = [];

  // 西文字体优先匹配西文/数字/符号
  if (enFont && enFont.trim()) {
    const parts = enFont.split(',').map((p) => p.trim()).filter(Boolean);
    for (const p of parts) {
      list.push(quoteFontFamily(p));
    }
  }

  // 中文字体匹配汉字/全角标点
  if (zhFont && zhFont.trim()) {
    const parts = zhFont.split(',').map((p) => p.trim()).filter(Boolean);
    for (const p of parts) {
      list.push(quoteFontFamily(p));
    }
  }

  if (genericFallback === 'monospace') {
    // 等宽字体回退链（优先内置优质中西文等宽字体）
    const monoFallbacks = [
      '"JetBrains Mono"',
      '"Maple Mono Normal NF CN"',
      'Consolas',
      '"Cascadia Code"',
      '"Microsoft YaHei Mono"',
      '"Courier New"',
      'monospace',
    ];
    for (const fb of monoFallbacks) {
      const cleanFb = fb.replace(/"/g, '').toLowerCase();
      if (!list.some((item) => item.replace(/"/g, '').toLowerCase() === cleanFb)) {
        list.push(fb);
      }
    }
  } else {
    const sansFallbacks = [
      '-apple-system',
      'BlinkMacSystemFont',
      '"Segoe UI"',
      '"Microsoft YaHei UI"',
      '"Noto Sans SC"',
      'Roboto',
      'sans-serif',
    ];
    for (const fb of sansFallbacks) {
      const cleanFb = fb.replace(/"/g, '').toLowerCase();
      if (!list.some((item) => item.replace(/"/g, '').toLowerCase() === cleanFb)) {
        list.push(fb);
      }
    }
  }

  return list.join(', ');
}

// 默认排版参数（代码字体初始默认采用内置的 JetBrains Mono 与 Maple Mono Normal NF CN）
const DEFAULT_TYPOGRAPHY: TypographySettings = {
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
};

/**
 * 注入排版 CSS 变量到 documentElement
 * 全部走 CSS 变量，不用动态 <style>、不用 !important、不直改 DOM style
 */
export function applyTypography(t: Partial<TypographySettings>): void {
  const root = document.documentElement;
  const merged = { ...DEFAULT_TYPOGRAPHY, ...t };

  // 1. Markdown / 正文排版 (西文字体 + 中文字体)
  const contentFontFamilyCss = formatFontFamily(
    merged.contentFontFamily,
    merged.contentFontFamilyZh,
    'sans-serif',
  );
  root.style.setProperty('--content-font-family', contentFontFamilyCss);
  root.style.setProperty('--content-font-size', `${merged.contentFontSize}px`);
  root.style.setProperty('--content-line-height', `${merged.contentLineHeight}`);
  // Markdown 正文内容区域最大宽度（默认 wide 宽屏 92%）
  root.style.setProperty('--content-max-width', resolveContentWidth(merged.contentWidth));

  // 2. 代码 / 纯文本排版（.sql / .txt / .json 等及代码块）(西文等宽 + 中文等宽)
  const monoFontFamilyCss = formatFontFamily(
    merged.monoFontFamily,
    merged.monoFontFamilyZh,
    'monospace',
  );
  root.style.setProperty('--mono-font-family', monoFontFamilyCss);
  root.style.setProperty('--mono-font-size', `${merged.monoFontSize}px`);
  root.style.setProperty('--mono-line-height', `${merged.monoLineHeight ?? 1.5}`);
  // 代码与纯文本编辑区域最大宽度（默认 full 全宽 100%）
  root.style.setProperty('--mono-max-width', resolveContentWidth(merged.monoContentWidth ?? 'full'));

  // 3. 文件树排版（资源管理器）
  const explorerFontFamilyCss = formatFontFamily(
    merged.explorerFontFamily,
    merged.explorerFontFamilyZh,
    'sans-serif',
  );
  root.style.setProperty('--explorer-font-family', explorerFontFamilyCss);
  root.style.setProperty('--explorer-font-size', `${merged.explorerFontSize ?? 13}px`);
  root.style.setProperty('--explorer-item-height', `${merged.explorerLineHeight ?? 24}px`);

  // 4. 软件全局界面 UI 排版（包括设置弹窗、提示、标题栏与状态栏等）
  const uiFontFamilyCss = formatFontFamily(
    merged.uiFontFamily,
    merged.uiFontFamilyZh,
    'sans-serif',
  );
  root.style.setProperty('--ui-font-family', uiFontFamilyCss);
  root.style.setProperty('--ui-font-size', `${merged.uiFontSize ?? 13}px`);

  // 缓存到 localStorage，供 main.tsx 防首屏闪烁读取
  try {
    localStorage.setItem(TYPOGRAPHY_KEY, JSON.stringify(merged));
  } catch {
    // ignore
  }
}

/**
 * 从 localStorage 读取缓存的排版设置并应用
 * 供 main.tsx 在 React 渲染前同步调用
 */
export function applyCachedTypography(): void {
  try {
    const cached = localStorage.getItem(TYPOGRAPHY_KEY);
    if (cached) {
      const t = JSON.parse(cached) as Partial<TypographySettings>;
      applyTypography(t);
    }
  } catch {
    // ignore
  }
}

/**
 * 从 localStorage 读取缓存的主题并应用
 * 供 main.tsx 在 React 渲染前同步调用
 * 返回 false 表示没有缓存，需要从系统设置加载
 */
export function applyCachedTheme(): boolean {
  try {
    const cached = localStorage.getItem(THEME_RESOLVED_KEY) as ThemeId | null;
    if (cached && cached in THEMES) {
      document.documentElement.dataset.theme = cached;
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

// ── 系统主题跟随 ──

let mediaQueryUnlisten: (() => void) | null = null;

/**
 * 开始监听系统主题变化
 * 当 themeMode === 'system' 时自动切换
 */
export function startSystemThemeListener(
  isSystem: () => boolean,
  systemLightTheme: ThemeId,
  systemDarkTheme: ThemeId,
  onChange: (resolved: ThemeId) => void,
): void {
  stopSystemThemeListener();

  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = (e: MediaQueryListEvent) => {
    if (!isSystem()) return;
    const resolved = e.matches ? systemDarkTheme : systemLightTheme;
    applyTheme(resolved);
    onChange(resolved);
  };

  mq.addEventListener('change', handler);
  mediaQueryUnlisten = () => mq.removeEventListener('change', handler);
}

/** 停止系统主题监听 */
export function stopSystemThemeListener(): void {
  if (mediaQueryUnlisten) {
    mediaQueryUnlisten();
    mediaQueryUnlisten = null;
  }
}
