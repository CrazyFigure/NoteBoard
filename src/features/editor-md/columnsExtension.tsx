// NoteBoard 分栏卡片扩展
// Markdown 没有分栏语法，采用 GitHub / VS Code / Typora 通用的「HTML 块 + 空行包裹 Markdown」写法：
//
//   <div class="nb-columns" style="display: flex; gap: 16px;">
//   <div class="nb-column" style="flex: 50; min-width: 0;">
//
//   第一栏（任意 Markdown / HTML）
//
//   </div>
//   <div class="nb-column" style="flex: 50; min-width: 0;">
//
//   第二栏
//
//   </div>
//   </div>
//
// 内联样式让支持 HTML 的渲染器（VS Code 预览、Typora 等）同样显示为分栏；会过滤 style 的平台（GitHub）
// 退化为上下排列，内容不丢失。
// 规范化约束：只接管上述标准写法（栏宽为规范数字、正文前后各一个空行），保证"解析→序列化"逐字一致；
// 其余手写变体不识别，继续由 RawHtmlBlock 原样保留，绝不静默改写。
// 栏宽以 flex 比例记录，调整后各栏之和为 100，精度一位小数。

import { Node, mergeAttributes, type Editor, type Range } from '@tiptap/core';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ReactNodeViewRenderer, NodeViewWrapper, NodeViewContent, type NodeViewProps } from '@tiptap/react';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { AlignHorizontalSpaceAround, Minus, Plus, Trash2, Ungroup } from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';
import { emitRawSegment } from './rawMarkdownSegments';
import { isSelectionInside } from './collapsibleState';

/** 界面上允许的栏数范围（解析时不限，保证任意标准写法都能往返） */
export const MIN_COLUMNS = 2;
export const MAX_COLUMNS = 6;
/** 拖拽时单栏最小占比 */
const MIN_COLUMN_RATIO = 0.1;

/** 外层容器开始标签（标准写法，逐字匹配） */
export const COLUMNS_OPEN_TAG = '<div class="nb-columns" style="display: flex; gap: 16px;">';
const DIV_CLOSE_TAG = '</div>';
// 单栏开始标签：栏宽只接受规范数字（无前导零、无多余小数位），保证解析后能逐字还原
const COLUMN_OPEN_PATTERN = /^<div class="nb-column" style="flex: (0\.[1-9]|[1-9]\d{0,2}(?:\.[1-9])?); min-width: 0;">$/;
const COLUMNS_START_PATTERN = /(?:^|\n)<div class="nb-columns" style="display: flex; gap: 16px;">\n<div class="nb-column" /;
// 嵌套计数：统计行内出现的 div 开始/结束标签（含正文中的手写 HTML），保证与正确的 </div> 配对
const DIV_OPEN_TAG = /<div[\s>]/gi;
const DIV_CLOSE_TAG_PATTERN = /<\/div\s*>/gi;
// 代码围栏起止：围栏内的 </div> 文本不参与配对
const FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})/;

/** 栏宽取一位小数；结果的字符串形式即规范写法 */
function roundWidth(value: number): number {
  return Math.max(0.1, Math.min(999.9, Math.round(value * 10) / 10));
}

/** 生成单栏开始标签 */
function renderColumnOpenTag(width: number): string {
  return `<div class="nb-column" style="flex: ${roundWidth(width)}; min-width: 0;">`;
}

/** 读取栏宽属性（异常值回退为 50） */
function widthOf(node: ProseMirrorNode): number {
  const width = Number(node.attrs.width);
  return Number.isFinite(width) && width > 0 ? width : 50;
}

/** 各栏均分时的栏宽 */
function equalWidths(count: number): number[] {
  return Array.from({ length: count }, () => roundWidth(100 / count));
}

/** 把一组栏宽按比例缩放为总和 100 */
function normalizeWidths(widths: number[]): number[] {
  const total = widths.reduce((sum, width) => sum + width, 0) || 1;
  return widths.map((width) => roundWidth((width / total) * 100));
}

