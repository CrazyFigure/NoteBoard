// 高亮块的共享颜色与默认值：不依赖图标、选择面板或应用状态。
export interface CalloutColorPreset {
  id: string;
  label: string;
  /** 导出到 Markdown 内联样式时使用的颜色（其他渲染器中的显示效果） */
  hex: string;
}

/** 颜色预设（顺序即面板中的排列顺序） */
export const CALLOUT_COLORS: CalloutColorPreset[] = [
  { id: 'blue', label: '蓝色', hex: '#3b82f6' },
  { id: 'green', label: '绿色', hex: '#22c55e' },
  { id: 'yellow', label: '黄色', hex: '#eab308' },
  { id: 'orange', label: '橙色', hex: '#f97316' },
  { id: 'red', label: '红色', hex: '#ef4444' },
  { id: 'pink', label: '粉色', hex: '#ec4899' },
  { id: 'purple', label: '紫色', hex: '#8b5cf6' },
  { id: 'teal', label: '青色', hex: '#14b8a6' },
  { id: 'gray', label: '灰色', hex: '#64748b' },
];

const COLOR_PRESET_MAP = new Map(CALLOUT_COLORS.map((preset) => [preset.id, preset]));
// 自定义颜色只接受小写 6 位十六进制，保证序列化写法唯一
const CUSTOM_COLOR_PATTERN = /^#[0-9a-f]{6}$/;

/** 默认颜色 */
export const DEFAULT_CALLOUT_COLOR = 'blue';

/** 是否为预设颜色名 */
export function isPresetColor(color: string): boolean {
  return COLOR_PRESET_MAP.has(color);
}

/** 是否为合法的高亮块颜色（预设名或小写 6 位十六进制） */
export function isValidCalloutColor(color: string): boolean {
  return isPresetColor(color) || CUSTOM_COLOR_PATTERN.test(color);
}

/** 颜色对应的十六进制值（导出样式、色块预览用） */
export function calloutColorHex(color: string): string {
  return COLOR_PRESET_MAP.get(color)?.hex ?? (CUSTOM_COLOR_PATTERN.test(color) ? color : COLOR_PRESET_MAP.get(DEFAULT_CALLOUT_COLOR)!.hex);
}

/** 颜色的中文名（自定义色显示十六进制值） */
export function calloutColorLabel(color: string): string {
  return COLOR_PRESET_MAP.get(color)?.label ?? color.toUpperCase();
}

/** 把用户输入整理为规范的十六进制色（支持省略 # 与 3 位简写）；不合法时返回 null */
export function normalizeHexInput(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (!value.startsWith('#')) value = `#${value}`;
  if (/^#[0-9a-f]{3}$/.test(value)) {
    value = `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
  }
  return CUSTOM_COLOR_PATTERN.test(value) ? value : null;
}

/** 默认图标 */
export const DEFAULT_CALLOUT_ICON = 'lightbulb';