// 可组合工作台：模板、布局和字段绑定均为结构化配置，不执行用户脚本，不包含 AI 调用。
import {createView,el,button} from '../shared/view.mjs';
import {marked} from 'marked';
import DOMPurify from 'dompurify';

const TYPES={metric:'指标',tasks:'任务清单',calendar:'日历',notes:'笔记卡片',chart:'统计图',table:'数据表',markdown:'文本',links:'快捷入口',progress:'完成进度'};
const clone=(value)=>JSON.parse(JSON.stringify(value));
const id=()=>`widget_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;

/** 稳定字段 id 与选项 id 用于持久化，界面始终显示业务名称和选项文字。 */
export function display(dataset,row,key){
  const column=dataset.columns.find((c)=>c.id===key);const value=row[key];
  if(value==null)return '';
  if(column?.type==='checkbox')return value?'已完成':'未完成';
  if(column?.type==='select'||column?.type==='multiSelect'){const values=Array.isArray(value)?value:[value];return values.map((v)=>column.options?.find((o)=>o.id===v)?.label??String(v)).join('、');}
  return typeof value==='object'?JSON.stringify(value):String(value);
}

/** 模板只建立视图和字段绑定，不向用户的真实数据表插入演示记录。 */
export function widget(type,dataset,title){
  const text=dataset.columns.find((c)=>c.type==='text'||c.type==='longText')?.id??dataset.columns[0]?.id??'';
  const status=dataset.columns.find((c)=>c.type==='checkbox'||/状态|完成|status/i.test(c.name))??dataset.columns.find((c)=>c.type==='select');
  const date=dataset.columns.find((c)=>/截止|到期|due|结束/i.test(c.name)&&/^date/.test(c.type))??dataset.columns.find((c)=>/^date/.test(c.type));
  const done=status?.options?.find((o)=>/完成|done|closed/i.test(o.label));
  return {id:id(),type,title:title??TYPES[type],sourceId:dataset.id,width:type==='metric'?4:type==='tasks'||type==='table'?8:6,height:type==='metric'?150:320,titleField:text,descriptionField:dataset.columns.find((c)=>c.type==='longText')?.id??'',statusField:status?.id??'',completedValue:done?.id??'',dateField:date?.id??'',groupField:status?.id??'',valueField:'',aggregate:'count',limit:12,filterField:'',filterOperator:'contains',filterValue:'',sortField:'',sortDirection:'asc',content:''};
}

function template(kind,dataset,sources=[]){
  const base={schemaVersion:1,title:kind==='project'?'项目驾驶舱':kind==='knowledge'?'知识与灵感':'个人工作台',subtitle:'',sources,widgets:[]};
  if(kind==='blank')return base;
  if(kind==='knowledge'){base.widgets=[{...widget('markdown',dataset,'写在前面'),content:'留一点空间，记录正在思考的事。',width:12,height:150},widget('notes',dataset,'最近记录'),{...widget('links',dataset,'常用入口'),content:'',width:6},widget('table',dataset,'资料一览')];return base;}
  base.widgets=[{...widget('metric',dataset,'全部任务'),aggregate:'count'}, {...widget('metric',dataset,'今日待办'),period:'today',onlyIncomplete:true},{...widget('metric',dataset,'已完成'),onlyCompleted:true},widget('tasks',dataset,'任务清单'),{...widget('progress',dataset,'完成进度'),width:4},widget('calendar',dataset,'近期日程'),widget('notes',dataset,'快捷笔记')];
  if(kind==='project'){base.widgets[1]={...widget('metric',dataset,'待处理'),onlyIncomplete:true};base.widgets[5]=widget('chart',dataset,'状态分布');}
  return base;
}

// 预设只是基础组件的可修改配置；不会创建演示数据，也不会强制覆盖用户字段。
export const PRESETS=[
  {key:'today',type:'tasks',name:'今日待办',description:'今天到期、尚未完成',patch:{period:'today',onlyIncomplete:true}},
  {key:'overdue',type:'tasks',name:'逾期提醒',description:'已过截止日期的任务',patch:{period:'overdue',onlyIncomplete:true}},
  {key:'upcoming',type:'tasks',name:'未来三天',description:'提前看看即将到来的安排',patch:{period:'upcoming',onlyIncomplete:true}},
  {key:'status',type:'chart',name:'状态分布',description:'按状态统计记录数',patch:{aggregate:'count'}},
  {key:'progress',type:'progress',name:'目标进度',description:'已完成记录占比',patch:{}},
  {key:'notes',type:'notes',name:'快捷笔记',description:'展示最近记录的文字与灵感',patch:{sortDirection:'desc'}},
  {key:'calendar',type:'calendar',name:'日程月历',description:'按日期查看你的安排',patch:{}},
  {key:'links',type:'links',name:'常用入口',description:'把常去的网址放在手边',patch:{content:'NoteBoard | https://github.com/CrazyFigure/NoteBoard'}},
  {key:'focus',type:'markdown',name:'今日专注',description:'留一块安静的计划空间',patch:{content:'### 今天最重要的一件事\n\n在这里写下你的目标。',width:12,height:180}},
];

/** 自动识别后保留全部组件设置入口；缺少日期等必要字段时清楚提示绑定。 */
export function presetWidget(key,dataset){
  const preset=PRESETS.find((item)=>item.key===key);if(!preset)throw new Error('未知预设模块');
  const w={...widget(preset.type,dataset,preset.name),...preset.patch};
  w.sortField=preset.key==='notes'?dataset.columns.find((c)=>/创建|更新|时间|日期|date/i.test(c.name)&&/^date/.test(c.type))?.id??'':w.dateField;
  return w;
}

export async function mount(api){
  const {container,signal,notify}=api,view=createView(container,api.name);
  let saved=clone(api.getConfig()??template('personal',api.getCurrentData())),draft=clone(saved),editing=false,selected=null,panel=null,dragged=null,destroyed=false;
  let query='',requestGeneration=0;
  const datasets=new Map([['current',api.getCurrentData()]]);
  const canvas=el('main','wb-canvas');view.viewport.append(canvas);
  const backdrop=el('div','wb-backdrop');backdrop.hidden=true;view.root.append(backdrop);
  const dateSelections=new Map();
  view.style.textContent+=`
    .np-toolbar{justify-content:flex-end}.wb-canvas{padding:28px 30px 48px;max-width:1440px;margin:auto}.np-scroll{background:color-mix(in srgb,var(--editor-surface) 60%,var(--editor-bg))}
    .wb-header{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:24px}.wb-header h1{font-size:24px;font-weight:600;margin:0 0 6px;letter-spacing:-.5px}.wb-header p{margin:0;color:var(--editor-text-muted)}.wb-date{color:var(--editor-text-muted);font-size:12px;white-space:nowrap;padding-top:8px}.wb-search{width:220px;max-width:100%;border:1px solid var(--control-border);background:var(--editor-bg);padding:8px 12px;border-radius:7px;font:inherit;color:inherit;margin-bottom:18px}
    .wb-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:18px;align-items:start}.wb-widget{min-width:0;background:var(--editor-bg);border:1px solid var(--editor-border);border-radius:12px;box-shadow:var(--shadow-sm);display:flex;flex-direction:column;overflow:hidden;position:relative}.wb-widget.editing{outline:1px dashed var(--editor-accent);outline-offset:3px}.wb-widget.selected{outline:2px solid var(--editor-accent)}.wb-widget-header{padding:17px 18px 11px;display:flex;align-items:center;gap:8px;flex-shrink:0}.wb-widget-header h2{font-size:14px;font-weight:600;margin:0;flex:1;min-width:0;overflow-wrap:anywhere}.wb-widget-header .wb-source{font-size:11px;color:var(--editor-text-muted);max-width:35%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.wb-widget-body{padding:0 18px 17px;flex:1;min-height:0;overflow:auto}.wb-gear{border:0;padding:3px 7px;color:var(--editor-text-muted)}.wb-metric{font-size:38px;line-height:1.2;font-weight:500;color:var(--editor-text);font-variant-numeric:tabular-nums;padding:4px 0}.wb-empty{color:var(--editor-text-muted);text-align:center;padding:30px 8px;line-height:1.7}.wb-record{display:flex;gap:10px;align-items:flex-start;padding:11px 0;border-bottom:1px solid var(--editor-border)}.wb-record:last-child{border-bottom:0}.wb-record-main{flex:1;min-width:0}.wb-record-title{font-size:13px;color:inherit;background:none;border:0;padding:0;text-align:left;max-width:100%;overflow-wrap:anywhere}.wb-record p{color:var(--editor-text-muted);font-size:12px;margin:4px 0;white-space:pre-wrap}.wb-record small{color:var(--editor-text-muted);font-size:11px}.wb-record input[type=checkbox]{accent-color:var(--editor-accent);width:16px;height:16px;margin-top:3px;flex-shrink:0}.wb-tag{display:inline-block;padding:2px 6px;background:var(--editor-surface);border-radius:4px;font-size:11px;color:var(--editor-text-muted);margin-right:5px}.wb-note{padding:12px 0;border-bottom:1px solid var(--editor-border)}.wb-note p{font-size:12px;line-height:1.7;white-space:pre-wrap;color:var(--editor-text-muted);margin:6px 0 0}.wb-bars{display:flex;flex-direction:column;gap:13px}.wb-bar-row{display:grid;grid-template-columns:80px minmax(20px,1fr) 40px;gap:10px;align-items:center;font-size:12px}.wb-bar-track{height:10px;border-radius:3px;background:var(--editor-surface);overflow:hidden}.wb-bar-fill{height:100%;background:var(--editor-accent);border-radius:3px}.wb-progress-label{display:flex;justify-content:space-between;margin:14px 0;color:var(--editor-text-muted);font-size:12px}.wb-progress-number{font-size:38px;font-variant-numeric:tabular-nums;padding:12px 0}.wb-table{border-collapse:collapse;font-size:12px;width:100%}.wb-table th,.wb-table td{text-align:left;border-bottom:1px solid var(--editor-border);padding:8px;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.wb-table th{font-weight:500;color:var(--editor-text-muted)}.wb-table tbody tr{cursor:pointer}.wb-table tbody tr:hover{background:var(--toolbar-hover)}.wb-table tbody tr:active{background:var(--toolbar-active)}.wb-text{white-space:pre-wrap;line-height:1.8;font-family:var(--content-font-family,var(--ui-font-family))}.wb-link{display:block;text-align:left;margin-bottom:8px;width:100%}.wb-calendar{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:3px;font-size:11px}.wb-calendar>span{text-align:center;color:var(--editor-text-muted);padding:5px 0}.wb-calendar button{border:0;padding:5px 0;min-width:0;font-size:12px;position:relative}.wb-calendar button.active{background:var(--toolbar-active);color:var(--editor-accent)}.wb-calendar button.has-records:after{content:'';display:block;width:4px;height:4px;border-radius:50%;background:var(--editor-accent);position:absolute;bottom:2px;left:calc(50% - 2px)}.wb-calendar-nav{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}.wb-calendar-nav button{border:0;padding:2px 8px}.wb-calendar-list{margin-top:10px}
    .wb-backdrop{position:absolute;inset:0;background:color-mix(in srgb,var(--editor-text) 15%,transparent);z-index:20;display:flex;justify-content:flex-end}.wb-backdrop[hidden]{display:none}.wb-panel{width:360px;max-width:100%;height:100%;overflow:auto;background:var(--editor-bg);border-left:1px solid var(--editor-border);padding:20px;box-shadow:var(--shadow-lg)}.wb-panel-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}.wb-panel h2{font-size:16px;margin:0}.wb-panel h3{font-size:13px;font-weight:600;margin:22px 0 12px}.wb-field{display:flex;flex-direction:column;gap:6px;margin:12px 0;color:var(--editor-text-muted);font-size:12px}.wb-field input,.wb-field select,.wb-field textarea{width:100%;font:var(--ui-font-size,13px) var(--ui-font-family);padding:7px 9px;min-height:34px;background:var(--editor-bg);color:var(--editor-text);border:1px solid var(--control-border);border-radius:6px}.wb-field textarea{min-height:120px;resize:vertical}.wb-panel-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}.wb-palette{display:grid;grid-template-columns:1fr 1fr;gap:10px}.wb-palette button{padding:18px 12px;text-align:left;min-height:80px}.wb-palette small{display:block;color:var(--editor-text-muted);margin-top:6px}.wb-source-row{padding:12px 0;border-bottom:1px solid var(--editor-border);overflow-wrap:anywhere}.wb-source-row p{font-size:11px;color:var(--editor-text-muted)}.wb-error{color:var(--error-500);font-size:12px;white-space:pre-wrap}.wb-drag{cursor:grab;border:0;background:transparent;color:var(--editor-text-muted);padding:2px 4px;user-select:none}.wb-drag:active{cursor:grabbing}.wb-footer-hint{margin:8px 0 0;font-size:11px;color:var(--editor-text-muted)}
    @media(max-width:760px){.wb-canvas{padding:20px 12px 30px}.wb-header{display:block;margin-bottom:18px}.wb-header h1{font-size:22px}.wb-date{margin-top:10px}.wb-grid{grid-template-columns:1fr;gap:12px}.wb-widget{grid-column:1!important}.wb-panel{width:100%}.np-toolbar{justify-content:flex-start}.wb-search{width:100%}.wb-calendar button{min-height:36px}.wb-widget-header{padding:14px 14px 10px}.wb-widget-body{padding:0 14px 14px}}
  `;
  // 小屏三项指标并列，优先给任务内容留出空间；操作栏避免无意义换行。
  view.style.textContent+=`
    .wb-note-description{font-size:.92em;line-height:1.7;color:var(--editor-text-muted);margin:6px 0;overflow-wrap:anywhere}.wb-note-description p{margin:3px 0}.wb-note-description pre{white-space:pre-wrap;margin:4px 0}.wb-note-description ul,.wb-note-description ol{padding-left:18px}.wb-record .wb-note-description{max-height:3.4em;overflow:hidden}.wb-record small{display:block;margin-top:5px}.wb-text p{margin:0 0 10px}
    @media(max-width:760px){.np-toolbar .np-name{width:auto;max-width:none;margin-right:auto}.wb-grid{grid-template-columns:repeat(6,minmax(0,1fr))}.wb-widget{grid-column:span 6!important}.wb-widget[data-type="metric"]{grid-column:span 2!important;height:120px!important}.wb-widget[data-type="metric"] .wb-source{display:none}.wb-widget[data-type="metric"] h2{font-size:12px}.wb-widget[data-type="metric"] .wb-metric{font-size:30px}}
  `;

  /** 异常集中转成可读反馈，组件错误不破坏已有配置。 */
  function safe(action){return async()=>{try{await action();}catch(error){notify(error.message??String(error));}};}
  function getData(w){return datasets.get(w.sourceId??'current')??{id:w.sourceId,name:'数据源未连接',columns:[],rows:[],error:'请在数据源中重新连接文件'};}
  function complete(w,row,dataset){const column=dataset.columns.find((c)=>c.id===w.statusField);return column?.type==='checkbox'?row[w.statusField]===true:!!w.completedValue&&row[w.statusField]===w.completedValue;}

  /** 同一组件的筛选、搜索、排序和统计均基于同一组行，避免指标与清单不一致。 */
  function filtered(w,dataset){
    let rows=dataset.rows.filter((row)=>{
      const effectiveQuery=api.getSearchQuery?.()??query;
      if(effectiveQuery&&!dataset.columns.some((c)=>display(dataset,row,c.id).toLowerCase().includes(effectiveQuery.toLowerCase())))return false;
      if(w.onlyCompleted&&!complete(w,row,dataset)||w.onlyIncomplete&&complete(w,row,dataset))return false;
      if(w.filterField){const value=display(dataset,row,w.filterField),expected=String(w.filterValue??'');if(w.filterOperator==='equals'&&value!==expected||w.filterOperator==='notEquals'&&value===expected||w.filterOperator==='isEmpty'&&value!==''||(!w.filterOperator||w.filterOperator==='contains')&&!value.toLowerCase().includes(expected.toLowerCase()))return false;}
      if(w.period){if(!w.dateField)return false;const day=String(row[w.dateField]??'').slice(0,10),today=localDay(new Date());if(w.period==='today'&&day!==today)return false;if(w.period==='upcoming'){const end=new Date();end.setDate(end.getDate()+3);if(day<today||day>localDay(end))return false;}if(w.period==='overdue'&&(!day||day>=today))return false;}
      return true;
    });
    if(w.sortField)rows=[...rows].sort((a,b)=>display(dataset,a,w.sortField).localeCompare(display(dataset,b,w.sortField),'zh-CN',{numeric:true})*(w.sortDirection==='desc'?-1:1));
    return rows;
  }
  function localDay(date){return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;}
  function openRecord(w,row){return safe(()=>api.openRecord(w.sourceId??'current',row.id));}

  /** 清单与卡片引用原始记录，只读数据源通过记录入口交给主程序编辑。 */
  function record(body,w,dataset,row,notes=false){
    const line=el('div',notes?'wb-note':'wb-record'),main=el('div','wb-record-main');
    if(!notes&&w.statusField&&(w.sourceId??'current')==='current'){
      const column=dataset.columns.find((c)=>c.id===w.statusField);
      if(column?.type==='checkbox'||column?.type==='select'&&w.completedValue){const check=el('input');check.type='checkbox';check.checked=complete(w,row,dataset);check.setAttribute('aria-label',`完成${display(dataset,row,w.titleField)}`);check.addEventListener('change',safe(()=>{const next=column.type==='checkbox'?check.checked:check.checked?w.completedValue:column.options?.find((o)=>o.id!==w.completedValue)?.id??'';api.updateRow(w.sourceId??'current',row.id,{[w.statusField]:next});}));line.append(check);}
    }
    const title=button(display(dataset,row,w.titleField)||'未命名记录',openRecord(w,row));title.className='wb-record-title';main.append(title);
    const description=w.descriptionField?display(dataset,row,w.descriptionField):'';
    if(description){
      const descriptionNode=el('div','wb-note-description');
      if(dataset.columns.find((c)=>c.id===w.descriptionField)?.longText?.markdown)descriptionNode.innerHTML=DOMPurify.sanitize(marked.parse(description.slice(0,notes?10000:1000)),{FORBID_TAGS:['img','iframe','object','style'],ALLOWED_URI_REGEXP:/^(?:#|data:)/i});
      else descriptionNode.textContent=description.slice(0,notes?400:120);
      main.append(descriptionNode);
    }
    const status=display(dataset,row,w.statusField),date=display(dataset,row,w.dateField);if(status||date){const meta=el('small');if(status)meta.append(el('span','wb-tag',status));if(date)meta.append(document.createTextNode(date));main.append(meta);}
    line.append(main);body.append(line);
  }

  /** 绘制单个组件，未知或删除的字段只展示空态，不猜测替换成其它业务字段。 */
  function content(body,w){
    const dataset=getData(w),rows=filtered(w,dataset),limit=Math.min(100,Math.max(1,Number(w.limit)||12));
    if(w.period&&!w.dateField){body.append(el('div','wb-empty','请在组件设置中绑定日期字段'));return;}
    if(['markdown','links'].includes(w.type)){
      if(w.type==='markdown'){const content=el('div','wb-text');content.innerHTML=DOMPurify.sanitize(marked.parse(String(w.content||'在组件设置中写下想展示的内容')),{FORBID_TAGS:['img','iframe','object','style'],ALLOWED_URI_REGEXP:/^(?:#|data:)/i});body.append(content);}
      else{for(const line of String(w.content??'').split('\n').filter(Boolean)){const [name,url]=line.split('|').map((s)=>s.trim());const b=button(name||url,safe(()=>api.openLink(url||name)));b.className='wb-link';body.append(b);}if(!body.children.length)body.append(el('div','wb-empty','在组件设置中添加常用入口'));}return;
    }
    if(dataset.error){body.append(el('div','wb-error',dataset.error));return;}
    if(w.type==='metric'){
      const values=rows.map((r)=>r[w.valueField]).filter((v)=>v!==null&&v!==undefined&&v!=='').map(Number).filter(Number.isFinite);let n=rows.length;
      if(w.aggregate==='sum')n=values.reduce((a,b)=>a+b,0);if(w.aggregate==='avg')n=values.length?values.reduce((a,b)=>a+b,0)/values.length:0;if(w.aggregate==='min')n=values.length?values.reduce((a,b)=>Math.min(a,b)):0;if(w.aggregate==='max')n=values.length?values.reduce((a,b)=>Math.max(a,b)):0;
      body.append(el('div','wb-metric',n.toLocaleString('zh-CN',{maximumFractionDigits:2})));if(w.caption)body.append(el('p','np-muted',w.caption));return;
    }
    if(w.type==='progress'){
      const done=rows.filter((r)=>complete(w,r,dataset)).length,percent=rows.length?Math.round(done/rows.length*100):0;
      body.append(el('div','wb-progress-number',`${percent}%`));const track=el('div','wb-bar-track'),fill=el('div','wb-bar-fill');fill.style.width=`${percent}%`;track.append(fill);body.append(track);const label=el('div','wb-progress-label');label.append(el('span','',`已完成 ${done}`),el('span','',`共 ${rows.length} 项`));body.append(label);return;
    }
    if(w.type==='chart'){
      if(!w.groupField){body.append(el('div','wb-empty','在组件设置中选择分组字段'));return;}
      const groups=new Map();for(const row of rows){const label=display(dataset,row,w.groupField)||'未分类';groups.set(label,(groups.get(label)??0)+(w.aggregate==='sum'?Number(row[w.valueField])||0:1));}
      const values=[...groups].sort((a,b)=>b[1]-a[1]).slice(0,limit),max=Math.max(1,...values.map((p)=>p[1]));const bars=el('div','wb-bars');bars.setAttribute('role','img');bars.setAttribute('aria-label',`${w.title}，${values.map(([k,v])=>`${k} ${v}`).join('，')}`);
      for(const [name,value]of values){const row=el('div','wb-bar-row'),track=el('div','wb-bar-track'),fill=el('div','wb-bar-fill');fill.style.width=`${Math.max(0,value)/max*100}%`;track.append(fill);row.append(el('span','',name),track,el('span','',value.toLocaleString('zh-CN')));bars.append(row);}body.append(bars);if(!values.length)body.append(el('div','wb-empty','暂无数据'));return;
    }
    if(w.type==='calendar'){
      if(!w.dateField){body.append(el('div','wb-empty','在组件设置中选择日期字段'));return;}
      const state=dateSelections.get(w.id)??{month:new Date(new Date().getFullYear(),new Date().getMonth(),1),day:localDay(new Date())};dateSelections.set(w.id,state);
      const nav=el('div','wb-calendar-nav');nav.append(button('‹',()=>{state.month=new Date(state.month.getFullYear(),state.month.getMonth()-1,1);renderCanvas();}),el('span','',state.month.toLocaleDateString('zh-CN',{year:'numeric',month:'long'})),button('›',()=>{state.month=new Date(state.month.getFullYear(),state.month.getMonth()+1,1);renderCanvas();}));body.append(nav);
      const grid=el('div','wb-calendar');for(const day of ['一','二','三','四','五','六','日'])grid.append(el('span','',day));const start=(state.month.getDay()+6)%7;for(let i=0;i<start;i++)grid.append(el('span'));
      const days=new Date(state.month.getFullYear(),state.month.getMonth()+1,0).getDate();const hits=new Set(rows.map((r)=>String(r[w.dateField]??'').slice(0,10)));
      for(let d=1;d<=days;d++){const day=localDay(new Date(state.month.getFullYear(),state.month.getMonth(),d)),b=button(String(d),()=>{state.day=day;renderCanvas();});b.className=`${state.day===day?'active ':''}${hits.has(day)?'has-records':''}`;b.setAttribute('aria-label',day);grid.append(b);}body.append(grid);
      const list=el('div','wb-calendar-list'),matches=rows.filter((r)=>String(r[w.dateField]??'').startsWith(state.day)).slice(0,limit);matches.forEach((r)=>record(list,w,dataset,r));if(!matches.length)list.append(el('div','wb-empty','当天没有安排'));body.append(list);return;
    }
    if(!rows.length){body.append(el('div','wb-empty','暂无符合条件的记录'));return;}
    if(w.type==='table'){
      const table=el('table','wb-table'),head=el('thead'),tr=el('tr'),columns=dataset.columns.filter((c)=>!w.visibleFields?.length||w.visibleFields.includes(c.id)).slice(0,12);for(const c of columns)tr.append(el('th','',c.name));head.append(tr);table.append(head);const tbody=el('tbody');for(const row of rows.slice(0,limit)){const line=el('tr');for(const c of columns)line.append(el('td','',display(dataset,row,c.id)));line.addEventListener('click',openRecord(w,row));tbody.append(line);}table.append(tbody);body.append(table);return;
    }
    rows.slice(0,limit).forEach((row)=>record(body,w,dataset,row,w.type==='notes'));
  }

  function renderCanvas(){
    if(destroyed)return;canvas.replaceChildren();
    const head=el('header','wb-header'),text=el('div'),h1=el('h1','',draft.title);text.append(h1);if(draft.subtitle)text.append(el('p','',draft.subtitle));head.append(text,el('div','wb-date',new Date().toLocaleDateString('zh-CN',{year:'numeric',month:'long',day:'numeric',weekday:'long'})));canvas.append(head);
    if(!api.getSearchQuery){const search=el('input','wb-search');search.type='search';search.placeholder='搜索工作台记录';search.setAttribute('aria-label','搜索工作台记录');search.value=query;search.addEventListener('input',()=>{query=search.value;renderWidgets();});canvas.append(search);}
    const grid=el('div','wb-grid');grid.id='wb-grid';canvas.append(grid);renderWidgets();
    if(!draft.widgets.length)canvas.append(el('div','wb-empty','从模板开始，或添加你的第一个组件'));
  }
  function renderWidgets(){
    const grid=canvas.querySelector('#wb-grid');if(!grid)return;grid.replaceChildren();
    for(const w of draft.widgets){const card=el('section',`wb-widget${editing?' editing':''}${selected===w.id?' selected':''}`);card.dataset.type=w.type;card.style.gridColumn=`span ${[4,6,8,12].includes(Number(w.width))?w.width:6}`;card.style.height=`${Math.min(900,Math.max(120,Number(w.height)||320))}px`;
      const header=el('div','wb-widget-header');if(editing){const drag=el('button','wb-drag','⠿');drag.type='button';drag.draggable=true;drag.setAttribute('aria-label','拖动组件排序');drag.addEventListener('dragstart',()=>{dragged=w.id;});header.append(drag);card.addEventListener('dragover',(event)=>event.preventDefault());card.addEventListener('drop',(event)=>{event.preventDefault();if(!dragged||dragged===w.id)return;const from=draft.widgets.findIndex((i)=>i.id===dragged),to=draft.widgets.findIndex((i)=>i.id===w.id);draft.widgets.splice(to,0,draft.widgets.splice(from,1)[0]);dragged=null;renderCanvas();});}
      header.append(el('h2','',w.title));if(!['markdown','links'].includes(w.type))header.append(el('span','wb-source',getData(w).name));if(editing){const gear=button('设置',()=>{selected=w.id;panel='widget';renderPanel();renderWidgets();});gear.className='wb-gear';header.append(gear);}const body=el('div','wb-widget-body');card.append(header,body);grid.append(card);try{content(body,w);}catch(error){body.append(el('div','wb-error',error.message));}
    }
  }

  /** 编辑模式使用草稿，保存才正式提交，取消恢复布局与字段绑定。 */
  function startEdit(){if(!editing){editing=true;draft=clone(saved);}renderToolbar();renderCanvas();}
  function renderToolbar(){
    view.toolbar.replaceChildren(el('span','np-name',editing?'自定义工作台':'工作台'));
    if(editing)view.toolbar.append(button('页面设置',()=>{panel='page';renderPanel();}),button('模板',()=>{panel='templates';renderPanel();}),button('添加组件',()=>{panel='add';renderPanel();}),button('数据源',()=>{panel='sources';renderPanel();}),button('取消',()=>{editing=false;draft=clone(saved);selected=null;closePanel();renderToolbar();renderCanvas();}),button('保存布局',safe(()=>{api.onChange(clone(draft));saved=clone(draft);editing=false;selected=null;closePanel();renderToolbar();renderCanvas();})));
    else view.toolbar.append(button('刷新数据',safe(loadAll)),button('自定义',startEdit));
  }
  function closePanel(){panel=null;backdrop.hidden=true;renderWidgets();}

  /** 表单只在明确 change 后更新预览，输入过程中保留焦点和未完成的中文输入。 */
  function field(parent,label,value,onChange,options){
    const wrap=el('label','wb-field',label);let input;
    if(Array.isArray(options)){input=el('select');for(const [key,name]of options){const option=el('option','',name);option.value=key;input.append(option);}input.value=String(value??'');}
    else{input=el(options==='textarea'?'textarea':'input');input.value=String(value??'');}
    input.addEventListener('change',()=>{onChange(input.value);renderCanvas();});wrap.append(input);parent.append(wrap);return input;
  }
  function renderPanel(){
    if(!panel)return;backdrop.hidden=false;backdrop.replaceChildren();const box=el('aside','wb-panel'),header=el('div','wb-panel-head');header.append(el('h2','',panel==='widget'?'组件设置':panel==='page'?'页面设置':panel==='templates'?'选择模板':panel==='sources'?'数据源':'添加组件'),button('关闭',closePanel));box.append(header);backdrop.append(box);
    if(panel==='page'){field(box,'工作台名称',draft.title,(v)=>draft.title=v);field(box,'简介',draft.subtitle,(v)=>draft.subtitle=v);return;}
    if(panel==='templates'){const palette=el('div','wb-palette');for(const [key,name,desc]of [['personal','个人工作台','任务 · 日程 · 笔记'],['project','项目驾驶舱','状态分布 · 进度 · 清单'],['knowledge','知识与灵感','资料 · 笔记 · 常用入口'],['blank','空白画布','从零开始自由组合']]){const b=button(name,()=>{const apply=button('替换当前布局',()=>{draft=template(key,api.getCurrentData(),draft.sources);selected=null;closePanel();renderCanvas();});box.querySelector('.wb-panel-actions')?.remove();const actions=el('div','wb-panel-actions');actions.append(apply);box.append(actions);});b.append(el('small','',desc));palette.append(b);}box.append(palette);return;}
    if(panel==='add'){
      const source=el('select');source.setAttribute('aria-label','预设模块数据源');
      for(const data of [api.getCurrentData(),...datasets.values()].filter((data,i,all)=>all.findIndex((other)=>other.id===data.id)===i)){const option=el('option','',data.name);option.value=data.id;source.append(option);}
      box.append(el('p','np-muted','选一个预设开始，字段和样式随时可以修改。'),source,el('h3','','预设模块'));
      const add=(next)=>{if(draft.widgets.length>=64){notify('最多支持 64 个组件');return;}draft.widgets.push(next);selected=next.id;panel='widget';renderCanvas();renderPanel();};
      const data=()=>source.value==='current'?api.getCurrentData():datasets.get(source.value)??api.getCurrentData();
      const presets=el('div','wb-palette');for(const item of PRESETS){const b=button(item.name,()=>add(presetWidget(item.key,data())));b.append(el('small','',item.description));presets.append(b);}box.append(presets,el('h3','','基础组件'));
      const palette=el('div','wb-palette');for(const [type,name]of Object.entries(TYPES))palette.append(button(name,()=>add(widget(type,data()))));box.append(palette);return;
    }
    if(panel==='sources'){
      box.append(el('p','np-muted','当前表格始终可用。外部表格使用相对路径，文件应一同同步。'));
      for(const source of draft.sources){const row=el('div','wb-source-row');row.append(el('strong','',source.name),el('p','',source.path));const data=datasets.get(source.id);if(data?.error)row.append(el('p','wb-error',data.error));const actions=el('div','wb-panel-actions');actions.append(button('重新绑定',safe(async()=>{const next=await api.chooseSource();if(!next)return;draft.sources=draft.sources.map((s)=>s.id===source.id?next:s);draft.widgets.forEach((w)=>{if(w.sourceId===source.id)w.sourceId=next.id;});await loadAll();renderPanel();})),button('移除',()=>{draft.sources=draft.sources.filter((s)=>s.id!==source.id);draft.widgets.forEach((w)=>{if(w.sourceId===source.id)w.sourceId='current';});renderPanel();renderCanvas();}));row.append(actions);box.append(row);}
      box.append(button('添加多维表格文件',safe(async()=>{if(draft.sources.length>=8)throw new Error('最多支持 8 个外部数据源');const source=await api.chooseSource();if(source){draft.sources.push(source);await loadAll();renderPanel();}})));return;
    }
    const w=draft.widgets.find((w)=>w.id===selected);if(!w){closePanel();return;}const data=getData(w),fields=[['','请选择字段'],...data.columns.map((c)=>[c.id,c.name])];
    field(box,'名称',w.title,(v)=>w.title=v);
    field(box,'宽度',w.width,(v)=>w.width=Number(v),[['4','三分之一'],['6','二分之一'],['8','三分之二'],['12','整行']]);
    field(box,'高度（120—900）',w.height,(v)=>w.height=Math.min(900,Math.max(120,Number(v)||320)));
    if(['markdown','links'].includes(w.type)){field(box,w.type==='links'?'每行一个入口：名称 | https://网址':'文本内容',w.content,(v)=>w.content=v,'textarea');}
    else{
      field(box,'数据源',w.sourceId??'current',(v)=>{w.sourceId=v;renderPanel();},[['current',api.getCurrentData().name],...draft.sources.map((s)=>[s.id,s.name])]);
      if(['tasks','notes','calendar'].includes(w.type)){field(box,'标题字段',w.titleField,(v)=>w.titleField=v,fields);field(box,'描述字段',w.descriptionField,(v)=>w.descriptionField=v,fields);field(box,'日期字段',w.dateField,(v)=>w.dateField=v,fields);}
      if(['tasks','progress','metric'].includes(w.type)){field(box,'完成状态字段',w.statusField,(v)=>{w.statusField=v;renderPanel();},fields);const status=data.columns.find((c)=>c.id===w.statusField);if(status?.options)field(box,'已完成选项',w.completedValue,(v)=>w.completedValue=v,[['','请选择'],...status.options.map((o)=>[o.id,o.label])]);}
      if(['metric','chart'].includes(w.type)){field(box,'统计方式',w.aggregate,(v)=>w.aggregate=v,w.type==='chart'?[['count','记录数'],['sum','求和']]:[['count','记录数'],['sum','求和'],['avg','平均值'],['min','最小值'],['max','最大值']]);field(box,'数值字段',w.valueField,(v)=>w.valueField=v,fields);}
      if(w.type==='chart')field(box,'分组字段',w.groupField,(v)=>w.groupField=v,fields);
      box.append(el('h3','','筛选与排序'));field(box,'筛选字段',w.filterField,(v)=>w.filterField=v,fields);field(box,'条件',w.filterOperator,(v)=>w.filterOperator=v,[['contains','包含'],['equals','等于'],['notEquals','不等于'],['isEmpty','为空']]);field(box,'筛选值（选项使用显示文字）',w.filterValue,(v)=>w.filterValue=v);
      field(box,'日期字段',w.dateField,(v)=>w.dateField=v,fields);field(box,'日期范围',w.period,(v)=>w.period=v,[['','全部日期'],['today','今天'],['upcoming','未来三天'],['overdue','已逾期']]);
      field(box,'完成状态筛选',w.onlyCompleted?'done':w.onlyIncomplete?'todo':'all',(v)=>{w.onlyCompleted=v==='done';w.onlyIncomplete=v==='todo';},[['all','全部'],['todo','未完成'],['done','已完成']]);
      field(box,'排序字段',w.sortField,(v)=>w.sortField=v,fields);field(box,'排序方向',w.sortDirection,(v)=>w.sortDirection=v,[['asc','升序'],['desc','降序']]);field(box,'最多显示记录（1—100）',w.limit,(v)=>w.limit=Math.max(1,Math.min(100,Number(v)||12)));
    }
    const actions=el('div','wb-panel-actions');
    for(const [label,offset]of [['上移',-1],['下移',1]])actions.append(button(label,()=>{const i=draft.widgets.indexOf(w),to=i+offset;if(to>=0&&to<draft.widgets.length){draft.widgets.splice(to,0,draft.widgets.splice(i,1)[0]);renderCanvas();}}));
    actions.append(button('复制组件',()=>{if(draft.widgets.length>=64)return;const next={...clone(w),id:id(),title:`${w.title} 副本`};draft.widgets.push(next);selected=next.id;renderCanvas();renderPanel();}),button('删除组件',()=>{draft.widgets=draft.widgets.filter((x)=>x.id!==w.id);selected=null;closePanel();renderCanvas();}));box.append(actions);
  }

  /** 每次刷新有独立代际，取消或切换配置后旧数据结果不会覆盖新视图。 */
  async function loadAll(){
    const token=++requestGeneration;if(signal.aborted)return;datasets.set('current',api.getCurrentData());
    for(const source of draft.sources){try{const data=await api.loadSource(source);if(token!==requestGeneration||destroyed)return;datasets.set(source.id,data);}catch(error){datasets.set(source.id,{id:source.id,name:source.name,columns:[],rows:[],error:error.message});}}
    if(token===requestGeneration&&!destroyed&&!signal.aborted)renderCanvas();
  }
  const unsubscribe=api.subscribe(()=>{datasets.set('current',api.getCurrentData());if(!editing){saved=clone(api.getConfig()??saved);draft=clone(saved);}renderCanvas();});
  backdrop.addEventListener('click',(event)=>{if(event.target===backdrop)closePanel();});
  view.root.addEventListener('keydown',(event)=>{if(event.key==='Escape'&&panel)closePanel();});
  renderToolbar();renderCanvas();await loadAll();
  return ()=>{destroyed=true;requestGeneration++;unsubscribe();view.destroy();};
}
