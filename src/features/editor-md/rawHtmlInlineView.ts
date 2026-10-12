// NoteBoard 行内原始 HTML 节点视图
// 含图片的行内 HTML（段落内的 <img>、README 常见的 `<a href><img></a>` 徽章/Logo 写法）渲染为过滤后的图片，
// 其余标签（<kbd>、<span style> 等）维持原有的源码标签样式。raw 原文始终是唯一数据源。

import type { NodeViewRendererProps } from '@tiptap/core';
import type { NodeView } from '@tiptap/pm/view';
import { useWindowStore } from '../../stores/windowStore';
import { handleLinkClick } from './linkHandler';
import { renderRawHtmlPreview } from './rawHtmlRender';
import { resolveDocumentImageSrc } from './rawHtmlBlockView';

const IMAGE_TAG_PATTERN = /<img\b/i;

/** 源码标签样式（与 renderHTML 输出一致） */
function createSourceView(raw: string): NodeView {
  const dom = document.createElement('code');
  dom.className = 'nb-md-raw-inline';
  dom.setAttribute('data-raw-html-inline', '');
  dom.textContent = raw;
  return { dom };
}

export function createRawHtmlInlineView({ node }: NodeViewRendererProps): NodeView {
  const raw = String(node.attrs.raw ?? '');
  const preview = IMAGE_TAG_PATTERN.test(raw) ? renderRawHtmlPreview(raw, resolveDocumentImageSrc) : null;
  if (preview?.kind !== 'render') return createSourceView(raw);

  const dom = document.createElement('span');
  dom.className = 'nb-md-html-inline';
  dom.contentEditable = 'false';
  // 内容已经过 DOMPurify 白名单过滤
  dom.innerHTML = preview.html;
  // 行内元素无法用 contain 约束绘制范围，直接去掉脱离文档流的定位，防止内联样式遮盖界面
  for (const element of dom.querySelectorAll<HTMLElement>('[style]')) {
    if (/^(?:fixed|absolute|sticky)$/i.test(element.style.position)) element.style.removeProperty('position');
  }
  // 链接一律拦截原生跳转（否则 webview 自身会被导航走）；与普通链接一致，Ctrl/Cmd + 单击打开
  dom.addEventListener('click', (event) => {
    const anchor = (event.target as HTMLElement).closest('a');
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute('href');
    const activeKey = useWindowStore.getState().activeKey;
    if ((event.ctrlKey || event.metaKey) && href && activeKey) void handleLinkClick(href, activeKey);
  });
  dom.addEventListener('auxclick', (event) => {
    if ((event.target as HTMLElement).closest('a')) event.preventDefault();
  });

  return {
    dom,
    // 点击交由上面的监听处理，不让编辑器的链接插件把它当作链接标记去编辑；按下仍交给编辑器以选中节点
    stopEvent: (event) => event.type === 'click' || event.type === 'auxclick',
    ignoreMutation: () => true,
    update: (next) => next.type === node.type && next.attrs.raw === raw,
  };
}
