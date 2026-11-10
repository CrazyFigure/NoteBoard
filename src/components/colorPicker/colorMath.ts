// NoteBoard 自定义取色的纯函数：十六进制规整、HSV 互转与派生色
// 不依赖 DOM，供取色面板、多维表格标签派生配色与单测共用。

/** 合法的 6 位十六进制颜色（统一小写存储） */
const HEX6_PATTERN = /^#[0-9a-f]{6}$/;

/** 规整用户输入的十六进制色：补 #、展开 3 位简写、统一小写；非法输入返回 null */
export function normalizeHex(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let value = input.trim().toLowerCase();
  if (!value) return null;
  if (!value.startsWith('#')) value = `#${value}`;
  if (/^#[0-9a-f]{3}$/.test(value)) {
    value = `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
  }
  return HEX6_PATTERN.test(value) ? value : null;
}

/** 是否为规整后的自定义十六进制色 */
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX6_PATTERN.test(value.toLowerCase());
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Hsv {
  /** 色相 0~360 */
  h: number;
  /** 饱和度 0~1 */
  s: number;
  /** 明度 0~1 */
  v: number;
}

/** 十六进制 → RGB（调用方保证输入已规整） */
export function hexToRgb(hex: string): Rgb {
  const value = parseInt(hex.slice(1), 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

/** RGB → 十六进制（分量越界时夹紧） */
export function rgbToHex({ r, g, b }: Rgb): string {
  const part = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** RGB → HSV */
export function rgbToHsv({ r, g, b }: Rgb): Hsv {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

/** HSV → RGB */
export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const c = v * s;
  const hh = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  let rgb: [number, number, number] = [0, 0, 0];
  if (hh < 1) rgb = [c, x, 0];
  else if (hh < 2) rgb = [x, c, 0];
  else if (hh < 3) rgb = [0, c, x];
  else if (hh < 4) rgb = [0, x, c];
  else if (hh < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const m = v - c;
  return { r: (rgb[0] + m) * 255, g: (rgb[1] + m) * 255, b: (rgb[2] + m) * 255 };
}

export function hexToHsv(hex: string): Hsv {
  return rgbToHsv(hexToRgb(hex));
}

export function hsvToHex(hsv: Hsv): string {
  return rgbToHex(hsvToRgb(hsv));
}

/** 两色按比例混合：ratio 为 a 的占比（0~1） */
export function mixHex(a: string, b: string, ratio: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return rgbToHex({
    r: ca.r * ratio + cb.r * (1 - ratio),
    g: ca.g * ratio + cb.g * (1 - ratio),
    b: ca.b * ratio + cb.b * (1 - ratio),
  });
}

/** WCAG 相对亮度 */
function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const channel = (n: number) => {
    const c = n / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 对比度（1~21） */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * 由一个自定义色派生标签三色（与内置色板同构：bg 底色 / text 文字 / border 描边）。
 * - 底色：主色混入白色，保持内置色板「浅底胶囊」的观感；
 * - 描边：比底色深一档，相邻浅底靠它区分；
 * - 文字：以主色为起点逐步压暗，直到在底色上达到 AA（4.5:1），黄、青这类亮色也能看清。
 */
export function deriveTagColors(hex: string): { bg: string; text: string; border: string } {
  const bg = mixHex(hex, '#ffffff', 0.18);
  const border = mixHex(hex, '#ffffff', 0.45);
  let text = hex;
  for (let i = 0; i < 10 && contrastRatio(text, bg) < 4.5; i += 1) {
    text = mixHex(text, '#000000', 0.85);
  }
  return { bg, text, border };
}
