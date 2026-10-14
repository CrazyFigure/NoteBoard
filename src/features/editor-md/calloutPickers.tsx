// NoteBoard 高亮块：图标库、颜色预设与选择面板
// 图标全部来自本地打包的 lucide 线性图标（无需联网，国内网络环境下同样可用），按场景分组；
// 颜色为 9 种预设 + 自定义十六进制色，预设色在各主题下由样式表单独调校，自定义色按主题自动混合出底色与描边。

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  AlarmClock,
  Award,
  Ban,
  BookOpen,
  Bookmark,
  Brain,
  Bug,
  CalendarDays,
  Camera,
  Check,
  CircleAlert,
  CircleCheckBig,
  CircleHelp,
  CircleOff,
  CircleX,
  Clock,
  Code,
  Coffee,
  Compass,
  Crown,
  Eye,
  Feather,
  Flag,
  Flame,
  Gem,
  Gift,
  Globe,
  GraduationCap,
  Hash,
  Heart,
  Highlighter,
  Info,
  Key,
  Leaf,
  Lightbulb,
  Link,
  ListTodo,
  Lock,
  MapPin,
  Megaphone,
  MessageCircle,
  Moon,
  Music,
  NotebookPen,
  Palette,
  Paperclip,
  PenLine,
  Pin,
  Puzzle,
  Quote,
  RectangleHorizontal,
  Rocket,
  Search,
  Settings,
  ShieldCheck,
  Smile,
  Sparkles,
  Star,
  Sun,
  Target,
  Terminal,
  ThumbsUp,
  TriangleAlert,
  Trophy,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { IS_MOBILE_UI } from '../../core/platform';
import { Tooltip } from '../../components/Tooltip';

// ── 颜色 ──

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

// ── 图标 ──

export interface CalloutIconDef {
  /** 写入 Markdown 的图标名（与 lucide 图标名一致） */
  id: string;
  label: string;
  Icon: LucideIcon;
}

