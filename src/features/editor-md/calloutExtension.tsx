// NoteBoard 高亮块扩展
// Markdown 没有高亮块语法，与分栏卡片一样采用通用的「HTML 块 + 空行包裹 Markdown」写法：
//
//   <div class="nb-callout" data-color="blue" data-icon="lightbulb" style="padding: 12px 16px; border-radius: 8px; border: 1px solid #3b82f64d; background: #3b82f61a;">
//
//   正文（任意 Markdown / HTML）
//
//   </div>
//
// - data-color：预设颜色名（blue / green …）或小写 6 位十六进制色；
// - data-icon：图标名（lucide 图标），不带图标时省略该属性；
// - style：由颜色唯一推导，让支持 HTML 的渲染器（VS Code 预览、Typora 等）显示为带底色的块，
//   会过滤 style 的平台（GitHub）退化为普通段落，内容不丢失。
// 规范化约束：只接管上述标准写法（属性顺序、样式与颜色一致、正文前后各一个空行），保证"解析→序列化"逐字一致；
// 其余手写变体不识别，继续由 RawHtmlBlock 原样保留，绝不静默改写。

import { Node, mergeAttributes, type Editor, type Range } from '@tiptap/core';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { NodeViewWrapper, NodeViewContent, type NodeViewProps } from '@tiptap/react';
import { contentReactNodeViewRenderer } from './contentNodeView';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Smile, Trash2, Ungroup } from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';
import { emitRawSegment } from './rawMarkdownSegments';
import { isSelectionInside } from './collapsibleState';
import { DIV_CLOSE_TAG, readDivBody } from './divBlockSyntax';
import {
  CalloutColorPicker,
  CalloutIconGlyph,
  CalloutIconPicker,
  DEFAULT_CALLOUT_COLOR,
  DEFAULT_CALLOUT_ICON,
  calloutColorHex,
  calloutColorLabel,
  getCalloutIcon,
  isPresetColor,
  isValidCalloutColor,
  type CalloutPreset,
} from './calloutPickers';

// 开始标签：属性顺序固定，样式随后与颜色推导结果逐字比对
const CALLOUT_OPEN_PATTERN = /^<div class="nb-callout" data-color="([a-z]+|#[0-9a-f]{6})"(?: data-icon="([a-z0-9]+(?:-[a-z0-9]+)*)")? style="[^"]*">$/;
const CALLOUT_START_PATTERN = /(?:^|\n)<div class="nb-callout" data-color="/;

/** 由颜色推导导出用的内联样式（10% 底色 + 30% 描边，深浅背景下都可读） */
function calloutExportStyle(color: string): string {
  const hex = calloutColorHex(color);
  return `padding: 12px 16px; border-radius: 8px; border: 1px solid ${hex}4d; background: ${hex}1a;`;
}

/** 生成开始标签（标准写法） */
export function renderCalloutOpenTag(color: string, icon: string): string {
  const iconAttr = icon ? ` data-icon="${icon}"` : '';
  return `<div class="nb-callout" data-color="${color}"${iconAttr} style="${calloutExportStyle(color)}">`;
}

/** 规范化颜色属性（异常值回退为默认色） */
function colorOf(node: ProseMirrorNode | { attrs?: Record<string, unknown> }): string {
  const color = String(node.attrs?.color ?? '');
  return isValidCalloutColor(color) ? color : DEFAULT_CALLOUT_COLOR;
}

/** 规范化图标属性（非法图标名视为不带图标） */
function iconOf(node: ProseMirrorNode | { attrs?: Record<string, unknown> }): string {
  const icon = String(node.attrs?.icon ?? '');
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(icon) ? icon : '';
}

/** 标准写法高亮块的分析结果 */
interface CalloutMatch {
  raw: string;
  color: string;
  icon: string;
  body: string;
}

/**
 * 识别源码开头的标准写法高亮块；不符合标准写法时返回 null（交由 RawHtmlBlock 原样保留）。
 * 导出供测试使用。
 */
