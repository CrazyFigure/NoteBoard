// NoteBoard 超链接插入与编辑模态弹窗
// 支持展示名称（展示名）与链接地址（URL）双输入框、已有链接回显与移除、键盘快捷键支持

import { useState, useEffect, useRef } from 'react';
import { Link, Link2, Type, X, Trash2, Check } from 'lucide-react';

export interface LinkModalProps {
  /** 弹窗是否可见 */
  isOpen: boolean;
  /** 初始展示文本（如当前选中文本） */
  initialText?: string;
  /** 初始链接地址（如已有链接 href） */
  initialUrl?: string;
  /** 是否为编辑已有链接模式 */
  isEditing?: boolean;
  /** 关闭弹窗回调 */
  onClose: () => void;
  /** 确认提交回调 */
  onConfirm: (data: { text: string; url: string }) => void;
  /** 移除链接回调 */
  onRemove?: () => void;
}

/** 现代化超链接编辑与插入模态弹窗组件 */
export function LinkModal({
  isOpen,
  initialText = '',
  initialUrl = '',
  isEditing = false,
  onClose,
  onConfirm,
  onRemove,
}: LinkModalProps) {
  const [text, setText] = useState(initialText);
  const [url, setUrl] = useState(initialUrl);

  const textInputRef = useRef<HTMLInputElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);

  // 弹窗打开或属性变化时同步初始值并自动聚焦
  useEffect(() => {
    if (isOpen) {
      setText(initialText);
      setUrl(initialUrl);

      // 延迟微任务聚焦，避免与弹窗挂载动效冲突
      setTimeout(() => {
        if (initialText.trim() && !initialUrl.trim()) {
          urlInputRef.current?.focus();
          urlInputRef.current?.select();
        } else {
          textInputRef.current?.focus();
          textInputRef.current?.select();
        }
      }, 50);
    }
  }, [isOpen, initialText, initialUrl]);

  // 全局 Escape 快捷键关闭
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // 提交处理
  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      // 若 URL 为空且处于编辑模式，视为移除链接
      if (isEditing && onRemove) {
        onRemove();
      }
      onClose();
      return;
    }
    onConfirm({
      text: text.trim(),
      url: trimmedUrl,
    });
    onClose();
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 9995,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.45)',
        backdropFilter: 'blur(4px)',
      }}
      onMouseDown={(e) => {
        // 点击遮罩空白区域关闭
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        style={{
          width: 440,
          maxWidth: '92vw',
          background: 'var(--editor-surface, #ffffff)',
          border: '1px solid var(--editor-border, rgba(0, 0, 0, 0.12))',
          borderRadius: 'var(--radius-lg, 8px)',
          boxShadow: '0 12px 32px -4px rgba(0, 0, 0, 0.18), 0 4px 12px -2px rgba(0, 0, 0, 0.08)',
          overflow: 'hidden',
          color: 'var(--editor-text, #1e293b)',
          fontFamily: 'var(--ui-font-family, sans-serif)',
          fontSize: 'var(--ui-font-size, 13px)',
          display: 'flex',
          flexDirection: 'column',
        }}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* 顶部标题栏 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            borderBottom: '1px solid var(--editor-border, rgba(0, 0, 0, 0.08))',
            background: 'var(--editor-bg, #f8fafc)',
            userSelect: 'none',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Link size={16} style={{ color: 'var(--accent-500, #3b82f6)' }} />
            <span style={{ fontWeight: 600, fontSize: 14 }}>
              {isEditing ? '编辑超链接' : '插入超链接'}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="关闭 (Esc)"
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--editor-text-muted, #64748b)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 4,
              borderRadius: 'var(--radius-sm, 4px)',
              transition: 'all var(--transition-fast, 150ms ease)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--toolbar-hover, rgba(0, 0, 0, 0.06))';
              e.currentTarget.style.color = 'var(--editor-text, #0f172a)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = 'var(--editor-text-muted, #64748b)';
            }}
          >
            <X size={15} />
          </button>
        </div>

        {/* 表单输入区域 */}
        <form onSubmit={handleSubmit} style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* 展示名称（展示名） */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: 'var(--editor-text-secondary, #475569)',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              <Type size={13} style={{ opacity: 0.8 }} />
              <span>展示名称（选填）</span>
            </label>
            <input
              ref={textInputRef}
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="输入链接要显示的文本（留空则默认使用链接地址）"
              style={{
                width: '100%',
                height: 34,
                padding: '0 10px',
                border: '1px solid var(--editor-border, #cbd5e1)',
                borderRadius: 'var(--radius-md, 6px)',
                background: 'var(--editor-bg, #ffffff)',
                color: 'var(--editor-text, #0f172a)',
                fontSize: 13,
                outline: 'none',
                transition: 'border-color var(--transition-fast, 150ms ease), box-shadow var(--transition-fast, 150ms ease)',
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = 'var(--accent-500, #3b82f6)';
                e.currentTarget.style.boxShadow = '0 0 0 2px rgba(59, 130, 246, 0.2)';
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = 'var(--editor-border, #cbd5e1)';
                e.currentTarget.style.boxShadow = 'none';
              }}
            />
          </div>

          {/* 链接地址（URL） */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: 'var(--editor-text-secondary, #475569)',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              <Link2 size={13} style={{ opacity: 0.8 }} />
              <span>链接地址 (URL)</span>
            </label>
            <input
              ref={urlInputRef}
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://... 或相对路径文档如 ./doc.md"
              style={{
                width: '100%',
                height: 34,
                padding: '0 10px',
                border: '1px solid var(--editor-border, #cbd5e1)',
                borderRadius: 'var(--radius-md, 6px)',
                background: 'var(--editor-bg, #ffffff)',
                color: 'var(--editor-text, #0f172a)',
                fontSize: 13,
                outline: 'none',
                transition: 'border-color var(--transition-fast, 150ms ease), box-shadow var(--transition-fast, 150ms ease)',
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = 'var(--accent-500, #3b82f6)';
                e.currentTarget.style.boxShadow = '0 0 0 2px rgba(59, 130, 246, 0.2)';
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = 'var(--editor-border, #cbd5e1)';
                e.currentTarget.style.boxShadow = 'none';
              }}
            />
          </div>

          {/* 底部按钮栏 */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: isEditing && onRemove ? 'space-between' : 'flex-end',
              marginTop: 4,
              paddingTop: 10,
              borderTop: '1px solid var(--editor-border, rgba(0, 0, 0, 0.06))',
            }}
          >
            {/* 移除链接按钮 */}
            {isEditing && onRemove && (
              <button
                type="button"
                onClick={() => {
                  onRemove();
                  onClose();
                }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '5px 10px',
                  background: 'transparent',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  color: '#ef4444',
                  borderRadius: 'var(--radius-md, 6px)',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 500,
                  transition: 'all var(--transition-fast, 150ms ease)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)';
                  e.currentTarget.style.borderColor = '#ef4444';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.borderColor = 'rgba(239, 68, 68, 0.3)';
                }}
              >
                <Trash2 size={13} />
                <span>移除链接</span>
              </button>
            )}

            {/* 取消与确认按钮组 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                onClick={onClose}
                style={{
                  padding: '5px 14px',
                  background: 'transparent',
                  border: '1px solid var(--editor-border, #cbd5e1)',
                  color: 'var(--editor-text, #334155)',
                  borderRadius: 'var(--radius-md, 6px)',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 500,
                  transition: 'all var(--transition-fast, 150ms ease)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--toolbar-hover, rgba(0, 0, 0, 0.05))';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                }}
              >
                取消
              </button>

              <button
                type="submit"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '5px 16px',
                  background: 'var(--accent-500, #3b82f6)',
                  border: '1px solid transparent',
                  color: '#ffffff',
                  borderRadius: 'var(--radius-md, 6px)',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 500,
                  boxShadow: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
                  transition: 'all var(--transition-fast, 150ms ease)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.opacity = '0.9';
                  e.currentTarget.style.transform = 'translateY(-0.5px)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.opacity = '1';
                  e.currentTarget.style.transform = 'translateY(0)';
                }}
              >
                <Check size={13} />
                <span>{isEditing ? '保存' : '插入'}</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