/** 图标分组（面板中按组展示） */
export const CALLOUT_ICON_GROUPS: Array<{ label: string; icons: CalloutIconDef[] }> = [
  {
    label: '提示',
    icons: [
      { id: 'lightbulb', label: '灵感', Icon: Lightbulb },
      { id: 'info', label: '信息', Icon: Info },
      { id: 'circle-alert', label: '提醒', Icon: CircleAlert },
      { id: 'triangle-alert', label: '注意', Icon: TriangleAlert },
      { id: 'circle-check-big', label: '完成', Icon: CircleCheckBig },
      { id: 'circle-x', label: '错误', Icon: CircleX },
      { id: 'circle-help', label: '疑问', Icon: CircleHelp },
      { id: 'ban', label: '禁止', Icon: Ban },
      { id: 'sparkles', label: '亮点', Icon: Sparkles },
      { id: 'star', label: '收藏', Icon: Star },
      { id: 'flame', label: '热门', Icon: Flame },
      { id: 'zap', label: '速记', Icon: Zap },
    ],
  },
  {
    label: '学习工作',
    icons: [
      { id: 'book-open', label: '阅读', Icon: BookOpen },
      { id: 'graduation-cap', label: '学习', Icon: GraduationCap },
      { id: 'notebook-pen', label: '笔记', Icon: NotebookPen },
      { id: 'pen-line', label: '书写', Icon: PenLine },
      { id: 'highlighter', label: '划重点', Icon: Highlighter },
      { id: 'list-todo', label: '待办', Icon: ListTodo },
      { id: 'target', label: '目标', Icon: Target },
      { id: 'flag', label: '里程碑', Icon: Flag },
      { id: 'calendar-days', label: '日程', Icon: CalendarDays },
      { id: 'clock', label: '时间', Icon: Clock },
      { id: 'alarm-clock', label: '闹钟', Icon: AlarmClock },
      { id: 'brain', label: '思考', Icon: Brain },
    ],
  },
  {
    label: '技术',
    icons: [
      { id: 'code', label: '代码', Icon: Code },
      { id: 'terminal', label: '终端', Icon: Terminal },
      { id: 'bug', label: '缺陷', Icon: Bug },
      { id: 'wrench', label: '工具', Icon: Wrench },
      { id: 'settings', label: '设置', Icon: Settings },
      { id: 'key', label: '密钥', Icon: Key },
      { id: 'lock', label: '安全', Icon: Lock },
      { id: 'shield-check', label: '防护', Icon: ShieldCheck },
      { id: 'link', label: '链接', Icon: Link },
      { id: 'paperclip', label: '附件', Icon: Paperclip },
      { id: 'hash', label: '话题', Icon: Hash },
      { id: 'search', label: '搜索', Icon: Search },
    ],
  },
  {
    label: '生活',
    icons: [
      { id: 'heart', label: '喜爱', Icon: Heart },
      { id: 'thumbs-up', label: '点赞', Icon: ThumbsUp },
      { id: 'smile', label: '微笑', Icon: Smile },
      { id: 'coffee', label: '咖啡', Icon: Coffee },
      { id: 'gift', label: '礼物', Icon: Gift },
      { id: 'trophy', label: '奖杯', Icon: Trophy },
      { id: 'award', label: '荣誉', Icon: Award },
      { id: 'crown', label: '皇冠', Icon: Crown },
      { id: 'gem', label: '宝石', Icon: Gem },
      { id: 'rocket', label: '发布', Icon: Rocket },
      { id: 'leaf', label: '自然', Icon: Leaf },
      { id: 'sun', label: '晴天', Icon: Sun },
      { id: 'moon', label: '夜晚', Icon: Moon },
      { id: 'music', label: '音乐', Icon: Music },
      { id: 'camera', label: '摄影', Icon: Camera },
      { id: 'map-pin', label: '地点', Icon: MapPin },
      { id: 'globe', label: '全球', Icon: Globe },
      { id: 'compass', label: '探索', Icon: Compass },
      { id: 'palette', label: '设计', Icon: Palette },
      { id: 'puzzle', label: '拼图', Icon: Puzzle },
      { id: 'megaphone', label: '公告', Icon: Megaphone },
      { id: 'message-circle', label: '讨论', Icon: MessageCircle },
      { id: 'quote', label: '引用', Icon: Quote },
      { id: 'bookmark', label: '书签', Icon: Bookmark },
      { id: 'pin', label: '置顶', Icon: Pin },
      { id: 'eye', label: '关注', Icon: Eye },
      { id: 'feather', label: '随笔', Icon: Feather },
    ],
  },
];

const ICON_MAP = new Map(CALLOUT_ICON_GROUPS.flatMap((group) => group.icons.map((icon) => [icon.id, icon] as const)));

/** 默认图标 */
export const DEFAULT_CALLOUT_ICON = 'lightbulb';

/** 按图标名查找图标定义；未知图标名（如手写的其他名称）返回 undefined */
export function getCalloutIcon(id: string): CalloutIconDef | undefined {
  return ICON_MAP.get(id);
}

/** 渲染图标；未知图标名退化为通用的亮点图标（源码中的图标名保持不变） */
export function CalloutIconGlyph({ id, size = 16 }: { id: string; size?: number }) {
  const Icon = ICON_MAP.get(id)?.Icon ?? Sparkles;
  return <Icon size={size} strokeWidth={2} aria-hidden="true" />;
}

// ── 菜单预设 ──

export interface CalloutPreset {
  id: string;
  label: string;
  color: string;
  /** 空字符串表示不带图标 */
  icon: string;
  description: string;
}

/** 插入菜单中的常用组合（插入后仍可随时改颜色与图标） */
export const CALLOUT_PRESETS: CalloutPreset[] = [
  { id: 'tip', label: '灵感', color: 'blue', icon: 'lightbulb', description: '蓝色 · 灵感与补充说明' },
  { id: 'success', label: '成功', color: 'green', icon: 'circle-check-big', description: '绿色 · 完成、推荐做法' },
  { id: 'warning', label: '注意', color: 'yellow', icon: 'triangle-alert', description: '黄色 · 需要留意的事项' },
  { id: 'danger', label: '警告', color: 'red', icon: 'circle-alert', description: '红色 · 风险与禁止事项' },
  { id: 'highlight', label: '重点', color: 'purple', icon: 'sparkles', description: '紫色 · 核心结论、亮点' },
  { id: 'plain', label: '纯色', color: 'gray', icon: '', description: '灰色 · 不带图标的底色块' },
];

