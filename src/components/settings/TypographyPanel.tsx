// NoteBoard 排版面板
// 正文/等宽字体族、字号、行高、内容宽度
// 实时预览 + CSS 变量注入
// 详见 docs/09-开发路线图.md 12.3-12.5

import { useSettingsStore } from '../../stores/settingsStore';
import { applyTypography } from '../../core/theme/applyTheme';

export function TypographyPanel() {
  const settings = useSettingsStore((s) => s.settings);

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
    fontSize: 13,
  };

  const labelStyle: React.CSSProperties = { width: 120, flexShrink: 0 };

  return (
    <div>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>排版</h2>

      {/* 正文字体族 */}
      <div style={rowStyle}>
        <span style={labelStyle}>正文字体</span>
        <input
          type="text"
          value={settings.typography.contentFontFamily}
          onChange={(e) => {
            useSettingsStore.getState().setTypography({ contentFontFamily: e.target.value });
            applyTypography({ ...settings.typography, contentFontFamily: e.target.value });
          }}
          placeholder="留空使用默认"
          style={inputStyle}
        />
      </div>

      {/* 等宽字体族 */}
      <div style={rowStyle}>
        <span style={labelStyle}>等宽字体</span>
        <input
          type="text"
          value={settings.typography.monoFontFamily}
          onChange={(e) => {
            useSettingsStore.getState().setTypography({ monoFontFamily: e.target.value });
            applyTypography({ ...settings.typography, monoFontFamily: e.target.value });
          }}
          style={inputStyle}
        />
      </div>

      {/* 正文字号 */}
      <div style={rowStyle}>
        <span style={labelStyle}>正文字号</span>
        <input
          type="number"
          min="12"
          max="24"
          value={settings.typography.contentFontSize}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10) || 16;
            useSettingsStore.getState().setTypography({ contentFontSize: v });
            applyTypography({ ...settings.typography, contentFontSize: v });
          }}
          style={{ ...inputStyle, width: 60 }}
        />
        <span style={{ color: 'var(--editor-text-muted)' }}>px</span>
      </div>

      {/* 等宽字号 */}
      <div style={rowStyle}>
        <span style={labelStyle}>等宽字号</span>
        <input
          type="number"
          min="10"
          max="20"
          value={settings.typography.monoFontSize}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10) || 14;
            useSettingsStore.getState().setTypography({ monoFontSize: v });
            applyTypography({ ...settings.typography, monoFontSize: v });
          }}
          style={{ ...inputStyle, width: 60 }}
        />
        <span style={{ color: 'var(--editor-text-muted)' }}>px</span>
      </div>

      {/* 行高 */}
      <div style={rowStyle}>
        <span style={labelStyle}>行高</span>
        <input
          type="range"
          min="1.2"
          max="2.4"
          step="0.1"
          value={settings.typography.contentLineHeight}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            useSettingsStore.getState().setTypography({ contentLineHeight: v });
            applyTypography({ ...settings.typography, contentLineHeight: v });
          }}
          style={{ flex: 1, maxWidth: 200 }}
        />
        <span style={{ width: 30 }}>{settings.typography.contentLineHeight.toFixed(1)}</span>
      </div>

      {/* 内容宽度 */}
      <div style={rowStyle}>
        <span style={labelStyle}>内容宽度</span>
        <select
          value={settings.typography.contentWidth}
          onChange={(e) => {
            const v = e.target.value as 'narrow' | 'standard' | 'wide' | 'full';
            useSettingsStore.getState().setTypography({ contentWidth: v });
            applyTypography({ ...settings.typography, contentWidth: v });
          }}
          style={selectStyle}
        >
          <option value="narrow">窄 (65%)</option>
          <option value="standard">标准 (80%)</option>
          <option value="wide">宽屏 (92%)</option>
          <option value="full">全宽 (100%)</option>
        </select>
      </div>

      {/* 实时预览 */}
      <div style={{ marginTop: 24 }}>
        <h3 style={{ fontSize: 14, marginBottom: 8 }}>预览</h3>
        <div
          style={{
            padding: '16px 24px',
            background: 'var(--editor-surface)',
            border: '1px solid var(--editor-border)',
            borderRadius: 6,
            fontFamily: settings.typography.contentFontFamily || 'var(--content-font-family)',
            fontSize: settings.typography.contentFontSize,
            lineHeight: settings.typography.contentLineHeight,
            maxWidth: 'var(--content-max-width)',
          }}
        >
          <p>这是正文内容，用于预览排版设置。</p>
          <p>
            包含<code style={{ fontFamily: settings.typography.monoFontFamily, fontSize: settings.typography.monoFontSize }}>行内代码</code>的段落。
          </p>
          <pre style={{ fontFamily: settings.typography.monoFontFamily, fontSize: settings.typography.monoFontSize, background: 'var(--cm-gutter-background)', padding: 8, borderRadius: 4 }}>
            <code>{'const x = 42;\nconsole.log(x);'}</code>
          </pre>
        </div>
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

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  maxWidth: 120,
};
