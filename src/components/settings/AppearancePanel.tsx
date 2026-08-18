// NoteBoard 外观面板
// 主题选择 + 跟随系统 + UI 缩放
// 详见 docs/09-开发路线图.md 12.2

import { useSettingsStore } from '../../stores/settingsStore';

export function AppearancePanel() {
  const settings = useSettingsStore((s) => s.settings);
  const setThemeMode = useSettingsStore((s) => s.setThemeMode);
  const setSystemLightTheme = useSettingsStore((s) => s.setSystemLightTheme);
  const setSystemDarkTheme = useSettingsStore((s) => s.setSystemDarkTheme);

  const themes: { id: string; label: string; preview: string }[] = [
    { id: 'chen-guang', label: '晨光', preview: '#fffef7' },
    { id: 'hu-po', label: '琥珀', preview: '#fffbf0' },
    { id: 'mo-ye', label: '墨夜', preview: '#1e1e1e' },
  ];

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
    fontSize: 13,
  };

  const labelStyle: React.CSSProperties = { width: 100, flexShrink: 0 };

  return (
    <div>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>外观</h2>

      {/* 主题模式 */}
      <div style={rowStyle}>
        <span style={labelStyle}>主题模式</span>
        <select
          value={settings.appearance.themeMode}
          onChange={(e) => setThemeMode(e.target.value as 'system' | 'chen-guang' | 'hu-po' | 'mo-ye')}
          style={selectStyle}
        >
          <option value="system">跟随系统</option>
          <option value="chen-guang">始终晨光</option>
          <option value="hu-po">始终琥珀</option>
          <option value="mo-ye">始终墨夜</option>
        </select>
      </div>

      {/* 系统浅色主题 */}
      {settings.appearance.themeMode === 'system' && (
        <div style={rowStyle}>
          <span style={labelStyle}>系统浅色时</span>
          <select
            value={settings.appearance.systemLightTheme}
            onChange={(e) => setSystemLightTheme(e.target.value as 'chen-guang' | 'hu-po')}
            style={selectStyle}
          >
            <option value="chen-guang">晨光</option>
            <option value="hu-po">琥珀</option>
          </select>
        </div>
      )}

      {/* 系统深色主题 */}
      {settings.appearance.themeMode === 'system' && (
        <div style={rowStyle}>
          <span style={labelStyle}>系统深色时</span>
          <select
            value={settings.appearance.systemDarkTheme}
            onChange={(e) => setSystemDarkTheme(e.target.value as 'mo-ye')}
            style={selectStyle}
          >
            <option value="mo-ye">墨夜</option>
          </select>
        </div>
      )}

      {/* 主题预览 */}
      <div style={rowStyle}>
        <span style={labelStyle}>可用主题</span>
        <div style={{ display: 'flex', gap: 8 }}>
          {themes.map((t) => (
            <div
              key={t.id}
              style={{
                width: 48,
                height: 48,
                borderRadius: 6,
                background: t.preview,
                border: '2px solid var(--editor-border)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 11,
                color: t.id === 'mo-ye' ? '#fff' : '#333',
              }}
            >
              {t.label}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  padding: '4px 8px',
  fontSize: 13,
  border: '1px solid var(--editor-border)',
  borderRadius: 3,
  background: 'var(--editor-surface)',
  color: 'var(--editor-text)',
  outline: 'none',
};
