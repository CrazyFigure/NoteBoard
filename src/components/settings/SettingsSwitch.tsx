// NoteBoard 设置页现代化开关控件与开关行
// 底层保留原生 checkbox（role="switch"）以兼容无障碍键盘交互与 <label> 包裹，视觉由轨道与滑块呈现

import { useId } from 'react';

export interface SettingsSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  size?: 'md' | 'sm';
  ariaLabel?: string;
  ariaLabelledBy?: string;
  className?: string;
}

/** 现代化滑动开关：配合 nb-raw-checkbox 避开全局复选框样式 */
export function SettingsSwitch({
  checked,
  onChange,
  disabled = false,
  size = 'md',
  ariaLabel,
  ariaLabelledBy,
  className,
}: SettingsSwitchProps) {
  const classes = [
    'nb-settings-switch',
    size === 'sm' ? 'is-sm' : '',
    disabled ? 'is-disabled' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={classes}>
      <input
        type="checkbox"
        role="switch"
        className="nb-raw-checkbox nb-settings-switch-input"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="nb-settings-switch-track" aria-hidden="true">
        <span className="nb-settings-switch-thumb" />
      </span>
    </span>
  );
}

export interface SettingsToggleRowProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
  settingId?: string;
  compact?: boolean;
}

/** 设置开关行：左侧标题/说明/可选图标，右侧开关；关闭态自动附带 is-off 柔化文字 */
export function SettingsToggleRow({
  title,
  description,
  icon,
  checked,
  onChange,
  disabled = false,
  ariaLabel,
  settingId,
  compact = false,
}: SettingsToggleRowProps) {
  const labelId = useId();
  const rowClasses = [
    'nb-settings-toggle-row',
    compact ? 'is-compact' : '',
    checked ? '' : 'is-off',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div data-setting-id={settingId} className={rowClasses}>
      <div id={labelId} className="nb-settings-toggle-label">
        {icon && (
          <span className="nb-settings-toggle-icon" aria-hidden="true">
            {icon}
          </span>
        )}
        <div className="nb-settings-toggle-text">
          <div className="nb-settings-toggle-title">{title}</div>
          {description && <div className="nb-settings-toggle-desc">{description}</div>}
        </div>
      </div>
      <SettingsSwitch
        checked={checked}
        disabled={disabled}
        ariaLabel={ariaLabel}
        ariaLabelledBy={ariaLabel ? undefined : labelId}
        onChange={onChange}
      />
    </div>
  );
}
