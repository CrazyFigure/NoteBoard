// NoteBoard 双链节点（可视化模式）
// `[[目标|显示名]]` 解析为行内原子节点，属性 inner 保存方括号内的原文，序列化时逐字写回，保证往返无损。
// `![[目标]]` 为嵌入：同一节点类型（embed=true），显示为图片或被嵌入笔记的只读卡片。
//
// 交互：
// 1. 桌面可编辑状态：Ctrl / Cmd + 单击跳转（与普通链接一致），单击选中，双击就地编辑原文；
// 2. 移动端与只读（沉浸阅读等）状态：直接点击跳转；嵌入卡片点击标题栏打开原笔记；
// 3. 目标不存在（例如同步还没带来另一端）时显示为虚线弱化样式，文件到达后索引重建自动恢复。

import { InputRule, mergeAttributes, Node, nodePasteRule, type MarkdownToken, type MarkdownTokenizer } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorView, NodeView } from '@tiptap/pm/view';
import { TextSelection } from '@tiptap/pm/state';
import { IS_MOBILE_UI } from '../../core/platform';
import { useWindowStore } from '../../stores/windowStore';
import { subscribeNoteIndex } from '../wikilink/noteIndex';
import { openWikiLink, resolveWikiLinkNow } from '../wikilink/wikiLinkNavigation';
import { findWikiLinkStart, matchWikiLinkAtStart, parseWikiLinkInner, wikiLinkLabel, WIKI_LINK_MAX_LENGTH } from '../wikilink/wikiLinkSyntax';
import { hideWikiLinkTooltip, scheduleWikiLinkTooltip } from './wikiLinkTooltip';
import { embedIdentity, renderWikiEmbed } from './wikiLinkEmbed';

export interface WikiLinkOptions {
  /** 所在文档 key（解析相对目标、同名优先级用）；为空时使用活动标签 */
  docKey: string;
}

/** tokenizer 附加在 marked token 上的内部文字与嵌入标记 */
type WikiLinkMarkdownToken = MarkdownToken & { inner?: string; embed?: boolean };

/** 行内 `[[...]]` / `![[...]]` tokenizer：不跨行、内部不含方括号 */
const wikiLinkTokenizer: MarkdownTokenizer = {
  name: 'wikiLink',
  level: 'inline',
  start: findWikiLinkStart,
  tokenize(source) {
    const match = matchWikiLinkAtStart(source);
    if (!match) return undefined;
    return { type: 'wikiLink', raw: match.raw, inner: match.inner, embed: match.embed };
  },
};

/** 输入 / 粘贴识别用的模式：可选的 `!` 前缀 + `[[...]]` */
const WIKI_LINK_BODY = `(!?)\\[\\[([^\\[\\]\\r\\n]{1,${WIKI_LINK_MAX_LENGTH}})\\]\\]`;

/** 编辑框写回前清理：方括号与换行会破坏语法 */
function sanitizeInner(value: string): string {
  return value.replace(/[[\]\r\n]/g, '').slice(0, WIKI_LINK_MAX_LENGTH).trim();
}

/** 是否应当跳转而非选中：移动端、只读状态直接点击；桌面编辑状态需按住 Ctrl / Cmd */
function shouldNavigate(event: MouseEvent, view: EditorView): boolean {
  if (event.button !== 0) return false;
  return IS_MOBILE_UI || !view.editable || event.ctrlKey || event.metaKey;
}

class WikiLinkNodeView implements NodeView {
  dom: HTMLSpanElement;
  private node: ProseMirrorNode;
  private readonly view: EditorView;
  private readonly getPos: () => number | undefined;
  private readonly getDocKey: () => string;
  private readonly unsubscribe: () => void;
  private input: HTMLInputElement | null = null;
  /** 嵌入内容容器与当前渲染的身份（变化时才重渲染） */
  private embedContainer: HTMLSpanElement | null = null;
  private embedKey = '';
  private disposeEmbed: (() => void) | null = null;

