// NoteBoard 自定义颜色区：已固定的自定义色块 + 内嵌取色盘（饱和度/明度面板、色相条、十六进制输入）
// 多维表格标签、Markdown 字体颜色与高亮共用；固定的颜色存进设置（按用途分组），跨窗口同步。
//
// 取色盘刻意做成面板内嵌的 DOM，而不是系统取色对话框：
// 系统对话框会夺走焦点，Markdown 悬浮菜单随编辑器失焦隐藏、各下拉面板随外部点击关闭，选中的颜色就无处落地。

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { Pin, Plus, X } from 'lucide-react';
import { Tooltip } from '../Tooltip';
import type { CustomColorKind } from '../../core/ipc/types';
import { pinCustomColor, unpinCustomColor, useCustomColors } from '../../stores/settingsStore';
import { deriveTagColors, hexToHsv, hsvToHex, isHexColor, mixHex, normalizeHex, type Hsv } from './colorMath';
import './customColorPicker.css';

/** 色块外观：tag = 标签胶囊预览，fill = 纯色底（高亮），text = 彩色字母 A（字体颜色） */
export type CustomSwatchVariant = 'tag' | 'fill' | 'text';

const DEFAULT_PICK_COLOR = '#3b82f6';

/** 按用途生成色块样式，与该用途下内置色块的观感保持一致 */
function swatchStyle(variant: CustomSwatchVariant, color: string, width: number, height: number): CSSProperties {
  const base: CSSProperties = {
    width,
    height,
    borderRadius: variant === 'tag' ? Math.max(4, Math.round(Math.min(width, height) * 0.3)) : 4,
  };
  if (variant === 'tag') {
    const derived = deriveTagColors(color);
    return { ...base, background: derived.bg, border: `1px solid ${derived.border}` };
  }
  if (variant === 'fill') {
    return { ...base, background: color, border: `1px solid ${mixHex(color, '#000000', 0.8)}` };
  }
  // 字体颜色：色样经 --nb-text-color 取色，深色主题下与正文一样提亮
  return {
    ...base,
    '--nb-text-color': color,
    border: '1px solid var(--editor-border, rgba(0,0,0,0.12))',
    fontSize: Math.round(height * 0.54),
  } as CSSProperties;
}

/** 在元素内按指针位置计算 0~1 的相对坐标 */
function relativePoint(event: ReactPointerEvent<HTMLElement>): { x: number; y: number } {
  const rect = event.currentTarget.getBoundingClientRect();
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  return {
    x: clamp((event.clientX - rect.left) / Math.max(1, rect.width)),
    y: clamp((event.clientY - rect.top) / Math.max(1, rect.height)),
  };
}

/** 内嵌取色盘 */
function ColorPickerPanel({
  initialColor,
  onApply,
  onPin,
}: {
  initialColor: string;
  onApply: (hex: string) => void;
  onPin: (hex: string) => void;
}) {
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(initialColor));
  const [hexInput, setHexInput] = useState(initialColor.toUpperCase());
  const hex = hsvToHex(hsv);
  const typed = normalizeHex(hexInput);

  /** 拖动面板 / 色相条时同步十六进制输入框 */
  const updateHsv = (next: Hsv) => {
    setHsv(next);
    setHexInput(hsvToHex(next).toUpperCase());
  };

  /** 通用拖动：按下即取值并捕获指针，移动持续取值 */
  const bindDrag = (pick: (point: { x: number; y: number }) => void) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      // 阻止默认行为：保留编辑器焦点与选区，避免悬浮菜单随失焦隐藏
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      pick(relativePoint(event));
    },
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      pick(relativePoint(event));
    },
  });

  /** 十六进制输入合法时同步到面板；灰阶色没有色相，沿用当前色相避免色相条跳回红色 */
  const syncFromInput = (value: string) => {
    setHexInput(value);
    const next = normalizeHex(value);
    if (!next) return;
    const parsed = hexToHsv(next);
    setHsv(parsed.s === 0 ? { ...parsed, h: hsv.h } : parsed);
  };

  const pureHue = hsvToHex({ h: hsv.h, s: 1, v: 1 });

  return (
    <div className="nb-cc-picker">
      <div
        className="nb-cc-sv"
        style={{ backgroundColor: pureHue }}
        {...bindDrag(({ x, y }) => updateHsv({ h: hsv.h, s: x, v: 1 - y }))}
      >
        <span className="nb-cc-thumb" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hex }} />
      </div>
      <div className="nb-cc-hue" {...bindDrag(({ x }) => updateHsv({ ...hsv, h: Math.min(359.9, x * 360) }))}>
        <span className="nb-cc-thumb" style={{ left: `${(hsv.h / 360) * 100}%`, background: pureHue }} />
      </div>
      <div className="nb-cc-controls">
        <span className="nb-cc-preview" style={{ background: typed ?? hex }} />
        <input
          className={`nb-cc-hex${typed ? '' : ' is-invalid'}`}
          value={hexInput}
          maxLength={7}
          spellCheck={false}
          aria-label="十六进制颜色"
          placeholder="#3B82F6"
          onChange={(event) => syncFromInput(event.target.value)}
          onKeyDown={(event) => {
            // 输入框内的按键不外溢：避免触发表格删行、编辑器快捷键等；Esc 仍交给外层关闭面板
            if (event.key !== 'Escape') event.stopPropagation();
            if (event.key === 'Enter' && typed) {
              event.preventDefault();
              onApply(typed);
            }
          }}
        />
      </div>
      <div className="nb-cc-controls">
        <button
          type="button"
          className="nb-cc-btn"
          style={{ flex: 1 }}
          disabled={!typed}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => typed && onApply(typed)}
        >
          使用
        </button>
        <Tooltip content="固定到色板，以后可直接选用" side="top" sideOffset={4} delayDuration={100}>
          <button
            type="button"
            className="nb-cc-btn is-primary"
            style={{ flex: 1 }}
            disabled={!typed}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => typed && onPin(typed)}
          >
            <Pin size={12} />
            固定
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

