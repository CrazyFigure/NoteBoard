// 多维表格工作台轻量宿主：文件选择、数据读取和记录入口由主程序控制。
import { useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { initializePlugins, usePluginStore } from '../../stores/pluginStore';
import { useDocumentStore } from '../../stores/documentStore';
import * as ipc from '../../core/ipc/commands';
import { loadPlugin } from './pluginService';
import { PluginsPanel } from './PluginsPanel';
import { showToast } from '../../stores/toastStore';
import { flushDocument } from '../session/documentSession';
import { requestBitableRecord } from '../bitable/recordOpenRequests';
import type { BitableDocument } from '../bitable/bitableTypes';
import type { WorkbenchConfig, WorkbenchDataset, WorkbenchSource } from './workbenchTypes';
import { relativeSourcePath, resolveSourcePath, validateWorkbenchConfig } from './workbenchSources';
import './plugins.css';

interface Props {
  docKey: string;
  data: BitableDocument;
  config?: WorkbenchConfig;
  searchQuery: string;
  onChange: (config: WorkbenchConfig) => void;
  onOpenRecord: (id: string) => void;
  onUpdateRow: (id: string, patch: Record<string, unknown>) => void;
}

export function WorkbenchView(props: Props) {
  const {docKey,data,config,searchQuery}=props;
  const ref=useRef<HTMLDivElement>(null), latest=useRef(props);latest.current=props;
  const installed=usePluginStore((s)=>s.installed), current=installed.find((p)=>p.manifest.id==='workbench');
  const [error,setError]=useState('');
  const refreshRef=useRef<(() => void)|null>(null);
  useEffect(()=>{void initializePlugins();},[]);
  useEffect(()=>{refreshRef.current?.();},[data,config,searchQuery]);

  useEffect(()=>{
    if(!current?.enabled||!ref.current)return;
    const controller=new AbortController();let dispose:(()=>void)|void;
    // 每次加载使用独立容器，迟到的旧版本清理不能移除新版本界面。
    const target=document.createElement('div');target.style.height='100%';ref.current.replaceChildren(target);
    const authorized=new Map<string,WorkbenchSource>();
    const readConfig=()=>latest.current.config;
    const currentData=():WorkbenchDataset=>({id:'current',name:latest.current.data.title,columns:latest.current.data.columns,rows:latest.current.data.rows});
    /** 外部数据源只读取用户在此工作台明确选择的文件，并保留已打开文件的权威未保存内容。 */
    const loadSource=async(source:WorkbenchSource):Promise<WorkbenchDataset>=>{
      const allowed=authorized.get(source.id)??readConfig()?.sources.find((s)=>s.id===source.id);
      if(!allowed||allowed.path!==source.path)throw new Error('请先选择数据源文件');
      const path=resolveSourcePath(docKey,allowed.path);
      const probe=await ipc.probeDocument(path);if(!probe.exists||probe.isDir||probe.kind!=='bitable')throw new Error('数据源不存在或已移动，请重新选择');
      if(probe.size>10*1024*1024)throw new Error('工作台单个外部数据源上限为 10 MB');
      const opened=useDocumentStore.getState().getDocument(path);
      if(opened)await flushDocument(path,'save');
      const payload=opened?useDocumentStore.getState().getDocument(path):await ipc.readDocument(path);
      const raw=JSON.parse(payload?.content??'');
      if(!Array.isArray(raw.columns)||!Array.isArray(raw.rows)||raw.rows.length>100000)throw new Error('数据源格式无效或超过十万条记录');
      return {id:source.id,name:allowed.name,columns:raw.columns,rows:raw.rows};
    };
    setError('');
    void (async()=>{
      try {
        const module=await loadPlugin('workbench',current.manifest.version);if(controller.signal.aborted)return;
        // 工作台接口通过显式回调提供，Office 的只读上下文不包含这些文档操作。
        const context={container:target,name:data.title,signal:controller.signal,notify:(text:string)=>showToast(text),
          getConfig:readConfig,getCurrentData:currentData,getSearchQuery:()=>latest.current.searchQuery,loadSource,
          onChange:(next:unknown)=>latest.current.onChange(validateWorkbenchConfig(next)),
          chooseSource:async()=>{
            if(!latest.current.docKey.includes('/')&&!latest.current.docKey.includes('\\'))throw new Error('请先保存多维表格，再添加其它文件作为数据源');
            const chosen=await open({multiple:false,filters:[{name:'多维表格',extensions:['bitable','table']}]});
            if(!chosen||Array.isArray(chosen))return null;
            if(chosen===docKey)throw new Error('当前表格已经是数据源');
            const source={id:`source_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,name:chosen.split(/[/\\]/).pop()??'多维表格',path:relativeSourcePath(docKey,chosen)};
            authorized.set(source.id,source);await loadSource(source);return source;
          },
          openRecord:async(sourceId:string,rowId:string)=>{
            if(sourceId==='current'){latest.current.onOpenRecord(rowId);return;}
            const source=readConfig()?.sources.find((s)=>s.id===sourceId)??authorized.get(sourceId);if(!source)throw new Error('数据源未配置');
            const path=resolveSourcePath(docKey,source.path);
            const owner=await ipc.findDocumentOwner(path);
            if(owner&&owner!==getCurrentWindow().label){await ipc.focusWindow(owner);showToast('来源表格已在其它窗口打开，请在该窗口查看记录');return;}
            const {openDocument}=await import('../editor-code/orchestration/openDocument');
            requestBitableRecord(path,rowId);
            await openDocument(path);
          },
          updateRow:(sourceId:string,rowId:string,patch:Record<string,unknown>)=>{
            if(sourceId!=='current')throw new Error('请打开来源记录修改，避免覆盖其它文件的未保存内容');
            latest.current.onUpdateRow(rowId,patch);
          },
          openLink:async(url:string)=>{if(!/^https?:\/\//i.test(url))throw new Error('仅支持 HTTP 与 HTTPS 链接');await ipc.openExternalUrl(url);},
          subscribe:(listener:()=>void)=>{refreshRef.current=listener;return()=>{refreshRef.current=null;};},
        };
        dispose=await module.mount(context);
        if(controller.signal.aborted)dispose?.();
      }catch(e){if(!controller.signal.aborted)setError(String(e));}
    })();
    return()=>{controller.abort();dispose?.();target.remove();refreshRef.current=null;};
  },[docKey,current?.enabled,current?.manifest.version]);

  return <div className="nb-plugin-host">
    {!current?.enabled&&<div className="nb-plugin-placeholder"><PluginsPanel only="workbench"/></div>}
    {error&&<div className="nb-plugin-error" role="alert">{error}</div>}
    <div ref={ref} hidden={!current?.enabled} style={{height:'100%'}}/>
  </div>;
}
