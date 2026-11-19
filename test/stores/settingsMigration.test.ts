// 设置版本迁移回归测试
// 覆盖：默认开启「Enter 与 Shift + Enter 互换」、v1/缺失版本号旧设置一次性迁移开启、迁移后手动关闭不再被覆盖。

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

describe('Enter 与 Shift + Enter 互换默认值与旧版迁移', () => {
  afterEach(() => {
    useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS), initialized: false });
    vi.restoreAllMocks();
  });

  it('新默认设置处于 v2 且默认勾选 Enter 互换', () => {
    expect(DEFAULT_SETTINGS.schemaVersion).toBe(CURRENT_SETTINGS_SCHEMA_VERSION);
    expect(DEFAULT_SETTINGS.schemaVersion).toBe(2);
    expect(DEFAULT_SETTINGS.editor.swapEnterKeys).toBe(true);
  });

  it('旧版 v1 且未勾选 Enter 互换的用户设置会一次性迁移为勾选并升级至 v2', () => {
    const legacy: Settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      schemaVersion: 1,
      editor: { ...DEFAULT_SETTINGS.editor, swapEnterKeys: false },
    };

    const result = migrateSettings(legacy);
    expect(result.migrated).toBe(true);
    expect(result.settings.schemaVersion).toBe(CURRENT_SETTINGS_SCHEMA_VERSION);
    expect(result.settings.editor.swapEnterKeys).toBe(true);
  });

  it('缺失 schemaVersion 的极旧设置同样会迁移为勾选 Enter 互换', () => {
    const legacy = structuredClone(DEFAULT_SETTINGS) as Partial<Settings> as Settings;
    delete (legacy as Partial<Settings>).schemaVersion;
    legacy.editor.swapEnterKeys = false;

    const result = migrateSettings(legacy);
    expect(result.migrated).toBe(true);
    expect(result.settings.schemaVersion).toBe(CURRENT_SETTINGS_SCHEMA_VERSION);
    expect(result.settings.editor.swapEnterKeys).toBe(true);
  });

  it('已升级至 v2 后用户手动取消勾选，再次加载不会被重新覆盖', () => {
    const v2OptOut: Settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
      editor: { ...DEFAULT_SETTINGS.editor, swapEnterKeys: false },
    };

    const result = migrateSettings(v2OptOut);
    expect(result.migrated).toBe(false);
    expect(result.settings.schemaVersion).toBe(CURRENT_SETTINGS_SCHEMA_VERSION);
    expect(result.settings.editor.swapEnterKeys).toBe(false);
  });

  it('settingsStore.init 收到未迁移的 v1 设置时自动迁移并写回持久化', async () => {
    const legacy: Settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      schemaVersion: 1,
      editor: { ...DEFAULT_SETTINGS.editor, swapEnterKeys: false },
    };

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
    expect(current.editor.swapEnterKeys).toBe(true);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
      editor: expect.objectContaining({ swapEnterKeys: true }),
    }));
  });
});
