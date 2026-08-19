// NoteBoard 编辑器面板
// 默认视图模式、软换行、行号、缩进、渲染增强开关、块把手开关
// 详见 docs/09-开发路线图.md 12.6

import { useSettingsStore } from '../../stores/settingsStore';

export function EditorPanel() {
  const settings = useSettingsStore((s) => s.settings);
  const setEditor = useSettingsStore((s) => s.setEditor);

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
      <h2 style={{ fontSize: 16, marginTop: 0 }}>编辑器</h2>

      {/* 默认视图模式 */}
      <div style={rowStyle}>
        <span style={labelStyle}>默认视图模式</span>
        <select
          value={settings.editor.defaultViewMode}
          onChange={(e) => setEditor({ defaultViewMode: e.target.value as 'visual' | 'source' })}
          style={selectStyle}
        >
          <option value="visual">可视化</option>
          <option value="source">源码</option>
        </select>
      </div>

      <div style={{ margin: '16px 0 8px', fontWeight: 600, fontSize: 13, color: 'var(--accent-strong)' }}>
        代码与纯文本展示 (.sql / .txt / .json 等)
      </div>

      {/* 显示空格（显示为点） */}
      <div style={rowStyle}>
        <span style={labelStyle}>显示空格（点）</span>
        <input
          type="checkbox"
          checked={settings.editor.showWhitespace ?? false}
          onChange={(e) => setEditor({ showWhitespace: e.target.checked })}
        />
      </div>

      {/* 显示换行符（↵） */}
      <div style={rowStyle}>
        <span style={labelStyle}>显示换行符 (↵)</span>
        <input
          type="checkbox"
          checked={settings.editor.showLineEndings ?? false}
          onChange={(e) => setEditor({ showLineEndings: e.target.checked })}
        />
      </div>

      {/* 软换行 */}
      <div style={rowStyle}>
        <span style={labelStyle}>软换行</span>
        <input
          type="checkbox"
          checked={settings.editor.softWrap}
          onChange={(e) => setEditor({ softWrap: e.target.checked })}
        />
      </div>

      {/* 行号 */}
      <div style={rowStyle}>
        <span style={labelStyle}>显示行号</span>
        <input
          type="checkbox"
          checked={settings.editor.showLineNumbers}
          onChange={(e) => setEditor({ showLineNumbers: e.target.checked })}
        />
      </div>

      {/* 缩进导线 */}
      <div style={rowStyle}>
        <span style={labelStyle}>缩进导线</span>
        <input
          type="checkbox"
          checked={settings.editor.showIndentGuides}
          onChange={(e) => setEditor({ showIndentGuides: e.target.checked })}
        />
      </div>

      {/* Tab 大小 */}
      <div style={rowStyle}>
        <span style={labelStyle}>Tab 大小</span>
        <input
          type="number"
          min="1"
          max="8"
          value={settings.editor.tabSize}
          onChange={(e) => setEditor({ tabSize: parseInt(e.target.value, 10) || 2 })}
          style={{ ...inputStyle, width: 60 }}
        />
      </div>

      {/* 用空格代替 Tab */}
      <div style={rowStyle}>
        <span style={labelStyle}>空格代替 Tab</span>
        <input
          type="checkbox"
          checked={settings.editor.insertSpaces}
          onChange={(e) => setEditor({ insertSpaces: e.target.checked })}
        />
      </div>

      <div style={{ margin: '16px 0 8px', fontWeight: 600, fontSize: 13, color: 'var(--accent-strong)' }}>
        Markdown 渲染增强
      </div>

      {/* 渲染增强开关 */}
      <div style={rowStyle}>
        <span style={labelStyle}>数学公式</span>
        <input
          type="checkbox"
          checked={settings.editor.enableMath}
          onChange={(e) => setEditor({ enableMath: e.target.checked })}
        />
      </div>

      <div style={rowStyle}>
        <span style={labelStyle}>Mermaid 图表</span>
        <input
          type="checkbox"
          checked={settings.editor.enableMermaid}
          onChange={(e) => setEditor({ enableMermaid: e.target.checked })}
        />
      </div>

      <div style={rowStyle}>
        <span style={labelStyle}>块把手</span>
        <input
          type="checkbox"
          checked={settings.editor.enableBlockHandle}
          onChange={(e) => setEditor({ enableBlockHandle: e.target.checked })}
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
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  width: 120,
};