  constructor(node: ProseMirrorNode, view: EditorView, getPos: () => number | undefined, getDocKey: () => string) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.getDocKey = getDocKey;
    this.dom = document.createElement('span');
    this.dom.contentEditable = 'false';
    this.dom.addEventListener('mousedown', this.handleMouseDown);
    this.dom.addEventListener('click', this.handleClick);
    this.dom.addEventListener('dblclick', this.handleDoubleClick);
    if (!IS_MOBILE_UI) {
      this.dom.addEventListener('mouseenter', this.handleMouseEnter);
      this.dom.addEventListener('mouseleave', hideWikiLinkTooltip);
    }
    // 索引重建（新建、删除、同步到达文件）后重新判断目标是否存在
    this.unsubscribe = subscribeNoteIndex(() => this.renderStatus());
    this.render();
  }

  private get inner(): string {
    return String(this.node.attrs.inner ?? '');
  }

  private get isEmbed(): boolean {
    return this.node.attrs.embed === true;
  }

  private render(): void {
    if (this.input) return;
    // 逐个切换而非整体覆盖 className，保留选中态等由 ProseMirror 管理的类
    this.dom.classList.toggle('nb-wikiembed', this.isEmbed);
    this.dom.classList.toggle('nb-wikilink', !this.isEmbed);
    this.dom.classList.remove('is-editing');
    this.dom.setAttribute('data-wiki-link', this.inner);
    if (this.isEmbed) {
      if (!this.embedContainer || this.embedContainer.parentNode !== this.dom) {
        this.embedContainer = document.createElement('span');
        this.embedContainer.className = 'nb-wikiembed-content';
        this.dom.replaceChildren(this.embedContainer);
        this.embedKey = '';
      }
    } else {
      this.disposeEmbedContent();
      this.dom.textContent = wikiLinkLabel(parseWikiLinkInner(this.inner));
    }
    this.renderStatus();
  }

  private disposeEmbedContent(): void {
    this.disposeEmbed?.();
    this.disposeEmbed = null;
    this.embedContainer = null;
    this.embedKey = '';
  }

  /** 按解析结果切换样式；嵌入在目标或其修改时间变化时重新渲染内容 */
  private renderStatus(): void {
    if (this.input) return;
    const resolution = resolveWikiLinkNow(this.inner, this.getDocKey());
    this.dom.classList.toggle('is-unresolved', resolution.status === 'missing');
    if (!this.isEmbed || !this.embedContainer) return;
    const key = `${this.inner}\n${embedIdentity(resolution)}`;
    if (key === this.embedKey) return;
    this.embedKey = key;
    this.disposeEmbed?.();
    this.disposeEmbed = renderWikiEmbed(this.embedContainer, {
      inner: this.inner,
      resolution,
      onOpen: () => void openWikiLink(this.inner, this.getDocKey()),
    });
  }

  private handleMouseDown = (event: MouseEvent) => {
    if (this.input) return;
    // 跳转手势不让 ProseMirror 选中节点或弹出键盘
    if (shouldNavigate(event, this.view)) event.preventDefault();
  };

  private handleClick = (event: MouseEvent) => {
    if (this.input || !shouldNavigate(event, this.view)) return;
    // 嵌入卡片正文中的链接、滚动等交给内容自身；只有点在非交互区域时才跳转
    if (this.isEmbed && (event.target as HTMLElement | null)?.closest('a, button')) return;
    event.preventDefault();
    event.stopPropagation();
    hideWikiLinkTooltip();
    void openWikiLink(this.inner, this.getDocKey());
  };

  private handleDoubleClick = (event: MouseEvent) => {
    if (IS_MOBILE_UI || !this.view.editable || this.input) return;
    event.preventDefault();
    this.startEditing();
  };

  private handleMouseEnter = () => {
    if (this.input || this.isEmbed) return;
    const resolution = resolveWikiLinkNow(this.inner, this.getDocKey());
    const editable = this.view.editable;
    let text: string;
    if (resolution.status === 'missing') text = '未找到笔记，可能尚未同步';
    else if (resolution.status === 'resolved') text = resolution.entry.relPath;
    else if (resolution.status === 'self') text = '当前文档内的标题';
    else text = '正在查找笔记…';
    // 只读状态单击即可跳转，不再提示快捷键（提示组件内部负责 Mac 上的 Cmd 写法）
    scheduleWikiLinkTooltip(this.dom, text, editable ? 'Ctrl + 单击' : undefined);
  };

  /** 就地编辑：显示原文输入框，Enter / 失焦提交，Esc 取消，清空则删除链接 */
  private startEditing(): void {
    hideWikiLinkTooltip();
    const input = document.createElement('input');
    input.className = 'nb-wikilink-input';
    input.value = this.inner;
    input.spellcheck = false;
    input.size = Math.max(6, this.inner.length + 2);
    input.addEventListener('input', () => {
      input.size = Math.max(6, input.value.length + 2);
    });
    input.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        this.finishEditing(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.finishEditing(false);
      }
    });
    input.addEventListener('blur', () => this.finishEditing(true));
    this.input = input;
    this.disposeEmbedContent();
    this.dom.classList.remove('nb-wikiembed', 'is-unresolved');
    this.dom.classList.add('nb-wikilink', 'is-editing');
    this.dom.replaceChildren(this.isEmbed ? '![[' : '[[', input, ']]');
    input.focus();
    input.select();
  }

  private finishEditing(commit: boolean): void {
    const input = this.input;
    if (!input) return;
    this.input = null;
    const value = sanitizeInner(input.value);
    const pos = this.getPos();
    if (commit && pos !== undefined && value !== this.inner) {
      const { state } = this.view;
      const tr = value
        ? state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, inner: value })
        : state.tr.delete(pos, pos + this.node.nodeSize);
      // 光标落到链接之后，继续输入不会覆盖链接
      const after = value ? pos + this.node.nodeSize : pos;
      tr.setSelection(TextSelection.create(tr.doc, Math.min(after, tr.doc.content.size)));
      this.view.dispatch(tr);
    } else {
      this.render();
    }
    this.view.focus();
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  selectNode(): void {
    this.dom.classList.add('ProseMirror-selectednode');
  }

  deselectNode(): void {
    this.dom.classList.remove('ProseMirror-selectednode');
  }

  /** 编辑框与嵌入卡片标题栏内的事件交给它们自己处理 */
  stopEvent(event: Event): boolean {
    if (this.input) return true;
    if ((event.target as HTMLElement | null)?.closest?.('.nb-wikiembed-header')) return true;
    return event.type === 'mousedown' && event instanceof MouseEvent && shouldNavigate(event, this.view);
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.unsubscribe();
    this.disposeEmbedContent();
    hideWikiLinkTooltip();
  }
}

