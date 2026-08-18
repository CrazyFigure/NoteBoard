// NoteBoard WCAG 2.1 对比度计算
// 详见 docs/06-主题与设计规范.md §11
// 算法来源：https://www.w3.org/TR/WCAG21/#dfn-relative-luminance

import type { ThemeId } from '../ipc/types';

/**
 * 将 #RRGGBB / #RGB 色值解析为 [r, g, b]（0-255 整数）
 * 支持 `#fff`、`#ffffff`、`rgb(1,2,3)`
 */
export function parseColor(hex: string): [number, number, number] {
  const trimmed = hex.trim();

  // rgb()/rgba() 格式
  if (trimmed.startsWith('rgb')) {
    const nums = trimmed.match(/\d+/g);
    if (nums && nums.length >= 3) {
      return [parseInt(nums[0], 10), parseInt(nums[1], 10), parseInt(nums[2], 10)];
    }
  }

  // 去掉 # 和可能的 alpha 后缀
  let h = trimmed.replace(/^#/, '');

  // 去掉 rgba 的 hex alpha（#RRGGBBAA → #RRGGBB）
  if (h.length === 8) h = h.slice(0, 6);

  // 展开 #RGB → #RRGGBB
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }

  if (h.length !== 6) {
    throw new Error(`无法解析颜色值: ${hex}`);
  }

  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return [r, g, b];
}

/**
 * 将 rgba 字符串解析为 [r, g, b, a]
 * 如果传入纯 hex，alpha = 1
 */
export function parseColorWithAlpha(c: string): [number, number, number, number] {
  const trimmed = c.trim();
  if (trimmed.startsWith('rgba')) {
    const nums = trimmed.match(/[\d.]+/g);
    if (nums && nums.length >= 4) {
      return [parseFloat(nums[0]), parseFloat(nums[1]), parseFloat(nums[2]), parseFloat(nums[3])];
    }
  }
  if (trimmed.startsWith('rgb')) {
    const nums = trimmed.match(/\d+/g);
    if (nums && nums.length >= 3) {
      return [parseInt(nums[0], 10), parseInt(nums[1], 10), parseInt(nums[2], 10), 1];
    }
  }
  const [r, g, b] = parseColor(c);
  return [r, g, b, 1];
}

/** sRGB 通道值 → 线性光 */
function channelToLinear(c: number): number {
  const cs = c / 255;
  return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
}

/**
 * 计算相对亮度（WCAG 2.1）
 * https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 */
export function relativeLuminance(color: string): number {
  const [r, g, b, a] = parseColorWithAlpha(color);
  // 如果有 alpha，先与白色混合（简化处理，因为实际背景可能是白）
  // 实际使用中多数颜色是纯 hex
  const r2 = a < 1 ? Math.round(r * a + 255 * (1 - a)) : r;
  const g2 = a < 1 ? Math.round(g * a + 255 * (1 - a)) : g;
  const b2 = a < 1 ? Math.round(b * a + 255 * (1 - a)) : b;

  const rl = channelToLinear(r2);
  const gl = channelToLinear(g2);
  const bl = channelToLinear(b2);
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

/**
 * 计算两个颜色之间的对比度（1.0 ~ 21.0）
 * https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio
 *
 * 如果有 alpha，先与指定背景混合（alpha 合成）
 */
export function contrastRatio(fg: string, bg: string): number {
  const fgAlpha = parseColorWithAlpha(fg);
  const bgRgb = parseColorWithAlpha(bg);

  // 如果 fg 有 alpha，先与 bg 合成
  let fgR = fgAlpha[0];
  let fgG = fgAlpha[1];
  let fgB = fgAlpha[2];
  const a = fgAlpha[3];
  if (a < 1) {
    fgR = Math.round(fgAlpha[0] * a + bgRgb[0] * (1 - a));
    fgG = Math.round(fgAlpha[1] * a + bgRgb[1] * (1 - a));
    fgB = Math.round(fgAlpha[2] * a + bgRgb[2] * (1 - a));
  }

  const fgHex = `#${[fgR, fgG, fgB].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  const bgHex = `#${[bgRgb[0], bgRgb[1], bgRgb[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

  const l1 = relativeLuminance(fgHex);
  const l2 = relativeLuminance(bgHex);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** 正文类对比度阈值（WCAG AA） */
export const TEXT_CONTRAST_THRESHOLD = 4.5;

/** 功能性指示对比度阈值（WCAG 1.4.11 非文本内容） */
export const UI_CONTRAST_THRESHOLD = 3.0;

// ── 从 CSS 中读取 Token 值 ──

/**
 * 获取指定主题下某个 CSS 变量的值
 * 通过临时创建元素、设置 data-theme、读取 getComputedStyle 实现
 */
export function getTokenValue(theme: ThemeId, token: string): string {
  if (typeof document === 'undefined') {
    throw new Error('getTokenValue 只能在浏览器环境中调用');
  }
  const root = document.documentElement;
  const prevTheme = root.dataset.theme;
  root.dataset.theme = theme;
  const value = getComputedStyle(root).getPropertyValue(token).trim();
  if (prevTheme) {
    root.dataset.theme = prevTheme;
  } else {
    delete root.dataset.theme;
  }
  if (!value) {
    throw new Error(`Token ${token} 在主题 ${theme} 中未定义`);
  }
  return value;
}

/**
 * 检查指定主题的指定 Token 对是否满足对比度阈值
 */
export function checkContrast(
  theme: ThemeId,
  fgToken: string,
  bgToken: string,
  threshold: number,
): { ratio: number; pass: boolean } {
  const fg = getTokenValue(theme, fgToken);
  const bg = getTokenValue(theme, bgToken);
  const ratio = contrastRatio(fg, bg);
  return { ratio, pass: ratio >= threshold };
}