export function matchCalloutBlock(src: string): CalloutMatch | null {
  const firstBreak = src.indexOf('\n');
  const head = firstBreak < 0 ? src : src.slice(0, firstBreak);
  const open = CALLOUT_OPEN_PATTERN.exec(head);
  if (!open) return null;
  const color = open[1];
  const icon = open[2] ?? '';
  // 颜色必须合法，且样式与颜色推导结果逐字一致（手改过样式的视为自定义 HTML）
  if (!isValidCalloutColor(color) || head !== renderCalloutOpenTag(color, icon)) return null;

  const lines = src.split('\n');
  const parsed = readDivBody(lines, 0);
  if (!parsed) return null;
  const { body, closeIndex } = parsed;
  // 结束标签后必须是空行或文末，否则 CommonMark 会把后续文字并入同一 HTML 块
  if (closeIndex + 1 < lines.length && lines[closeIndex + 1].trim() !== '') return null;

  const raw = lines.slice(0, closeIndex + 1).join('\n') + (closeIndex + 1 < lines.length ? '\n' : '');
  return { raw, color, icon, body };
}

// ── 高亮块操作（节点视图、菜单共用） ──

/** 读取 pos 处的高亮块；位置失效或类型不符时返回 null */
function calloutAt(editor: Editor, pos: number): ProseMirrorNode | null {
  const node = editor.state.doc.nodeAt(pos);
  return node && node.type.name === 'calloutBlock' ? node : null;
}

/** 生成高亮块内容（一个空段落） */
export function createCalloutContent(color = DEFAULT_CALLOUT_COLOR, icon = DEFAULT_CALLOUT_ICON) {
  return {
    type: 'calloutBlock',
    attrs: { color: isValidCalloutColor(color) ? color : DEFAULT_CALLOUT_COLOR, icon },
    content: [{ type: 'paragraph' }],
  };
}

/** 插入高亮块并把光标放到块内开头（菜单、斜杠命令、工具栏共用） */
export function insertCalloutBlock(editor: Editor, preset?: Pick<CalloutPreset, 'color' | 'icon'>, range?: Range): boolean {
  let chain = editor.chain().focus();
  if (range) chain = chain.deleteRange(range);
  return chain
    .insertContent(createCalloutContent(preset?.color, preset?.icon ?? DEFAULT_CALLOUT_ICON))
    .command(({ tr }) => {
      // 插入后光标可能落在块后方，统一移到新高亮块的第一个段落
      const { $from } = tr.selection;
      for (let depth = $from.depth; depth > 0; depth -= 1) {
        if ($from.node(depth).type.name === 'calloutBlock') {
          tr.setSelection(TextSelection.near(tr.doc.resolve($from.before(depth) + 1), 1));
          return true;
        }
      }
      const before = $from.nodeBefore;
      if (before?.type.name === 'calloutBlock') {
        tr.setSelection(TextSelection.near(tr.doc.resolve($from.pos - before.nodeSize + 1), 1));
      }
      return true;
    })
    .run();
}

/** 修改高亮块属性（一次操作对应一步撤销） */
export function setCalloutAttrs(editor: Editor, pos: number, attrs: { color?: string; icon?: string }): boolean {
  const node = calloutAt(editor, pos);
  if (!node) return false;
  const next = { ...node.attrs, ...attrs };
  if (next.color === node.attrs.color && next.icon === node.attrs.icon) return false;
  return editor
    .chain()
    .command(({ tr }) => {
      tr.setNodeMarkup(pos, undefined, next);
      return true;
    })
    .run();
}

/** 取消高亮块：正文展开为普通块 */
export function unwrapCallout(editor: Editor, pos: number): boolean {
  const node = calloutAt(editor, pos);
  if (!node) return false;
  // 结果以文档修改是否成功为准（聚焦失败不影响操作本身）
  let applied = false;
  editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.replaceWith(pos, pos + node.nodeSize, node.content);
      tr.setSelection(TextSelection.near(tr.doc.resolve(pos), 1)).scrollIntoView();
      applied = true;
      return true;
    })
    .run();
  return applied;
}