/** 双链行内节点 */
export const WikiLink = Node.create<WikiLinkOptions>({
  name: 'wikiLink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return { docKey: '' };
  },

  addAttributes() {
    return {
      inner: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-wiki-link') ?? '',
        renderHTML: (attributes) => ({ 'data-wiki-link': attributes.inner }),
      },
      embed: {
        default: false,
        parseHTML: (element) => element.hasAttribute('data-wiki-embed'),
        renderHTML: (attributes) => (attributes.embed ? { 'data-wiki-embed': '' } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-wiki-link]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { class: node.attrs.embed ? 'nb-wikiembed' : 'nb-wikilink' }),
      wikiLinkLabel(parseWikiLinkInner(String(node.attrs.inner ?? ''))),
    ];
  },

  renderText({ node }) {
    // 复制为纯文本、搜索辅助文本等通道保留原始写法
    return `${node.attrs.embed ? '!' : ''}[[${String(node.attrs.inner ?? '')}]]`;
  },

  addNodeView() {
    const options = this.options;
    const getDocKey = () => options.docKey || useWindowStore.getState().activeKey || '';
    return ({ node, view, getPos }) => new WikiLinkNodeView(node, view, getPos, getDocKey);
  },

  markdownTokenName: 'wikiLink',
  markdownTokenizer: wikiLinkTokenizer,
  parseMarkdown(token, helpers) {
    const wikiToken = token as WikiLinkMarkdownToken;
    return helpers.createNode('wikiLink', { inner: wikiToken.inner ?? '', embed: wikiToken.embed === true });
  },
  renderMarkdown(node) {
    const inner = String(node.attrs?.inner ?? '');
    // 表格单元格中的 `|` 必须写成 `\|`，否则会被当作列分隔符（与 Obsidian 写法一致）
    const escaped = node.attrs?.inTableCell ? inner.replace(/(^|[^\\])\|/g, '$1\\|') : inner;
    return `${node.attrs?.embed ? '!' : ''}[[${escaped}]]`;
  },

  addInputRules() {
    const type = this.type;
    return [
      // 手动输入闭合的 `]]` 时转换为双链节点；前面带 `!` 时为嵌入
      new InputRule({
        find: new RegExp(`${WIKI_LINK_BODY}$`),
        handler: ({ state, range, match }) => {
          if (!match[2].trim()) return null;
          state.tr.replaceWith(range.from, range.to, type.create({ inner: match[2], embed: match[1] === '!' }));
        },
      }),
    ];
  },

  addPasteRules() {
    return [
      nodePasteRule({
        find: new RegExp(WIKI_LINK_BODY, 'g'),
        type: this.type,
        getAttributes: (match) => (match[2].trim() ? { inner: match[2], embed: match[1] === '!' } : false),
      }),
    ];
  },
});
