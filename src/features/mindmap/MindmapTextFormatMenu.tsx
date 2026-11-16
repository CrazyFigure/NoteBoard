// NoteBoard 思维导图标题选中文字后的格式悬浮菜单
// 加粗 / 斜体 / 下划线 / 删除线 / 文字颜色 / 高亮背景 / 清除格式。
// 菜单按钮在 mousedown 阶段阻止默认行为，保证编辑框不失焦、选区不丢失。
// 颜色与节点样式浮层同步：选中全部文字时，文字颜色 / 背景即节点颜色，色板与浮层一致；
// 部分选中时为内联颜色 / 高亮，显示的颜色为实际生效值（无内联颜色时取节点颜色）。
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
import { HIGHLIGHT_PRESETS, type ColorState, type StylePatch, type ToggleStyleKey } from './mindmapRichText';
import { NODE_FILL_PRESETS, NODE_TEXT_PRESETS, textSwatchBackground } from './mindmapNodeColors';

/** 当前选区的格式状态（用于按钮激活态） */
export interface FormatState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  /** 实际生效的文字颜色 */
  color: ColorState;
  /** 部分选中时为内联高亮，选中全部文字时为节点背景色 */
  highlight: ColorState;
}

interface MindmapTextFormatMenuProps {
  rect: { left: number; top: number; bottom: number; width: number };
  state: FormatState;
  /** 是否选中了全部文字（此时颜色作用于整个节点） */
  wholeText: boolean;
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

export function MindmapTextFormatMenu({ rect, state, wholeText, onPatch }: MindmapTextFormatMenuProps) {
  const [palette, setPalette] = useState<'color' | 'highlight' | null>(null);
  // 选区上方空间不足时改为显示在下方
  const placeBelow = rect.top < 56;
  const left = Math.min(Math.max(rect.left + rect.width / 2, 170), window.innerWidth - 170);
  const top = placeBelow ? rect.bottom + 8 : rect.top - 8;

  // 选中全部文字时背景色板换成节点背景预设，与节点样式浮层一致
  const nodeFill = palette === 'highlight' && wholeText;
  const presets = palette === 'color' ? NODE_TEXT_PRESETS : nodeFill ? NODE_FILL_PRESETS : HIGHLIGHT_PRESETS;
  const currentState = palette === 'color' ? state.color : state.highlight;
  const current = currentState.value?.toLowerCase();
  const highlightLabel = wholeText ? '背景颜色' : '高亮背景';
  const defaultLabel = palette === 'color' ? '默认颜色' : nodeFill ? '默认背景' : '无高亮';

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
            <Baseline size={14} style={{ color: state.color.value }} />
            <ChevronDown size={10} style={{ opacity: 0.6 }} />
          </button>
        </Tooltip>
        <Tooltip content={highlightLabel} side="top" sideOffset={6}>
          <button
            type="button"
            className="nb-mindmap-format-btn is-wide"
            data-active={palette === 'highlight'}
            aria-label={highlightLabel}
            onClick={() => setPalette((p) => (p === 'highlight' ? null : 'highlight'))}
          >
            <Highlighter size={14} style={{ background: state.highlight.value, borderRadius: 2 }} />
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

      {/* 颜色面板：文字颜色 / 高亮背景共用；颜色不一致（mixed）时不高亮任何色块 */}
      {palette && (
        <div className="nb-mindmap-format-palette" role="radiogroup" aria-label={palette === 'color' ? '文字颜色' : highlightLabel}>
          <Tooltip content={defaultLabel} side="bottom" sideOffset={4}>
            <button
              type="button"
              className="nb-mindmap-format-swatch"
              data-active={!current && !currentState.mixed}
              aria-label={defaultLabel}
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
                data-active={current === preset.value.toLowerCase()}
                aria-label={preset.name}
                onClick={() => onPatch({ type: 'color', key: palette, value: preset.value })}
              >
                {palette === 'color' ? (
                  // 白色 / 黑色等极端颜色加衬底，浅色 / 深色主题下都看得清
                  <span
                    className="nb-mindmap-format-text-swatch"
                    style={{ color: preset.value, background: textSwatchBackground(preset.value) }}
                  >
                    A
                  </span>
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
