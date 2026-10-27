// 设置中的插件目录与已安装管理，安装操作立即生效，不与外观设置的临时预览混用。
import { useEffect, useState } from 'react';
import { Download, RefreshCw, FileText, FileSpreadsheet, Presentation, FileType, LayoutDashboard, DraftingCompass, BookOpen, Trash2 } from 'lucide-react';
import { initializePlugins, usePluginStore } from '../../stores/pluginStore';
import { OFFICIAL_PLUGINS, isNewerPluginVersion, type PluginId } from './pluginTypes';
import { Tooltip } from '../../components/Tooltip';
import { PluginFonts } from './PluginFonts';
import { ProgressRing } from './ProgressRing';
import { canManageInstance } from '../account/accountState';
import './plugins.css';

export const PLUGIN_ICONS = { word: FileText, excel: FileSpreadsheet, powerpoint: Presentation, pdf: FileType, cad: DraftingCompass, epub: BookOpen, workbench: LayoutDashboard };

/** target 来自一次性跳转：字体区或某个插件卡片，定位后短暂高亮。 */
export function PluginsPanel({ target }: { target?: string | null }) {
  const { installed, catalog, busy, progress, error, check, act } = usePluginStore();
  const [tab, setTab] = useState<'all' | 'installed'>('all');
  const [removeId, setRemoveId] = useState<PluginId | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  // 网页多用户部署中插件按实例共享，普通用户只能使用管理员安装并启用的插件。
  const manage = canManageInstance();
  useEffect(() => { void initializePlugins(); }, []);
  useEffect(() => {
    if (!target || target === 'plugins') return;
    const element = target === 'fonts' ? 'nb-plugin-fonts' : `nb-plugin-${target.slice('plugin:'.length)}`;
    // 设置父容器在切换栏目后重置滚动；下一帧再定位，避免被父级重置覆盖。
    const frame = requestAnimationFrame(() => document.getElementById(element)?.scrollIntoView({ block: target === 'fonts' ? 'start' : 'center' }));
    let timer: number | undefined;
    if (target !== 'fonts') { setTab('all'); setHighlight(target.slice('plugin:'.length)); timer = window.setTimeout(() => setHighlight(null), 1600); }
    return () => { cancelAnimationFrame(frame); window.clearTimeout(timer); };
  }, [target]);
  return <div className="nb-plugins">
    <div className="nb-plugins-heading"><h2>插件</h2>
      <button type="button" className="nb-plugin-button" disabled={!!busy} onClick={() => void check()}><RefreshCw size={14} className={busy === 'catalog' ? 'nb-spin' : undefined} />{busy === 'catalog' ? '正在检查…' : '检查更新'}</button>
    </div>
    <div className="nb-plugins-tabs" role="tablist" aria-label="插件分类">
      <button type="button" role="tab" aria-selected={tab === 'all'} onClick={() => setTab('all')}>发现插件</button>
      <button type="button" role="tab" aria-selected={tab === 'installed'} onClick={() => setTab('installed')}>已安装{installed.length ? ` ${installed.length}` : ''}</button>
    </div>
    {!manage && <p className="nb-plugin-managed">插件由管理员统一安装和启用</p>}
    {error && <div className="nb-plugin-error" role="alert">{error}</div>}
    <div className="nb-plugin-list">{OFFICIAL_PLUGINS.filter((item) => tab === 'all' || installed.some((p) => p.manifest.id === item.id)).map((item) => {
      const current = installed.find((p) => p.manifest.id === item.id);
      const latest = catalog.find((p) => p.id === item.id);
      const update = current && latest && isNewerPluginVersion(latest.version, current.manifest.version);
      const installing = busy === `install:${item.id}`;
      const percent = progress?.id === item.id ? progress.percent : null;
      const Icon = PLUGIN_ICONS[item.id];
      return <article className={`nb-plugin-card${highlight === item.id ? ' is-highlight' : ''}`} id={`nb-plugin-${item.id}`} key={item.id}>
        <div className="nb-plugin-icon"><Icon size={19} /></div>
        <div className="nb-plugin-info">
          <div className="nb-plugin-name">{item.name}<span>{current ? `v${current.manifest.version}` : latest ? `v${latest.version}` : '官方插件'}</span></div>
          <div className="nb-plugin-meta"><span>{item.description}</span>{item.formats.split(' · ').map((format) => <span className="nb-plugin-chip" key={format}>{format}</span>)}</div>
          {update && <p className="nb-plugin-update">可更新到 v{latest.version} · {latest.changelog}</p>}
          {current?.invalid && <p className="nb-plugin-inline-error">插件文件损坏：{current.error}</p>}
        </div>
        <div className="nb-plugin-actions">
          {!manage ? <span className="nb-plugin-confirm-text">{current ? current.enabled && !current.invalid ? '已启用' : '未启用' : '未安装'}</span> : removeId === item.id ? <>
            <span className="nb-plugin-confirm-text">{item.id === 'workbench' ? '卸载？布局会保留' : '确定卸载？'}</span>
            <button type="button" className="nb-plugin-button" onClick={() => setRemoveId(null)}>取消</button>
            <button type="button" className="nb-plugin-button danger" disabled={!!busy} onClick={() => { void act('remove', item.id); setRemoveId(null); }}>卸载</button>
          </> : !current ? <button type="button" className="nb-plugin-button primary" disabled={!!busy} onClick={() => void act('install', item.id)}>
            {installing ? <ProgressRing percent={percent} /> : <Download size={14} />}{installing ? percent == null ? '正在下载' : `${percent}%` : '下载安装'}
          </button> : <>
            {(current.invalid || update) && <button type="button" className="nb-plugin-button primary" disabled={!!busy} onClick={() => void act('install', item.id)}>
              {installing && <ProgressRing percent={percent} />}{installing ? percent == null ? '正在下载' : `${percent}%` : current.invalid ? '重新下载' : '更新'}
            </button>}
            <label className="nb-plugin-enable"><input type="checkbox" checked={current.enabled} disabled={!!busy || current.invalid} onChange={(event) => void act('toggle', item.id, event.target.checked)} />启用</label>
            <Tooltip content="卸载插件"><button type="button" className="nb-plugin-button icon" aria-label={`卸载${item.name}`} disabled={!!busy} onClick={() => setRemoveId(item.id)}><Trash2 size={14} /></button></Tooltip>
          </>}
        </div>
        {current && !current.invalid && <details className="nb-plugin-license"><summary>版本与开源许可</summary>
          {current.manifest.changelog && <p>{current.manifest.changelog}</p>}
          <pre>{current.manifest.licenses}</pre>
        </details>}
      </article>;
    })}</div>
    {tab === 'installed' && !installed.length && <p className="nb-plugin-empty">还没有安装插件</p>}
    <PluginFonts />
  </div>;
}