/** 统计一行中某类标签的出现次数 */
function countMatches(line: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  return line.match(pattern)?.length ?? 0;
}

/** 判断某行是否闭合了给定的代码围栏（同字符、长度不短于开启围栏） */
function closesFence(line: string, fence: string): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return Boolean(match && match[1][0] === fence[0] && match[1].length >= fence.length);
}

/** 标准写法分栏块的分析结果 */
interface ColumnsMatch {
  raw: string;
  columns: Array<{ width: number; body: string }>;
}

/**
 * 从 lines[start] 开始查找与当前栏配对的 `</div>` 行号（跳过代码围栏与嵌套 div）；
 * 结构不符合标准写法时返回 -1。
 */
function findColumnClose(lines: string[], start: number): number {
  let depth = 0;
  let fence: string | null = null;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const fenceOpen = FENCE_OPEN_PATTERN.exec(line);
    if (fenceOpen) {
      fence = fenceOpen[1];
      continue;
    }
    // 同层的结束标签必须独占一行且无缩进、无多余空白
    if (depth === 0 && line === DIV_CLOSE_TAG) return index;
    depth += countMatches(line, DIV_OPEN_TAG) - countMatches(line, DIV_CLOSE_TAG_PATTERN);
    // 出现多余的结束标签说明结构不是标准写法
    if (depth < 0) return -1;
  }
  return -1;
}

/**
 * 识别源码开头的标准写法分栏块；不符合标准写法时返回 null（交由 RawHtmlBlock 原样保留）。
 * 导出供测试使用。
 */
export function matchColumnsBlock(src: string): ColumnsMatch | null {
  if (!src.startsWith(`${COLUMNS_OPEN_TAG}\n`)) return null;
  const lines = src.split('\n');
  const columns: ColumnsMatch['columns'] = [];
  let index = 1;

  while (index < lines.length) {
    const open = COLUMN_OPEN_PATTERN.exec(lines[index]);
    if (!open) break;
    // 开始标签后必须是一个空行（空行允许含空白：列表内序列化会给空行补缩进）
    if (index + 1 >= lines.length || lines[index + 1].trim() !== '') return null;
    const bodyStart = index + 2;
    const closeIndex = findColumnClose(lines, bodyStart);
    if (closeIndex < 0) return null;

    const between = lines.slice(bodyStart, closeIndex);
    let body = '';
    if (between.length > 0) {
      // 非空正文与结束标签之间必须恰有一个空行
      if (between.length < 2 || between[between.length - 1].trim() !== '') return null;
      body = between.slice(0, -1).join('\n');
      if (body.trim() === '') return null;
    }
    columns.push({ width: Number(open[1]), body });
    index = closeIndex + 1;
  }

  // 至少一栏，且各栏之后紧跟外层结束标签
  if (columns.length === 0 || lines[index] !== DIV_CLOSE_TAG) return null;
  // 结束标签后必须是空行或文末，否则 CommonMark 会把后续文字并入同一 HTML 块
  if (index + 1 < lines.length && lines[index + 1].trim() !== '') return null;

  const raw = lines.slice(0, index + 1).join('\n') + (index + 1 < lines.length ? '\n' : '');
  return { raw, columns };
}

// ── 分栏操作（浮动工具栏、菜单共用） ──

/** 读取 pos 处的分栏块；位置失效或类型不符时返回 null */
function columnsAt(editor: Editor, pos: number): ProseMirrorNode | null {
  const node = editor.state.doc.nodeAt(pos);
  return node && node.type.name === 'columnsBlock' ? node : null;
}

/** 生成分栏块内容（各栏均分、每栏一个空段落） */
export function createColumnsContent(count: number) {
  const safeCount = Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, Math.round(count)));
  return {
    type: 'columnsBlock',
    content: equalWidths(safeCount).map((width) => ({
      type: 'columnBlock',
      attrs: { width },
      content: [{ type: 'paragraph' }],
    })),
  };
}

