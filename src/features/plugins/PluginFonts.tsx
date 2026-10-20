// 字体继续复用历史增强包及其校验服务，已有用户无需迁移文件或重复下载。
import { useEffect, useState } from 'react';
import { Type, Download, Trash2 } from 'lucide-react';
import { useFontPackStore } from '../../stores/fontPackStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { listSystemFonts } from '../../core/ipc/commands';
import { resolveSystemFontFallbackPatch } from '../../app/fontPack';
import { showToast } from '../../stores/toastStore';
import { Tooltip } from '../../components/Tooltip';
import { ProgressRing } from './ProgressRing';

const FONTS = [
  { family:'Maple Mono Normal NF CN', label:'中文推荐', sample:'把想法写下来，让灵感慢慢生长。' },
  { family:'JetBrains Mono', label:'西文推荐', sample:'Ideas become clearer, one note at a time.' },
];

/** 两款字体共用一个版本化资源包，下载与卸载都按整包进行；系统已有同名字体时直接使用。 */
export function PluginFonts() {
  const { status, action, progress, error, init, download, remove } = useFontPackStore();
  const [system, setSystem] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { void init(); void listSystemFonts().then((items) => setSystem(items.map((item) => item.family))).catch(() => {}); }, [init]);
  const ready = status?.state === 'ready';
  const local = (family: string) => system.some((name) => name.toLowerCase() === family.toLowerCase());
  const allLocal = FONTS.every((font) => local(font.family));
  // 网页下载没有原生进度事件，未知进度时显示进行中，不伪造 0%。
  const percent = action === 'download' ? progress?.percent ?? null : null;

  /** 先把引用包字体的排版字段切到真实系统字体，再删除文件，避免界面落到无效字体。 */
  const handleRemove = async () => {
    setConfirming(false);
    try {
      const { settings, setTypography } = useSettingsStore.getState();
      const patch = resolveSystemFontFallbackPatch(settings.typography, (await listSystemFonts()).map((font) => font.family));
      if (Object.keys(patch).length) await setTypography(patch);
      const result = await remove();
      if (result?.state === 'missing') showToast('字体包已卸载，当前使用系统字体', 'success');
    } catch (removeError) {
      showToast(`字体包卸载失败：${String(removeError)}`, 'error', 5000);
    }
  };

  return <section id="nb-plugin-fonts" className="nb-plugin-fonts">
    <div className="nb-plugin-fonts-heading">
      <div><h3>字体</h3><p>字体增强包 v{status?.version || '1.0.0'} · 两款一起下载，约 19 MB</p></div>
      <div className="nb-plugin-actions">
        {ready ? confirming ? <>
          <span className="nb-plugin-confirm-text">卸载字体包？</span>
          <button type="button" className="nb-plugin-button" onClick={() => setConfirming(false)}>取消</button>
          <button type="button" className="nb-plugin-button danger" disabled={!!action} onClick={() => void handleRemove()}>卸载</button>
        </> : <Tooltip content="卸载字体包"><button type="button" className="nb-plugin-button icon" aria-label="卸载字体包" disabled={!!action} onClick={() => setConfirming(true)}>{action === 'remove' ? <ProgressRing percent={null} /> : <Trash2 size={14} />}</button></Tooltip>
          : !allLocal && <button type="button" className="nb-plugin-button primary" disabled={!!action || status?.state === 'verifying'} onClick={() => void download()}>
            {action === 'download' ? <ProgressRing percent={percent} /> : <Download size={14} />}
            {action === 'download' ? percent == null ? '正在下载' : `${percent}%` : status?.state === 'invalid' ? '修复字体包' : '下载字体包'}
          </button>}
      </div>
    </div>
    <div className="nb-plugin-font-grid">{FONTS.map((font) => {
      const available = ready || local(font.family);
      const state = ready ? '已安装' : local(font.family) ? '本机已有' : status?.state === 'verifying' ? '校验中' : '未下载';
      return <article className="nb-plugin-card nb-plugin-font-card" key={font.family}>
        <div className="nb-plugin-icon"><Type size={18} /></div>
        <div className="nb-plugin-info">
          <div className="nb-plugin-name">{font.family}</div>
          <div className="nb-plugin-meta"><span>{font.label} · SIL OFL 1.1</span><span className={`nb-plugin-chip${available ? ' is-ready' : ''}`}>{state}</span></div>
          <p className="nb-font-sample" style={{ fontFamily: available ? `"${font.family}", var(--ui-font-family)` : undefined }}>{font.sample}</p>
        </div>
      </article>;
    })}</div>
    {error && <p className="nb-plugin-error" role="alert">{error}</p>}
  </section>;
}
