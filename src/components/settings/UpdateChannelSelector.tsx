// 更新渠道选择：GitHub / 腾讯云 CNB
// 渠道写入设置后，检测更新、安装包、字体包与插件下载均从所选渠道获取

import type { UpdateChannel } from '../../core/ipc/types';
import { IS_WEB } from '../../core/platform';
import { RELEASE_CHANNELS, useUpdateChannel } from '../../core/releaseChannel';
import { useSettingsStore } from '../../stores/settingsStore';
import { Tooltip } from '../Tooltip';
import './about-panel.css';

export const UPDATE_CHANNEL_ORDER: UpdateChannel[] = ['github', 'cnb'];

// 网页版由部署者更新镜像，渠道只影响字体包与插件
const CHANNEL_HINT = IS_WEB ? '字体包与插件从所选渠道下载' : '检测更新、安装包、字体与插件均从所选渠道下载';

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