/** 菜单中预设的图标：带图标的预设显示该图标，纯色预设显示一个色块 */
export function CalloutPresetIcon({ preset, size = 15 }: { preset: CalloutPreset; size?: number }) {
  const hex = calloutColorHex(preset.color);
  if (!preset.icon) return <RectangleHorizontal size={size} color={hex} fill={`${hex}33`} />;
  const Icon = ICON_MAP.get(preset.icon)?.Icon ?? Sparkles;
  return <Icon size={size} color={hex} />;
}

// ── 选择面板 ──

const VIEWPORT_PADDING = 8;

/**
 * 锚定在触发按钮上的浮层（Portal 到 body + fixed 定位，避免被编辑区滚动容器裁剪）：
 * 优先在下方展开，空间不足时翻到上方，并夹进视口；点按外部、Esc、外部滚动时关闭。
 */
function CalloutPopover({
  anchor,
  width,
  onClose,
  children,
}: {
  anchor: HTMLElement;
  width: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  // 窄屏下面板宽度不超过视口
  const effectiveWidth = Math.min(width, window.innerWidth - VIEWPORT_PADDING * 2);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const rect = anchor.getBoundingClientRect();
    const height = panel.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // 右侧放得下时与锚点左对齐（块左侧的图标），否则与锚点右对齐（右上角的工具栏），最后夹进视口
    const preferred = rect.left + effectiveWidth <= vw - VIEWPORT_PADDING ? rect.left : rect.right - effectiveWidth;
    const left = Math.max(VIEWPORT_PADDING, Math.min(preferred, vw - effectiveWidth - VIEWPORT_PADDING));
    const below = vh - rect.bottom - VIEWPORT_PADDING - 6;
    const above = rect.top - VIEWPORT_PADDING - 6;
    if (height <= below || below >= above) {
      setLayout({ top: rect.bottom + 6, left, maxHeight: Math.max(160, below) });
    } else {
      const maxHeight = Math.max(160, above);
      setLayout({ top: Math.max(VIEWPORT_PADDING, rect.top - 6 - Math.min(height, maxHeight)), left, maxHeight });
    }
  }, [anchor, effectiveWidth]);

  useEffect(() => {
    const inside = (target: EventTarget | null) =>
      target instanceof globalThis.Node && (panelRef.current?.contains(target) || anchor.contains(target));
    const handlePointer = (event: PointerEvent) => {
      if (!inside(event.target)) onClose();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    // 外部滚动会让 fixed 定位与锚点错开，直接关闭；面板自身滚动不关闭
    const handleScroll = (event: Event) => {
      if (!inside(event.target)) onClose();
    };
    // 移动端软键盘弹出/收起只改变视口高度，不关闭面板（面板内有十六进制输入框）
    let lastWidth = window.innerWidth;
    const handleResize = () => {
      if (IS_MOBILE_UI && window.innerWidth === lastWidth) return;
      lastWidth = window.innerWidth;
      onClose();
    };
    document.addEventListener('pointerdown', handlePointer, true);
    document.addEventListener('keydown', handleKey, true);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleResize);
    return () => {
      document.removeEventListener('pointerdown', handlePointer, true);
      document.removeEventListener('keydown', handleKey, true);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleResize);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={panelRef}
      className="nb-callout-popover"
      style={{
        width: effectiveWidth,
        top: layout?.top ?? -9999,
        left: layout?.left ?? -9999,
        maxHeight: layout?.maxHeight,
        visibility: layout ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

/** 颜色选择面板：预设色块 + 自定义颜色（系统取色器与十六进制输入） */
export function CalloutColorPicker({
  anchor,
  color,
  onChange,
  onClose,
}: {
  anchor: HTMLElement;
  color: string;
  onChange: (color: string) => void;
  onClose: () => void;
}) {
  const custom = !isPresetColor(color);
  const [hexInput, setHexInput] = useState(() => calloutColorHex(color).toUpperCase());
  const nativeRef = useRef<HTMLInputElement>(null);
  const valid = normalizeHexInput(hexInput) !== null;

  useEffect(() => {
    setHexInput(calloutColorHex(color).toUpperCase());
  }, [color]);

  // 系统取色器拖动时只预览输入框中的值，确认（change）后才写入文档，避免产生大量撤销步骤
  useEffect(() => {
    const input = nativeRef.current;
    if (!input) return;
    const handleChange = () => {
      const next = normalizeHexInput(input.value);
      if (next) onChange(next);
    };
    input.addEventListener('change', handleChange);
    return () => input.removeEventListener('change', handleChange);
  }, [onChange]);

  /** 应用输入框中的十六进制色 */
  const applyHex = () => {
    const next = normalizeHexInput(hexInput);
    if (next && next !== color) onChange(next);
  };

  return (
    <CalloutPopover anchor={anchor} width={252} onClose={onClose}>
      <div className="nb-callout-popover-title">底色</div>
      <div className="nb-callout-swatches" role="listbox" aria-label="高亮块颜色">
        {CALLOUT_COLORS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            role="option"
            aria-selected={preset.id === color}
            aria-label={preset.label}
            className={`nb-callout-swatch${preset.id === color ? ' is-active' : ''}`}
            data-color={preset.id}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onChange(preset.id);
              onClose();
            }}
          >
            {preset.id === color && <Check size={14} strokeWidth={2.6} />}
          </button>
        ))}
      </div>
      <div className="nb-callout-popover-title">自定义</div>
      <div className="nb-callout-custom">
        <label className={`nb-callout-swatch is-native${custom ? ' is-active' : ''}`} aria-label="打开取色器">
          <span className="nb-callout-native-preview" style={{ background: valid ? normalizeHexInput(hexInput)! : calloutColorHex(color) }} />
          <input
            ref={nativeRef}
            type="color"
            value={calloutColorHex(color)}
            onInput={(event) => setHexInput(event.currentTarget.value.toUpperCase())}
            onChange={() => {
              /* 由原生 change 监听写入文档 */
            }}
          />
        </label>
        <input
          className={`nb-callout-hex${valid ? '' : ' is-invalid'}`}
          value={hexInput}
          spellCheck={false}
          maxLength={7}
          aria-label="十六进制颜色"
          placeholder="#3B82F6"
          onChange={(event) => setHexInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              applyHex();
            }
          }}
          onBlur={applyHex}
        />
      </div>
    </CalloutPopover>
  );
}

