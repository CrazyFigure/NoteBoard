// NoteBoard 关于面板
// 版本、GPL-3.0、第三方致谢、仓库链接、配置损坏告警位
// 详见 docs/09-开发路线图.md 12.9

import { useState, useEffect } from 'react';
import { getRegisteredShortcuts } from '../../core/shortcuts';

export function AboutPanel() {
  const [version] = useState('0.1.0');
  const shortcuts = getRegisteredShortcuts();

  const sectionStyle: React.CSSProperties = {
    marginBottom: 24,
  fontSize: 13,
    lineHeight: 1.8,
  color: 'var(--editor-text)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  overflowWrap: 'break-word',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  maxWidth: '100%',
  width: '100%',
  boxSizing: 'border-box',
    padding: '0 8px',
  };

  const headingStyle: React.CSSProperties = {
    fontSize: 14,
    marginBottom: 8,
    marginTop: 0,
  };

  const listStyle: React.CSSProperties = {
    margin: 0,
    padding: 0,
    listStyle: 'none',
    fontSize: 13,
    lineHeight: 1.8,
  };

  return (
    <div>
      <h2 style={headingStyle}>关于 NoteBoard</h2>

      <div style={sectionStyle}>
        <p>版本: {version}</p>
        <p>许可证: GPL-3.0</p>
        <p>仓库: https://github.com/your-org/noteboard</p>
      </div>

      {/* 第三方致谢 */}
      <div style={sectionStyle}>
        <h3 style={headingStyle}>第三方致谢</h3>
        <ul style={listStyle}>
          <li>• note-gen — TipTap Markdown 编辑器灵感来源</li>
          <li>• TMD (Taolang Markdown) — 主题配色方案</li>
          <li>• Excalidraw — 画板组件</li>
          <li>• TipTap — 富文本编辑框架</li>
          <li>• CodeMirror 6 — 代码编辑器</li>
          <li>• Tauri — 桌面应用框架</li>
        </ul>
      </div>

      {/* 快捷键列表 */}
      <div style={sectionStyle}>
        <h3 style={headingStyle}>快捷键（只读）</h3>
        <div style={{ fontSize: 12, color: 'var(--editor-text-muted)' }}>
          {shortcuts.map((s: { key: string; description: string }) => (
            <div key={s.key} style={{ display: 'flex', gap: 12, marginBottom: 4 }}>
              <code style={{ minWidth: 120 }}>{s.key}</code>
              <span>{s.description}</span>
            </div>
          ))}
        </div>
      </div>

      {/* 配置损坏告警位 */}
      <div style={sectionStyle}>
        <h3 style={headingStyle}>配置</h3>
        <p style={{ fontSize: 12, color: 'var(--editor-text-muted)' }}>
          如果设置无法正常保存，可能是配置文件损坏。
          删除 settings.json 后重启应用可恢复默认设置。
        </p>
      </div>
    </div>
  );
}
