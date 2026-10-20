// 仅开发替身读取本地构建插件，生产构建没有此下载来源和模拟安装状态。
import type { InstalledPlugin, PluginCatalog, PluginId, PluginPackage } from '../features/plugins/pluginTypes';
const installed=new Map<string,InstalledPlugin>();

export async function mockPluginCommand(args:Record<string,unknown>):Promise<unknown>{
  const catalog=await fetch('/plugins/dist/catalog.json').then((r)=>{if(!r.ok)throw new Error('请先运行 pnpm --dir plugins build');return r.json() as Promise<PluginCatalog>;});
  const id=args.id as PluginId;
  if(args.operation==='catalog')return catalog;
  if(args.operation==='list')return [...installed.values()];
  if(args.operation==='remove'){installed.delete(id);return null;}
  if(args.operation==='toggle'){const item=installed.get(id);if(item)item.enabled=args.enabled===true;return null;}
  const entry=catalog.plugins.find((p)=>p.id===id);if(!entry)throw new Error('未知插件');
  const pkg=await fetch(`/plugins/dist/${id}-${entry.version}.nbplugin`).then((r)=>r.json() as Promise<PluginPackage>);
  if(args.operation==='install'){installed.set(id,{manifest:pkg.manifest,enabled:installed.get(id)?.enabled??false});return null;}
  if(args.operation==='load'&&installed.get(id)?.enabled)return pkg;
  throw new Error('请先安装并启用插件');
}
