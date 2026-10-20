// 多文件工作台的数据源路径随文档保存为相对路径，禁止固化设备盘符。
import type { WorkbenchConfig } from './workbenchTypes';
import { USES_WINDOWS_PATHS } from '../../core/platform';

/** 将显式选择的同盘文件转换为相对路径，跨盘引用无法保证跨端可移植。 */
export function relativeSourcePath(documentPath: string, sourcePath: string): string {
  const base=documentPath.replaceAll('\\','/').split('/'); base.pop();
  const target=sourcePath.replaceAll('\\','/').split('/');
  const equal=(a:string,b:string)=>USES_WINDOWS_PATHS?a.toLowerCase()===b.toLowerCase():a===b;
  if (!equal(base[0],target[0])) throw new Error('请将数据源与工作台保存在同一存储位置，便于多端同步');
  let shared=0;
  while(shared<base.length&&shared<target.length&&equal(base[shared],target[shared]))shared++;
  return [...base.slice(shared).map(()=>'..'),...target.slice(shared)].join('/');
}

/** 还原相对路径时逐段处理上级目录；绝对路径与非法引用直接拒绝。 */
export function resolveSourcePath(documentPath: string, relative: string): string {
  if (!relative || relative.startsWith('/') || relative.includes('\\') || relative.includes(':') || relative.includes('\0')) throw new Error('数据源路径无效，请重新选择文件');
  const parts=documentPath.replaceAll('\\','/').split('/');parts.pop();
  for(const part of relative.split('/')) {
    if(part==='..'){if(parts.length<=1||parts.length===2&&parts[0]==='')throw new Error('数据源路径越过存储根目录');parts.pop();}
    else if(part&&part!=='.')parts.push(part);
  }
  return parts.join('/');
}

/** 配置边界统一在宿主校验，防止坏模板制造无界组件或失效数据源引用。 */
export function validateWorkbenchConfig(value: unknown): WorkbenchConfig {
  const config=value as WorkbenchConfig;
  const types=new Set(['metric','tasks','calendar','notes','chart','table','markdown','links','progress']);
  if(config?.schemaVersion!==1||typeof config.title!=='string'||!Array.isArray(config.sources)||config.sources.length>8||!Array.isArray(config.widgets)||config.widgets.length>64)throw new Error('工作台配置无效，最多支持 8 个外部数据源和 64 个组件');
  const ids=new Set<string>();
  for(const source of config.sources){if(typeof source.id!=='string'||source.id==='current'||ids.has(source.id)||typeof source.path!=='string'||typeof source.name!=='string')throw new Error('工作台数据源配置无效');ids.add(source.id);}
  const widgetIds=new Set<string>();
  for(const widget of config.widgets){if(typeof widget.id!=='string'||widgetIds.has(widget.id)||!types.has(widget.type)||typeof widget.title!=='string'||widget.sourceId&&widget.sourceId!=='current'&&!ids.has(widget.sourceId))throw new Error('工作台组件配置无效');widgetIds.add(widget.id);}
  return config;
}