export interface CustomColorSectionProps {
  /** 固定颜色所属用途（各用途分开保存） */
  kind: CustomColorKind;
  variant: CustomSwatchVariant;
  /** 当前生效的颜色，用于标出选中态与作为取色盘初值 */
  activeColor?: string | null;
  /** 内置色板的颜色值：当前颜色属于内置色时不再额外显示「未固定」色块 */
  presetColors?: string[];
  onSelect: (hex: string) => void;
  swatchWidth?: number;
  swatchHeight?: number;
}

/** 自定义颜色区：固定色块 + 「+」打开取色盘 */
export function CustomColorSection({
  kind,
  variant,
  activeColor,
  presetColors,
  onSelect,
  swatchWidth = 20,
  swatchHeight = swatchWidth,
}: CustomColorSectionProps) {
  const pinned = useCustomColors(kind);
  const [pickerOpen, setPickerOpen] = useState(false);
  const active = typeof activeColor === 'string' ? activeColor.toLowerCase() : null;
  // 取色盘每次打开都从当前颜色起步
  const [pickerSeed, setPickerSeed] = useState(DEFAULT_PICK_COLOR);
  const rootRef = useRef<HTMLDivElement>(null);

  // 当前颜色是自定义色但尚未固定（如他人文档里的颜色）时，额外显示一个可固定的色块
  const unpinnedActive =
    active && isHexColor(active) && !pinned.includes(active) && !presetColors?.some((c) => c.toLowerCase() === active)
      ? active
      : null;

  useEffect(() => {
    if (!pickerOpen) return;
    // 展开后把取色盘滚入可见区域（面板底部空间不足时）
    rootRef.current?.scrollIntoView({ block: 'nearest' });
  }, [pickerOpen]);

  const togglePicker = () => {
    if (!pickerOpen) setPickerSeed(active && isHexColor(active) ? active : pinned[pinned.length - 1] ?? DEFAULT_PICK_COLOR);
    setPickerOpen((open) => !open);
  };

  const renderSwatch = (color: string, removable: boolean) => (
    <Tooltip
      key={color}
      content={removable ? `${color.toUpperCase()}` : `${color.toUpperCase()}（未固定）`}
      side="top"
      sideOffset={4}
      delayDuration={100}
    >
      <button
        type="button"
        aria-label={color}
        className={`nb-cc-swatch${variant === 'text' ? ' nb-text-color-preview' : ''}${active === color ? ' is-active' : ''}`}
        style={swatchStyle(variant, color, swatchWidth, swatchHeight)}
        // 阻止默认行为，保留编辑器焦点与选区
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onSelect(color)}
      >
        {variant === 'text' && 'A'}
        {removable ? (
          <span
            role="button"
            aria-label="删除自定义颜色"
            className="nb-cc-remove"
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.stopPropagation();
              unpinCustomColor(kind, color);
            }}
          >
            <X size={10} strokeWidth={3} />
          </span>
        ) : (
          <span
            role="button"
            aria-label="固定此颜色"
            className="nb-cc-remove"
            style={{ background: 'var(--editor-accent, #3b82f6)' }}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.stopPropagation();
              pinCustomColor(kind, color);
            }}
          >
            <Pin size={9} strokeWidth={3} />
          </span>
        )}
      </button>
    </Tooltip>
  );

  return (
    <div ref={rootRef} className="nb-cc">
      <div className="nb-cc-row">
        {pinned.map((color) => renderSwatch(color, true))}
        {unpinnedActive && renderSwatch(unpinnedActive, false)}
        <Tooltip content={pickerOpen ? '收起取色盘' : '自定义颜色'} side="top" sideOffset={4} delayDuration={100}>
          <button
            type="button"
            aria-label="自定义颜色"
            aria-expanded={pickerOpen}
            className={`nb-cc-add${pickerOpen ? ' is-open' : ''}`}
            style={{ width: swatchWidth, height: swatchHeight }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={togglePicker}
          >
            <Plus size={Math.max(11, Math.round(Math.min(swatchWidth, swatchHeight) * 0.6))} />
          </button>
        </Tooltip>
      </div>
      {pickerOpen && (
        <ColorPickerPanel
          key={pickerSeed}
          initialColor={pickerSeed}
          onApply={(hex) => onSelect(hex)}
          onPin={(hex) => {
            pinCustomColor(kind, hex);
            setPickerOpen(false);
            onSelect(hex);
          }}
        />
      )}
    </div>
  );
}
