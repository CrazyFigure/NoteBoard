// 笔记插件复用现有主题、触屏缩放和 PDF 查看器；同一时刻只保留当前页/附件。
import { createView, el, pager, zoomControl, iconButton, dropdown } from './view.mjs';
import { noteMediaType } from './noteArchive.mjs';
import { mount as mountPdf } from '../pdf/index.mjs';
const SVG = 'http://www.w3.org/2000/svg';

/** 用填充轮廓保留每点宽度，同一笔高亮只应用一次透明度，避免线段相交处加深。 */
export function inkSvg(page) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${page.width} ${page.height}`);
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', page.label);
  for (const stroke of page.strokes) {
    let run = [];
    const draw = () => {
      if (!run.length) return;
      const node = document.createElementNS(SVG, run.length === 1 ? 'circle' : 'path');
      node.setAttribute('fill', `rgb(${stroke.color.join(',')})`); node.setAttribute('opacity', String(stroke.opacity));
      if (run.length === 1) { node.setAttribute('cx', run[0][0]); node.setAttribute('cy', run[0][1]); node.setAttribute('r', Math.max(.05, run[0][2] / 2)); }
      else {
        const left = [], right = [];
        for (let i = 0; i < run.length; i++) {
          const [x, y, width] = run[i], before = run[Math.max(0, i - 1)], after = run[Math.min(run.length - 1, i + 1)];
          const dx = after[0] - before[0], dy = after[1] - before[1], length = Math.hypot(dx, dy) || 1;
          const nx = -dy / length * width / 2, ny = dx / length * width / 2;
          left.push(`${x + nx},${y + ny}`); right.push(`${x - nx},${y - ny}`);
        }
        node.setAttribute('d', `M${left.join('L')}L${right.reverse().join('L')}Z`);
      }
      svg.append(node); run = [];
    };
    for (const point of stroke.points) {
      if (stroke.breaks && Math.abs(point[0]) < .01 && Math.abs(point[1]) < .01) draw();
      // 连续重复坐标表示点状笔画，合并后按圆点绘制，避免退化轮廓不可见。
      else if (run.length && run.at(-1)[0] === point[0] && run.at(-1)[1] === point[1]) {
        if (point[2] > run.at(-1)[2]) run[run.length - 1] = point;
      } else run.push(point);
    }
    draw();
  }
  return svg;
}

/** 文档关闭、切页和切附件分别取消异步任务，Blob 与 PDF 线程均随所属视图释放。 */
export async function mountNotebook(context, openBook) {
  const { container, name, bytes, signal, reading } = context;
  const book = await openBook(bytes, signal); signal.throwIfAborted();
  if (!book.pages.length && !book.resources.length) throw new Error('未找到可阅读的笔迹或内嵌预览，请在原应用导出 PDF');
  const view = createView(container, name, reading);
  view.style.textContent += `:host [hidden]{display:none!important}.np-note-notice{margin:0;padding:8px 12px;border-bottom:1px solid var(--editor-border);line-height:1.6;font-size:12px;color:var(--editor-text-muted);max-height:112px;overflow:auto;flex-shrink:0}.np-note-stage{min-width:100%;width:max-content;padding:12px;background:var(--np-backdrop);min-height:100%}.np-note-paper{display:block;margin:auto;background:white;box-shadow:var(--np-paper-shadow);max-width:none}.np-note-paper>svg,.np-note-paper>img{display:block;width:100%;height:auto}.np-note-attachment{height:100%;min-height:0}.np-note-message{padding:24px;max-width:600px;white-space:pre-wrap}.np-select{max-width:min(280px,100%)}@media(max-width:760px){.np-note-notice{padding:6px 8px;max-height:96px}.np-note-stage{padding:8px}}`;
  const notice = el('p', 'np-note-notice', book.warnings.join(' ')); notice.setAttribute('role', 'note');
  view.toolbar.after(notice);
  const stage = el('div', 'np-note-stage'), paper = el('div', 'np-note-paper'); stage.append(paper);
  let page = 0, selected = book.pages.some((p) => p.strokes.length) ? 'ink' : book.resources.length ? '0' : 'ink';
  let zoom = 1, fit = true, disposed = false, generation = 0, release = () => {}, resourceController;
  const pageControl = pager({ go: (n) => { page = n - 1; void show(); } });
  const zoomer = zoomControl({ min: .1, max: 4, step: .1, target: view.viewport, get: () => zoom, set: (next) => { zoom = next; fit = false; layout(); } });
  const fitButton = iconButton('fit-width', '适合宽度', () => { fit = true; layout(); });
  const options = [...(book.pages.length ? [['ink', '笔迹页面（兼容解析）']] : []), ...book.resources.map((r, i) => [String(i), r.label])];
  const selector = dropdown({ options, value: selected, ariaLabel: '查看笔迹或内嵌资源', onChange: (value) => { selected = value; void show(); } });
  view.toolbar.append(selector, pageControl.element, zoomer.element, fitButton);

  /** 自适应以逻辑宽度计算，窄屏不强制 25% 下限，长纸使用 SVG 避免大 Canvas 分配。 */
  function layout() {
    const natural = Number(paper.dataset.width) || 612;
    if (fit) zoom = Math.min(1, Math.max(.01, (view.viewport.clientWidth - 24) / natural));
    paper.style.width = `${natural * zoom}px`; zoomer.update();
  }
  async function show() {
    const token = ++generation;
    resourceController?.abort(); release(); release = () => {};
    view.viewport.replaceChildren(stage); paper.replaceChildren(); view.viewport.scrollTop = 0;
    const ink = selected === 'ink';
    pageControl.element.hidden = !ink; zoomer.element.hidden = false; fitButton.hidden = false;
    if (ink) {
      const item = book.pages[page]; pageControl.set(page + 1, book.pages.length);
      paper.dataset.width = String(item.width); paper.append(inkSvg(item));
      if (!item.strokes.length) paper.append(el('p', 'np-note-message', '此页未解析出可显示的笔迹；页面可能为空，或含尚不支持的内容。请在原应用核对。'));
      layout(); return;
    }
    paper.append(el('p', 'np-note-message', '正在读取内嵌资源…'));
    try {
      const resource = book.resources[Number(selected)], data = await resource.read();
      if (disposed || signal.aborted || token !== generation) return;
      const type = noteMediaType(data);
      paper.replaceChildren();
      if (type === 'application/pdf') {
        zoomer.element.hidden = true; fitButton.hidden = true;
        const host = el('div', 'np-note-attachment'); view.viewport.replaceChildren(host);
        resourceController = new AbortController();
        const cleanup = await mountPdf({ ...context, container: host, name: `${resource.label}（独立附件，不含笔记批注）`, bytes: data, signal: resourceController.signal, reading: undefined });
        if (disposed || signal.aborted || token !== generation) cleanup?.(); else release = cleanup ?? (() => {});
      } else if (type?.startsWith('image/')) {
        const url = URL.createObjectURL(new Blob([data], { type })); release = () => URL.revokeObjectURL(url);
        const image = el('img'); image.alt = resource.preview ? '内嵌预览，通常仅包含首页，不能代表完整笔记' : '独立图片附件，不含笔记批注';
        image.onload = () => {
          if (disposed || token !== generation) return;
          paper.dataset.width = String(image.naturalWidth || 612); layout();
        };
        image.onerror = () => { if (!disposed && token === generation) paper.replaceChildren(el('p', 'np-note-message', '此内嵌图片无法解码，请从原应用导出 PDF。')); };
        image.src = url; paper.append(image); layout();
      } else paper.append(el('p', 'np-note-message', '此附件不是可识别的 PNG、JPEG 或 PDF，无法直接阅读。请从原应用导出 PDF。'));
    } catch (error) {
      if (!disposed && !signal.aborted && token === generation) { view.viewport.replaceChildren(stage); paper.replaceChildren(el('p', 'np-note-message', `资源无法打开：${error.message}`)); }
    }
  }
  const resize = new ResizeObserver(() => { if (fit) layout(); }); resize.observe(view.viewport);
  const destroy = () => {
    if (disposed) return;
    disposed = true; generation++; resourceController?.abort(); release(); resize.disconnect(); selector.close(); view.destroy();
    signal.removeEventListener('abort', destroy);
  };
  signal.addEventListener('abort', destroy, { once: true });
  try { await show(); } catch (error) { destroy(); throw error; }
  return destroy;
}
