// 字体继续复用历史增强包及其校验服务，已有用户无需迁移文件或重复下载。
import { useEffect, useState } from 'react';
import { Type, Download, Check } from 'lucide-react';
import { useFontPackStore } from '../../stores/fontPackStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { listSystemFonts } from '../../core/ipc/commands';

const FONTS = [
  { family:'Maple Mono Normal NF CN', label:'中文推荐', sample:'把想法写下来，让灵感慢慢生长。', chinese:true },
  { family:'JetBrains Mono', label:'西文推荐', sample:'Ideas become clearer, one note at a time.', chinese:false },
];

/** 两款字体共用已有版本化资源包；系统已存在同名字体时直接使用，省去重复文件。 */
export function PluginFonts() {
  const { status, action, progress, error, init, download } = useFontPackStore();
  const [system, setSystem] = useState<string[]>([]);
  const { setTypography } = useSettingsStore();
  useEffect(() => { void init(); void listSystemFonts().then((items) => setSystem(items.map((item) => item.family.toLowerCase()))).catch(() => {}); }, [init]);
  const ready = status?.state === 'ready';
  // 网页下载没有原生进度事件，未知进度时显示进行中，不伪造 0%。
  const downloadLabel = action ? progress?.percent == null ? '正在下载…' : `正在下载 ${progress.percent}%` : '下载字体增强包';
  return <section id="nb-plugin-fonts" className="nb-plugin-fonts">
    <h3>字体</h3><p className="nb-plugin-empty">字体增强包 v{status?.version || '1.0.0'} · 两款字体共用一次下载，约 19 MB。已有应用字体包自动复用；字体按使用情况加载。</p>
    <div className="nb-plugin-font-grid">{FONTS.map((font) => {
      const local = system.includes(font.family.toLowerCase());
      const available = ready || local;
      return <article className="nb-plugin-card nb-plugin-font-card" key={font.family}>
        <div className="nb-plugin-icon"><Type size={22} /></div>
        <div className="nb-plugin-info"><div className="nb-plugin-name">{font.family}</div><p>{font.label} · SIL OFL 1.1</p>
          <p className="nb-font-sample" style={{fontFamily:available ? `"${font.family}", var(--ui-font-family)` : undefined}}>{font.sample}</p>
          <span className="nb-plugin-formats">{ready ? '应用字体已就绪（自动复用）' : local ? '本机字体可用，无需重复下载' : status?.state === 'verifying' ? '正在后台校验已有字体…' : '尚未下载'}</span>
          {available ? <button type="button" className="nb-plugin-button" onClick={() => void setTypography(font.chinese ? {contentFontFamilyZh:font.family,monoFontFamilyZh:font.family,uiFontFamilyZh:font.family,explorerFontFamilyZh:font.family} : {contentFontFamily:font.family,monoFontFamily:font.family,uiFontFamily:font.family,explorerFontFamily:font.family})}><Check size={14} />用于{font.chinese ? '中文' : '西文'}排版</button> : <button type="button" className="nb-plugin-button primary" disabled={!!action || status?.state === 'verifying'} onClick={() => void download()}><Download size={14} />{downloadLabel}</button>}
        </div>
      </article>;
    })}</div>
    {error && <p className="nb-plugin-error" role="alert">{error}</p>}
  </section>;
}
