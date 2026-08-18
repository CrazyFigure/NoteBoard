// NoteBoard 不受支持文件格式主视图
// 当打开非文本或未适配格式文件时在右侧主区域展示
// 提供系统默认打开与文件定位等快捷操作

import { useState } from 'react';
import { FileQuestion, ExternalLink, FolderOpen, Copy, Check } from 'lucide-react';
import * as ipc from '../core/ipc/commands';
import { extFromPath } from '../core/docKind';

interface UnsupportedViewProps {
  filePath: string;
  fileName?: string;
  fileSize?: number;
}

// 格式化文件大小辅助函数
function formatFileSize(bytes?: number): string {
  if (bytes === undefined || bytes === null || bytes === 0) return '未知大小';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function UnsupportedView({ filePath, fileName, fileSize }: UnsupportedViewProps) {
  const [copied, setCopied] = useState(false);
  const name = fileName || filePath.split(/[\\/]/).pop() || filePath;
  const ext = extFromPath(filePath).toUpperCase() || '未知类型';

  // 处理用系统默认应用打开
  const handleOpenDefault = async () => {
    try {
      await ipc.openWithDefaultApp(filePath);
    } catch (e) {
      console.error('用系统默认程序打开失败:', e);
    }
  };

  // 处理在文件管理器中定位
  const handleReveal = async () => {
    try {
      await ipc.revealInExplorer(filePath);
    } catch (e) {
      console.error('在资源管理器中定位失败:', e);
    }
  };

  // 处理复制路径
  const handleCopyPath = () => {
    navigator.clipboard.writeText(filePath);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '32px 24px',
        boxSizing: 'border-box',
        background: 'var(--editor-bg)',
        color: 'var(--editor-text)',
        fontFamily: 'var(--content-font-family)',
      }}
    >
      <div
        style={{
          maxWidth: 460,
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          gap: 20,
          padding: '32px 28px',
          background: 'var(--editor-surface)',
          border: '1px solid var(--editor-border)',
          borderRadius: 12,
          boxShadow: 'var(--shadow-md, 0 4px 6px -1px rgba(0,0,0,0.1))',
        }}
      >
        {/* 顶部格式图标 */}
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: 16,
            background: 'var(--editor-bg)',
            border: '1px solid var(--editor-border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <FileQuestion size={32} color="var(--editor-text-muted)" />
        </div>

        {/* 文件名与类型标签 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
          <h2
            style={{
              fontSize: 18,
              fontWeight: 600,
              color: 'var(--editor-heading)',
              margin: 0,
              wordBreak: 'break-all',
            }}
          >
            {name}
          </h2>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              fontSize: 12,
              color: 'var(--editor-text-muted)',
            }}
          >
            <span
              style={{
                padding: '2px 8px',
                borderRadius: 4,
                background: 'var(--editor-bg)',
                border: '1px solid var(--editor-border)',
                fontWeight: 500,
              }}
            >
              {ext}
            </span>
            {fileSize !== undefined && fileSize > 0 && (
              <span>{formatFileSize(fileSize)}</span>
            )}
          </div>
        </div>

        {/* 格式不支持说明 */}
        <div
          style={{
            fontSize: 13,
            lineHeight: 1.6,
            color: 'var(--editor-text-secondary)',
            background: 'var(--editor-bg)',
            padding: '12px 16px',
            borderRadius: 8,
            border: '1px solid var(--editor-border)',
            width: '100%',
            boxSizing: 'border-box',
          }}
        >
          NoteBoard 专为 Markdown 笔记、自由画板及轻量纯文本设计。
          <br />
          当前文件格式暂不支持直接在软件内查看或编辑。
        </div>

        {/* 快捷操作按钮组 */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            width: '100%',
          }}
        >
          {/* 主动作：用系统默认应用打开 */}
          <button
            type="button"
            onClick={handleOpenDefault}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              padding: '10px 16px',
              border: 'none',
              borderRadius: 6,
              background: 'var(--editor-accent, #3b82f6)',
              color: '#ffffff',
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'opacity var(--transition-fast)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.opacity = '0.9';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.opacity = '1';
            }}
          >
            <ExternalLink size={15} />
            <span>用系统默认程序打开</span>
          </button>

          {/* 次动作行 */}
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              type="button"
              onClick={handleReveal}
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                padding: '8px 12px',
                border: '1px solid var(--editor-border)',
                borderRadius: 6,
                background: 'var(--editor-surface)',
                color: 'var(--editor-text)',
                fontSize: 12,
                cursor: 'pointer',
                transition: 'background var(--transition-fast)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--toolbar-hover)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'var(--editor-surface)';
              }}
            >
              <FolderOpen size={14} />
              <span>在文件管理器中定位</span>
            </button>

            <button
              type="button"
              onClick={handleCopyPath}
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                padding: '8px 12px',
                border: '1px solid var(--editor-border)',
                borderRadius: 6,
                background: 'var(--editor-surface)',
                color: 'var(--editor-text)',
                fontSize: 12,
                cursor: 'pointer',
                transition: 'background var(--transition-fast)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--toolbar-hover)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'var(--editor-surface)';
              }}
            >
              {copied ? <Check size={14} color="var(--success-600)" /> : <Copy size={14} />}
              <span>{copied ? '已复制路径' : '复制完整路径'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
