// 设置中的插件目录与已安装管理，安装操作立即生效，不与外观设置的临时预览混用。
import { useEffect, useState } from 'react';
import { Download, RefreshCw, FileText, FileSpreadsheet, Presentation, FileType, LayoutDashboard, DraftingCompass, Trash2 } from 'lucide-react';
import { initializePlugins, usePluginStore } from '../../stores/pluginStore';
import { OFFICIAL_PLUGINS, isNewerPluginVersion, type PluginId } from './pluginTypes';
import { Tooltip } from '../../components/Tooltip';
import { PluginFonts } from './PluginFonts';
import './plugins.css';

const ICONS = { word: FileText, excel: FileSpreadsheet, powerpoint: Presentation, pdf: FileType, cad: DraftingCompass, workbench: LayoutDashboard };

/** 紧凑模式用于未安装查看器时就地安装，避免反复寻找设置入口。 */
export function PluginsPanel({ only, section }: { only?: PluginId; section?: 'fonts' }) {
  const { installed, catalog, busy, error, check, act } = usePluginStore();
  const [tab, setTab] = useState<'all' | 'installed'>('all');
  const [removeId, setRemoveId] = useState<PluginId | null>(null);
  useEffect(() => { void initializePlugins(); }, []);
  useEffect(() => {
    if (section !== 'fonts') return;
    // 设置父容器在切换栏目后重置滚动；下一帧再定位字体，避免被父级重置覆盖。
    const frame = requestAnimationFrame(() => document.getElementById('nb-plugin-fonts')?.scrollIntoView({block:'start'}));
    return () => cancelAnimationFrame(frame);
  }, [section]);
  return <div className="nb-plugins">
    <div className="nb-plugins-heading"><h2>{only ? '安装查看插件' : '插件'}</h2>
      <button type="button" className="nb-plugin-button" disabled={!!busy} onClick={() => void check()}><RefreshCw size={14} />{busy === 'catalog' ? '正在检查…' : '检查更新'}</button>
    </div>
    {!only && <div className="nb-plugins-tabs" role="tablist" aria-label="插件分类">
      <button type="button" role="tab" aria-selected={tab === 'all'} onClick={() => setTab('all')}>发现插件</button>
      <button type="button" role="tab" aria-selected={tab === 'installed'} onClick={() => setTab('installed')}>已安装</button>
    </div>}
    {error && <div className="nb-plugin-error" role="alert">{error}</div>}
    <div className="nb-plugin-list">{OFFICIAL_PLUGINS.filter((item) => (!only || item.id === only) && (tab === 'all' || installed.some((p) => p.manifest.id === item.id))).map((item) => {
      const current = installed.find((p) => p.manifest.id === item.id);
      const latest = catalog.find((p) => p.id === item.id);
      const update = current && latest && isNewerPluginVersion(latest.version, current.manifest.version);
      const Icon = ICONS[item.id];
      return <article className="nb-plugin-card" key={item.id}>
        <div className="nb-plugin-icon"><Icon size={23} /></div>
        <div className="nb-plugin-info"><div className="nb-plugin-name">{item.name}<span>{current ? `v${current.manifest.version}` : latest ? `v${latest.version}` : '官方插件'}</span></div>
          <p>{item.description}</p><div className="nb-plugin-formats">{item.formats}</div>
          {update && <p className="nb-plugin-update">可更新到 v{latest.version} · {latest.changelog}</p>}
          {current?.invalid && <p className="nb-plugin-error">插件文件损坏：{current.error}</p>}
          {current && <details><summary>版本与开源许可</summary><p>{current.manifest.changelog}</p><pre>{current.manifest.licenses}</pre></details>}
        </div>
        <div className="nb-plugin-actions">
          {!current ? <button type="button" className="nb-plugin-button primary" disabled={!!busy} onClick={() => void act('install', item.id)}><Download size={14} />{busy === `install:${item.id}` ? '正在下载…' : '下载安装'}</button> : <>
            {current.invalid && <button type="button" className="nb-plugin-button primary" disabled={!!busy} onClick={() => void act('install', item.id)}>重新下载修复</button>}
            {update && <button type="button" className="nb-plugin-button primary" disabled={!!busy} onClick={() => void act('install', item.id)}>更新</button>}
            <label className="nb-plugin-enable"><input type="checkbox" checked={current.enabled} disabled={!!busy || current.invalid} onChange={(event) => void act('toggle', item.id, event.target.checked)} />启用</label>
            <Tooltip content="卸载插件，保留文档与工作台配置"><button type="button" className="nb-plugin-button icon" aria-label={`卸载${item.name}`} disabled={!!busy} onClick={() => setRemoveId(item.id)}><Trash2 size={14} /></button></Tooltip>
          </>}
        </div>
      </article>;
    })}</div>
    {tab === 'installed' && !installed.length && <p className="nb-plugin-empty">还没有安装插件</p>}
    {!only && <PluginFonts />}
    {removeId && <div className="nb-plugin-confirm" role="alertdialog" aria-label="卸载插件"><span>卸载此插件？文档和工作台配置会保留。</span><div><button type="button" className="nb-plugin-button" onClick={() => setRemoveId(null)}>取消</button><button type="button" className="nb-plugin-button" onClick={() => { void act('remove', removeId); setRemoveId(null); }}>卸载</button></div></div>}
  </div>;
}
