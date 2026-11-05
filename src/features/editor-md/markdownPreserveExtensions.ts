// NoteBoard 原样保留类 Markdown 节点
// 可视化编辑器不具备语义编辑能力、但必须在往返中逐字保留的语法：
// 1. Front matter（文档首部 `---` YAML 块）——此前会被解析成分隔线 + 二级标题并持续漂移；
// 2. 脚注引用 `[^id]` 与脚注定义 `[^id]: 内容`——此前被 marked 当作引用式链接改写为 `[^1](note)`；
// 3. 块级原始 HTML（`<details>`、`<div align>` 等）——此前被剥成纯文本。
// 这些节点在可视化模式中以只读源码样式展示，编辑需切换到源码模式；
// 块级 HTML 例外：可渲染时显示过滤后的渲染结果，并可就地编辑源码（见 rawHtmlBlockView）。

import { ReactNodeViewRenderer } from '@tiptap/react';
import { RawHtmlBlockComponent } from './rawHtmlBlockView';
import { createRawHtmlInlineView } from './rawHtmlInlineView';
import { FrontMatterBlockCore, FootnoteDefinitionBlockCore, FootnoteReferenceCore, RawHtmlInlineCore, RawHtmlBlockMergeCore, RawHtmlBlockCore } from './markdownPreserveCore';

/** Front matter 原子节点：raw 保存含分隔符的完整原文 */
export const FrontMatterBlock = FrontMatterBlockCore;

/** 脚注定义原子节点：raw 保存 `[^id]: 内容`（含续行）原文 */
export const FootnoteDefinitionBlock = FootnoteDefinitionBlockCore;

/** 脚注引用行内原子节点 */
export const FootnoteReference = FootnoteReferenceCore;

/** 行内原始 HTML 标签原子节点：保留 <kbd>、<span style>、<sub>、<img> 等 schema 无法表达的标签，标签间文字仍可编辑；
 *  包裹图片的链接 `<a href><img></a>` 整体作为一个节点 */
export const RawHtmlInline = RawHtmlInlineCore.extend({
  // 可视化显示：含图片的渲染为过滤后的图片，其余维持源码标签样式；renderHTML 仍用于剪贴板与 getHTML
  addNodeView() {
    return createRawHtmlInlineView;
  }
});

/**
 * 合并被空行拆开的块级 HTML：整体是一段完整 HTML 时产出单个块级 html token，交给 RawHtmlBlock 解析（规则见 rawHtmlScan）。
 * marked 后注册的块级 tokenizer 先执行，本扩展须先于折叠块/分栏/高亮块注册，保证其标准写法优先被识别。
 */
export const RawHtmlBlockMerge = RawHtmlBlockMergeCore;

/** 块级原始 HTML 原子节点：仅接管 marked 的块级 html token，行内 HTML 维持原有处理 */
export const RawHtmlBlock = RawHtmlBlockCore.extend({
  // 可视化显示：渲染预览 / 源码样式 + 就地编辑；renderHTML 仍用于剪贴板与 getHTML
  addNodeView() {
    return ReactNodeViewRenderer(RawHtmlBlockComponent);
  }
});