/** 插入分栏块并把光标放到第一栏开头（菜单、斜杠命令、工具栏共用） */
export function insertColumnsBlock(editor: Editor, count: number, range?: Range): boolean {
  let chain = editor.chain().focus();
  if (range) chain = chain.deleteRange(range);
  return chain
    .insertContent(createColumnsContent(count))
    .command(({ tr }) => {
      // 插入后光标默认落在最后一栏末尾，改到新分栏块的第一栏
      const { $from } = tr.selection;
      for (let depth = $from.depth; depth > 0; depth -= 1) {
        if ($from.node(depth).type.name === 'columnsBlock') {
          tr.setSelection(TextSelection.near(tr.doc.resolve($from.before(depth) + 1), 1));
          break;
        }
      }
      return true;
    })
    .run();
}

/** 只有一个空段落的栏视为空栏 */
function isEmptyColumn(column: ProseMirrorNode): boolean {
  return column.childCount === 1 && column.firstChild!.isTextblock && column.firstChild!.content.size === 0;
}

/** 在同一个命令链中修改文档并保持编辑器焦点（一次操作对应一步撤销） */
function runColumnsChange(editor: Editor, build: (tr: Transaction) => boolean): boolean {
  // 结果以文档修改是否成功为准（聚焦失败不影响操作本身）
  let applied = false;
  editor
    .chain()
    .focus()
    .command(({ tr }) => {
      applied = build(tr);
      return applied;
    })
    .run();
  return applied;
}

/** 在末尾增加一栏：新栏取平均宽度，整体重新按比例归一 */
export function addColumn(editor: Editor, pos: number): boolean {
  const node = columnsAt(editor, pos);
  if (!node || node.childCount >= MAX_COLUMNS) return false;
  const widths: number[] = [];
  node.forEach((column) => widths.push(widthOf(column)));
  const average = widths.reduce((sum, width) => sum + width, 0) / widths.length;
  const nextWidths = normalizeWidths([...widths, average]);

  return runColumnsChange(editor, (tr) => {
    const { schema } = tr.doc.type;
    // 先改已有各栏宽度（不改变节点大小，位置不受影响），再在末尾插入新栏
    node.forEach((column, offset, index) => {
      tr.setNodeMarkup(pos + 1 + offset, undefined, { ...column.attrs, width: nextWidths[index] });
    });
    const column = schema.nodes.columnBlock.create(
      { width: nextWidths[nextWidths.length - 1] },
      schema.nodes.paragraph.create(),
    );
    const insertPos = pos + node.nodeSize - 1;
    tr.insert(insertPos, column);
    // 光标移到新栏，便于直接输入
    tr.setSelection(TextSelection.near(tr.doc.resolve(insertPos + 1), 1)).scrollIntoView();
    return true;
  });
}

/** 删除最后一栏：其内容并入前一栏末尾、宽度归前一栏，不丢失内容 */
export function removeLastColumn(editor: Editor, pos: number): boolean {
  const node = columnsAt(editor, pos);
  if (!node || node.childCount <= MIN_COLUMNS) return false;
  const last = node.lastChild!;
  const prev = node.child(node.childCount - 2);
  const lastPos = pos + node.nodeSize - 1 - last.nodeSize;
  const prevPos = lastPos - prev.nodeSize;

  return runColumnsChange(editor, (tr) => {
    tr.setNodeMarkup(prevPos, undefined, { ...prev.attrs, width: roundWidth(widthOf(prev) + widthOf(last)) });
    tr.delete(lastPos, lastPos + last.nodeSize);
    // lastPos - 1 即前一栏内容末尾；空栏直接删除
    if (!isEmptyColumn(last)) tr.insert(lastPos - 1, last.content);
    return true;
  });
}