/** 删除整个高亮块 */
export function deleteCallout(editor: Editor, pos: number): boolean {
  if (!calloutAt(editor, pos)) return false;
  return editor.chain().focus().setNodeSelection(pos).deleteSelection().run();
}

// ── 节点视图 ──

/** 读取节点当前位置；节点已脱离文档时返回 null */
function positionOf(getPos: () => number | undefined): number | null {
  try {
    const pos = getPos();
    return typeof pos === 'number' ? pos : null;
  } catch {
    return null;
  }
}

/** 浮动工具栏按钮 */
function CalloutToolButton({
  tip,
  danger,
  active,
  onClick,
  children,
  buttonRef,
}: {
  tip: string;
  danger?: boolean;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
  buttonRef?: (element: HTMLButtonElement | null) => void;
}) {
  return (
    // 不随面板开关切换 disabled：切换会重建按钮元素，导致已打开面板的锚点脱离文档
    <Tooltip content={tip} side="top" sideOffset={4}>
      <button
        ref={buttonRef}
        type="button"
        className={`nb-callout-tool${danger ? ' is-danger' : ''}${active ? ' is-active' : ''}`}
        aria-label={tip}
        // 阻止按下时编辑器失焦或移动选区
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClick}
      >
        {children}
      </button>
    </Tooltip>
  );
}

type OpenPicker = { kind: 'color' | 'icon'; anchor: HTMLElement } | null;

