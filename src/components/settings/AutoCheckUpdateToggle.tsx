// 自动检查更新开关：关闭后不再启动及定时静默检查，手动检测不受影响
// 设置项为 system.autoCheckUpdate（默认开启），检查逻辑见 stores/updateStore.ts

import { useSettingsStore } from '../../stores/settingsStore';
import { Tooltip } from '../Tooltip';
import './about-panel.css';

export function AutoCheckUpdateToggle() {
  // 旧设置缺字段时视为开启
  const enabled = useSettingsStore((s) => s.settings.system?.autoCheckUpdate !== false);
  const setSystem = useSettingsStore((s) => s.setSystem);
  return (
    <div className="nb-about-row" data-setting-id="autoCheckUpdate">
      <Tooltip content="启动及每 5 分钟静默检查" side="top" sideOffset={4}>
        <label className="nb-about-check">
          <input
            type="checkbox"
            aria-label="自动检查更新"
            checked={enabled}
            onChange={(e) => void setSystem({ autoCheckUpdate: e.target.checked })}
          />
          <span>自动检查更新</span>
        </label>
      </Tooltip>
    </div>
  );
}
