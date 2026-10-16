// NoteBoard 块格式菜单
// 单击块把手时，对列表与表格弹出小菜单，设置只影响 Markdown 写法的格式：
// - 列表：项间距（紧凑 / 宽松，宽松即 Markdown 中各项之间空一行）；
// - 表格：源码排版（紧凑 / 对齐）。Markdown 表格行之间不能有空行，没有"间距"可设。

import { useEffect, useReducer, useRef } from 'react';
import type { Editor } from '@tiptap/core';
import { SPACING_LIST_TYPES, type ListSpacing } from './markdownListSpacing';
import type { TableMarkdownStyle } from './markdownTable';

/** 该类型的块是否有可设置的格式 */
export function hasBlockFormatMenu(nodeType: string | null): boolean {
  return nodeType === 'table' || (nodeType !== null && SPACING_LIST_TYPES.includes(nodeType));
}

interface FormatOption {
  value: string;
  label: string;
  /** 当前属性值属于该选项时为选中态 */
  matches: (current: unknown) => boolean;
  /** 点击后写入的属性值；null 表示保持当前值 */
  resolve: (current: unknown) => string | null;
}

interface FormatSpec {
  title: string;
  attribute: string;
  options: FormatOption[];
  hint: string;
}

const LIST_SPACING_SPEC: FormatSpec = {
  title: '列表项间距',
  attribute: 'spacing',
  options: [
    {
      value: 'tight',
      label: '紧凑',
      matches: (current) => current !== 'loose',
      resolve: (current) => (current === 'loose' ? ('tight' satisfies ListSpacing) : null),
    },
    {
      value: 'loose',
      label: '宽松',
      matches: (current) => current === 'loose',
      resolve: (current) => (current === 'loose' ? null : ('loose' satisfies ListSpacing)),
    },
  ],
  hint: '宽松：项之间空一行',
};

const isCompactTable = (current: unknown) => current === 'compact' || current === 'compact-bare';

const TABLE_STYLE_SPEC: FormatSpec = {
  title: '表格源码排版',
  attribute: 'markdownStyle',
  options: [
    {
      value: 'compact',
      label: '紧凑',
      matches: isCompactTable,
      // 已是紧凑写法（含 `|---|` 变体）时保持原样
      resolve: (current) => (isCompactTable(current) ? null : ('compact' satisfies TableMarkdownStyle)),
    },
    {
      value: 'aligned',
      label: '对齐',
      matches: (current) => !isCompactTable(current),
      // 旧版按字符数补齐的表格中文列对不齐，点击后改为按显示宽度对齐
      resolve: (current) => (current === 'aligned' || current === null || current === undefined
        ? null
        : ('aligned' satisfies TableMarkdownStyle)),
    },
  ],
  hint: '仅影响源码，显示不变',
};

function specFor(nodeType: string): FormatSpec | null {
  if (nodeType === 'table') return TABLE_STYLE_SPEC;
  if (SPACING_LIST_TYPES.includes(nodeType)) return LIST_SPACING_SPEC;
  return null;
}

export interface BlockFormatMenuProps {
  editor: Editor;
  /** 目标块的文档位置 */
  pos: number;
  /** 打开时的块类型；文档变化导致该位置不再是此类型时自动关闭 */
  nodeType: string;
  top: number;
  left: number;
  /** 点击这些元素不视为"点击菜单外部"（如把手本身，由把手自行切换） */
  ignoreElement: HTMLElement | null;
  onClose: () => void;
}

export function BlockFormatMenu({ editor, pos, nodeType, top, left, ignoreElement, onClose }: BlockFormatMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  // 编辑器事务后重新读取属性（撤销等外部修改也能同步选中态）
  const [, forceUpdate] = useReducer((count: number) => count + 1, 0);

  const node = editor.state.doc.nodeAt(pos);
  const spec = specFor(nodeType);
  const isValid = Boolean(node && spec && node.type.name === nodeType);

  useEffect(() => {
    const handleTransaction = () => forceUpdate();
    editor.on('transaction', handleTransaction);
    return () => {
      editor.off('transaction', handleTransaction);
    };
  }, [editor]);

  // 目标块被删除或改变类型时关闭
  useEffect(() => {
    if (!isValid) onClose();
  }, [isValid, onClose]);

  // 点击菜单外部或按 Esc 关闭
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || menuRef.current?.contains(target) || ignoreElement?.contains(target)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [ignoreElement, onClose]);

  if (!isValid || !node || !spec) return null;
  const current = node.attrs[spec.attribute];

  /** 写入属性：作为普通编辑事务，可撤销，并使文档标记为已修改 */
  const apply = (option: FormatOption) => {
    const value = option.resolve(current);
    if (value !== null) {
      editor.chain().command(({ tr }) => {
        tr.setNodeAttribute(pos, spec.attribute, value);
        return true;
      }).run();
    }
    onClose();
  };

  return (
    <div
      ref={menuRef}
      className="nb-block-format-menu"
      style={{ top, left }}
      role="menu"
      aria-label={spec.title}
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="nb-block-format-menu-title">{spec.title}</div>
      <div className="nb-block-format-menu-options" role="group">
        {spec.options.map((option) => {
          const selected = option.matches(current);
          return (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              className={`nb-block-format-option${selected ? ' is-selected' : ''}`}
              onClick={() => apply(option)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <div className="nb-block-format-menu-hint">{spec.hint}</div>
    </div>
  );
}