function CalloutComponent({ node, editor, getPos, selected }: NodeViewProps) {
  const color = colorOf(node);
  const icon = iconOf(node);
  const editable = editor.isEditable;
  // 光标位于块内时常驻显示工具栏（触屏没有悬停，只能据此唤出）
  const [focused, setFocused] = useState(() => isSelectionInside(editor, getPos, node));
  const [picker, setPicker] = useState<OpenPicker>(null);
  const nodeRef = useRef(node);
  nodeRef.current = node;
  const colorButtonRef = useRef<HTMLButtonElement | null>(null);
  const iconButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const handleSelection = () => setFocused(isSelectionInside(editor, getPos, nodeRef.current));
    editor.on('selectionUpdate', handleSelection);
    editor.on('update', handleSelection);
    return () => {
      editor.off('selectionUpdate', handleSelection);
      editor.off('update', handleSelection);
    };
  }, [editor, getPos]);

  const closePicker = useCallback(() => setPicker(null), []);

  /** 打开/切换选择面板 */
  const togglePicker = (kind: 'color' | 'icon', anchor: HTMLElement | null) => {
    if (!anchor) return;
    setPicker((current) => (current?.kind === kind ? null : { kind, anchor }));
  };

  /** 以当前位置修改属性 */
  const updateAttrs = useCallback(
    (attrs: { color?: string; icon?: string }) => {
      const pos = positionOf(getPos);
      if (pos !== null) setCalloutAttrs(editor, pos, attrs);
    },
    [editor, getPos],
  );
  const handleColorChange = useCallback((next: string) => updateAttrs({ color: next }), [updateAttrs]);
  const handleIconChange = useCallback((next: string) => updateAttrs({ icon: next }), [updateAttrs]);

  /** 以当前位置执行块操作 */
  const run = (action: (editor: Editor, pos: number) => boolean) => {
    const pos = positionOf(getPos);
    if (pos !== null) action(editor, pos);
  };

  // 预设色由样式表按主题调校；自定义色写入 CSS 变量，底色与描边按主题自动混合
  const style = isPresetColor(color) ? undefined : ({ '--callout-accent': color } as CSSProperties);
  const iconLabel = icon ? getCalloutIcon(icon)?.label ?? icon : '';
  const toolbarVisible = focused || selected || picker !== null;

  return (
    <NodeViewWrapper
      className={`nb-callout${toolbarVisible ? ' is-focused' : ''}${selected ? ' is-selected' : ''}${icon ? ' has-icon' : ''}`}
      data-callout=""
      data-color={isPresetColor(color) ? color : 'custom'}
      style={style}
    >
      {icon && (
        <div className="nb-callout-icon-slot" contentEditable={false}>
          {editable ? (
            <Tooltip content="更换图标" side="top" sideOffset={4}>
              <button
                ref={iconButtonRef}
                type="button"
                className="nb-callout-icon"
                aria-label={`图标：${iconLabel}，点击更换`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => togglePicker('icon', event.currentTarget)}
              >
                <CalloutIconGlyph id={icon} />
              </button>
            </Tooltip>
          ) : (
            <span className="nb-callout-icon">
              <CalloutIconGlyph id={icon} />
            </span>
          )}
        </div>
      )}
      <NodeViewContent className="nb-callout-content" />
      {editable && (
        <div className="nb-callout-toolbar" contentEditable={false}>
          <CalloutToolButton
            tip={`颜色：${calloutColorLabel(color)}`}
            active={picker?.kind === 'color'}
            buttonRef={(element) => {
              colorButtonRef.current = element;
            }}
            onClick={() => togglePicker('color', colorButtonRef.current)}
          >
            <span className="nb-callout-tool-dot" />
          </CalloutToolButton>
          <CalloutToolButton
            tip={icon ? '更换图标' : '添加图标'}
            active={picker?.kind === 'icon'}
            buttonRef={(element) => {
              // 有图标时面板锚定在图标本身，无图标时锚定在工具栏按钮
              if (!icon) iconButtonRef.current = element;
            }}
            onClick={() => togglePicker('icon', iconButtonRef.current)}
          >
            {icon ? <CalloutIconGlyph id={icon} size={14} /> : <Smile size={14} />}
          </CalloutToolButton>
          <span className="nb-callout-divider" />
          <CalloutToolButton tip="取消高亮块（保留内容）" onClick={() => run(unwrapCallout)}>
            <Ungroup size={14} />
          </CalloutToolButton>
          <CalloutToolButton tip="删除高亮块" danger onClick={() => run(deleteCallout)}>
            <Trash2 size={14} />
          </CalloutToolButton>
        </div>
      )}
      {picker?.kind === 'color' && (
        <CalloutColorPicker anchor={picker.anchor} color={color} onChange={handleColorChange} onClose={closePicker} />
      )}
      {picker?.kind === 'icon' && (
        <CalloutIconPicker anchor={picker.anchor} icon={icon} onChange={handleIconChange} onClose={closePicker} />
      )}
    </NodeViewWrapper>
  );
}

