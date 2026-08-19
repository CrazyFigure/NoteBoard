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

const DEFAULT_TYPOGRAPHY: TypographySettings = {
  contentFontFamily: '',
  monoFontFamily: "Consolas, 'Cascadia Code', 'Microsoft YaHei Mono', monospace",
  contentFontSize: 16,
  monoFontSize: 14,
  contentLineHeight: 1.7,
  monoLineHeight: 1.5,
  contentWidth: 'standard',
  explorerFontFamily: '',
  explorerFontSize: 13,
  explorerLineHeight: 24,
};

/**
 * 注入排版 CSS 变量到 documentElement
 * 全部走 CSS 变量，不用动态 <style>、不用 !important、不直改 DOM style
 */
export function applyTypography(t: Partial<TypographySettings>): void {
  const root = document.documentElement;
  const merged = { ...DEFAULT_TYPOGRAPHY, ...t };

  // 1. Markdown / 正文排版
  if (merged.contentFontFamily) {
    root.style.setProperty('--content-font-family', merged.contentFontFamily);
  } else {
    // 空字符串 = 系统默认，恢复到 CSS 中的默认值
    root.style.setProperty(
      '--content-font-family',
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei UI', 'Noto Sans SC', Roboto, sans-serif",
    );
  }
  root.style.setProperty('--content-font-size', `${merged.contentFontSize}px`);
  root.style.setProperty('--content-line-height', `${merged.contentLineHeight}`);
  // 内容区域最大宽度（支持预设与自定义百分比）
  root.style.setProperty('--content-max-width', resolveContentWidth(merged.contentWidth));

  // 2. 代码 / 纯文本排版（.sql / .txt / .json 等及代码块）
  root.style.setProperty('--mono-font-family', merged.monoFontFamily);
  root.style.setProperty('--mono-font-size', `${merged.monoFontSize}px`);
  root.style.setProperty('--mono-line-height', `${merged.monoLineHeight ?? 1.5}`);

  // 3. 文件树排版（资源管理器）
  if (merged.explorerFontFamily) {
    root.style.setProperty('--explorer-font-family', merged.explorerFontFamily);
  } else {
    root.style.setProperty(
      '--explorer-font-family',
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei UI', 'Noto Sans SC', Roboto, sans-serif",
    );
  }
  root.style.setProperty('--explorer-font-size', `${merged.explorerFontSize ?? 13}px`);
  root.style.setProperty('--explorer-item-height', `${merged.explorerLineHeight ?? 24}px`);

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
