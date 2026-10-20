// Word 只读查看：DOCX 保留页面结构，DOC 使用免费二进制解析器；永不写回原文件。
import { renderAsync } from 'docx-preview';
import { parseMsDocToHtml } from 'msdoc-viewer';
import DOMPurify from 'dompurify';
import { createView, button, guardLinks, applyFontFallback } from '../shared/view.mjs';
import { cleanOpenXml } from '../shared/openXml.mjs';

export async function mount({ container, name, bytes, signal, notify }) {
  const view = createView(container, name);
  guardLinks(view.root, notify);
  let zoom = 1;
  const page = document.createElement('div'); page.className = 'np-word';
  view.viewport.append(page);
  view.style.textContent += `
    .np-scroll{background:var(--editor-surface)}.np-word{padding:24px;transform-origin:top left;font-family:var(--content-font-family,var(--ui-font-family));overflow:auto;min-height:100%}.np-word>div.docx-wrapper{padding:0;background:transparent}.np-word section.docx{box-shadow:var(--shadow-sm);margin:0 auto 24px}.np-word.reading,.np-word.reading *{font-family:var(--content-font-family,var(--ui-font-family))!important;color:var(--editor-text)!important;background-color:var(--editor-bg)!important}.np-word.reading section{max-width:100%;width:auto!important;min-height:0!important}.np-word img{max-width:100%}@media(max-width:760px){.np-word{padding:10px}.np-word section.docx{margin-bottom:10px}}
  `;
  const zoomLabel = document.createElement('span'); zoomLabel.textContent = '100%';
  const applyZoom = (delta) => { zoom = Math.min(2, Math.max(.4, zoom + delta)); page.style.zoom = String(zoom); zoomLabel.textContent = `${Math.round(zoom * 100)}%`; };
  // 以未缩放的页面和容器内边距计算比例，重复点击不会越缩越小。
  const fitWidth=()=>{
    const paper=page.querySelector('section.docx,table');let width=paper?.offsetWidth??view.viewport.clientWidth-24;
    if(paper)for(let parent=paper.parentElement;parent;parent=parent.parentElement){const css=getComputedStyle(parent);width+=(parseFloat(css.paddingLeft)||0)+(parseFloat(css.paddingRight)||0);if(parent===page)break;}
    zoom=Math.min(1,Math.max(.25,(view.viewport.clientWidth-24)/Math.max(1,width)));page.style.zoom=String(zoom);zoomLabel.textContent=`${Math.round(zoom*100)}%`;
  };
  view.toolbar.append(button('−', () => applyZoom(-.1)), zoomLabel, button('＋', () => applyZoom(.1)), button('适合宽度',fitWidth),button('阅读排版', () => {page.classList.toggle('reading');if(page.classList.contains('reading')){zoom=1;applyZoom(0);}else fitWidth();}));
  try {
    if (/\.docx$/i.test(name)) {
      // 禁止嵌入 HTML 内容块，修订和批注按静态文档呈现，不启用编辑器。
      const cleanBytes=await cleanOpenXml(bytes);if(signal.aborted){view.destroy();return;}
      await renderAsync(cleanBytes, page, page, { inWrapper:true, ignoreLastRenderedPageBreak:false, renderAltChunks:false, renderChanges:false, renderComments:false, useBase64URL:true });
    } else {
      const result = await parseMsDocToHtml(bytes);
      if (signal.aborted) { view.destroy(); return; }
      const style = document.createElement('style'); style.textContent = (result.css ?? '').replace(/@import[^;]+;/gi,'').replace(/url\(\s*['"]?https?:[^)]+\)/gi,'none');
      page.append(style);
      const body = document.createElement('div');
      // 旧版 DOC 样式以此容器为作用域，不能只插入内部表格而丢失默认排版。
      body.className='msdoc-root';body.style.fontFamily='var(--content-font-family,var(--ui-font-family))';
      body.innerHTML = DOMPurify.sanitize(result.html, { ADD_ATTR:['style'], ALLOWED_URI_REGEXP:/^(?:data:|blob:|#)/i });
      page.append(body);
    }
    // 文档内的远程图片、样式和对象不参与只读预览，避免离线阅读触发外部资源请求。
    for (const e of page.querySelectorAll('script,iframe,object,embed,link')) e.remove();
    for (const image of page.querySelectorAll('img')) if (!/^(data:|blob:)/i.test(image.src)) image.removeAttribute('src');
    for (const style of page.querySelectorAll('style')) style.textContent = style.textContent.replace(/@import[^;]+;/gi, '').replace(/url\(\s*['"]?https?:[^)]+\)/gi, 'none');
    applyFontFallback(page);
    if(view.viewport.clientWidth<760)fitWidth();
    if (signal.aborted) view.destroy();
    return view.destroy;
  } catch (error) { view.destroy(); throw error; }
}
