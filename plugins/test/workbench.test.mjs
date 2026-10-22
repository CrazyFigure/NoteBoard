// 字段的业务 key 不一定等于存储 ID；测试使用不同值，防止空名称和错误统计回归。
import test from 'node:test';
import assert from 'node:assert/strict';
import {widget,display,presetWidget,PRESETS,sourceLabel,labels,matchesFilter,fieldOptions,missingBinding,filterChoices,moveWidget} from '../workbench/index.mjs';

test('组件绑定真实字段 ID，选择项显示业务标签',()=>{
  const dataset={id:'current',name:'任务',columns:[{id:'col_title',key:'title',name:'任务名称',type:'text'},{id:'col_status',key:'status',name:'当前状态',type:'select',options:[{id:'opt_done',label:'已完成'}]}],rows:[]};
  const config=widget('tasks',dataset);
  assert.equal(config.titleField,'col_title');assert.equal(config.statusField,'col_status');assert.equal(config.completedValue,'opt_done');
  const row={id:'row1',col_title:'准备报告',col_status:'opt_done'};
  assert.equal(display(dataset,row,config.titleField),'准备报告');assert.equal(display(dataset,row,config.statusField),'已完成');
});

test('预设模块绑定所选外部表字段，日期筛选可继续修改，不写入演示行',()=>{
  const dataset={id:'external_tasks',name:'项目',columns:[{id:'task',name:'名称',type:'text'},{id:'due',name:'截止日期',type:'date'},{id:'done',name:'已完成',type:'checkbox'}],rows:[]};
  const config=presetWidget('overdue',dataset);
  assert.equal(config.sourceId,'external_tasks');assert.equal(config.dateField,'due');assert.equal(config.period,'overdue');assert.equal(config.onlyIncomplete,true);
  for(const preset of PRESETS)assert.equal(presetWidget(preset.key,dataset).sourceId,'external_tasks');
  assert.deepEqual(dataset.rows,[]);
});

test('数据源名称去掉多维表格扩展名，兼容旧配置',()=>{
  assert.equal(sourceLabel('每日工作记录.bitable'),'每日工作记录');
  assert.equal(sourceLabel('项目.TABLE'),'项目');
  assert.equal(sourceLabel('报告.bitable.md'),'报告.bitable.md');
});

// 多选「项目」字段是工作台最常见的分组来源，筛选与分组都按选项文字拆分。
const projects={id:'current',name:'日志',columns:[{id:'day',name:'日期',type:'date'},{id:'project',name:'项目',type:'multiSelect',options:[{id:'a',label:'宝山'},{id:'b',label:'MES'}]},{id:'text',name:'内容',type:'text'},{id:'hours',name:'工时',type:'number'},{id:'done',name:'完成',type:'checkbox'}],rows:[]};

test('多选字段拆成各选项，勾选框统一为完成文字',()=>{
  assert.deepEqual(labels(projects,{project:['a','b']},'project'),['宝山','MES']);
  assert.deepEqual(labels(projects,{project:null},'project'),[]);
  assert.deepEqual(labels(projects,{done:null},'done'),['未完成']);
  assert.deepEqual(filterChoices(projects.columns[1]),['宝山','MES']);
  assert.equal(filterChoices(projects.columns[2]),null);
});

test('筛选按选项匹配，未填写筛选值时不过滤',()=>{
  const row={project:['a','b'],text:'整理报表'};
  assert.equal(matchesFilter({filterField:'project',filterOperator:'equals',filterValue:'MES'},projects,row),true);
  assert.equal(matchesFilter({filterField:'project',filterOperator:'notEquals',filterValue:'宝山'},projects,row),false);
  assert.equal(matchesFilter({filterField:'project',filterOperator:'equals',filterValue:''},projects,row),true);
  assert.equal(matchesFilter({filterField:'text',filterOperator:'contains',filterValue:'报表'},projects,row),true);
  assert.equal(matchesFilter({filterField:'text',filterOperator:'isEmpty'},projects,{text:''}),true);
  assert.equal(matchesFilter({filterField:'project',filterOperator:'notEmpty'},projects,{project:[]}),false);
});

test('字段下拉按用途过滤类型，保留旧配置已绑定的字段',()=>{
  assert.deepEqual(fieldOptions(projects,'date').map(([id])=>id),['','day']);
  assert.deepEqual(fieldOptions(projects,'number','text').map(([id])=>id),['','text','hours']);
  assert.deepEqual(fieldOptions(projects,'status').map(([id])=>id),['','project','done']);
});

test('必要字段缺失时给出提示，统计图默认按多选字段分组',()=>{
  const chart=widget('chart',{...projects,columns:projects.columns.filter((c)=>c.type!=='checkbox')});
  assert.equal(chart.groupField,'project');assert.equal(widget('chart',projects).groupField,'done');assert.equal(missingBinding(chart,projects),'');
  assert.match(missingBinding({...chart,aggregate:'sum'},projects),/数值字段/);
  assert.match(missingBinding({type:'progress',statusField:''},projects),/完成状态字段/);
  assert.match(missingBinding({type:'progress',statusField:'project'},projects),/已完成选项/);
  assert.equal(missingBinding({type:'progress',statusField:'done'},projects),'');
  assert.match(missingBinding({type:'metric',aggregate:'count',period:'today',dateField:''},projects),/日期字段/);
});

test('拖动排序插入到目标之前或之后，目标无效时保持原样',()=>{
  const list=['a','b','c','d'].map((id)=>({id}));const ids=(items)=>items.map((w)=>w.id).join('');
  assert.equal(ids(moveWidget(list,'a','c',true)),'bcad');
  assert.equal(ids(moveWidget(list,'d','b',false)),'adbc');
  assert.equal(ids(moveWidget(list,'b','a',false)),'bacd');
  assert.equal(moveWidget(list,'a','x',true),list);
  assert.equal(ids(list),'abcd');
});
