// 设置版本迁移回归测试
// 覆盖旧版回车互换字段的清理，以及前端写回和重复加载。

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CURRENT_SETTINGS_SCHEMA_VERSION,
  DEFAULT_SETTINGS,
  migrateSettings,
  useSettingsStore,
} from '../../src/stores/settingsStore';
import * as ipc from '../../src/core/ipc/commands';
import * as events from '../../src/core/ipc/events';
import * as applyTheme from '../../src/core/theme/applyTheme';
import { useFontPackStore } from '../../src/stores/fontPackStore';
import type { Settings } from '../../src/core/ipc/types';

/** 构造原始旧设置，保留一个自定义字段以检查迁移不会重置其他编辑器选项。 */
function legacySettings(version: number | undefined, swapEnterKeys: boolean): Settings {
  const settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    editor: { ...DEFAULT_SETTINGS.editor, swapEnterKeys, tabSize: 8 },
  };
  if (version === undefined) delete (settings as Partial<Settings>).schemaVersion;
  else settings.schemaVersion = version;
  return settings;
}

describe('移除旧版回车互换设置', () => {
  afterEach(() => {
    useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS), initialized: false });
    vi.restoreAllMocks();
  });

  it('新默认设置不存在回车互换字段', () => {
    expect(DEFAULT_SETTINGS.schemaVersion).toBe(CURRENT_SETTINGS_SCHEMA_VERSION);
    expect(DEFAULT_SETTINGS.editor).not.toHaveProperty('swapEnterKeys');
  });

  it.each([[1, false], [2, true], [undefined, false]] as const)('版本 %s 清理旧回车互换字段，原值为 %s', (version, swapped) => {
    const result = migrateSettings(legacySettings(version, swapped));
    expect(result.migrated).toBe(true);
    expect(result.settings.schemaVersion).toBe(3);
    expect(result.settings.editor).not.toHaveProperty('swapEnterKeys');
    expect(result.settings.editor.tabSize).toBe(8);
    expect(migrateSettings(result.settings)).toEqual({ settings: result.settings, migrated: false });
  });

  it('settingsStore.init 会持久化清理后的浏览器旧设置', async () => {
    const legacy = legacySettings(2, true);
    vi.spyOn(ipc, 'loadSettings').mockResolvedValue(legacy);
    const saveSpy = vi.spyOn(ipc, 'saveSettings').mockResolvedValue(1);
    vi.spyOn(events, 'onSettingsChanged').mockResolvedValue(() => {});
    vi.spyOn(applyTheme, 'resolveTheme').mockReturnValue('chen-guang');
    vi.spyOn(applyTheme, 'applyTheme').mockImplementation(() => {});
    vi.spyOn(applyTheme, 'applyTypography').mockImplementation(() => {});
    vi.spyOn(applyTheme, 'startSystemThemeListener').mockImplementation(() => {});
    vi.spyOn(useFontPackStore.getState(), 'init').mockResolvedValue(undefined);

    useSettingsStore.setState({ initialized: false });
    await useSettingsStore.getState().init();

    const current = useSettingsStore.getState().settings;
    expect(current.schemaVersion).toBe(CURRENT_SETTINGS_SCHEMA_VERSION);
    expect(current.editor).not.toHaveProperty('swapEnterKeys');
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledWith(current);
  });
});
