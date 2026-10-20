// Excel 只读表格：使用保存的公式结果，虚拟化可视区域，不执行宏和公式。
import * as XLSX from 'xlsx';
import { createView, el, button, copyText } from '../shared/view.mjs';
import { cleanOpenXml } from '../shared/openXml.mjs';

export async function mount({ container, name, bytes, signal, notify }) {
  const workbook = XLSX.read(/\.xlsx$/i.test(name)?await cleanOpenXml(bytes):bytes, { type:'array', cellStyles:true, cellDates:true, cellFormula:true });
  if (signal.aborted) return;
  const view = createView(container, name);
  const picker = el('select'); picker.setAttribute('aria-label', '工作表');
  workbook.SheetNames.forEach((name) => { const option = el('option', '', name); option.value = name; picker.append(option); });
  const position = el('span', 'np-muted', 'A1');
  let rangeMode=false;
  const rangeButton=button('连续选择',()=>{rangeMode=!rangeMode;rangeButton.setAttribute('aria-pressed',String(rangeMode));});rangeButton.setAttribute('aria-pressed','false');
  view.toolbar.append(picker, position, rangeButton, button('复制选区', () => copy()));
  const grid = el('div', 'np-grid'); grid.setAttribute('role', 'grid'); grid.setAttribute('aria-readonly', 'true');
  grid.tabIndex=0;
  view.viewport.append(grid);
  view.style.textContent += `.np-grid{position:relative;min-width:100%;user-select:none}.np-cell{position:absolute;height:28px;padding:5px 7px;border-right:1px solid var(--editor-border);border-bottom:1px solid var(--editor-border);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:var(--editor-bg);font-family:var(--content-font-family,var(--ui-font-family))}.np-cell.selected{background:color-mix(in srgb,var(--editor-accent) 16%,var(--editor-bg))!important;outline:1px solid var(--editor-accent);outline-offset:-1px;z-index:1}.np-cell.heading{background:var(--editor-surface);color:var(--editor-text-muted);text-align:center;user-select:none}.np-cell:focus-visible{outline:2px solid var(--editor-accent);outline-offset:-2px}`;
  const ROW = 28, COL = 128, LABEL = 48;
  let sheet, range, merges=[], selection = { r:0, c:0, endR:0, endC:0 }, dragging = false, frame = 0;
  const text = (r, c) => {
    const cell = sheet[XLSX.utils.encode_cell({ r, c })];
    return cell ? cell.f && cell.v == null ? '（无缓存结果）' : XLSX.utils.format_cell(cell) : '';
  };
  function bounds() { return { r1:Math.min(selection.r,selection.endR), r2:Math.max(selection.r,selection.endR), c1:Math.min(selection.c,selection.endC), c2:Math.max(selection.c,selection.endC) }; }
  /** 选区复制设定硬上限，避免一次复制整张百万行表格耗尽内存。 */
  function copy() {
    const b = bounds();
    if ((b.r2-b.r1+1)*(b.c2-b.c1+1)>100000) { notify('请将复制选区缩小到十万个单元格以内'); return; }
    const rows = [];
    const encode=(value)=>b.r1===b.r2&&b.c1===b.c2?value:/[\t\n"]/.test(value)?`"${value.replaceAll('"','""')}"`:value;
    for (let r=b.r1;r<=b.r2;r++) { const cells=[]; for(let c=b.c1;c<=b.c2;c++) cells.push(encode(text(r,c))); rows.push(cells.join('\t')); }
    void copyText(rows.join('\n'), notify);
  }
  /** 仅创建窗口附近的行列；滚动位置决定虚拟单元格，不截断工作簿数据。 */
  function render() {
    const b = bounds();
    position.textContent = `${XLSX.utils.encode_cell({r:b.r1,c:b.c1})}:${XLSX.utils.encode_cell({r:b.r2,c:b.c2})}`;
    const top = view.viewport.scrollTop, left = view.viewport.scrollLeft;
    const startR=Math.max(0,Math.floor(top/ROW)-2), endR=Math.min(range.e.r,startR+Math.ceil(view.viewport.clientHeight/ROW)+5);
    const startC=Math.max(0,Math.floor((left-LABEL)/COL)-1), endC=Math.min(range.e.c,startC+Math.ceil(view.viewport.clientWidth/COL)+3);
    const fragment=document.createDocumentFragment();
    const visibleMerges=merges.filter((m)=>m.e.r>=startR&&m.s.r<=endR&&m.e.c>=startC&&m.s.c<=endC);
    const appendCell=(r,c,endR=r,endC=c)=>{
      const cell=el('div',`np-cell${r<=b.r2&&endR>=b.r1&&c<=b.c2&&endC>=b.c1?' selected':''}`,text(r,c));
      cell.setAttribute('role','gridcell');cell.setAttribute('aria-label',`${XLSX.utils.encode_cell({r,c})} ${text(r,c)}`);
      cell.style.cssText=`top:${(r+1)*ROW}px;left:${LABEL+c*COL}px;width:${(endC-c+1)*COL}px;height:${(endR-r+1)*ROW}px`;
      fragment.append(cell);
    };
    for(let r=startR;r<=endR;r++) for(let c=startC;c<=endC;c++) {
      if(!visibleMerges.some((m)=>r>=m.s.r&&r<=m.e.r&&c>=m.s.c&&c<=m.e.c))appendCell(r,c);
    }
    for(const m of visibleMerges)appendCell(m.s.r,m.s.c,m.e.r,m.e.c);
    for(let c=startC;c<=endC;c++) { const h=el('div','np-cell heading',XLSX.utils.encode_col(c));h.style.cssText=`top:0;left:${LABEL+c*COL}px;width:${COL}px`;fragment.append(h); }
    for(let r=startR;r<=endR;r++) { const h=el('div','np-cell heading',r+1);h.style.cssText=`top:${(r+1)*ROW}px;left:0;width:${LABEL}px`;fragment.append(h); }
    grid.replaceChildren(fragment);
  }
  function pick(event) {
    const rect=grid.getBoundingClientRect();
    return { r:Math.max(0,Math.min(range.e.r,Math.floor((event.clientY-rect.top)/ROW)-1)), c:Math.max(0,Math.min(range.e.c,Math.floor((event.clientX-rect.left-LABEL)/COL))) };
  }
  grid.addEventListener('pointerdown',(event)=>{const p=pick(event);grid.focus({preventScroll:true}); if(!event.shiftKey&&!rangeMode) selection={...p,endR:p.r,endC:p.c};else{selection.endR=p.r;selection.endC=p.c;}dragging=true;if(event.pointerType==='mouse'){event.preventDefault();grid.setPointerCapture(event.pointerId);}render();});
  grid.addEventListener('pointermove',(event)=>{if(!dragging||event.pointerType!=='mouse')return;const p=pick(event);selection.endR=p.r;selection.endC=p.c;render();});
  grid.addEventListener('pointerup',()=>{dragging=false;});grid.addEventListener('pointercancel',()=>{dragging=false;});
  view.root.addEventListener('keydown',(event)=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='c'){event.preventDefault();event.stopPropagation();copy();}});
  grid.addEventListener('keydown',(event)=>{const moves={ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1]};const move=moves[event.key];if(!move)return;event.preventDefault();event.stopPropagation();const r=Math.max(0,Math.min(range.e.r,selection.endR+move[0])),c=Math.max(0,Math.min(range.e.c,selection.endC+move[1]));if(event.shiftKey){selection.endR=r;selection.endC=c;}else selection={r,c,endR:r,endC:c};render();});
  view.viewport.addEventListener('scroll',()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(render);});
  function changeSheet() {
    sheet=workbook.Sheets[picker.value];range=XLSX.utils.decode_range(sheet['!ref']??'A1');selection={r:0,c:0,endR:0,endC:0};
    merges=sheet['!merges']??[];if(merges.length>10000)throw new Error('合并区域过多，请使用专业表格软件打开');
    grid.style.height=`${(range.e.r+2)*ROW}px`;grid.style.width=`${LABEL+(range.e.c+1)*COL}px`;view.viewport.scrollTo(0,0);render();
  }
  picker.addEventListener('change',changeSheet);changeSheet();
  const resize=new ResizeObserver(render);resize.observe(view.viewport);
  return ()=>{cancelAnimationFrame(frame);resize.disconnect();view.destroy();};
}
