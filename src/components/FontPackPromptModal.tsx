// NoteBoard 首次启动字体包提示：只提供下载启用或切换系统字体两个明确结果。

import { Download, PackageOpen } from 'lucide-react';

import { useFontPackStore } from '../stores/fontPackStore';

interface FontPackPromptModalProps {
  open: boolean;
  onEnabled: () => void;
  onUseSystem: () => Promise<void> | void;
}

const formatBytes = (value?: number | null) => {
  if (!value || !Number.isFinite(value)) return '—';
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
};

/** 下载按钮必须由用户明确触发，首次启动检测本身不会自动消耗网络流量。 */
export function FontPackPromptModal({
  open,
  onEnabled,
  onUseSystem,
}: FontPackPromptModalProps) {
  const { status, action, progress, error, download } = useFontPackStore();
  if (!open) return null;

  const downloading = action === 'download';
  const busy = Boolean(action);
  const totalBytes = progress?.totalBytes ?? status?.downloadSizeBytes;
  const percent = progress?.percent
    ?? (progress && totalBytes
      ? Math.round((progress.downloadedBytes / totalBytes) * 100)
      : 0);

  const handleDownload = async () => {
    const nextStatus = await download();
    if (nextStatus?.state === 'ready') onEnabled();
  };

  return (
    <div className="nb-font-pack-backdrop">
      <div
        aria-labelledby="nb-font-pack-prompt-title"
        aria-modal="true"
        className="nb-font-pack-prompt"
        role="dialog"
      >
        <div className="nb-font-pack-prompt-icon" aria-hidden="true">
          <PackageOpen size={25} />
        </div>
        <div className="nb-font-pack-prompt-copy">
          <h3 id="nb-font-pack-prompt-title">增强字体包未安装</h3>
          <p>
            下载 JetBrains Mono 与 Maple Mono 字体包（约 {formatBytes(status?.downloadSizeBytes)}）。
            字体仅供 NoteBoard 使用，不会安装到 Windows；下载一次，后续版本更新可继续复用。
          </p>
          <p className="nb-font-pack-muted">下载来自 NoteBoard 官方 GitHub Release，只有校验完整后才会启用。</p>
        </div>

        {error ? <p className="nb-font-pack-error" role="alert">{error}</p> : null}

        {downloading ? (
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

        <div className="nb-font-pack-actions">
          <button className="nb-btn-secondary" disabled={busy} onClick={onUseSystem} type="button">
            使用系统字体
          </button>
          <button autoFocus className="nb-btn-primary" disabled={busy} onClick={handleDownload} type="button">
            <Download size={16} />
            {downloading ? '正在下载' : '下载并启用（推荐）'}
          </button>
        </div>
      </div>
    </div>
  );
}