/** 图标选择面板：不显示图标 + 分组图标网格 */
export function CalloutIconPicker({
  anchor,
  icon,
  onChange,
  onClose,
}: {
  anchor: HTMLElement;
  icon: string;
  onChange: (icon: string) => void;
  onClose: () => void;
}) {
  /** 选择后立即关闭面板 */
  const choose = (next: string) => {
    if (next !== icon) onChange(next);
    onClose();
  };

  return (
    <CalloutPopover anchor={anchor} width={IS_MOBILE_UI ? 340 : 312} onClose={onClose}>
      <button
        type="button"
        className={`nb-callout-icon-none${icon === '' ? ' is-active' : ''}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => choose('')}
      >
        <CircleOff size={15} />
        <span>不显示图标</span>
        {icon === '' && <Check size={14} className="nb-callout-icon-none-check" />}
      </button>
      {CALLOUT_ICON_GROUPS.map((group) => (
        <div key={group.label}>
          <div className="nb-callout-popover-title">{group.label}</div>
          <div className="nb-callout-icon-grid" role="listbox" aria-label={group.label}>
            {group.icons.map((item) => (
              <Tooltip key={item.id} content={item.label} side="top" sideOffset={4}>
                <button
                  type="button"
                  role="option"
                  aria-selected={item.id === icon}
                  aria-label={item.label}
                  className={`nb-callout-icon-cell${item.id === icon ? ' is-active' : ''}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(item.id)}
                >
                  <item.Icon size={18} strokeWidth={1.9} />
                </button>
              </Tooltip>
            ))}
          </div>
        </div>
      ))}
    </CalloutPopover>
  );
}
