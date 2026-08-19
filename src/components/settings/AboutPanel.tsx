// NoteBoard 关于面板
// 版本、GPL-3.0、第三方致谢、仓库链接、配置损坏告警位
// 详见 docs/09-开发路线图.md 12.9

import { useState } from 'react';
import { RefreshCw, ExternalLink } from 'lucide-react';
import { getRegisteredShortcuts } from '../../core/shortcuts';
import * as ipc from '../../core/ipc/commands';
import type { UpdateCheckResult } from '../../core/ipc/types';
import { translateUpdateCheckError } from '../../core/updates';
import { UpdateModal } from '../UpdateModal';

export function AboutPanel() {
  const [version] = useState('0.1.0');
  const shortcuts = getRegisteredShortcuts();

  // 更新检测状态与弹窗控制
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  // 执行检查更新逻辑
  const handleCheckForUpdates = async () => {
    try {
      setCheckingUpdate(true);
      setCheckError(null);
      setUpdateResult(null);
      setUpdateModalOpen(true);
      const res = await ipc.checkForUpdates();
      setUpdateResult(res);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setCheckError(translateUpdateCheckError(msg));
    } finally {
      setCheckingUpdate(false);
    }
  };

  // 在系统默认浏览器打开 GitHub 仓库
  const handleOpenGithub = () => {
    ipc.openExternalUrl('https://github.com/CrazyFigure/NoteBoard').catch((err) => {
      console.error('无法打开 GitHub 链接:', err);
    });
  };

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
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <span>版本: v{version}</span>
          <button
            type="button"
            disabled={checkingUpdate}
            onClick={handleCheckForUpdates}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '3px 10px',
              fontSize: 12,
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--editor-border)',
              background: 'var(--editor-surface)',
              color: 'var(--accent-strong)',
              cursor: checkingUpdate ? 'not-allowed' : 'pointer',
              fontWeight: 500,
              boxShadow: 'var(--shadow-sm)',
              transition: 'all var(--transition-fast)',
            }}
            onMouseEnter={(e) => {
              if (!checkingUpdate) {
                e.currentTarget.style.background = 'var(--toolbar-hover)';
                e.currentTarget.style.borderColor = 'var(--editor-border-focus)';
                e.currentTarget.style.transform = 'translateY(-1px)';
                e.currentTarget.style.boxShadow = 'var(--shadow-md)';
              }
            }}
            onMouseLeave={(e) => {
              if (!checkingUpdate) {
                e.currentTarget.style.background = 'var(--editor-surface)';
                e.currentTarget.style.borderColor = 'var(--editor-border)';
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.boxShadow = 'var(--shadow-sm)';
              }
            }}
            onMouseDown={(e) => {
              if (!checkingUpdate) {
                e.currentTarget.style.background = 'var(--toolbar-active)';
                e.currentTarget.style.transform = 'translateY(0) scale(0.96)';
              }
            }}
            onMouseUp={(e) => {
              if (!checkingUpdate) {
                e.currentTarget.style.background = 'var(--toolbar-hover)';
                e.currentTarget.style.transform = 'translateY(-1px)';
              }
            }}
          >
            <RefreshCw size={12} className={checkingUpdate ? 'spin' : ''} style={checkingUpdate ? { animation: 'spin 1s linear infinite' } : undefined} />
            <span>{checkingUpdate ? '正在检查...' : '检测更新'}</span>
          </button>
        </div>
        <p style={{ margin: '4px 0' }}>许可证: GPL-3.0</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '4px 0' }}>
          <span>开源仓库:</span>
          <button
            type="button"
            onClick={handleOpenGithub}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: 0,
              border: 'none',
              background: 'transparent',
              color: 'var(--accent-strong)',
              fontSize: 13,
              cursor: 'pointer',
              textDecoration: 'underline',
              transition: 'all var(--transition-fast)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'scale(1.03)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'scale(1)';
            }}
            onMouseDown={(e) => {
              e.currentTarget.style.transform = 'scale(0.96)';
            }}
            onMouseUp={(e) => {
              e.currentTarget.style.transform = 'scale(1.03)';
            }}
          >
            <span>CrazyFigure/NoteBoard</span>
            <ExternalLink size={13} />
          </button>
        </div>
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

      {/* 更新弹窗 */}
      <UpdateModal
        isOpen={updateModalOpen}
        onClose={() => setUpdateModalOpen(false)}
        result={updateResult}
        checkError={checkError}
        checking={checkingUpdate}
        onRecheck={handleCheckForUpdates}
      />
    </div>
  );
}
