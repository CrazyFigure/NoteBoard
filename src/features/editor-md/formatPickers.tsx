// NoteBoard 对齐 / 缩进与字体颜色的共享界面元素
// 悬浮菜单、右键菜单与顶部操作栏共用同一套文案、图标与色板，保证三处入口一致。

import { useState, type CSSProperties } from 'react';
import { AlignCenter, AlignLeft, AlignRight, IndentDecrease, IndentIncrease, X, type LucideIcon } from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';
import { TEXT_COLORS } from './markdownInlineMarks';
import type { BlockAlign } from './blockFormat';

/** 对齐选项（顺序即菜单顺序） */
export const ALIGN_OPTIONS: Array<{ align: BlockAlign; label: string; Icon: LucideIcon }> = [
  { align: 'left', label: '左对齐', Icon: AlignLeft },
  { align: 'center', label: '居中对齐', Icon: AlignCenter },
  { align: 'right', label: '右对齐', Icon: AlignRight },
];

/** 缩进选项（delta：1 增加，-1 减少） */
export const INDENT_OPTIONS: Array<{ delta: 1 | -1; label: string; Icon: LucideIcon }> = [
  { delta: 1, label: '增加缩进', Icon: IndentIncrease },
  { delta: -1, label: '减少缩进', Icon: IndentDecrease },
];

/** 当前对齐方式对应的图标 */
export function AlignIcon({ align, size = 16 }: { align: BlockAlign; size?: number }) {
  const Icon = ALIGN_OPTIONS.find((option) => option.align === align)?.Icon ?? AlignLeft;
  return <Icon size={size} />;
}

/** 字体颜色图标：字母 A + 当前颜色色条（未设置颜色时色条跟随文字色） */
export function TextColorIcon({ color, size = 16 }: { color?: string | null; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 16 6-12 6 12" />
      <path d="M8 12h8" />
      <rect
        x="4"
        y="18.5"
        width="16"
        height="3.5"
        rx="1"
        stroke="none"
        fill="currentColor"
        // 有颜色时由色样类取色（深色主题下同样提亮），否则跟随文字色
        className={color ? 'nb-text-color-preview' : undefined}
        style={color ? ({ '--nb-text-color': color } as CSSProperties) : undefined}
      />
    </svg>
  );
}

/** 单个颜色色块：显示该颜色的字母 A，深色主题下与正文同样提亮 */
function TextColorSwatch({
  name,
  color,
  active,
  onSelect,
}: {
  name: string;
  color: string;
  active: boolean;
  onSelect: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  return (
    <Tooltip content={name} side="top" sideOffset={4}>
      <button
        type="button"
        aria-label={name}
        // 阻止默认行为，保留编辑器焦点与选区
        onMouseDown={(e) => {
          e.preventDefault();
          setPressed(true);
        }}
        onMouseUp={() => setPressed(false)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => {
          setHovered(false);
          setPressed(false);
        }}
        onClick={onSelect}
        className="nb-text-color-preview"
        style={{
          '--nb-text-color': color,
          width: 32,
          height: 26,
          padding: 0,
          borderRadius: 4,
          border: active ? '2px solid var(--nb-text-color)' : '1px solid var(--editor-border, rgba(0,0,0,0.12))',
          background: hovered ? 'var(--editor-hover-background, rgba(0,0,0,0.06))' : 'transparent',
          cursor: 'pointer',
          fontSize: 14,
          fontWeight: 700,
          lineHeight: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transform: pressed ? 'scale(0.92)' : hovered ? 'scale(1.1)' : 'scale(1)',
          transition: 'transform 100ms ease, background-color 100ms ease',
        } as CSSProperties}
      >
        A
      </button>
    </Tooltip>
  );
}

/** 字体颜色色板：8 色网格 + 恢复默认颜色 */
export function TextColorGrid({
  activeColor,
  onSelect,
  onClear,
}: {
  activeColor?: string | null;
  onSelect: (color: string) => void;
  onClear: () => void;
}) {
  const [clearHovered, setClearHovered] = useState(false);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--editor-text-secondary, #64748b)', paddingLeft: 2 }}>
        选择字体颜色
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
        {TEXT_COLORS.map((item) => (
          <TextColorSwatch
            key={item.color}
            name={item.name}
            color={item.color}
            active={activeColor?.toLowerCase() === item.color}
            onSelect={() => onSelect(item.color)}
          />
        ))}
      </div>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onMouseEnter={() => setClearHovered(true)}
        onMouseLeave={() => setClearHovered(false)}
        onClick={onClear}
        style={{
          marginTop: 2,
          padding: '4px 8px',
          border: '1px solid var(--control-border, rgba(0,0,0,0.1))',
          borderRadius: 4,
          background: clearHovered ? 'var(--editor-hover-background, rgba(0,0,0,0.06))' : 'transparent',
          color: 'var(--editor-text-secondary, #64748b)',
          cursor: 'pointer',
          fontSize: 12,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 4,
          transition: 'background-color 100ms ease',
        }}
      >
        <X size={13} />
        <span>默认颜色</span>
      </button>
    </div>
  );
}
