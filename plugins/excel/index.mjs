// Excel 只读表格：使用保存的公式结果，虚拟化可视区域，不执行宏和公式。
import * as XLSX from 'xlsx';
import { createView, el, button, copyText, zoomControl, separator, tip, MOD } from '../shared/view.mjs';
import { cleanOpenXml } from '../shared/openXml.mjs';

const ROW = 26, COL = 100, LABEL = 48, HEADER = 26, MIN = 24;

/** 行列尺寸前缀和：虚拟化定位与命中均为对数时间，拖动调整只重算受影响之后的部分。 */
export class Axis {
  constructor(sizes) { this.sizes = Float64Array.from(sizes); this.offsets = new Float64Array(this.sizes.length + 1); this.rebuild(0); }
  rebuild(from) { for (let i = from; i < this.sizes.length; i++) this.offsets[i + 1] = this.offsets[i] + this.sizes[i]; }
  get total() { return this.offsets[this.sizes.length]; }
  start(i) { return this.offsets[i]; }
  size(i) { return this.sizes[i]; }
  end(i) { return this.offsets[i + 1]; }
  /** 返回包含该位置的索引；越界时夹到首尾。 */
  indexAt(position) {
    let low = 0, high = this.sizes.length - 1;
    if (high < 0) return 0;
    while (low < high) { const mid = (low + high + 1) >> 1; if (this.offsets[mid] <= position) low = mid; else high = mid - 1; }
    return low;
  }
  resize(i, size) { this.sizes[i] = size; this.rebuild(i); }
}

/** 列宽优先取像素值，其次按字符宽换算；隐藏列宽度为 0。 */
export function columnSizes(cols = [], count) {
  return Array.from({ length: count }, (_, i) => {
    const c = cols[i]; if (!c) return COL; if (c.hidden) return 0;
    if (c.wpx) return Math.max(MIN, c.wpx);
    if (c.wch) return Math.max(MIN, Math.round(c.wch * 7 + 5));
    if (c.width) return Math.max(MIN, Math.round(c.width * 7));
    return COL;
  });
}

/** 行高优先取像素值，其次按磅换算；隐藏行高度为 0。 */
export function rowSizes(rows = [], count) {
  return Array.from({ length: count }, (_, i) => {
    const r = rows[i]; if (!r) return ROW; if (r.hidden) return 0;
    if (r.hpx) return Math.max(18, Math.round(r.hpx));
    if (r.hpt) return Math.max(18, Math.round(r.hpt * 4 / 3));
    return ROW;
  });
}

