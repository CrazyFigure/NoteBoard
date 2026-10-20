// 工作台配置必须可跨设备移动，并在插件缺失时保持文档数据完整。
import { describe,it,expect } from 'vitest';
import { relativeSourcePath,resolveSourcePath,sourceDisplayName,validateWorkbenchConfig } from '../../src/features/plugins/workbenchSources';
import { createDefaultBitableDocument,parseBitableDocument,serializeBitableDocument } from '../../src/features/bitable/bitableConverter';
import { isEditable,kindFromPath } from '../../src/core/docKind';
import { isNewerPluginVersion } from '../../src/features/plugins/pluginTypes';

describe('工作台跨文件引用与配置边界',()=>{
  it('同盘文件持久化相对路径，换位置后恢复关联',()=>{
    const relative=relativeSourcePath('C:/notes/projects/home.bitable','C:/notes/data/tasks.bitable');
    expect(relative).toBe('../data/tasks.bitable');
    expect(resolveSourcePath('/workspace/projects/home.bitable',relative)).toBe('/workspace/data/tasks.bitable');
    expect(()=>relativeSourcePath('C:/notes/a.bitable','D:/notes/b.bitable')).toThrow('同一存储位置');
    expect(()=>resolveSourcePath('/workspace/a.bitable','../../private.bitable')).toThrow();
    expect(()=>resolveSourcePath('/workspace/a.bitable','C:/private.bitable')).toThrow();
  });
  it('已有视图和数据完整往返，卸载插件不影响工作台配置',()=>{
    const doc=createDefaultBitableDocument();
    const config=validateWorkbenchConfig({schemaVersion:1,title:'工作台',sources:[{id:'tasks',name:'任务',path:'tasks.bitable'}],widgets:[{id:'metric',type:'metric',title:'任务数',sourceId:'tasks',width:4}]});
    doc.views.push({id:'dashboard',name:'工作台',type:'workbench',workbench:config});
    const result=parseBitableDocument(serializeBitableDocument(doc));
    expect(result.rows).toEqual(doc.rows);expect(result.columns).toEqual(doc.columns);
    expect(result.views).toEqual(doc.views);
    expect(()=>validateWorkbenchConfig({...config,sources:Array(9).fill(config.sources[0])})).toThrow();
    expect(()=>validateWorkbenchConfig({...config,widgets:[{...config.widgets[0],sourceId:'unknown'}]})).toThrow();
  });
  it('新旧 Office 与 PDF 均进入只读查看，插件版本按数值更新',()=>{
    for(const ext of ['doc','docx','xls','xlsx','ppt','pptx','pdf','dwg','dxf','epub'])expect(kindFromPath(`document.${ext}`)).toBe('preview');
    expect(isEditable('preview')).toBe(false);
    expect(isNewerPluginVersion('1.10.0','1.9.0')).toBe(true);
    expect(isNewerPluginVersion('1.9.0','1.10.0')).toBe(false);
  });
  it('数据源显示文件名而非表格内部默认标题',()=>{
    expect(sourceDisplayName('C:\\notes\\每日工作记录.bitable')).toBe('每日工作记录');
    expect(sourceDisplayName('/workspace/data/tasks.table')).toBe('tasks');
  });
});
