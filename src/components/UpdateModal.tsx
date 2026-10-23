// NoteBoard 自动更新模态弹窗组件
// 支持新版本展示、分版本可折叠的 Release Notes、下载进度条、代理与错误提示及一键安装
// 桌面端为居中弹窗，移动端为底部面板（Android 应用内下载 APK 后调起系统安装器）

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
  ArrowRight,
} from 'lucide-react';
import { Tooltip } from './Tooltip';
import { UpdateReleaseNotes } from './UpdateReleaseNotes';
import type { UpdateCheckResult, UpdateDownloadProgress, UpdateReleaseNote } from '../core/ipc/types';
import * as ipc from '../core/ipc/commands';
import { IS_MOBILE_UI, IS_NATIVE_MOBILE, USES_MANUAL_UPDATE_INSTALL } from '../core/platform';
import { useBackDismiss } from '../mobile/components';
import { resumeSnapshotTracking, saveCurrentWindowSnapshot } from '../features/session/closedWindowSession';
import './update-modal.css';

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

// 发布时间格式化为 YYYY-MM-DD
function formatDate(value?: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (num: number) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
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

  // 移动端返回键关闭弹窗（下载中不响应，避免中断进度展示）
  useBackDismiss(IS_MOBILE_UI && isOpen && !downloading, onClose);

  // 桌面端 Esc 关闭弹窗（下载中不响应）
  useEffect(() => {
    if (!isOpen || downloading) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, downloading, onClose]);

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

  // 分版本更新日志；兼容旧结构（仅有最新版正文）时合成单个版本条目
  const releaseNotes = useMemo<UpdateReleaseNote[]>(() => {
    if (!result) return [];
    if (result.releaseNotes && result.releaseNotes.length > 0) return result.releaseNotes;
    return [
      {
        version: result.latestVersion,
        name: result.releaseName,
        url: result.releaseUrl,
        publishedAt: result.publishedAt,
        body: result.releaseBody,
      },
    ];
  }, [result]);

  // 处理下载并执行安装
  const handleDownloadAndInstall = async () => {
    if (!result?.installerDownloadUrl || !result?.installerAssetName) {
      return;
    }
    // 桌面端安装器启动后进程会被直接结束、不走窗口关闭流程，先记录当前打开的文件以便更新后恢复
    if (!IS_NATIVE_MOBILE) {
      try {
        await saveCurrentWindowSnapshot();
      } catch (err) {
        console.error('更新前保存最近文件快照失败:', err);
      }
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
      // 安装未启动、应用继续使用：恢复增量记录
      if (!IS_NATIVE_MOBILE) resumeSnapshotTracking();
      const msg = err instanceof Error ? err.message : String(err);
      // 移动端失败时引导改用浏览器从 Release 页面下载
      setInstallError(
        IS_NATIVE_MOBILE
          ? `安装包下载或安装失败：${msg}。可点击「Release 页面」在浏览器中下载。`
          : `安装包下载或启动失败：${msg}`,
      );
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
  // 免安装版不在应用内下载安装，主按钮改为前往 GitHub Release 页面
  const portableUpdate = Boolean(showDetail && result?.portable);
  const latestDate = formatDate(result?.publishedAt);

  return (
    <div
      className="nb-update-overlay"
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
        className="nb-update-dialog"
        role="dialog"
        aria-modal="true"
        style={{
          width: 540,
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
          <Tooltip content="关闭" shortcut="Esc" side="bottom" sideOffset={4}>
            <button
              type="button"
              disabled={downloading}
              onClick={onClose}
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
              aria-label="关闭更新弹窗"
            >
              <X size={16} />
            </button>
          </Tooltip>
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
                正在连接 GitHub 检查最新版本
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
              {/* 版本概览：当前版本 → 最新版本，跨多个版本时标注数量 */}
              <div className="nb-update-hero">
                <div className="nb-update-hero-versions">
                  <div className="nb-update-hero-version">
                    <span className="nb-update-hero-label">当前版本</span>
                    <span className="nb-update-hero-value is-current">v{result.currentVersion}</span>
                  </div>
                  <ArrowRight size={16} className="nb-update-hero-arrow" />
                  <div className="nb-update-hero-version">
                    <span className="nb-update-hero-label">
                      最新版本{latestDate ? ` · ${latestDate}` : ''}
                    </span>
                    <span className="nb-update-hero-value is-latest">v{result.latestVersion}</span>
                  </div>
                </div>
                <div className="nb-update-hero-meta">
                  {releaseNotes.length > 1 && (
                    <span className="nb-update-chip">
                      {result.releaseNotesTruncated ? `${releaseNotes.length}+` : releaseNotes.length} 个版本待更新
                    </span>
                  )}
                  {portableUpdate ? (
                    <span className="nb-update-hero-size">
                      <span className="nb-update-hero-label">免安装版需手动下载替换</span>
                    </span>
                  ) : (
                    <span className="nb-update-hero-size">
                      <span className="nb-update-hero-label">安装包 </span>
                      {formatBytes(result.installerSize)}
                    </span>
                  )}
                </div>
              </div>

              {/* 分版本更新日志：单个版本默认展开，多个版本默认折叠 */}
              <UpdateReleaseNotes
                key={result.latestVersion}
                notes={releaseNotes}
                truncated={Boolean(result.releaseNotesTruncated)}
                onOpenUrl={handleOpenUrl}
              />

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
                    <span>{progressPercent >= 100 ? '下载完成，正在启动安装程序' : '正在下载安装包'}</span>
                    <span>
                      {downloadProgress
                        ? `${formatBytes(downloadProgress.downloadedBytes)} / ${formatBytes(
                            downloadProgress.totalBytes
                          )} (${progressPercent}%)`
                        : `${progressPercent}%`}
                    </span>
                  </div>
                  <div className="nb-update-progress-track">
                    <div className="nb-update-progress-bar" style={{ width: `${progressPercent}%` }} />
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* 底部操作按钮 */}
        <div
          className="nb-update-footer"
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

          {/* 打开 Release 页面（免安装版由主按钮承担，避免重复） */}
          {result?.releaseUrl && !portableUpdate && (
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

          {/* 免安装版：前往 GitHub 下载 */}
          {portableUpdate && result && (
            <button
              type="button"
              className="nb-btn-primary"
              onClick={() => handleOpenUrl(result.releaseUrl)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 16px',
                fontSize: 12,
                fontWeight: 500,
              }}
            >
              <ExternalLink size={14} />
              <span>前往 GitHub 下载</span>
            </button>
          )}

          {/* 下载并安装升级 */}
          {showDetail && !portableUpdate && (
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
              {/* 移动端同样在应用内下载 APK，完成后由系统安装器完成升级 */}
              <span>{downloading ? '正在下载' : USES_MANUAL_UPDATE_INSTALL ? '下载安装包' : '下载并安装'}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
