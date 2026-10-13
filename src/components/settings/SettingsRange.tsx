// 设置页细滑块：在原生 range 基础上按当前值计算左侧已填充比例，交给 CSS 渐变绘制。

import type { CSSProperties, InputHTMLAttributes } from 'react';

type SettingsRangeProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

export function SettingsRange({ className, style, ...props }: SettingsRangeProps) {
  const min = Number(props.min ?? 0);
  const max = Number(props.max ?? 100);
  const value = Number(props.value ?? min);
  // WebKit 没有"已填充轨道"伪元素，只能把百分比写入 CSS 变量，由轨道渐变着色
  const percent = max > min && Number.isFinite(value)
    ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100))
    : 0;

  return (
    <input
      {...props}
      type="range"
      className={className ? `nb-settings-range ${className}` : 'nb-settings-range'}
      style={{ ...style, '--nb-range-fill': `${percent}%` } as CSSProperties}
    />
  );
}
