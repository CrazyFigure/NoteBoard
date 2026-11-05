// CAD 缩略图：复用现有渲染器缓存整图，不创建第二份几何场景或 WebGL 上下文。
import { el, iconButton } from '../shared/view.mjs';

const STORAGE_KEY = 'nb-minimap-visible:cad';
// 面板尺寸、留白及自动出现阈值与主程序的画布缩略图保持一致。
const MAX_WIDTH = 200, MAX_HEIGHT = 150, MIN_SIDE = 48, PAD = 8;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** 在有界总览采样中查找已绘制像素；整图适配留白使左上角像素可作为背景色。 */
export function imageContentBounds({ data, width, height }) {
  let left = width, top = height, right = -1, bottom = -1;
  // 忽略不超过 2 级的插值舍入差异，细线的抗锯齿像素仍参与边界计算。
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    if (Math.abs(data[offset] - data[0]) <= 2 && Math.abs(data[offset + 1] - data[1]) <= 2
      && Math.abs(data[offset + 2] - data[2]) <= 2 && Math.abs(data[offset + 3] - data[3]) <= 2) continue;
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  if (right < left) return null;
  // 外扩一个采样像素，保留边缘细线；不能按实体距离或数量丢弃远处的真实内容。
  return { left: Math.max(0, left - 1), top: Math.max(0, top - 1), right: Math.min(width, right + 2), bottom: Math.min(height, bottom + 2) };
}

/** 世界坐标的 Y 轴向上；面板坐标的 Y 轴向下，统一在映射处转换。 */
export function minimapLayout(bounds, viewport) {
  const bw = Math.max(1e-9, bounds.maxX - bounds.minX), bh = Math.max(1e-9, bounds.maxY - bounds.minY);
  const sizeScale = Math.min((MAX_WIDTH - PAD * 2) / bw, (MAX_HEIGHT - PAD * 2) / bh);
  const width = Math.round(Math.max(MIN_SIDE, bw * sizeScale + PAD * 2));
  const height = Math.round(Math.max(MIN_SIDE, bh * sizeScale + PAD * 2));
  // 视野移到空白处时合并显示范围，保证视口框仍完整留在面板内。
  const minX = Math.min(bounds.minX, viewport.minX), maxX = Math.max(bounds.maxX, viewport.maxX);
  const minY = Math.min(bounds.minY, viewport.minY), maxY = Math.max(bounds.maxY, viewport.maxY);
  const scale = Math.min((width - PAD * 2) / Math.max(1e-9, maxX - minX), (height - PAD * 2) / Math.max(1e-9, maxY - minY));
  return { width, height, scale, minX, maxY,
    x: (width - (maxX - minX) * scale) / 2,
    y: (height - (maxY - minY) * scale) / 2 };
}

/** 按实际重叠面积与边长判断；回差避免在临界缩放来回闪烁。 */
export function needsMinimap(bounds, viewport, wasNeeded = false) {
  const overlap = (min, max) => Math.max(0, Math.min(bounds[max], viewport[max]) - Math.max(bounds[min], viewport[min])) / Math.max(1e-9, bounds[max] - bounds[min]);
  const x = overlap('minX', 'maxX'), y = overlap('minY', 'maxY');
  return x * y <= (wasNeeded ? .42 : 1 / 3) || Math.min(x, y) <= (wasNeeded ? .6 : .5);
}

