// NoteBoard 文件面板
// forceManualSave、显示隐藏文件、恢复会话、图片目录名、大文件阈值
// 详见 docs/09-开发路线图.md 12.7

import { useSettingsStore } from '../../stores/settingsStore';
import { open } from '@tauri-apps/plugin-dialog';
import * as ipc from '../../core/ipc/commands';
import { showToast } from '../../stores/toastStore';

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

  /** 通过系统目录选择器更新暂存位置，取消选择时保持现有设置。 */
  const chooseStagingDirectory = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === 'string') await setFile({ stagingDirectory: selected });
  };

  /** 恢复内置默认目录，避免在前端拼接平台相关路径。 */
  const resetStagingDirectory = async () => {
    const defaultDirectory = await ipc.getDefaultStagingDirectory();
    await setFile({ stagingDirectory: defaultDirectory });
  };

  /** 设置页中的“打开”使用系统文件管理器，便于直接复制或整理暂存文件。 */
  const revealStagingDirectory = async () => {
    try {
      await ipc.openStagingDirectory();
    } catch (error) {
      showToast(`无法打开暂存区：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  };

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

      {/* 暂存目录：只读展示，使用目录选择器避免手工输入无效路径。 */}
      <div style={{ ...rowStyle, alignItems: 'flex-start' }}>
        <span style={{ ...labelStyle, paddingTop: 5 }}>暂存位置</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
          <input
            type="text"
            readOnly
            value={settings.file.stagingDirectory ?? ''}
            title={settings.file.stagingDirectory ?? ''}
            style={{ ...inputStyle, maxWidth: 360, width: '100%' }}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="nb-btn-secondary" onClick={chooseStagingDirectory}>选择位置…</button>
            <button type="button" className="nb-btn-secondary" onClick={resetStagingDirectory}>恢复默认</button>
            <button type="button" className="nb-btn-secondary" onClick={revealStagingDirectory}>打开</button>
          </div>
          <span style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>
            未保存内容以“时间-序号-文件名”写入；正常保存后自动清理本次恢复副本。
          </span>
        </div>
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

      {/* 最近文件恢复 */}
      <div style={rowStyle}>
        <span style={labelStyle}>保留最近文件</span>
        <input
          type="checkbox"
          checked={settings.file.restoreSession}
          onChange={(e) => setFile({ restoreSession: e.target.checked })}
        />
      </div>
      <div style={{ margin: '-10px 0 16px 152px', fontSize: 11, color: 'var(--editor-text-muted)' }}>
        默认开启；启动时自动恢复到 Tab 栏，当前页面仍停留 Home。
      </div>

      {/* 图片目录名 */}
      <div style={rowStyle}>
        <span style={labelStyle}>图片目录名称</span>
        <input
          type="text"
          value={settings.file.imageDirName ?? 'img'}
          onChange={(e) => setFile({ imageDirName: e.target.value })}
          placeholder="img"
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
