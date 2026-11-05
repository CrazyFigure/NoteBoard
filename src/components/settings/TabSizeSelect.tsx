// Tab 宽度共用下拉框：提供常用宽度，并保留旧配置中的其他宽度，打开设置时不改写原值。
import { SettingsSelect, type SettingsSelectOption } from './SettingsSelect';

// 仅收敛界面可选项，不改变默认宽度、空格偏好或 Markdown 列表的回写规则。
const TAB_SIZE_PRESETS: readonly SettingsSelectOption<string>[] = [
  { value: '2', label: '2' },
  { value: '3', label: '3' },
  { value: '4', label: '4' },
];

interface TabSizeSelectProps {
  value: number;
  onChange: (value: number) => void;
}

/** 旧宽度以“自定义（原值）”显示，只有用户选择新选项后才更新设置。 */
export function TabSizeSelect({ value, onChange }: TabSizeSelectProps) {
  const selectedValue = String(value);
  const options = TAB_SIZE_PRESETS.some((option) => option.value === selectedValue)
    ? TAB_SIZE_PRESETS
    : [...TAB_SIZE_PRESETS, { value: selectedValue, label: `自定义（${selectedValue}）` }];

  return (
    <SettingsSelect
      ariaLabel="Tab 缩进宽度"
      value={selectedValue}
      options={options}
      onChange={(selected) => onChange(Number(selected))}
    />
  );
}
