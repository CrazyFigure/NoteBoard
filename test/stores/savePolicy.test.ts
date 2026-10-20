// NoteBoard 自动保存策略判定测试
// 验证信息图有独立开关，未单独设置时沿用「代码与文本」开关

import { afterEach, describe, expect, it } from 'vitest';
import { resolveSavePolicy } from '../../src/stores/documentStore';
import { useSettingsStore } from '../../src/stores/settingsStore';
import type { FileSettings } from '../../src/core/ipc/types';

const initialSettings = useSettingsStore.getState().settings;

/** 覆盖文件设置中的自动保存开关 */
function setFileSettings(patch: Partial<FileSettings>): void {
  useSettingsStore.setState({ settings: { ...initialSettings, file: { ...initialSettings.file, ...patch } } });
}

describe('resolveSavePolicy', () => {
  afterEach(() => {
    useSettingsStore.setState({ settings: initialSettings });
  });

  it('信息图未单独设置时沿用代码与文本开关', () => {
    setFileSettings({ autoSaveOther: true, autoSaveInfographic: undefined });
    expect(resolveSavePolicy('code', 'infographic')).toBe('auto');
    setFileSettings({ autoSaveOther: false, autoSaveInfographic: undefined });
    expect(resolveSavePolicy('code', 'infographic')).toBe('manual');
  });

  it('信息图开关与代码与文本开关互不影响', () => {
    setFileSettings({ autoSaveOther: false, autoSaveInfographic: true });
    expect(resolveSavePolicy('code', 'infographic')).toBe('auto');
    expect(resolveSavePolicy('code', 'sql')).toBe('manual');

    setFileSettings({ autoSaveOther: true, autoSaveInfographic: false });
    expect(resolveSavePolicy('code', 'infographic')).toBe('manual');
    expect(resolveSavePolicy('code', 'json')).toBe('auto');
  });

  it('自由画板只受画板开关控制', () => {
    setFileSettings({ autoSaveBoard: true, autoSaveOther: false });
    expect(resolveSavePolicy('board', 'plaintext')).toBe('auto');
  });
});
