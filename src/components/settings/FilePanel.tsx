// NoteBoard 文件面板
// forceManualSave、显示隐藏文件、恢复会话、图片目录名、大文件阈值
// 详见 docs/09-开发路线图.md 12.7

import { useSettingsStore } from '../../stores/settingsStore';

export function FilePanel() {
  const settings = useSettingsStore((s) => s.settings);
  const setFile = useSettingsStore((s) => s.setFile);

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
    fontSize: 13,
  };

  const labelStyle: React.CSSProperties = { width: 140, flexShrink: 0 };

  return (
    <div>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>文件</h2>

      {/* 强制手动保存 */}
      <div style={rowStyle}>
        <span style={labelStyle}>强制手动保存</span>
        <input
          type="checkbox"
          checked={settings.file.forceManualSave}
          onChange={(e) => setFile({ forceManualSave: e.target.checked })}
        />
      </div>

      {/* 显示隐藏文件 */}
      <div style={rowStyle}>
        <span style={labelStyle}>显示隐藏文件</span>
        <input
          type="checkbox"
          checked={settings.file.showHiddenFiles}
          onChange={(e) => setFile({ showHiddenFiles: e.target.checked })}
        />
      </div>

      {/* 恢复会话 */}
      <div style={rowStyle}>
        <span style={labelStyle}>启动时恢复会话</span>
        <input
          type="checkbox"
          checked={settings.file.restoreSession}
          onChange={(e) => setFile({ restoreSession: e.target.checked })}
        />
      </div>

      {/* 图片目录名 */}
      <div style={rowStyle}>
        <span style={labelStyle}>图片目录名</span>
        <input
          type="text"
          value={settings.file.imageDirName}
          onChange={(e) => setFile({ imageDirName: e.target.value })}
          style={inputStyle}
        />
      </div>

      {/* 大文件阈值 */}
      <div style={rowStyle}>
        <span style={labelStyle}>大文件阈值 (MB)</span>
        <input
          type="number"
          min="1"
          max="500"
          value={Math.round(settings.file.largeFileConfirmMb)}
          onChange={(e) => {
            const mb = parseInt(e.target.value, 10) || 50;
            setFile({ largeFileConfirmMb: mb });
          }}
          style={{ ...inputStyle, width: 60 }}
        />
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '4px 8px',
  fontSize: 13,
  border: '1px solid var(--editor-border)',
  borderRadius: 3,
  background: 'var(--editor-surface)',
  color: 'var(--editor-text)',
  outline: 'none',
  flex: 1,
  maxWidth: 200,
};
