// NoteBoard 排版面板
// 正文/代码/文件树字体族、字号、行高、内容宽度
// 实时预览 + CSS 变量注入
// 详见 docs/09-开发路线图.md 12.3-12.5

import { useSettingsStore } from '../../stores/settingsStore';
import { applyTypography, contentWidthToPercent, CONTENT_WIDTH_PERCENT_MAP } from '../../core/theme/applyTheme';

export function TypographyPanel() {
  const settings = useSettingsStore((s) => s.settings);

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    marginBottom: 12,
    fontSize: 13,
  };

  const labelStyle: React.CSSProperties = { width: 130, flexShrink: 0, fontWeight: 500 };
  const sectionTitleStyle: React.CSSProperties = { fontSize: 14, fontWeight: 600, margin: '16px 0 10px', color: 'var(--editor-heading)' };

  return (
    <div style={{ paddingBottom: 20 }}>
      <h2 style={{ fontSize: 16, marginTop: 0, marginBottom: 16 }}>排版设置</h2>

      {/* ── 1. 编辑区域宽度 ── */}
      <div style={sectionTitleStyle}>1. 编辑区域宽度 (全局版心)</div>

      {/* 内容宽度 */}
      <div style={{ ...rowStyle, alignItems: 'flex-start' }}>
        <span style={{ ...labelStyle, marginTop: 4 }}>版心最大宽度</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, maxWidth: 260 }}>
          <select
            value={['narrow', 'standard', 'wide', 'full'].includes(settings.typography.contentWidth) ? settings.typography.contentWidth : 'custom'}
            onChange={(e) => {
              const v = e.target.value;
              if (v !== 'custom') {
                useSettingsStore.getState().setTypography({ contentWidth: v });
                applyTypography({ ...settings.typography, contentWidth: v });
              }
            }}
            style={selectStyle}
          >
            <option value="narrow">窄 (65%)</option>
            <option value="standard">标准 (80%)</option>
            <option value="wide">宽屏 (92%)</option>
            <option value="full">全宽 (100%)</option>
            {!['narrow', 'standard', 'wide', 'full'].includes(settings.typography.contentWidth) && (
              <option value="custom">自定义 ({contentWidthToPercent(settings.typography.contentWidth)}%)</option>
            )}
          </select>
          {/* 滑动条自定义宽度调节 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input
              type="range"
              min="40"
              max="100"
              step="1"
              value={contentWidthToPercent(settings.typography.contentWidth)}
              onChange={(e) => {
                const val = `${e.target.value}%`;
                useSettingsStore.getState().setTypography({ contentWidth: val });
                applyTypography({ ...settings.typography, contentWidth: val });
              }}
              style={{ flex: 1, cursor: 'pointer' }}
            />
            <span style={{ width: 35, fontSize: 12, color: 'var(--editor-text-muted)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
              {contentWidthToPercent(settings.typography.contentWidth)}%
            </span>
          </div>
        </div>
      </div>

      {/* ── 2. 软件界面 UI 排版 ── */}
      <div style={sectionTitleStyle}>2. 软件界面 UI 排版 (全局界面 / 弹窗 / 提示 / 菜单)</div>

      {/* 界面 UI 字体 */}
      <div style={rowStyle}>
        <span style={labelStyle}>界面 UI 字体</span>
        <input
          type="text"
          value={settings.typography.uiFontFamily ?? ''}
          onChange={(e) => {
            useSettingsStore.getState().setTypography({ uiFontFamily: e.target.value });
            applyTypography({ ...settings.typography, uiFontFamily: e.target.value });
          }}
          placeholder="留空使用系统默认界面字体"
          style={inputStyle}
        />
      </div>

      {/* 界面 UI 字号 */}
      <div style={rowStyle}>
        <span style={labelStyle}>界面 UI 基础字号</span>
        <input
          type="range"
          min="12"
          max="18"
          step="1"
          value={settings.typography.uiFontSize ?? 13}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10) || 13;
            useSettingsStore.getState().setTypography({ uiFontSize: v });
            applyTypography({ ...settings.typography, uiFontSize: v });
          }}
          style={{ flex: 1, maxWidth: 200 }}
        />
        <span style={{ width: 30 }}>{settings.typography.uiFontSize ?? 13}px</span>
      </div>

      {/* ── 3. Markdown 正文排版 ── */}
      <div style={sectionTitleStyle}>3. Markdown 正文排版</div>

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
          placeholder="留空使用系统默认"
          style={inputStyle}
        />
      </div>

      {/* 正文字号 */}
      <div style={rowStyle}>
        <span style={labelStyle}>正文字号</span>
        <input
          type="number"
          min="12"
          max="26"
          value={settings.typography.contentFontSize}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10) || 16;
            useSettingsStore.getState().setTypography({ contentFontSize: v });
            applyTypography({ ...settings.typography, contentFontSize: v });
          }}
          style={{ ...inputStyle, width: 70 }}
        />
        <span style={{ color: 'var(--editor-text-muted)' }}>px</span>
      </div>

      {/* 正文行高 */}
      <div style={rowStyle}>
        <span style={labelStyle}>正文行高</span>
        <input
          type="range"
          min="1.3"
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

      {/* ── 4. 代码与纯文本排版 ── */}
      <div style={sectionTitleStyle}>4. 代码与纯文本排版 (.sql / .txt / .json 等)</div>

      {/* 等宽字体族 */}
      <div style={rowStyle}>
        <span style={labelStyle}>代码等宽字体</span>
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

      {/* 等宽字号 */}
      <div style={rowStyle}>
        <span style={labelStyle}>代码字号</span>
        <input
          type="number"
          min="10"
          max="24"
          value={settings.typography.monoFontSize ?? 14}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10) || 14;
            useSettingsStore.getState().setTypography({ monoFontSize: v });
            applyTypography({ ...settings.typography, monoFontSize: v });
          }}
          style={{ ...inputStyle, width: 70 }}
        />
        <span style={{ color: 'var(--editor-text-muted)' }}>px (支持 Ctrl+滚轮)</span>
      </div>

      {/* 代码行高 */}
      <div style={rowStyle}>
        <span style={labelStyle}>代码行高</span>
        <input
          type="range"
          min="1.2"
          max="2.2"
          step="0.1"
          value={settings.typography.monoLineHeight ?? 1.5}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            useSettingsStore.getState().setTypography({ monoLineHeight: v });
            applyTypography({ ...settings.typography, monoLineHeight: v });
          }}
          style={{ flex: 1, maxWidth: 200 }}
        />
        <span style={{ width: 30 }}>{(settings.typography.monoLineHeight ?? 1.5).toFixed(1)}</span>
      </div>

      {/* ── 5. 文件树排版 ── */}
      <div style={sectionTitleStyle}>5. 文件树排版 (左侧资源管理器)</div>

      {/* 文件树字体族 */}
      <div style={rowStyle}>
        <span style={labelStyle}>文件树字体</span>
        <input
          type="text"
          value={settings.typography.explorerFontFamily ?? ''}
          onChange={(e) => {
            useSettingsStore.getState().setTypography({ explorerFontFamily: e.target.value });
            applyTypography({ ...settings.typography, explorerFontFamily: e.target.value });
          }}
          placeholder="留空使用系统默认"
          style={inputStyle}
        />
      </div>

      {/* 文件树字号 */}
      <div style={rowStyle}>
        <span style={labelStyle}>文件树字号</span>
        <input
          type="number"
          min="11"
          max="18"
          value={settings.typography.explorerFontSize ?? 13}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10) || 13;
            useSettingsStore.getState().setTypography({ explorerFontSize: v });
            applyTypography({ ...settings.typography, explorerFontSize: v });
          }}
          style={{ ...inputStyle, width: 70 }}
        />
        <span style={{ color: 'var(--editor-text-muted)' }}>px (支持 Ctrl+滚轮)</span>
      </div>

      {/* 目录条目行高 */}
      <div style={rowStyle}>
        <span style={labelStyle}>目录条目高度</span>
        <input
          type="number"
          min="20"
          max="36"
          value={settings.typography.explorerLineHeight ?? 24}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10) || 24;
            useSettingsStore.getState().setTypography({ explorerLineHeight: v });
            applyTypography({ ...settings.typography, explorerLineHeight: v });
          }}
          style={{ ...inputStyle, width: 70 }}
        />
        <span style={{ color: 'var(--editor-text-muted)' }}>px</span>
      </div>

      {/* 实时预览 */}
      <div style={{ marginTop: 24 }}>
        <h3 style={{ fontSize: 14, marginBottom: 8 }}>排版效果预览</h3>
        <div
          style={{
            padding: '16px 20px',
            background: 'var(--editor-surface)',
            border: '1px solid var(--editor-border)',
            borderRadius: 6,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          {/* 界面 UI 预览 */}
          <div
            style={{
              fontFamily: settings.typography.uiFontFamily || 'var(--ui-font-family)',
              fontSize: settings.typography.uiFontSize ?? 13,
              padding: '8px 12px',
              background: 'var(--editor-bg)',
              border: '1px solid var(--editor-border)',
              borderRadius: 4,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span style={{ fontWeight: 600 }}>软件界面 UI 预览 · 提示文本</span>
            <span style={{ padding: '2px 6px', background: 'var(--editor-selection)', color: 'var(--accent-strong)', borderRadius: 3, fontSize: '0.9em' }}>
              按钮示例
            </span>
          </div>

          {/* 正文预览 */}
          <div
            style={{
              fontFamily: settings.typography.contentFontFamily || 'var(--content-font-family)',
              fontSize: settings.typography.contentFontSize,
              lineHeight: settings.typography.contentLineHeight,
            }}
          >
            <p style={{ margin: 0 }}>
              Markdown 正文效果，包含 <code style={{ fontFamily: settings.typography.monoFontFamily, fontSize: '0.9em', background: 'var(--code-inline-bg)', padding: '2px 4px', borderRadius: 3 }}>code</code> 行内代码。
            </p>
          </div>

          {/* 代码预览 */}
          <pre
            style={{
              margin: 0,
              fontFamily: settings.typography.monoFontFamily,
              fontSize: settings.typography.monoFontSize ?? 14,
              lineHeight: settings.typography.monoLineHeight ?? 1.5,
              background: 'var(--cm-gutter-background)',
              padding: '8px 12px',
              borderRadius: 4,
            }}
          >
            <code>{'SELECT id, title FROM notes;\nconst status = "ok";'}</code>
          </pre>

          {/* 文件树条目预览 */}
          <div
            style={{
              height: settings.typography.explorerLineHeight ?? 24,
              fontSize: settings.typography.explorerFontSize ?? 13,
              fontFamily: settings.typography.explorerFontFamily || 'inherit',
              display: 'flex',
              alignItems: 'center',
              padding: '0 8px',
              background: 'var(--explorer-active)',
              borderLeft: '2px solid var(--accent-strong)',
              borderRadius: 3,
            }}
          >
            📁 示例文档.md
          </div>
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
