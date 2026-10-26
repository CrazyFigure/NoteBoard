// NoteBoard 双链节点（可视化模式）
// `[[目标|显示名]]` 解析为行内原子节点，属性 inner 保存方括号内的原文，序列化时逐字写回，保证往返无损。
// `![[目标]]` 为嵌入：同一节点类型（embed=true），显示为图片或被嵌入笔记的只读卡片。
//
// 交互：
// 1. 桌面可编辑状态：Ctrl / Cmd + 单击跳转（与普通链接一致），单击选中，双击打开编辑弹窗；
// 2. 移动端可编辑状态：点击打开编辑弹窗（内含「打开笔记」）；只读（沉浸阅读等）状态直接点击跳转；
//    嵌入卡片点击标题栏打开原笔记；
// 3. 目标不存在（例如同步还没带来另一端）时显示为虚线弱化样式，文件到达后索引重建自动恢复。

import { Extension, InputRule, mergeAttributes, Node, nodePasteRule, type JSONContent, type MarkdownToken, type MarkdownTokenizer } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorView, NodeView } from '@tiptap/pm/view';
import { IS_MOBILE_UI } from '../../core/platform';
import { useWindowStore } from '../../stores/windowStore';
import { subscribeNoteIndex } from '../wikilink/noteIndex';
import { openWikiLink, resolveWikiLinkNow } from '../wikilink/wikiLinkNavigation';
import { editWikiLinkNode } from '../wikilink/wikiLinkActions';
import {
  EMBED_IMAGE_EXTENSIONS,
  findWikiLinkStart,
  formatWikiLinkMarkdown,
  formatWikiLinkInner,
  matchWikiLinkAtStart,
  parseWikiLinkInner,
  wikiLinkLabel,
  WIKI_LINK_MAX_LENGTH,
} from '../wikilink/wikiLinkSyntax';
import { hideWikiLinkTooltip, scheduleWikiLinkTooltip } from './wikiLinkTooltip';
import { EMBED_HEIGHT_VAR, embedHeightOf, embedIdentity, renderWikiEmbed } from './wikiLinkEmbed';
import { placeEmbedAsBlock } from './wikiLinkBlock';
import { emitRawSegment } from './rawMarkdownSegments';

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

/**
 * 点击手势：
 * - navigate：只读状态直接点击、桌面编辑状态 Ctrl / Cmd + 单击 → 跳转；
 * - edit：移动端编辑状态点击 → 打开编辑弹窗（弹窗内可再点「打开笔记」）；
 * - none：桌面编辑状态普通单击 → 交给 ProseMirror 选中节点。
 */
function clickIntent(event: MouseEvent, view: EditorView): 'navigate' | 'edit' | 'none' {
  if (event.button !== 0) return 'none';
  if (!view.editable || event.ctrlKey || event.metaKey) return 'navigate';
  return IS_MOBILE_UI ? 'edit' : 'none';
}

class WikiLinkNodeView implements NodeView {
  dom: HTMLSpanElement;
  private node: ProseMirrorNode;
  private readonly view: EditorView;
  private readonly getPos: () => number | undefined;
  private readonly getDocKey: () => string;
  private readonly unsubscribe: () => void;
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
    // 逐个切换而非整体覆盖 className，保留选中态等由 ProseMirror 管理的类
    this.dom.classList.toggle('nb-wikiembed', this.isEmbed);
    this.dom.classList.toggle('nb-wikilink', !this.isEmbed);
    this.dom.setAttribute('data-wiki-link', this.inner);
    if (this.isEmbed) {
      if (!this.embedContainer || this.embedContainer.parentNode !== this.dom) {
        this.embedContainer = document.createElement('span');
        this.embedContainer.className = 'nb-wikiembed-content';
        this.dom.replaceChildren(this.embedContainer);
        this.embedKey = '';
      }
      // `|高度` 只改卡片正文高度，不重新读取、渲染嵌入内容
      const height = embedHeightOf(this.inner);
      if (height === null) this.embedContainer.style.removeProperty(EMBED_HEIGHT_VAR);
      else this.embedContainer.style.setProperty(EMBED_HEIGHT_VAR, `${height}px`);
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
    const resolution = resolveWikiLinkNow(this.inner, this.getDocKey());
    this.dom.classList.toggle('is-unresolved', resolution.status === 'missing');
    if (!this.isEmbed || !this.embedContainer) return;
    // 身份不含 `|` 后的尺寸：拖动调整高度后不重新渲染内容（图片宽度变化仍需重渲染）
    const parts = parseWikiLinkInner(this.inner);
    const isImage = resolution.status === 'resolved' && EMBED_IMAGE_EXTENSIONS.has(resolution.entry.ext);
    const key = `${formatWikiLinkInner({ ...parts, alias: isImage ? parts.alias : '' })}\n${embedIdentity(resolution)}`;
    if (key === this.embedKey) return;
    this.embedKey = key;
    this.disposeEmbed?.();
    this.disposeEmbed = renderWikiEmbed(this.embedContainer, {
      inner: this.inner,
      resolution,
      onOpen: () => void openWikiLink(this.inner, this.getDocKey()),
      onResize: (height) => this.commitHeight(height),
      onHint: (target, text) => {
        if (target && text) scheduleWikiLinkTooltip(target, text);
        else hideWikiLinkTooltip();
      },
    });
  }

