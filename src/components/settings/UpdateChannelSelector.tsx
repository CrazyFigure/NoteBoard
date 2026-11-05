// 更新渠道选择：GitHub / 腾讯云 CNB
// 所选渠道用于下载，检测更新时按 GitHub、CNB 顺序探测并自动切换到可用渠道。

import type { UpdateChannel } from '../../core/ipc/types';
import { IS_WEB } from '../../core/platform';
import { RELEASE_CHANNELS, useUpdateChannel } from '../../core/releaseChannel';
import { useSettingsStore } from '../../stores/settingsStore';
import { Tooltip } from '../Tooltip';
import './about-panel.css';

export const UPDATE_CHANNEL_ORDER: UpdateChannel[] = ['github', 'cnb'];

// 网页版由部署者更新镜像，渠道只影响字体包与插件
const CHANNEL_HINT = IS_WEB ? '字体包与插件从所选渠道下载' : '检测更新优先 GitHub，失败后尝试腾讯云 CNB；可用渠道将自动用于安装包、字体与插件下载';

export function UpdateChannelSelector() {
  const channel = useUpdateChannel();
  const setSystem = useSettingsStore((state) => state.setSystem);

  return (
    <div className="nb-about-row">
      <span>更新渠道</span>
      <Tooltip content={CHANNEL_HINT} side="top" sideOffset={4}>
        <div className="nb-about-segmented" role="radiogroup" aria-label="更新渠道">
          {UPDATE_CHANNEL_ORDER.map((id) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={channel === id}
              className={`nb-about-segment${channel === id ? ' is-active' : ''}`}
              onClick={() => { if (channel !== id) void setSystem({ updateChannel: id }); }}
            >
              {RELEASE_CHANNELS[id].label}
            </button>
          ))}
        </div>
      </Tooltip>
    </div>
  );
}