/** 各栏宽度均分 */
export function equalizeColumns(editor: Editor, pos: number): boolean {
  const node = columnsAt(editor, pos);
  if (!node) return false;
  const widths = equalWidths(node.childCount);
  let changed = false;
  node.forEach((column, _offset, index) => {
    if (widthOf(column) !== widths[index]) changed = true;
  });
  if (!changed) return false;
  return runColumnsChange(editor, (tr) => {
    node.forEach((column, offset, index) => {
      tr.setNodeMarkup(pos + 1 + offset, undefined, { ...column.attrs, width: widths[index] });
    });
    return true;
  });
}

/** 取消分栏：各栏内容按顺序展开为普通块（跳过空栏） */
export function unwrapColumns(editor: Editor, pos: number): boolean {
  const node = columnsAt(editor, pos);
  if (!node) return false;
  const blocks: ProseMirrorNode[] = [];
  node.forEach((column) => {
    if (!isEmptyColumn(column)) column.forEach((child) => blocks.push(child));
  });
  return runColumnsChange(editor, (tr) => {
    const { schema } = tr.doc.type;
    tr.replaceWith(pos, pos + node.nodeSize, blocks.length > 0 ? blocks : [schema.nodes.paragraph.create()]);
    tr.setSelection(TextSelection.near(tr.doc.resolve(pos), 1)).scrollIntoView();
    return true;
  });
}