  /** 拖动卡片底边结束：把高度写回 `|高度`（null 去掉，恢复自动），可撤销 */
  private commitHeight(height: number | null): void {
    const pos = this.getPos();
    if (pos === undefined || !this.view.editable) return;
    const parts = parseWikiLinkInner(this.inner);
    const inner = formatWikiLinkInner({ ...parts, alias: height === null ? '' : String(height) });
    if (inner === this.inner) return;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, inner }));
  }

  /** 点在嵌入卡片的标题栏、正文链接等自身可交互区域 */
  private isInteractiveTarget(event: Event): boolean {
    return this.isEmbed && Boolean((event.target as HTMLElement | null)?.closest('a, button, .nb-wikiembed-resize'));
  }

  private handleMouseDown = (event: MouseEvent) => {
    // 跳转 / 弹窗手势不让 ProseMirror 选中节点或弹出键盘
    if (clickIntent(event, this.view) !== 'none' && !this.isInteractiveTarget(event)) event.preventDefault();
  };

  private handleClick = (event: MouseEvent) => {
    if (this.isInteractiveTarget(event)) return;
    const intent = clickIntent(event, this.view);
    if (intent === 'none') return;
    event.preventDefault();
    event.stopPropagation();
    hideWikiLinkTooltip();
    if (intent === 'navigate') void openWikiLink(this.inner, this.getDocKey());
    else this.openEditor();
  };

  private handleDoubleClick = (event: MouseEvent) => {
    if (IS_MOBILE_UI || !this.view.editable || this.isInteractiveTarget(event)) return;
    event.preventDefault();
    this.openEditor();
  };

  /** 打开编辑弹窗：改目标、标题、显示名、链接 / 嵌入，或删除 */
  private openEditor(): void {
    hideWikiLinkTooltip();
    const pos = this.getPos();
    if (pos === undefined) return;
    void editWikiLinkNode(this.view, pos, this.getDocKey());
  }

  private handleMouseEnter = () => {
    if (this.isEmbed) return;
    const resolution = resolveWikiLinkNow(this.inner, this.getDocKey());
    let text: string;
    if (resolution.status === 'missing') text = '未找到笔记，可能尚未同步';
    else if (resolution.status === 'resolved') text = resolution.entry.relPath;
    else if (resolution.status === 'self') text = '当前文档内的标题';
    else text = '正在查找笔记…';
    // 编辑状态提示跳转快捷键与双击编辑；只读状态单击即可跳转（提示组件负责 Mac 上的 Cmd 写法）
    if (this.view.editable) scheduleWikiLinkTooltip(this.dom, `${text} · 双击编辑`, 'Ctrl + 单击打开');
    else scheduleWikiLinkTooltip(this.dom, text);
  };

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

  /** 嵌入卡片标题栏与跳转 / 弹窗手势的事件不交给 ProseMirror */
  stopEvent(event: Event): boolean {
    if ((event.target as HTMLElement | null)?.closest?.('.nb-wikiembed-header, .nb-wikiembed-resize')) return true;
    return event.type === 'mousedown' && event instanceof MouseEvent && clickIntent(event, this.view) !== 'none';
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

/** 解析器上与标记施加相关的最小接口 */
interface MarkManagerLike {
  applyMarkToContent?: (markType: string, content: JSONContent[], attrs?: Record<string, unknown>) => JSONContent[];
  nbWikiLinkMarksPatched?: boolean;
}

/**
 * @tiptap/markdown 解析 `**粗体**` 等行内标记时只给文本节点加标记，
 * `**[[笔记]]**` 中的双链会丢失粗体，进入可视化再保存就变成 `[[笔记]]`。
 * 这里为本编辑器独占的解析器补上：标记同样作用于双链节点（序列化见 serialize.ts 的双链原文片段）。
 */
export function applyMarksToWikiLinks(manager: MarkManagerLike | undefined): void {
  if (!manager || manager.nbWikiLinkMarksPatched || typeof manager.applyMarkToContent !== 'function') return;
  const original = manager.applyMarkToContent;
  manager.applyMarkToContent = function (markType, content, attrs) {
    const result = original.call(this, markType, content, attrs);
    return result.map((node) => (node.type === 'wikiLink'
      ? { ...node, marks: [...(node.marks ?? []), attrs ? { type: markType, attrs } : { type: markType }] }
      : node));
  };
  manager.nbWikiLinkMarksPatched = true;
}

/**
 * 解析器创建后补上「行内标记作用于双链」的能力。
 * Markdown 扩展在 onBeforeCreate 中创建解析器；本扩展优先级最低，onBeforeCreate 排在其后执行，
 * 无论编辑器是否挂载到页面（无头编辑器不触发 onCreate）都能在首次解析前完成。
 */
export const WikiLinkMarkdownMarks = Extension.create({
  name: 'wikiLinkMarkdownMarks',
  priority: 1,
  onBeforeCreate() {
    applyMarksToWikiLinks((this.editor.storage as unknown as { markdown?: { manager?: MarkManagerLike } }).markdown?.manager);
  },
});

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
    // 正常保存时 serialize.ts 已把双链转为受保护的原文片段（携带粗体等标记）；这里只服务其它直接序列化的通道。
    // 原文同样经 emitRawSegment 登记，全文后处理（实体还原、冗余转义清理）不会改动链接内容
    return emitRawSegment(formatWikiLinkMarkdown(String(node.attrs?.inner ?? ''), node.attrs?.embed === true));
  },

  addInputRules() {
    const type = this.type;
    return [
      // 手动输入闭合的 `]]` 时转换为双链节点；前面带 `!` 时为嵌入，并单独成段
      new InputRule({
        find: new RegExp(`${WIKI_LINK_BODY}$`),
        handler: ({ state, range, match }) => {
          if (!match[2].trim()) return null;
          const embed = match[1] === '!';
          const node = type.create({ inner: match[2], embed });
          if (embed) placeEmbedAsBlock(state.tr, range.from, range.to, node);
          else state.tr.replaceWith(range.from, range.to, node);
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
