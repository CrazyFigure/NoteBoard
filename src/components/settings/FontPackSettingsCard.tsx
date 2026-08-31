// NoteBoard 设置页字体包管理卡片：下载、修复、离线导入与明确删除。

import { Download, PackageCheck, Trash2, Upload } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';

import { resolveSystemFontFallbackPatch } from '../../app/fontPack';
import * as ipc from '../../core/ipc/commands';
import { useFontPackStore } from '../../stores/fontPackStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { showToast } from '../../stores/toastStore';

const formatBytes = (value?: number | null) => {
  if (!value || !Number.isFinite(value)) return '—';
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
};

/** 设置页长期保留管理入口，用户拒绝首次下载后仍可随时重新启用应用字体。 */
export function FontPackSettingsCard() {
  const { settings, setTypography } = useSettingsStore();
  const {
    status,
    action,
    progress,
    error,
    download,
    importArchive,
    remove,
    clearError,
  } = useFontPackStore();
  const busy = Boolean(action);
  const ready = status?.state === 'ready';
  const totalBytes = progress?.totalBytes ?? status?.downloadSizeBytes;
  const percent = progress?.percent
    ?? (progress && totalBytes
      ? Math.round((progress.downloadedBytes / totalBytes) * 100)
      : 0);
  const statusText = ready
    ? `已安装 v${status.version}`
    : status?.state === 'invalid'
      ? '需要修复'
      : '尚未安装';

  const handleDownload = async () => {
    const result = await download();
    if (result?.state === 'ready') showToast('字体包已下载并启用', 'success');
  };

  const handleImport = async () => {
    clearError();
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: 'NoteBoard 字体包', extensions: ['zip'] }],
    });
    if (typeof selected !== 'string') return;
    const result = await importArchive(selected);
    if (result?.state === 'ready') showToast('字体包已导入并启用', 'success');
  };

  const handleRemove = async () => {
    clearError();
    try {
      // 先把依赖应用字体的字段保存为真实系统字体，再删除文件，避免当前窗口出现无效配置。
      const installed = await ipc.listSystemFonts();
      const patch = resolveSystemFontFallbackPatch(
        settings.typography,
        installed.map((font) => font.family),
      );
      if (Object.keys(patch).length) await setTypography(patch);
      const result = await remove();
      if (result?.state === 'missing') showToast('应用字体包已删除，当前使用系统字体', 'success');
    } catch (operationError) {
      showToast(`字体包删除失败：${String(operationError)}`, 'error', 5000);
    }
  };

  return (
    <div className="nb-font-pack-settings-card">
      <div className="nb-font-pack-settings-heading">
        <div>
          <div className="nb-font-pack-settings-title">
            <PackageCheck size={16} />
            应用增强字体包
          </div>
          <p>
            JetBrains Mono + Maple Mono 仅在 NoteBoard 内启用，不安装到 Windows；普通升级和卸载默认保留。
          </p>
        </div>
        <span className={`nb-font-pack-status is-${status?.state ?? 'missing'}`}>{statusText}</span>
      </div>

      <div className="nb-font-pack-settings-meta">
        <span>安装后约 {formatBytes(status?.installedSizeBytes)}</span>
        <span>在线下载约 {formatBytes(status?.downloadSizeBytes)}</span>
      </div>

      {action === 'download' ? (
        <div className="nb-font-pack-progress" aria-live="polite">
          <div className="nb-font-pack-progress-copy">
            <span>正在下载并校验字体包</span>
            <span>{Math.min(100, Math.max(0, percent))}%</span>
          </div>
          <div className="nb-font-pack-progress-track">
            <div
              className="nb-font-pack-progress-fill"
              style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
            />
          </div>
          <span className="nb-font-pack-muted">
            {formatBytes(progress?.downloadedBytes)} / {formatBytes(totalBytes)}
          </span>
        </div>
      ) : null}

      {error ? <p className="nb-font-pack-error" role="alert">{error}</p> : null}

      <div className="nb-font-pack-settings-actions">
        <button className="nb-btn-secondary" disabled={busy} onClick={handleImport} type="button">
          <Upload size={15} />
          {action === 'import' ? '正在导入' : '手动导入字体包'}
        </button>
        {ready ? (
          <button className="nb-font-pack-remove-button" disabled={busy} onClick={handleRemove} type="button">
            <Trash2 size={15} />
            {action === 'remove' ? '正在删除' : '删除字体包'}
          </button>
        ) : (
          <button className="nb-btn-primary" disabled={busy} onClick={handleDownload} type="button">
            <Download size={15} />
            {action === 'download' ? '正在下载' : status?.state === 'invalid' ? '修复字体包' : '下载并启用'}
          </button>
        )}
      </div>
    </div>
  );
}