/** 删除整个分栏块 */
export function deleteColumns(editor: Editor, pos: number): boolean {
  if (!columnsAt(editor, pos)) return false;
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
function ColumnsToolButton({
  tip,
  disabled,
  danger,
  onClick,
  children,
}: {
  tip: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip content={tip} side="top" sideOffset={4}>
      <button
        type="button"
        className={`nb-columns-tool${danger ? ' is-danger' : ''}`}
        aria-label={tip}
        disabled={disabled}
        // 阻止按下时编辑器失焦或移动选区
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClick}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function ColumnsComponent({ node, editor, getPos, selected }: NodeViewProps) {
  const count = node.childCount;
  // 光标位于分栏内时常驻显示工具栏（触屏没有悬停，只能据此唤出）
  const [focused, setFocused] = useState(() => isSelectionInside(editor, getPos, node));
  const nodeRef = useRef(node);
  nodeRef.current = node;

  useEffect(() => {
    const handleSelection = () => setFocused(isSelectionInside(editor, getPos, nodeRef.current));
    editor.on('selectionUpdate', handleSelection);
    editor.on('update', handleSelection);
    return () => {
      editor.off('selectionUpdate', handleSelection);
      editor.off('update', handleSelection);
    };
  }, [editor, getPos]);

  /** 以当前位置执行分栏操作 */
  const run = (action: (editor: Editor, pos: number) => boolean) => {
    const pos = positionOf(getPos);
    if (pos !== null) action(editor, pos);
  };

  return (
    <NodeViewWrapper
      className={`nb-columns${focused ? ' is-focused' : ''}${selected ? ' is-selected' : ''}`}
      data-columns=""
    >
      {editor.isEditable && (
        <div className="nb-columns-toolbar" contentEditable={false}>
          <ColumnsToolButton
            tip={count <= MIN_COLUMNS ? `至少 ${MIN_COLUMNS} 栏，可使用"取消分栏"` : '减少一栏（内容并入前一栏）'}
            disabled={count <= MIN_COLUMNS}
            onClick={() => run(removeLastColumn)}
          >
            <Minus size={14} />
          </ColumnsToolButton>
          <span className="nb-columns-count">{count} 栏</span>
          <ColumnsToolButton
            tip={count >= MAX_COLUMNS ? `最多 ${MAX_COLUMNS} 栏` : '增加一栏'}
            disabled={count >= MAX_COLUMNS}
            onClick={() => run(addColumn)}
          >
            <Plus size={14} />
          </ColumnsToolButton>
          <span className="nb-columns-divider" />
          <ColumnsToolButton tip="均分栏宽" onClick={() => run(equalizeColumns)}>
            <AlignHorizontalSpaceAround size={14} />
          </ColumnsToolButton>
          <ColumnsToolButton tip="取消分栏（内容按顺序保留）" onClick={() => run(unwrapColumns)}>
            <Ungroup size={14} />
          </ColumnsToolButton>
          <ColumnsToolButton tip="删除分栏" danger onClick={() => run(deleteColumns)}>
            <Trash2 size={14} />
          </ColumnsToolButton>
        </div>
      )}
      <NodeViewContent className="nb-columns-content" />
    </NodeViewWrapper>
  );
}

/**
 * 单栏节点视图（原生 DOM）：栏元素本身就是 flex 子项，React 节点视图的包裹层会破坏布局。
 * 每栏右侧（最后一栏除外）带一个拖拽条，拖动时实时改两侧栏的 flex 比例，松手后一次性写回文档（一步撤销）。
 */
function createColumnView(initialNode: ProseMirrorNode, view: EditorView, getPos: () => number | undefined) {
  let node = initialNode;
  const dom = document.createElement('div');
  dom.className = 'nb-column';
  dom.setAttribute('data-column', '');
  dom.style.flexGrow = String(widthOf(node));

  const contentDOM = document.createElement('div');
  contentDOM.className = 'nb-column-content';
  dom.appendChild(contentDOM);

  const handle = document.createElement('div');
  handle.className = 'nb-column-resizer';
  handle.contentEditable = 'false';
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', '拖动调整栏宽');
  dom.appendChild(handle);

  // 拖拽进行中的状态
  let drag: {
    pointerId: number;
    startX: number;
    index: number;
    widths: number[];
    total: number;
    available: number;
    next: HTMLElement;
    current: number[];
  } | null = null;

  const onPointerMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { index, widths, total, available } = drag;
    // 像素位移按"总比例 / 可用宽度"折算成 flex 比例
    const delta = ((event.clientX - drag.startX) * total) / available;
    const pair = widths[index] + widths[index + 1];
    const min = total * MIN_COLUMN_RATIO;
    const left = Math.max(min, Math.min(pair - min, widths[index] + delta));
    drag.current = [...widths];
    drag.current[index] = left;
    drag.current[index + 1] = pair - left;
    dom.style.flexGrow = String(left);
    drag.next.style.flexGrow = String(pair - left);
  };

  const finishDrag = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { current, widths } = drag;
    drag = null;
    handle.classList.remove('is-dragging');
    document.body.classList.remove('nb-column-resizing');
    handle.removeEventListener('pointermove', onPointerMove);
    handle.removeEventListener('pointerup', finishDrag);
    handle.removeEventListener('pointercancel', finishDrag);
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);

    const pos = positionOf(getPos);
    const changed = current.some((width, index) => Math.abs(width - widths[index]) > 0.05);
    if (pos === null || !changed) {
      // 未移动或节点已失效：还原为文档中的宽度
      dom.style.flexGrow = String(widthOf(node));
      return;
    }
    const $pos = view.state.doc.resolve(pos);
    const parent = $pos.parent;
    if (parent.type.name !== 'columnsBlock' || parent.childCount !== current.length) return;
    // 写回时整体归一为总和 100，源码中的数字更直观
    const nextWidths = normalizeWidths(current);
    const parentStart = $pos.start();
    const tr = view.state.tr;
    parent.forEach((column, offset, index) => {
      if (widthOf(column) !== nextWidths[index]) {
        tr.setNodeMarkup(parentStart + offset, undefined, { ...column.attrs, width: nextWidths[index] });
      }
    });
    if (tr.docChanged) view.dispatch(tr);
  };

  handle.addEventListener('pointerdown', (event) => {
    if (!view.editable || event.button !== 0) return;
    const pos = positionOf(getPos);
    const next = dom.nextElementSibling as HTMLElement | null;
    const container = dom.parentElement;
    if (pos === null || !next || !container) return;
    const $pos = view.state.doc.resolve(pos);
    const parent = $pos.parent;
    const index = $pos.index();
    if (parent.type.name !== 'columnsBlock' || index >= parent.childCount - 1) return;

    event.preventDefault();
    event.stopPropagation();
    const widths: number[] = [];
    parent.forEach((column) => widths.push(widthOf(column)));
    const gap = parseFloat(getComputedStyle(container).columnGap) || 0;
    const available = Math.max(1, container.clientWidth - gap * (widths.length - 1));
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      index,
      widths,
      total: widths.reduce((sum, width) => sum + width, 0),
      available,
      next,
      current: widths,
    };
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('is-dragging');
    // 拖动期间全局保持调整光标并禁止选中文字
    document.body.classList.add('nb-column-resizing');
    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', finishDrag);
    handle.addEventListener('pointercancel', finishDrag);
  });

  return {
    dom,
    contentDOM,
    update(updated: ProseMirrorNode) {
      if (updated.type !== node.type) return false;
      node = updated;
      // 拖动中由指针事件控制宽度，避免其它事务把宽度跳回
      if (!drag) dom.style.flexGrow = String(widthOf(node));
      return true;
    },
    // 拖拽条上的事件不交给 ProseMirror（不移动选区、不触发拖放）
    stopEvent(event: Event) {
      return event.target instanceof globalThis.Node && handle.contains(event.target);
    },
    // 只关心内容区内的变更；栏自身的样式与拖拽条变化不触发重新渲染
    ignoreMutation(mutation: MutationRecord | { type: 'selection'; target: globalThis.Node }) {
      if (mutation.type === 'selection') return false;
      return !contentDOM.contains(mutation.target);
    },
    destroy() {
      document.body.classList.remove('nb-column-resizing');
    },
  };
}