/** 高亮块节点 */
export const CalloutBlock = Node.create({
  name: 'calloutBlock',
  group: 'block',
  content: 'block+',
  selectable: true,
  defining: true,

  addAttributes() {
    return {
      color: {
        default: DEFAULT_CALLOUT_COLOR,
        parseHTML: (element) => {
          const color = (element as HTMLElement).getAttribute('data-color') ?? '';
          return isValidCalloutColor(color) ? color : DEFAULT_CALLOUT_COLOR;
        },
        renderHTML: (attributes) => ({ 'data-color': String(attributes.color) }),
      },
      icon: {
        default: DEFAULT_CALLOUT_ICON,
        parseHTML: (element) => (element as HTMLElement).getAttribute('data-icon') ?? '',
        renderHTML: (attributes) => (attributes.icon ? { 'data-icon': String(attributes.icon) } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-callout]' }];
  },

  // 复制到剪贴板等场景输出带底色的 HTML，粘贴到其他应用也能看出是高亮块
  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-callout': '', class: 'nb-callout', style: calloutExportStyle(colorOf(node)) }),
      0,
    ];
  },

  // 块级 tokenizer：优先于 marked 内置 html 块识别标准写法
  markdownTokenizer: {
    name: 'calloutBlock',
    level: 'block',
    start: (src: string) => {
      const match = CALLOUT_START_PATTERN.exec(src);
      if (!match) return -1;
      return match.index + (match[0].startsWith('\n') ? 1 : 0);
    },
    tokenize: (src, _tokens, lexer) => {
      const match = matchCalloutBlock(src);
      if (!match) return undefined;
      const tokens = match.body ? lexer.blockTokens(match.body) : [];
      // 位于列表内时 marked 以"非顶层"状态解析，段落会成为块级 text token；
      // 块内正文按顶层块处理（与分栏、折叠块一致），原地改为段落以保留稍后填充的行内 token
      for (const token of tokens) {
        if (token.type === 'text' && Array.isArray(token.tokens)) token.type = 'paragraph';
      }
      return {
        type: 'calloutBlock',
        raw: match.raw,
        text: match.raw,
        color: match.color,
        icon: match.icon,
        tokens,
      };
    },
  },

  parseMarkdown: (token, helpers) => {
    const parseBlocks = helpers.parseBlockChildren ?? helpers.parseChildren;
    const children = parseBlocks(token.tokens || []);
    // 内容约束为 block+，空高亮块补一个空段落
    return helpers.createNode(
      'calloutBlock',
      { color: String(token.color), icon: String(token.icon ?? '') },
      children.length > 0 ? children : [{ type: 'paragraph' }],
    );
  },

  // 序列化为标准写法；首尾标签走原样片段，避免全文后处理误改
  renderMarkdown: (node, helpers) => {
    const head = emitRawSegment(renderCalloutOpenTag(colorOf(node), iconOf(node)));
    const tail = emitRawSegment(DIV_CLOSE_TAG);
    const body = node.content ? helpers.renderChildren(node.content, '\n\n') : '';
    return body.trim() === '' ? `${head}\n\n${tail}` : `${head}\n\n${body}\n\n${tail}`;
  },

  addNodeView() {
    return contentReactNodeViewRenderer(CalloutComponent);
  },

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => exitCalloutFromEmptyParagraph(editor.state, (tr) => editor.view.dispatch(tr)),
    };
  },
});

/**
 * 正文末尾的空段落中按回车：删除该空段落并跳出到高亮块后方
 * （触屏没有方向键，高亮块位于文末时否则无法跳出）。与折叠块的跳出规则一致。导出供测试使用。
 */
export function exitCalloutFromEmptyParagraph(state: EditorState, dispatch: (tr: Transaction) => void): boolean {
  const { $from, empty } = state.selection;
  if (!empty || $from.depth < 2) return false;
  const paragraph = $from.parent;
  if (paragraph.type.name !== 'paragraph' || paragraph.content.size > 0) return false;
  const calloutDepth = $from.depth - 1;
  const callout = $from.node(calloutDepth);
  // 只有一个段落时保持默认行为（在块内换行），避免一按回车就把空高亮块的正文删光
  if (callout.type.name !== 'calloutBlock' || callout.childCount < 2) return false;
  if ($from.index(calloutDepth) !== callout.childCount - 1) return false;

  const paragraphStart = $from.before();
  const tr = state.tr.delete(paragraphStart, paragraphStart + paragraph.nodeSize);
  const insertPos = tr.mapping.map($from.after(calloutDepth));
  tr.insert(insertPos, state.schema.nodes.paragraph.create());
  tr.setSelection(TextSelection.create(tr.doc, insertPos + 1));
  dispatch(tr.scrollIntoView());
  return true;
}

/** 源码模式插入的标准写法片段（附占位文字） */
export function calloutSourceSnippet(preset?: Pick<CalloutPreset, 'color' | 'icon'>): string {
  const color = preset && isValidCalloutColor(preset.color) ? preset.color : DEFAULT_CALLOUT_COLOR;
  const icon = preset ? preset.icon : DEFAULT_CALLOUT_ICON;
  return `\n${renderCalloutOpenTag(color, icon)}\n\n高亮块内容\n\n${DIV_CLOSE_TAG}\n\n`;
}