export async function mount({ container, name, bytes, signal, notify }) {
  const workbook = XLSX.read(/\.xlsx$/i.test(name)?await cleanOpenXml(bytes):bytes, { type:'array', cellStyles:true, cellDates:true, cellFormula:true });
  if (signal.aborted) return;
  const view = createView(container, name);
  view.style.textContent += `
    .np-scroll{background:var(--editor-bg);outline:none}
    .np-formula{display:flex;align-items:stretch;border-bottom:1px solid var(--editor-border);background:var(--editor-bg);flex-shrink:0;min-height:30px}
    .np-address{width:88px;flex-shrink:0;display:flex;align-items:center;justify-content:center;border-right:1px solid var(--editor-border);color:var(--editor-text-muted);font-size:12px;font-variant-numeric:tabular-nums;user-select:none}
    .np-value{flex:1;min-width:0;padding:6px 12px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:96px;overflow:auto;user-select:text;font-family:var(--content-font-family,var(--ui-font-family));line-height:1.5}
    .np-value small{color:var(--editor-text-muted);margin-left:10px;font-family:var(--mono-font-family,monospace)}
    .np-grid{position:relative;user-select:none;outline:none;font-size:calc(13px * var(--z,1))}
    .np-colhead{position:sticky;top:0;z-index:3;background:var(--editor-surface)}
    .np-rowhead{position:sticky;left:0;z-index:2;background:var(--editor-surface)}
    .np-corner{position:sticky;left:0;top:0;z-index:4;background:var(--editor-surface);border-right:1px solid var(--editor-border);border-bottom:1px solid var(--editor-border);cursor:pointer}.np-corner:hover{background:var(--toolbar-hover)}
    .np-cells{position:absolute;left:0;z-index:1}
    .np-cell{position:absolute;padding:0 6px;border-right:1px solid var(--editor-border);border-bottom:1px solid var(--editor-border);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:var(--editor-bg);font-family:var(--content-font-family,var(--ui-font-family));display:flex;align-items:center}
    .np-cell>span{overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}.np-cell.num>span{text-align:right}.np-cell.wrap{align-items:flex-start;padding-top:4px;white-space:pre-wrap;overflow-wrap:anywhere}
    .np-cell.selected{background:color-mix(in srgb,var(--editor-accent) 12%,var(--editor-bg))}
    .np-cell.anchor{box-shadow:inset 0 0 0 2px var(--editor-accent);z-index:1}
    .np-head{position:absolute;display:flex;align-items:center;justify-content:center;color:var(--editor-text-muted);font-size:calc(12px * var(--z,1));border-right:1px solid var(--editor-border);border-bottom:1px solid var(--editor-border);background:var(--editor-surface);cursor:pointer;font-variant-numeric:tabular-nums}
    .np-head:hover{background:var(--toolbar-hover)}.np-head.active{color:var(--editor-accent);background:color-mix(in srgb,var(--editor-accent) 10%,var(--editor-surface));font-weight:500}
    .np-head .np-handle{position:absolute;z-index:1}.np-colhead .np-handle{right:-4px;top:0;bottom:0;width:8px;cursor:col-resize}.np-rowhead .np-handle{bottom:-4px;left:0;right:0;height:8px;cursor:row-resize}
    .np-handle:hover,.np-handle.dragging{background:color-mix(in srgb,var(--editor-accent) 45%,transparent)}
    .np-sheets{display:flex;gap:2px;padding:0 8px;border-top:1px solid var(--editor-border);background:var(--editor-surface);overflow-x:auto;flex-shrink:0;scrollbar-width:thin}
    .np-sheets button{border:0;border-radius:0;height:32px;padding:0 14px;background:transparent;color:var(--editor-text-muted);border-top:2px solid transparent;flex-shrink:0}
    .np-sheets button:hover{background:var(--toolbar-hover);color:var(--editor-text)}.np-sheets button[aria-selected=true]{color:var(--editor-accent);border-top-color:var(--editor-accent);background:var(--editor-bg);font-weight:500}
    @media(max-width:760px){.np-address{width:64px}.np-sheets button{height:40px}}
  `;
  const layout = view.viewport.parentElement;
  // 编辑栏显示当前单元格完整内容，省略号截断的文字在这里可完整阅读和复制。
  const formula = el('div', 'np-formula'), address = el('div', 'np-address', 'A1'), value = el('div', 'np-value');
  formula.append(address, value); layout.insertBefore(formula, view.viewport);
  const sheets = el('nav', 'np-sheets'); sheets.setAttribute('role', 'tablist'); sheets.setAttribute('aria-label', '工作表'); layout.append(sheets);
  const grid = el('div', 'np-grid'); grid.setAttribute('role', 'grid'); grid.setAttribute('aria-readonly', 'true'); grid.tabIndex = 0;
  const colhead = el('div', 'np-colhead'), corner = el('div', 'np-corner'), rowhead = el('div', 'np-rowhead'), cells = el('div', 'np-cells');
  tip(corner, '全选'); colhead.append(corner); grid.append(colhead, rowhead, cells); view.viewport.append(grid);

  let sheet, range, merges = [], cols, rows, zoom = 1, frame = 0;
  let lastHandle = null, selection = { r:0, c:0, endR:0, endC:0 }, drag = null, resizing = null, pointer = null, autoFrame = 0, autoTime = 0;
  const zoomer = zoomControl({ min:.5, max:2, step:.1, target:view.viewport, get:() => zoom, set:(next, anchor) => setZoom(next, anchor) });
  view.toolbar.append(zoomer.element, separator(), button('复制', () => copy(), { icon:'copy', tip:`复制选区（${MOD} + C）` }));

  const text = (r, c) => {
    const cell = sheet[XLSX.utils.encode_cell({ r, c })];
    return cell ? cell.f && cell.v == null ? '（无缓存结果）' : XLSX.utils.format_cell(cell) : '';
  };
  function bounds() { return { r1:Math.min(selection.r,selection.endR), r2:Math.max(selection.r,selection.endR), c1:Math.min(selection.c,selection.endC), c2:Math.max(selection.c,selection.endC) }; }
  /** 选区复制设定硬上限，避免一次复制整张百万行表格耗尽内存。 */
  function copy() {
    const b = bounds();
    if ((b.r2-b.r1+1)*(b.c2-b.c1+1)>100000) { notify('请将复制选区缩小到十万个单元格以内'); return; }
    const lines = [];
    const encode=(value)=>b.r1===b.r2&&b.c1===b.c2?value:/[\t\n"]/.test(value)?`"${value.replaceAll('"','""')}"`:value;
    for (let r=b.r1;r<=b.r2;r++) { const line=[]; for(let c=b.c1;c<=b.c2;c++) line.push(encode(text(r,c))); lines.push(line.join('\t')); }
    void copyText(lines.join('\n'), notify);
  }
  const mergeAt = (r, c) => merges.find((m) => r >= m.s.r && r <= m.e.r && c >= m.s.c && c <= m.e.c);

  /** 尺寸变化后同步网格总宽高与表头层大小。 */
  function resizeGrid() {
    const width = (LABEL + cols.total) * zoom, height = (HEADER + rows.total) * zoom;
    grid.style.setProperty('--z', String(zoom));
    grid.style.width = `${width}px`; grid.style.height = `${height}px`;
    colhead.style.width = `${width}px`; colhead.style.height = `${HEADER * zoom}px`;
    corner.style.width = `${LABEL * zoom}px`; corner.style.height = `${HEADER * zoom}px`;
    rowhead.style.width = `${LABEL * zoom}px`; rowhead.style.height = `${rows.total * zoom}px`;
    cells.style.top = `${HEADER * zoom}px`;
  }

  /** 仅创建窗口附近的行列；滚动位置决定虚拟单元格，不截断工作簿数据。 */
  function render() {
    frame = 0;
    const b = bounds(), z = zoom;
    const anchorMerge = mergeAt(selection.r, selection.c);
    address.textContent = b.r1 === b.r2 && b.c1 === b.c2 || anchorMerge ? XLSX.utils.encode_cell({ r:selection.r, c:selection.c }) : `${XLSX.utils.encode_cell({r:b.r1,c:b.c1})}:${XLSX.utils.encode_cell({r:b.r2,c:b.c2})}`;
    const active = sheet[XLSX.utils.encode_cell({ r:selection.r, c:selection.c })];
    value.replaceChildren(document.createTextNode(text(selection.r, selection.c)));
    if (active?.f) value.append(el('small', '', `=${active.f}`));
    const vp = view.viewport, top = vp.scrollTop / z, left = vp.scrollLeft / z;
    const startR = Math.max(0, rows.indexAt(top) - 1), endR = Math.min(range.e.r, rows.indexAt(top + vp.clientHeight / z) + 2);
    const startC = Math.max(0, cols.indexAt(left - LABEL) - 1), endC = Math.min(range.e.c, cols.indexAt(left + vp.clientWidth / z) + 2);
    const cellFragment = document.createDocumentFragment(), colFragment = document.createDocumentFragment(), rowFragment = document.createDocumentFragment();
    const visibleMerges = merges.filter((m) => m.e.r >= startR && m.s.r <= endR && m.e.c >= startC && m.s.c <= endC);
    const appendCell = (r, c, lastR = r, lastC = c) => {
      const width = cols.end(lastC) - cols.start(c), height = rows.end(lastR) - rows.start(r);
      if (width <= 0 || height <= 0) return;
      const cell = sheet[XLSX.utils.encode_cell({ r, c })], content = text(r, c);
      const selected = r <= b.r2 && lastR >= b.r1 && c <= b.c2 && lastC >= b.c1;
      const node = el('div', `np-cell${selected ? ' selected' : ''}${r === selection.r && c === selection.c ? ' anchor' : ''}${cell?.t === 'n' ? ' num' : ''}${height > ROW * 1.5 ? ' wrap' : ''}`);
      node.append(el('span', '', content));
      node.setAttribute('role', 'gridcell'); node.setAttribute('aria-label', `${XLSX.utils.encode_cell({ r, c })} ${content}`);
      node.style.cssText = `top:${rows.start(r) * z}px;left:${(LABEL + cols.start(c)) * z}px;width:${width * z}px;height:${height * z}px`;
      cellFragment.append(node);
    };
    for (let r = startR; r <= endR; r++) for (let c = startC; c <= endC; c++) {
      if (!visibleMerges.some((m) => r >= m.s.r && r <= m.e.r && c >= m.s.c && c <= m.e.c)) appendCell(r, c);
    }
    for (const m of visibleMerges) appendCell(m.s.r, m.s.c, m.e.r, m.e.c);
    for (let c = startC; c <= endC; c++) {
      if (!cols.size(c)) continue;
      const head = el('div', `np-head${c >= b.c1 && c <= b.c2 ? ' active' : ''}`, XLSX.utils.encode_col(c)); head.dataset.col = String(c);
      head.style.cssText = `top:0;left:${(LABEL + cols.start(c)) * z}px;width:${cols.size(c) * z}px;height:${HEADER * z}px`;
      const handle = el('div', 'np-handle'); handle.dataset.col = String(c); head.append(handle); colFragment.append(head);
    }
    for (let r = startR; r <= endR; r++) {
      if (!rows.size(r)) continue;
      const head = el('div', `np-head${r >= b.r1 && r <= b.r2 ? ' active' : ''}`, r + 1); head.dataset.row = String(r);
      head.style.cssText = `top:${rows.start(r) * z}px;left:0;width:${LABEL * z}px;height:${rows.size(r) * z}px`;
      const handle = el('div', 'np-handle'); handle.dataset.row = String(r); head.append(handle); rowFragment.append(head);
    }
    cells.replaceChildren(cellFragment); colhead.replaceChildren(corner, colFragment); rowhead.replaceChildren(rowFragment);
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };

  /** 指针位置换算为单元格；超出可视区域时夹到边界，配合自动滚动持续扩展选区。 */
  function pick(clientX, clientY) {
    const rect = grid.getBoundingClientRect();
    return { r:Math.min(range.e.r, rows.indexAt((clientY - rect.top) / zoom - HEADER)), c:Math.min(range.e.c, cols.indexAt((clientX - rect.left) / zoom - LABEL)) };
  }
  function extend(clientX, clientY) {
    const p = pick(clientX, clientY);
    if (drag === 'col') selection.endC = p.c; else if (drag === 'row') selection.endR = p.r; else { selection.endR = p.r; selection.endC = p.c; }
    schedule();
  }
  /** 拖选靠近或越过视口边缘时持续滚动，速度随越界距离增大。 */
  function autoScroll(time = performance.now()) {
    autoFrame = 0;
    if (!drag || !pointer) return;
    // 按实际经过时间换算滚动距离，帧率波动时速度保持一致。
    const elapsed = Math.min(100, autoTime ? time - autoTime : 16) / 16; autoTime = time;
    const rect = view.viewport.getBoundingClientRect(), edge = 28;
    const innerTop = rect.top + HEADER * zoom, innerLeft = rect.left + LABEL * zoom;
    const speed = (distance) => Math.min(48, 4 + distance * .5) * elapsed;
    let dx = 0, dy = 0;
    if (drag !== 'col') { if (pointer.y < innerTop + edge) dy = -speed(innerTop + edge - pointer.y); else if (pointer.y > rect.bottom - edge) dy = speed(pointer.y - rect.bottom + edge); }
    if (drag !== 'row') { if (pointer.x < innerLeft + edge) dx = -speed(innerLeft + edge - pointer.x); else if (pointer.x > rect.right - edge) dx = speed(pointer.x - rect.right + edge); }
    if (dx || dy) { view.viewport.scrollBy(dx, dy); extend(pointer.x, pointer.y); }
    autoFrame = requestAnimationFrame(autoScroll);
  }
  function stopDrag() { drag = null; pointer = null; cancelAnimationFrame(autoFrame); autoFrame = 0; autoTime = 0; }

  /** 双击边界按内容自适应列宽：取可视行附近最多 500 行测量，避免遍历整张大表。 */
  function autofit(c) {
    const context = document.createElement('canvas').getContext('2d'), style = getComputedStyle(cells.firstElementChild ?? grid);
    context.font = `${parseFloat(style.fontSize) / zoom}px ${style.fontFamily}`;
    const first = rows.indexAt(view.viewport.scrollTop / zoom), last = Math.min(range.e.r, first + 500);
    let width = context.measureText(XLSX.utils.encode_col(c)).width;
    for (let r = first; r <= last; r++) if (!mergeAt(r, c)) width = Math.max(width, context.measureText(text(r, c)).width);
    cols.resize(c, Math.min(800, Math.max(MIN, Math.ceil(width + 16)))); resizeGrid(); render();
  }

  grid.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const handle = event.target.closest?.('.np-handle'), head = event.target.closest?.('.np-head'), cornerHit = event.target === corner;
    grid.focus({ preventScroll:true });
    if (handle) {
      // 拖动表头边缘调整宽高；双击由 dblclick 处理自适应。
      event.preventDefault(); event.stopPropagation();
      const isCol = handle.dataset.col != null, index = Number(isCol ? handle.dataset.col : handle.dataset.row), axis = isCol ? cols : rows;
      // 指针捕获会让 dblclick 落到网格上，这里按两次按下的间隔识别双击：列边缘自适应宽度。
      const now = performance.now(), double = isCol && lastHandle?.index === index && now - lastHandle.time < 400;
      lastHandle = isCol ? { index, time:now } : null;
      if (double) { lastHandle = null; autofit(index); return; }
      resizing = { isCol, index, axis, start:isCol ? event.clientX : event.clientY, size:axis.size(index), handle };
      handle.classList.add('dragging'); grid.setPointerCapture(event.pointerId); return;
    }
    if (cornerHit) { selection = { r:0, c:0, endR:range.e.r, endC:range.e.c }; render(); return; }
    if (head) {
      const isCol = head.dataset.col != null, index = Number(isCol ? head.dataset.col : head.dataset.row);
      if (event.shiftKey) { if (isCol) selection.endC = index; else selection.endR = index; }
      else selection = isCol ? { r:0, c:index, endR:range.e.r, endC:index } : { r:index, c:0, endR:index, endC:range.e.c };
      drag = isCol ? 'col' : 'row';
    } else {
      const p = pick(event.clientX, event.clientY);
      if (event.shiftKey) { selection.endR = p.r; selection.endC = p.c; } else selection = { ...p, endR:p.r, endC:p.c };
      drag = 'cell';
    }
    // 触屏保留原生滚动；鼠标与触控笔捕获指针以支持拖出视口后继续选择。
    if (event.pointerType === 'touch') drag = null;
    else { event.preventDefault(); grid.setPointerCapture(event.pointerId); pointer = { x:event.clientX, y:event.clientY }; if (!autoFrame) autoFrame = requestAnimationFrame(autoScroll); }
    render();
  });
  grid.addEventListener('pointermove', (event) => {
    if (resizing) {
      const delta = ((resizing.isCol ? event.clientX : event.clientY) - resizing.start) / zoom;
      resizing.axis.resize(resizing.index, Math.max(resizing.isCol ? MIN : 18, Math.round(resizing.size + delta))); resizeGrid(); schedule(); return;
    }
    if (!drag) return;
    pointer = { x:event.clientX, y:event.clientY }; extend(event.clientX, event.clientY);
  });
  const finish = () => { if (resizing) { resizing.handle.classList.remove('dragging'); resizing = null; schedule(); } stopDrag(); };
  grid.addEventListener('pointerup', finish); grid.addEventListener('pointercancel', finish); grid.addEventListener('lostpointercapture', finish);

  /** 键盘移动后把活动单元格滚入视口，表头遮挡部分计入偏移。 */
  function reveal(r, c) {
    const vp = view.viewport, z = zoom;
    const top = (HEADER + rows.start(r)) * z, bottom = (HEADER + rows.end(r)) * z, left = (LABEL + cols.start(c)) * z, right = (LABEL + cols.end(c)) * z;
    if (top - HEADER * z < vp.scrollTop) vp.scrollTop = top - HEADER * z; else if (bottom > vp.scrollTop + vp.clientHeight) vp.scrollTop = bottom - vp.clientHeight;
    if (left - LABEL * z < vp.scrollLeft) vp.scrollLeft = left - LABEL * z; else if (right > vp.scrollLeft + vp.clientWidth) vp.scrollLeft = right - vp.clientWidth;
  }
  grid.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey;
    // 焦点在网格时复制选区；编辑栏里选中的文字仍走系统复制。
    if (mod && event.key.toLowerCase() === 'c') { event.preventDefault(); event.stopPropagation(); copy(); return; }
    if (mod && event.key.toLowerCase() === 'a') { event.preventDefault(); event.stopPropagation(); selection = { r:0, c:0, endR:range.e.r, endC:range.e.c }; render(); return; }
    const page = Math.max(1, Math.floor(view.viewport.clientHeight / (ROW * zoom)) - 1);
    const moves = { ArrowUp:[-1,0], ArrowDown:[1,0], ArrowLeft:[0,-1], ArrowRight:[0,1], PageUp:[-page,0], PageDown:[page,0] };
    const move = moves[event.key]; if (!move) return;
    event.preventDefault(); event.stopPropagation();
    const base = event.shiftKey ? { r:selection.endR, c:selection.endC } : { r:selection.r, c:selection.c };
    const r = Math.max(0, Math.min(range.e.r, mod ? move[0] < 0 ? 0 : move[0] > 0 ? range.e.r : base.r : base.r + move[0]));
    const c = Math.max(0, Math.min(range.e.c, mod ? move[1] < 0 ? 0 : move[1] > 0 ? range.e.c : base.c : base.c + move[1]));
    if (event.shiftKey) { selection.endR = r; selection.endC = c; } else selection = { r, c, endR:r, endC:c };
    reveal(r, c); render();
  });
  view.viewport.addEventListener('scroll', schedule, { passive:true });

  /** 以指针位置为锚点缩放，指针下的单元格保持不动。 */
  function setZoom(next, anchor) {
    const vp = view.viewport, rect = vp.getBoundingClientRect();
    const ax = anchor ? anchor.x - rect.left : vp.clientWidth / 2, ay = anchor ? anchor.y - rect.top : vp.clientHeight / 2;
    const x = (vp.scrollLeft + ax) / zoom, y = (vp.scrollTop + ay) / zoom;
    zoom = Math.round(next * 100) / 100; resizeGrid();
    vp.scrollLeft = x * zoom - ax; vp.scrollTop = y * zoom - ay; render();
  }

  function changeSheet(sheetName) {
    sheet = workbook.Sheets[sheetName]; range = XLSX.utils.decode_range(sheet['!ref'] ?? 'A1');
    merges = sheet['!merges'] ?? []; if (merges.length > 10000) throw new Error('合并区域过多，请使用专业表格软件打开');
    cols = new Axis(columnSizes(sheet['!cols'], range.e.c + 1)); rows = new Axis(rowSizes(sheet['!rows'], range.e.r + 1));
    selection = { r:0, c:0, endR:0, endC:0 };
    for (const tab of sheets.children) tab.setAttribute('aria-selected', String(tab.dataset.sheet === sheetName));
    resizeGrid(); view.viewport.scrollTo(0, 0); render();
  }
  // 工作表以底部标签切换，与常见表格软件一致；只有一张表时也保留以显示表名。
  for (const sheetName of workbook.SheetNames) {
    const tab = button(sheetName, () => changeSheet(sheetName)); tab.dataset.sheet = sheetName; tab.setAttribute('role', 'tab'); sheets.append(tab);
  }
  changeSheet(workbook.SheetNames[0]);
  const resize = new ResizeObserver(schedule); resize.observe(view.viewport);
  return () => { cancelAnimationFrame(frame); stopDrag(); resize.disconnect(); view.destroy(); };
}