/** 单栏节点：只能出现在分栏块内 */
export const ColumnBlock = Node.create({
  name: 'columnBlock',
  content: 'block+',
  // 栏边界不可被退格/合并跨越
  isolating: true,
  defining: true,
  selectable: false,
  draggable: false,

  addAttributes() {
    return {
      width: {
        default: 50,
        parseHTML: (element) => {
          const width = Number((element as HTMLElement).getAttribute('data-width'));
          return Number.isFinite(width) && width > 0 ? roundWidth(width) : 50;
        },
        renderHTML: (attributes) => ({
          'data-width': String(attributes.width),
          style: `flex: ${attributes.width} 1 0%; min-width: 0;`,
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-column]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-column': '', class: 'nb-column' }), 0];
  },

  renderMarkdown: (node, helpers) => {
    const head = emitRawSegment(renderColumnOpenTag(Number(node.attrs?.width ?? 50)));
    const tail = emitRawSegment(DIV_CLOSE_TAG);
    const body = node.content ? helpers.renderChildren(node.content, '\n\n') : '';
    return body.trim() === '' ? `${head}\n\n${tail}` : `${head}\n\n${body}\n\n${tail}`;
  },

  addNodeView() {
    return ({ node, view, getPos }) => createColumnView(node, view, getPos as () => number | undefined);
  },
});

/** 分栏块节点 */
export const ColumnsBlock = Node.create({
  name: 'columnsBlock',
  group: 'block',
  content: 'columnBlock+',
  selectable: true,
  defining: true,
  isolating: true,

  parseHTML() {
    return [{ tag: 'div[data-columns]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-columns': '', class: 'nb-columns' }), 0];
  },

  // 块级 tokenizer：优先于 marked 内置 html 块识别标准写法
  markdownTokenizer: {
    name: 'columnsBlock',
    level: 'block',
    start: (src: string) => {
      const match = COLUMNS_START_PATTERN.exec(src);
      if (!match) return -1;
      return match.index + (match[0].startsWith('\n') ? 1 : 0);
    },
    tokenize: (src, _tokens, lexer) => {
      const match = matchColumnsBlock(src);
      if (!match) return undefined;
      const columns = match.columns.map((column) => {
        const tokens = column.body ? lexer.blockTokens(column.body) : [];
        // 位于列表内时 marked 以"非顶层"状态解析，段落会成为块级 text token；
        // 栏内正文按顶层块处理（与折叠块一致），原地改为段落以保留稍后填充的行内 token
        for (const token of tokens) {
          if (token.type === 'text' && Array.isArray(token.tokens)) token.type = 'paragraph';
        }
        return { width: column.width, tokens };
      });
      return {
        type: 'columnsBlock',
        raw: match.raw,
        text: match.raw,
        columns,
        // 汇总子 token，便于 marked 的 walkTokens 等遍历
        tokens: columns.flatMap((column) => column.tokens),
      };
    },
  },

  parseMarkdown: (token, helpers) => {
    const parseBlocks = helpers.parseBlockChildren ?? helpers.parseChildren;
    const columns = (token.columns as Array<{ width: number; tokens: unknown[] }> | undefined) ?? [];
    const content = columns.map((column) => {
      const children = parseBlocks((column.tokens || []) as Parameters<typeof parseBlocks>[0]);
      // 栏内容约束为 block+，空栏补一个空段落
      return helpers.createNode('columnBlock', { width: column.width }, children.length > 0 ? children : [{ type: 'paragraph' }]);
    });
    return helpers.createNode('columnsBlock', {}, content);
  },

  // 序列化为标准写法；首尾标签走原样片段，避免全文后处理误改
  renderMarkdown: (node, helpers) => {
    const head = emitRawSegment(COLUMNS_OPEN_TAG);
    const tail = emitRawSegment(DIV_CLOSE_TAG);
    const body = node.content ? helpers.renderChildren(node.content, '\n') : '';
    return `${head}\n${body}\n${tail}`;
  },

  addNodeView() {
    return ReactNodeViewRenderer(ColumnsComponent);
  },

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => exitColumnsFromEmptyParagraph(editor.state, (tr) => editor.view.dispatch(tr)),
    };
  },
});