/** 挂载后由 onViewChange 调用 sync；只有主题改变才使整图缓存失效。 */
export function mountMinimap(host, renderer) {
  let enabled = true;
  try { enabled = localStorage.getItem(STORAGE_KEY) !== '0'; } catch { /* 存储不可用时仍可切换 */ }
  let stopped = false, capturing = false, dirty = true, needed = false, frame = 0, mapping, drag = null, imageBounds;
  // 原始实体范围可能包含未绘制的尺寸标注占位点；首张总览生成后改用实际绘制范围。
  let contentBounds = renderer.getBounds();
  const image = el('canvas'), panel = el('div', 'cad-minimap'), canvas = el('canvas'), box = el('div', 'cad-minimap-viewport');
  const style = el('style');
  style.textContent = `
    .cad-minimap{position:absolute;z-index:6;right:12px;bottom:10px;overflow:hidden;border:1px solid var(--editor-border);border-radius:8px;background:var(--editor-surface);box-shadow:0 4px 14px #0000001a;cursor:pointer;user-select:none;touch-action:none;transition:border-color .12s,box-shadow .12s}
    .cad-minimap:hover,.cad-minimap:focus-visible{border-color:var(--editor-accent);box-shadow:0 6px 18px #00000024}
    .cad-minimap:focus-visible{outline:2px solid var(--editor-accent);outline-offset:2px}
    .cad-minimap[data-dragging]{cursor:grabbing}.cad-minimap:active{border-color:var(--editor-accent)}
    .cad-minimap-viewport{position:absolute;left:0;top:0;pointer-events:none;border:1.5px solid var(--editor-accent);border-radius:2px;background:color-mix(in srgb,var(--editor-accent) 16%,transparent)}
    .cad-minimap[data-dragging] .cad-minimap-viewport{background:color-mix(in srgb,var(--editor-accent) 24%,transparent)}
    button.cad-minimap-close{position:absolute;top:4px;right:4px;width:20px;min-width:20px;height:20px;padding:0;opacity:0;transition:opacity .12s,background .12s,transform .12s}
    .cad-minimap:hover .cad-minimap-close,.cad-minimap:focus-within .cad-minimap-close{opacity:1}
    button.cad-minimap-show{position:absolute;z-index:7;right:12px;bottom:10px;opacity:.7;box-shadow:0 2px 6px #00000014}
    button.cad-minimap-show:hover,button.cad-minimap-show:focus-visible{opacity:1}
    .cad-minimap[hidden],button.cad-minimap-show[hidden]{display:none}
    @media(pointer:coarse){button.cad-minimap-close{opacity:1;width:28px;height:28px}}
  `;
  panel.tabIndex = 0; panel.setAttribute('role', 'group'); panel.setAttribute('aria-label', '图纸缩略图（方向键移动视野）');
  const close = iconButton('x', '隐藏缩略图', () => toggle(false), 'cad-minimap-close');
  const show = iconButton('map', '显示缩略图', () => toggle(true), 'cad-minimap-show');
  close.setAttribute('aria-expanded', 'true'); show.setAttribute('aria-expanded', 'false');
  panel.append(canvas, box, close); host.append(style, panel, show);
  // 异步首帧之前保持隐藏，避免空面板闪现。
  panel.hidden = true; show.hidden = true;

  /** 读取真实 Canvas 的 CSS 尺寸，不能把 DPR 像素当成世界坐标。 */
  function viewport() {
    const topLeft = renderer.screenToWorld({ x: 0, y: 0 });
    const bottomRight = renderer.screenToWorld({ x: renderer.canvas.clientWidth, y: renderer.canvas.clientHeight });
    return { minX: topLeft.x, maxY: topLeft.y, maxX: bottomRight.x, minY: bottomRight.y };
  }

  /** 同一任务内临时切到整图并同步恢复，浏览器绘制前已还原用户位置与缩放。 */
  function capture(bounds) {
    const saved = renderer.getViewState();
    let source;
    capturing = true;
    try {
      const width = renderer.canvas.clientWidth, height = renderer.canvas.clientHeight;
      renderer.setViewState({ centerX: (bounds.minX + bounds.maxX) / 2, centerY: (bounds.minY + bounds.maxY) / 2,
        scale: Math.min(width / Math.max(1e-9, bounds.maxX - bounds.minX), height / Math.max(1e-9, bounds.maxY - bounds.minY)) * .92 });
      imageBounds = viewport();
      // renderer.captureCanvas 同步合成 WebGL 与文字层，不能使用异步截图打断恢复流程。
      source = renderer.captureCanvas();
      const ratio = Math.min(1, 400 / source.width, 300 / source.height);
      image.width = Math.max(1, Math.round(source.width * ratio)); image.height = Math.max(1, Math.round(source.height * ratio));
      // 高质量降采样保留细线，避免小比例下图纸线段被普通采样漏掉。
      const context = image.getContext('2d'); context.imageSmoothingQuality = 'high';
      context.drawImage(source, 0, 0, image.width, image.height);
      const clip = imageContentBounds(context.getImageData(0, 0, image.width, image.height));
      if (clip) {
        const left = clip.left / image.width, top = clip.top / image.height;
        const width = (clip.right - clip.left) / image.width, height = (clip.bottom - clip.top) / image.height;
        const worldWidth = imageBounds.maxX - imageBounds.minX, worldHeight = imageBounds.maxY - imageBounds.minY;
        // 裁剪必须同时换算世界边界，视口框、点击与拖动才会与总览图严格对齐。
        imageBounds = { minX: imageBounds.minX + left * worldWidth, maxX: imageBounds.minX + (left + width) * worldWidth,
          maxY: imageBounds.maxY - top * worldHeight, minY: imageBounds.maxY - (top + height) * worldHeight };
        contentBounds = imageBounds;
        const pixelWidth = source.width * width, pixelHeight = source.height * height;
        const cropRatio = Math.min(1, 400 / pixelWidth, 300 / pixelHeight);
        image.width = Math.max(1, Math.round(pixelWidth * cropRatio)); image.height = Math.max(1, Math.round(pixelHeight * cropRatio));
        // 从原截图取裁剪区域，避免放大低分辨率采样后损失细节。
        context.imageSmoothingQuality = 'high';
        context.drawImage(source, source.width * left, source.height * top, pixelWidth, pixelHeight, 0, 0, image.width, image.height);
      } else contentBounds = bounds;
      mapping = null;
      dirty = false;
    } finally {
      // 截图失败也必须恢复原视野，临时全尺寸位图立即释放。
      if (source) { source.width = 0; source.height = 0; }
      try { renderer.setViewState(saved); } finally { capturing = false; }
    }
  }

  /** 隐藏时只计算显隐；普通平移只移动框，缓存映射变化才重画小位图。 */
  function update() {
    let bounds = contentBounds;
    const vp = viewport();
    const valid = Object.values(bounds).every(Number.isFinite) && bounds.maxX >= bounds.minX && bounds.maxY >= bounds.minY;
    needed = valid && renderer.canvas.clientWidth > 0 && renderer.canvas.clientHeight > 0 && (Boolean(drag) || needsMinimap(bounds, vp, needed));
    panel.hidden = !enabled || !needed; show.hidden = enabled || !needed;
    if (panel.hidden) return;
    try {
      if (dirty) {
        // 主题刷新仍从完整实体范围截图，不能累积裁剪误差或遗漏新显现的边缘线条。
        capture(renderer.getBounds()); bounds = contentBounds;
        needed = Boolean(drag) || needsMinimap(bounds, vp, needed);
        panel.hidden = !needed;
        if (panel.hidden) return;
      }
    }
    catch { panel.hidden = true; return; /* 辅助预览失败不能影响主图 */ }
    const next = drag?.mapping ?? minimapLayout(bounds, vp);
    if (!mapping || dirty || Object.keys(next).some((key) => next[key] !== mapping[key])) {
      mapping = next;
      panel.style.width = `${mapping.width}px`; panel.style.height = `${mapping.height}px`;
      const pixel = Math.min(globalThis.devicePixelRatio || 1, 2);
      canvas.width = Math.round(mapping.width * pixel); canvas.height = Math.round(mapping.height * pixel);
      const ctx = canvas.getContext('2d'); ctx.setTransform(pixel, 0, 0, pixel, 0, 0); ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image, mapping.x + (imageBounds.minX - mapping.minX) * mapping.scale, mapping.y + (mapping.maxY - imageBounds.maxY) * mapping.scale,
        (imageBounds.maxX - imageBounds.minX) * mapping.scale, (imageBounds.maxY - imageBounds.minY) * mapping.scale);
    }
    box.style.width = `${(vp.maxX - vp.minX) * mapping.scale}px`; box.style.height = `${(vp.maxY - vp.minY) * mapping.scale}px`;
    box.style.transform = `translate(${mapping.x + (vp.minX - mapping.minX) * mapping.scale}px,${mapping.y + (mapping.maxY - vp.maxY) * mapping.scale}px)`;
  }

  /** 合并密集的缩放、平移和窗口尺寸事件；截图中的临时视野事件直接忽略。 */
  function sync() {
    if (stopped || capturing || frame) return;
    frame = requestAnimationFrame(() => { frame = 0; if (!stopped) update(); });
  }
  function toggle(next) {
    enabled = next; drag = null; panel.removeAttribute('data-dragging');
    try { localStorage.setItem(STORAGE_KEY, next ? '1' : '0'); } catch { /* 不阻断本次操作 */ }
    update(); (next ? close : show).focus({ preventScroll: true });
  }
  /** 将面板内指针换算成世界坐标；拖动期间锁定映射以免空白区扩展导致跳动。 */
  function point(event, map = mapping) {
    const rect = panel.getBoundingClientRect();
    return { x: map.minX + ((event.clientX - rect.left) * map.width / rect.width - map.x) / map.scale,
      y: map.maxY - ((event.clientY - rect.top) * map.height / rect.height - map.y) / map.scale };
  }
  function navigate(x, y) {
    const bounds = contentBounds;
    renderer.setViewState({ ...renderer.getViewState(), centerX: clamp(x, bounds.minX, bounds.maxX), centerY: clamp(y, bounds.minY, bounds.maxY) });
  }
  panel.addEventListener('pointerdown', (event) => {
    event.stopPropagation();
    if (event.button !== 0 || event.target.closest('button') || !mapping) return;
    event.preventDefault(); panel.focus({ preventScroll: true });
    const p = point(event), vp = viewport(), view = renderer.getViewState();
    const inside = p.x >= vp.minX && p.x <= vp.maxX && p.y >= vp.minY && p.y <= vp.maxY;
    drag = { id: event.pointerId, mapping, dx: inside ? p.x - view.centerX : 0, dy: inside ? p.y - view.centerY : 0 };
    panel.setPointerCapture(event.pointerId); panel.setAttribute('data-dragging', '');
    if (!inside) navigate(p.x, p.y);
  });
  panel.addEventListener('pointermove', (event) => {
    if (drag?.id !== event.pointerId) return;
    event.stopPropagation(); const p = point(event, drag.mapping); navigate(p.x - drag.dx, p.y - drag.dy);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) panel.addEventListener(type, (event) => {
    if (drag?.id !== event.pointerId) return;
    event.stopPropagation(); drag = null; panel.removeAttribute('data-dragging');
    if (panel.hasPointerCapture(event.pointerId)) panel.releasePointerCapture(event.pointerId);
    sync();
  });
  panel.addEventListener('keydown', (event) => {
    if (event.target !== panel || event.ctrlKey || event.metaKey || event.altKey) return;
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[event.key];
    if (!direction) return;
    event.preventDefault(); event.stopPropagation(); const vp = viewport(), view = renderer.getViewState();
    navigate(view.centerX + direction[0] * (vp.maxX - vp.minX) / 10, view.centerY + direction[1] * (vp.maxY - vp.minY) / 10);
  });
  for (const node of [panel, show]) for (const type of ['pointerdown', 'mousedown', 'dblclick', 'wheel']) node.addEventListener(type, (event) => event.stopPropagation());
  sync();
  return { sync, invalidate() { dirty = true; mapping = null; sync(); }, destroy() {
    stopped = true; cancelAnimationFrame(frame); drag = null;
    image.width = 0; image.height = 0; canvas.width = 0; canvas.height = 0;
    panel.remove(); show.remove(); style.remove();
  } };
}
