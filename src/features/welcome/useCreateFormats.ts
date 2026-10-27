// 读取归一化后的新建格式布局（主页、「+」菜单与设置面板共用）

import { useMemo } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { resolveCreateFormats, type ResolvedCreateFormats } from './createFormats';

export function useCreateFormats(): ResolvedCreateFormats {
  const saved = useSettingsStore((s) => s.settings.layout?.createFormats);
  return useMemo(() => resolveCreateFormats(saved), [saved]);
}
