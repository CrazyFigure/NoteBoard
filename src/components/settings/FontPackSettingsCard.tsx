// 排版页只保留下载入口；字体资源统一在插件页管理，避免重复安装路径。
import { ArrowRight, Type } from 'lucide-react';
import { openPluginSettings } from '../../features/plugins/openPluginSettings';

/** 原字体包管理卡的位置保留为导航，排版选择仍使用已有字体下拉。 */
export function FontPackSettingsCard({ onOpen }: { onOpen?: () => void }) {
  return <div className="nb-font-pack-settings-card">
    <div className="nb-font-pack-settings-title"><Type size={16} />推荐字体</div>
    <p>Maple Mono Normal NF CN（中文）与 JetBrains Mono（西文），可在插件中下载，仅供本应用使用。</p>
    <button type="button" className="nb-btn-secondary" onClick={onOpen ?? (() => openPluginSettings('fonts'))}>前往插件下载字体 <ArrowRight size={15} /></button>
  </div>;
}
