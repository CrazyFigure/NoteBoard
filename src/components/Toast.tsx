// NoteBoard 全局 Toast 悬浮提示层
// 渲染来自 toastStore 的轻量通知

import { useToastStore } from '../stores/toastStore';
import { AlertCircle, AlertTriangle, CheckCircle, Info, X } from 'lucide-react';

export function ToastContainer() {
  const { toasts, removeToast } = useToastStore();

  if (toasts.length === 0) return null;

  return (
    // 全局 Toast 容器：定位在顶部同一高度的水平居中位置，避免遮挡右上角搜索与替换栏
    <div
      style={{
        position: 'fixed',
        top: 48,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 99999,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        pointerEvents: 'none',
        maxWidth: 'calc(100vw - 48px)',
      }}
    >
      {toasts.map((toast) => {
        const isWarning = toast.type === 'warning';
        const isError = toast.type === 'error';
        const isSuccess = toast.type === 'success';

        const icon = isError ? (
          <AlertCircle size={16} color="var(--error-500, #ef4444)" style={{ flexShrink: 0 }} />
        ) : isWarning ? (
          <AlertTriangle size={16} color="var(--warning-600, #f59e0b)" style={{ flexShrink: 0 }} />
        ) : isSuccess ? (
          <CheckCircle size={16} color="var(--success-600, #10b981)" style={{ flexShrink: 0 }} />
        ) : (
          <Info size={16} color="var(--editor-accent, #3b82f6)" style={{ flexShrink: 0 }} />
        );

        return (
          <div
            key={toast.id}
            style={{
              pointerEvents: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 14px',
              borderRadius: 8,
              background: 'var(--editor-surface)',
              border: `1px solid ${
                isWarning
                  ? 'var(--warning-600, #f59e0b)'
                  : isError
                  ? 'var(--error-500, #ef4444)'
                  : 'var(--editor-border)'
              }`,
              boxShadow: 'var(--shadow-lg, 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1))',
              color: 'var(--editor-text)',
              fontSize: 13,
              lineHeight: 1.4,
              animation: 'nb-toast-in 0.2s ease-out',
            }}
          >
            {icon}
            <span style={{ flex: 1 }}>{toast.message}</span>
            {/* 关闭提示按钮，带 Hover 与 Active 反馈 */}
            <button
              type="button"
              onClick={() => removeToast(toast.id)}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--editor-text-muted)',
                cursor: 'pointer',
                padding: 2,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 4,
                transition: 'all var(--transition-fast)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = 'var(--editor-text)';
                e.currentTarget.style.background = 'var(--toolbar-hover)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = 'var(--editor-text-muted)';
                e.currentTarget.style.background = 'transparent';
              }}
              onMouseDown={(e) => {
                e.currentTarget.style.background = 'var(--toolbar-active)';
                e.currentTarget.style.transform = 'scale(0.92)';
              }}
              onMouseUp={(e) => {
                e.currentTarget.style.background = 'var(--toolbar-hover)';
                e.currentTarget.style.transform = 'scale(1)';
              }}
              title="关闭提示"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
