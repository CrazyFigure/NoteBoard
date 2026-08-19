// NoteBoard 自动更新模态弹窗组件
// 支持新版本展示、Release Notes 渲染、下载进度条、代理与错误提示及一键安装

import { useState, useEffect, useMemo } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  Download,
  ExternalLink,
  X,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Sparkles,
} from 'lucide-react';
import type { UpdateCheckResult, UpdateDownloadProgress } from '../core/ipc/types';
import * as ipc from '../core/ipc/commands';

interface UpdateModalProps {
  isOpen: boolean;
  onClose: () => void;
  result: UpdateCheckResult | null;
  checkError?: string | null;
  checking?: boolean;
  onRecheck?: () => void;
}

// 格式化字节数
function formatBytes(bytes?: number | null): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) {
    return '未知大小';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function UpdateModal({
  isOpen,
  onClose,
  result,
  checkError,
  checking = false,
  onRecheck,
}: UpdateModalProps) {
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<UpdateDownloadProgress | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  // 监听 Tauri 后端推送的下载进度事件
  useEffect(() => {
    if (!isOpen) {
      setDownloading(false);
      setDownloadProgress(null);
      setInstallError(null);
      return;
    }

    let unlisten: UnlistenFn | undefined;
    listen<UpdateDownloadProgress>('noteboard-update-download-progress', (event) => {
      setDownloadProgress(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [isOpen]);

  // 计算下载进度百分比
  const progressPercent = useMemo(() => {
    if (downloadProgress?.percent !== undefined) {
      return Math.min(100, Math.max(0, downloadProgress.percent));
    }
    if (downloadProgress && downloadProgress.totalBytes && downloadProgress.totalBytes > 0) {
      return Math.min(
        100,
        Math.max(
          0,
          Math.round((downloadProgress.downloadedBytes / downloadProgress.totalBytes) * 100)
        )
      );
    }
    return 0;
  }, [downloadProgress]);

  // 处理下载并执行安装
  const handleDownloadAndInstall = async () => {
    if (!result?.installerDownloadUrl || !result?.installerAssetName) {
      return;
    }
    try {
      setDownloading(true);
      setInstallError(null);
      await ipc.downloadAndInstallUpdate({
        downloadUrl: result.installerDownloadUrl,
        assetName: result.installerAssetName,
        installerSize: result.installerSize,
      });
      // 安装器成功启动后关闭弹窗
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setInstallError(`安装包下载或启动失败：${msg}`);
    } finally {
      setDownloading(false);
    }
  };

  // 在系统默认浏览器中打开外部链接
  const handleOpenUrl = (url: string) => {
    ipc.openExternalUrl(url).catch((err) => {
      console.error('无法打开外部链接:', err);
    });
  };

  if (!isOpen) return null;

  const showDetail = Boolean(result?.updateAvailable && !checkError && !checking);

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.45)',
        backdropFilter: 'blur(4px)',
      }}
      onClick={downloading ? undefined : onClose}
    >
      <div
        style={{
          width: 520,
          maxWidth: '92vw',
          maxHeight: '85vh',
          background: 'var(--editor-bg)',
          border: '1px solid var(--editor-border)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-lg)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          color: 'var(--editor-text)',
          fontFamily: 'var(--ui-font-family)',
          fontSize: 'var(--ui-font-size)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶部标题栏 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 18px',
            borderBottom: '1px solid var(--editor-border)',
            background: 'var(--editor-surface)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Sparkles size={18} color="var(--accent-strong)" />
            <span style={{ fontWeight: 600, fontSize: 14 }}>
              {checking
                ? '检查更新'
                : showDetail
                ? '发现新版本 NoteBoard'
                : '软件更新'}
            </span>
          </div>
          <button
            type="button"
            disabled={downloading}
            onClick={onClose}
            title="关闭 (Esc)"
            style={{
              background: 'transparent',
              border: 'none',
              cursor: downloading ? 'not-allowed' : 'pointer',
              color: 'var(--editor-text-muted)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 4,
              borderRadius: 'var(--radius-sm)',
              opacity: downloading ? 0.5 : 1,
              transition: 'all var(--transition-fast)',
            }}
            onMouseEnter={(e) => {
              if (!downloading) {
                e.currentTarget.style.background = 'var(--toolbar-hover)';
                e.currentTarget.style.color = 'var(--editor-text)';
                e.currentTarget.style.transform = 'scale(1.08)';
              }
            }}
            onMouseLeave={(e) => {
              if (!downloading) {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = 'var(--editor-text-muted)';
                e.currentTarget.style.transform = 'scale(1)';
              }
            }}
            onMouseDown={(e) => {
              if (!downloading) {
                e.currentTarget.style.background = 'var(--toolbar-active)';
                e.currentTarget.style.transform = 'scale(0.92)';
              }
            }}
            onMouseUp={(e) => {
              if (!downloading) {
                e.currentTarget.style.background = 'var(--toolbar-hover)';
                e.currentTarget.style.transform = 'scale(1.08)';
              }
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* 主体内容 */}
        <div
          style={{
            padding: '18px 20px',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          {/* 1. 正在检查中 */}
          {checking && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '30px 0',
                gap: 12,
              }}
            >
              <RefreshCw
                size={28}
                className="spin"
                style={{ animation: 'spin 1s linear infinite' }}
                color="var(--accent-strong)"
              />
              <span style={{ fontSize: 13, color: 'var(--editor-text-secondary)' }}>
                正在连接 GitHub 检查最新版本...
              </span>
            </div>
          )}

          {/* 2. 检查失败提示 */}
          {!checking && checkError && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: '12px 14px',
                  background: 'rgba(239, 68, 68, 0.08)',
                  border: '1px solid rgba(239, 68, 68, 0.25)',
                  borderRadius: 'var(--radius-md)',
                  color: 'var(--editor-text)',
                  fontSize: 13,
                  lineHeight: 1.6,
                }}
              >
                <AlertCircle size={18} color="#ef4444" style={{ flexShrink: 0, marginTop: 2 }} />
                <div>{checkError}</div>
              </div>
            </div>
          )}

          {/* 3. 已是最新版本 */}
          {!checking && !checkError && result && !result.updateAvailable && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                textAlign: 'center',
                padding: '24px 10px',
                gap: 10,
              }}
            >
              <CheckCircle2 size={36} color="#10b981" />
              <div style={{ fontWeight: 600, fontSize: 15 }}>已是最新版本</div>
              <div style={{ fontSize: 13, color: 'var(--editor-text-secondary)' }}>
                NoteBoard 当前版本 (v{result.currentVersion}) 已经是最新版本，无需更新。
              </div>
            </div>
          )}

          {/* 4. 发现新版本详情 */}
          {showDetail && result && (
            <>
              {/* 版本跳跃指示器 */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 14px',
                  background: 'var(--editor-surface)',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--editor-border)',
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>版本更新</span>
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--accent-strong)' }}>
                    v{result.currentVersion} → v{result.latestVersion}
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, textAlign: 'right' }}>
                  <span style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>安装包大小</span>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>
                    {formatBytes(result.installerSize)}
                  </span>
                </div>
              </div>

              {/* 发布时间 */}
              {result.publishedAt && (
                <div style={{ fontSize: 12, color: 'var(--editor-text-muted)', marginTop: -4 }}>
                  发布时间：{new Date(result.publishedAt).toLocaleString('zh-CN')}
                </div>
              )}

              {/* 更新日志正文 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>更新日志</span>
                <div
                  style={{
                    maxHeight: 180,
                    overflowY: 'auto',
                    padding: '10px 12px',
                    background: 'var(--editor-surface)',
                    border: '1px solid var(--editor-border)',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 12,
                    lineHeight: 1.6,
                    color: 'var(--editor-text)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {result.releaseBody?.trim() ? (
                    result.releaseBody
                  ) : (
                    <span style={{ color: 'var(--editor-text-muted)' }}>本次更新暂无详细日志说明。</span>
                  )}
                </div>
              </div>

              {/* 下载错误提示 */}
              {installError && (
                <div
                  style={{
                    padding: '8px 12px',
                    background: 'rgba(239, 68, 68, 0.08)',
                    border: '1px solid rgba(239, 68, 68, 0.25)',
                    borderRadius: 'var(--radius-sm)',
                    color: '#ef4444',
                    fontSize: 12,
                  }}
                >
                  {installError}
                </div>
              )}

              {/* 下载进度条 */}
              {downloading && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: 12,
                      color: 'var(--editor-text-muted)',
                    }}
                  >
                    <span>正在下载安装包...</span>
                    <span>
                      {downloadProgress
                        ? `${formatBytes(downloadProgress.downloadedBytes)} / ${formatBytes(
                            downloadProgress.totalBytes
                          )} (${progressPercent}%)`
                        : `${progressPercent}%`}
                    </span>
                  </div>
                  <div
                    style={{
                      height: 6,
                      background: 'var(--editor-surface)',
                      borderRadius: 3,
                      overflow: 'hidden',
                      border: '1px solid var(--editor-border)',
                    }}
                  >
                    <div
                      style={{
                        height: '100%',
                        width: `${progressPercent}%`,
                        background: 'var(--accent-strong)',
                        transition: 'width 0.15s ease',
                      }}
                    />
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* 底部操作按钮 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 10,
            padding: '12px 18px',
            borderTop: '1px solid var(--editor-border)',
            background: 'var(--editor-surface)',
          }}
        >
          {/* 取消 / 关闭 */}
          <button
            type="button"
            className="nb-btn-secondary"
            disabled={downloading}
            onClick={onClose}
            style={{
              padding: '6px 14px',
              fontSize: 12,
              cursor: downloading ? 'not-allowed' : 'pointer',
              opacity: downloading ? 0.5 : 1,
            }}
          >
            {showDetail ? '稍后' : '关闭'}
          </button>

          {/* 打开 Release 页面 */}
          {result?.releaseUrl && (
            <button
              type="button"
              className="nb-btn-secondary"
              disabled={downloading}
              onClick={() => handleOpenUrl(result.releaseUrl)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 14px',
                fontSize: 12,
                cursor: downloading ? 'not-allowed' : 'pointer',
              }}
            >
              <ExternalLink size={14} />
              <span>Release 页面</span>
            </button>
          )}

          {/* 重新检查按钮 */}
          {checkError && onRecheck && (
            <button
              type="button"
              className="nb-btn-primary"
              onClick={onRecheck}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 14px',
                fontSize: 12,
                fontWeight: 500,
              }}
            >
              <RefreshCw size={14} />
              <span>重试</span>
            </button>
          )}

          {/* 下载并安装升级 */}
          {showDetail && (
            <button
              type="button"
              className="nb-btn-primary"
              disabled={downloading || !result?.installerDownloadUrl}
              onClick={handleDownloadAndInstall}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 16px',
                fontSize: 12,
                cursor: downloading || !result?.installerDownloadUrl ? 'not-allowed' : 'pointer',
                fontWeight: 500,
                opacity: downloading ? 0.7 : 1,
              }}
            >
              <Download size={14} />
              <span>{downloading ? '正在下载...' : '下载并安装'}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