/**
 * 最后一栏末尾的空段落中按回车：删除该空段落并跳出到分栏块后方
 * （触屏没有方向键，分栏块位于文末时否则无法跳出）。与折叠块的跳出规则一致。导出供测试使用。
 */
export function exitColumnsFromEmptyParagraph(state: EditorState, dispatch: (tr: Transaction) => void): boolean {
  const { $from, empty } = state.selection;
  if (!empty || $from.depth < 3) return false;
  const paragraph = $from.parent;
  if (paragraph.type.name !== 'paragraph' || paragraph.content.size > 0) return false;
  const columnDepth = $from.depth - 1;
  const column = $from.node(columnDepth);
  const columns = $from.node(columnDepth - 1);
  if (column.type.name !== 'columnBlock' || columns.type.name !== 'columnsBlock') return false;
  // 只处理最后一栏；栏内只有一个段落时保持默认行为，避免一按回车就把空栏删光
  if ($from.index(columnDepth - 1) !== columns.childCount - 1 || column.childCount < 2) return false;
  if ($from.index(columnDepth) !== column.childCount - 1) return false;

  const paragraphStart = $from.before();
  const tr = state.tr.delete(paragraphStart, paragraphStart + paragraph.nodeSize);
  const insertPos = tr.mapping.map($from.after(columnDepth - 1));
  tr.insert(insertPos, state.schema.nodes.paragraph.create());
  tr.setSelection(TextSelection.create(tr.doc, insertPos + 1));
  dispatch(tr.scrollIntoView());
  return true;
}

/** 源码模式插入的标准写法片段（各栏均分，附占位文字） */
export function columnsSourceSnippet(count: number): string {
  const safeCount = Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, Math.round(count)));
  const columns = equalWidths(safeCount)
    .map((width, index) => `${renderColumnOpenTag(width)}\n\n第 ${index + 1} 栏内容\n\n${DIV_CLOSE_TAG}`)
    .join('\n');
  return `\n${COLUMNS_OPEN_TAG}\n${columns}\n${DIV_CLOSE_TAG}\n\n`;
}
