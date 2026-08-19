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

      <div style={{ margin: '16px 0 8px', fontWeight: 600, fontSize: 13, color: 'var(--accent-strong)' }}>
        自动保存设置（关闭时使用 Ctrl+S 手动保存，关闭未保存标签页时将提示确认）
      </div>

      {/* Markdown 笔记自动保存 */}
      <div style={rowStyle}>
        <span style={labelStyle}>Markdown 自动保存</span>
        <input
          type="checkbox"
          checked={settings.file.autoSaveMarkdown ?? false}
          onChange={(e) => setFile({ autoSaveMarkdown: e.target.checked })}
        />
      </div>

      {/* 自由画板自动保存 */}
      <div style={rowStyle}>
        <span style={labelStyle}>自由画板自动保存</span>
        <input
          type="checkbox"
          checked={settings.file.autoSaveBoard ?? false}
          onChange={(e) => setFile({ autoSaveBoard: e.target.checked })}
        />
      </div>

      {/* 代码与文本文档自动保存 */}
      <div style={rowStyle}>
        <span style={labelStyle}>代码与文本自动保存</span>
        <input
          type="checkbox"
          checked={settings.file.autoSaveOther ?? false}
          onChange={(e) => setFile({ autoSaveOther: e.target.checked })}
        />
      </div>

      <div style={{ margin: '16px 0 8px', fontWeight: 600, fontSize: 13, color: 'var(--accent-strong)' }}>
        通用文件设置
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
