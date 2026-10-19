// NoteBoard 思维导图标题选中文字后的格式悬浮菜单
// 加粗 / 斜体 / 下划线 / 删除线 / 文字颜色 / 高亮背景 / 清除格式。
// 菜单按钮在 mousedown 阶段阻止默认行为，保证编辑框不失焦、选区不丢失。
// 详见 docs/09-开发路线图.md

import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Ban,
  Baseline,
  Bold,
  ChevronDown,
  Highlighter,
  Italic,
  RemoveFormatting,
  Strikethrough,
  Underline,
} from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';
import { stopReactPropagation } from '../bitable/bitableUtils';
import {
  HIGHLIGHT_PRESETS,
  TEXT_COLOR_PRESETS,
  type StylePatch,
  type ToggleStyleKey,
} from './mindmapRichText';

/** 当前选区的格式状态（用于按钮激活态） */
export interface FormatState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  color?: string;
  highlight?: string;
}

interface MindmapTextFormatMenuProps {
  rect: { left: number; top: number; bottom: number; width: number };
  state: FormatState;
  onPatch: (patch: StylePatch) => void;
}

const TOGGLES: Array<{ key: ToggleStyleKey; label: string; shortcut?: string; Icon: typeof Bold }> = [
  { key: 'bold', label: '加粗', shortcut: 'Ctrl+B', Icon: Bold },
  { key: 'italic', label: '斜体', shortcut: 'Ctrl+I', Icon: Italic },
  { key: 'underline', label: '下划线', shortcut: 'Ctrl+U', Icon: Underline },
  { key: 'strike', label: '删除线', Icon: Strikethrough },
];

/** 阻止按下时抢走编辑框焦点，同时不让事件沿 React 树冒泡到画布 */
const keepSelection = (e: React.MouseEvent | React.PointerEvent) => {
  e.preventDefault();
  stopReactPropagation(e);
};

export function MindmapTextFormatMenu({ rect, state, onPatch }: MindmapTextFormatMenuProps) {
  const [palette, setPalette] = useState<'color' | 'highlight' | null>(null);
  // 选区上方空间不足时改为显示在下方
  const placeBelow = rect.top < 56;
  const left = Math.min(Math.max(rect.left + rect.width / 2, 170), window.innerWidth - 170);
  const top = placeBelow ? rect.bottom + 8 : rect.top - 8;

  const presets = palette === 'color' ? TEXT_COLOR_PRESETS : HIGHLIGHT_PRESETS;
  const current = palette === 'color' ? state.color : state.highlight;

  return createPortal(
    <div
      className="nb-mindmap-format-menu"
      role="toolbar"
      aria-label="文字格式"
      onMouseDown={keepSelection}
      onPointerDown={keepSelection}
      onClick={stopReactPropagation}
      onDoubleClick={stopReactPropagation}
      style={{
        left,
        top,
        transform: placeBelow ? 'translateX(-50%)' : 'translate(-50%, -100%)',
      }}
    >
      <div className="nb-mindmap-format-row">
        {TOGGLES.map(({ key, label, shortcut, Icon }) => (
          <Tooltip key={key} content={label} shortcut={shortcut} side="top" sideOffset={6}>
            <button
              type="button"
              className="nb-mindmap-format-btn"
              data-active={state[key]}
              aria-label={label}
              aria-pressed={state[key]}
              onClick={() => onPatch({ type: 'toggle', key })}
            >
              <Icon size={14} />
            </button>
          </Tooltip>
        ))}
        <span className="nb-mindmap-format-divider" />
        <Tooltip content="文字颜色" side="top" sideOffset={6}>
          <button
            type="button"
            className="nb-mindmap-format-btn is-wide"
            data-active={palette === 'color'}
            aria-label="文字颜色"
            onClick={() => setPalette((p) => (p === 'color' ? null : 'color'))}
          >
            <Baseline size={14} style={{ color: state.color }} />
            <ChevronDown size={10} style={{ opacity: 0.6 }} />
          </button>
        </Tooltip>
        <Tooltip content="高亮背景" side="top" sideOffset={6}>
          <button
            type="button"
            className="nb-mindmap-format-btn is-wide"
            data-active={palette === 'highlight'}
            aria-label="高亮背景"
            onClick={() => setPalette((p) => (p === 'highlight' ? null : 'highlight'))}
          >
            <Highlighter size={14} style={{ background: state.highlight, borderRadius: 2 }} />
            <ChevronDown size={10} style={{ opacity: 0.6 }} />
          </button>
        </Tooltip>
        <span className="nb-mindmap-format-divider" />
        <Tooltip content="清除格式" side="top" sideOffset={6}>
          <button
            type="button"
            className="nb-mindmap-format-btn"
            aria-label="清除格式"
            onClick={() => onPatch({ type: 'clear' })}
          >
            <RemoveFormatting size={14} />
          </button>
        </Tooltip>
      </div>

      {/* 颜色面板：文字颜色 / 高亮背景共用 */}
      {palette && (
        <div className="nb-mindmap-format-palette" role="radiogroup" aria-label={palette === 'color' ? '文字颜色' : '高亮背景'}>
          <Tooltip content={palette === 'color' ? '默认颜色' : '无高亮'} side="bottom" sideOffset={4}>
            <button
              type="button"
              className="nb-mindmap-format-swatch"
              data-active={!current}
              aria-label={palette === 'color' ? '默认颜色' : '无高亮'}
              onClick={() => onPatch({ type: 'color', key: palette, value: null })}
            >
              <Ban size={12} />
            </button>
          </Tooltip>
          {presets.map((preset) => (
            <Tooltip key={preset.value} content={preset.name} side="bottom" sideOffset={4}>
              <button
                type="button"
                className="nb-mindmap-format-swatch"
                data-active={current === preset.value}
                aria-label={preset.name}
                onClick={() => onPatch({ type: 'color', key: palette, value: preset.value })}
              >
                {palette === 'color' ? (
                  <span style={{ color: preset.value, fontWeight: 700, fontSize: 13 }}>A</span>
                ) : (
                  <span className="nb-mindmap-format-chip" style={{ background: preset.value }} />
                )}
              </button>
            </Tooltip>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}
