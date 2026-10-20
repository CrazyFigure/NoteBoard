// 字段的业务 key 不一定等于存储 ID；测试使用不同值，防止空名称和错误统计回归。
import test from 'node:test';
import assert from 'node:assert/strict';
import {widget,display,presetWidget,PRESETS,sourceLabel} from '../workbench/index.mjs';

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
