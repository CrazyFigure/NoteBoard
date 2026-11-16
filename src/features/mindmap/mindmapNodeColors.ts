// NoteBoard 思维导图节点配色：背景色 / 文字颜色的预设、校验与自动对比色
// 颜色只作用于设置它的节点本身，不向子节点继承，新建节点也不沿用。
// 详见 docs/09-开发路线图.md

import { hexToRgb, normalizeHex } from '../../components/colorPicker/colorMath';

export interface NodeColorPreset {
  value: string;
  name: string;
}

/** 背景色预设：前一组为浅色底（深色文字），后一组为饱和色底（白色文字） */
export const NODE_FILL_PRESETS: NodeColorPreset[] = [
  { value: '#fee2e2', name: '浅红' },
  { value: '#ffedd5', name: '浅橙' },
  { value: '#fef3c7', name: '浅黄' },
  { value: '#dcfce7', name: '浅绿' },
  { value: '#cffafe', name: '浅青' },
  { value: '#dbeafe', name: '浅蓝' },
  { value: '#ede9fe', name: '浅紫' },
  { value: '#ef4444', name: '红色' },
  { value: '#f97316', name: '橙色' },
  { value: '#eab308', name: '黄色' },
  { value: '#22c55e', name: '绿色' },
  { value: '#06b6d4', name: '青色' },
  { value: '#3b82f6', name: '蓝色' },
  { value: '#8b5cf6', name: '紫色' },
  { value: '#64748b', name: '灰色' },
];

/** 文字颜色预设 */
export const NODE_TEXT_PRESETS: NodeColorPreset[] = [
  { value: '#1f2937', name: '黑色' },
  { value: '#ffffff', name: '白色' },
  { value: '#ef4444', name: '红色' },
  { value: '#f97316', name: '橙色' },
  { value: '#ca8a04', name: '黄色' },
  { value: '#16a34a', name: '绿色' },
  { value: '#0891b2', name: '青色' },
  { value: '#2563eb', name: '蓝色' },
  { value: '#7c3aed', name: '紫色' },
  { value: '#db2777', name: '粉色' },
  { value: '#6b7280', name: '灰色' },
];

/** 浅色底上的文字颜色 */
const DARK_TEXT = '#1f2937';
/** 深色底上的文字颜色 */
const LIGHT_TEXT = '#ffffff';

/** 读取文档中的节点颜色：只接受十六进制色（统一为 6 位小写），其余视为未设置 */
export function normalizeNodeColor(value: unknown): string | undefined {
  return normalizeHex(value) ?? undefined;
}

/** sRGB 相对亮度（WCAG 定义） */
function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** 两个颜色的对比度（1 ~ 21） */
function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * 文字色样的衬底：极浅的颜色（如白色）衬深底、极深的颜色衬浅底，
 * 其余跟随表面色，保证色样在浅色 / 深色主题下都看得清
 */
export function textSwatchBackground(color: string): string {
  const hex = normalizeHex(color);
  if (!hex) return 'var(--editor-surface, #ffffff)';
  const luminance = relativeLuminance(hex);
  if (luminance > 0.8) return '#475569';
  if (luminance < 0.03) return '#e2e8f0';
  return 'var(--editor-surface, #ffffff)';
}

/** 白字可接受的最低对比度（WCAG 大号文字 / 图形标准）：中等明度的饱和色底优先用白字，观感更干净 */
const LIGHT_TEXT_MIN_CONTRAST = 3;

/** 背景色上的文字颜色（白色 / 深色二选一）；未设置文字颜色时自动使用 */
export function readableTextOn(fill: string): string {
  const hex = normalizeHex(fill);
  if (!hex) return DARK_TEXT;
  return contrastRatio(hex, LIGHT_TEXT) >= LIGHT_TEXT_MIN_CONTRAST ? LIGHT_TEXT : DARK_TEXT;
}
