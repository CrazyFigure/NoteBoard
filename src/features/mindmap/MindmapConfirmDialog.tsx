// NoteBoard 思维导图二次确认对话框
// Portal 到 body；打开时聚焦确认按钮（Enter 直接确认），Esc 取消，按键不再传给画布快捷键。
// 详见 docs/09-开发路线图.md

import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle } from 'lucide-react';
import { stopReactPropagation } from '../bitable/bitableUtils';

interface MindmapConfirmDialogProps {
  title: string;
  message: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function MindmapConfirmDialog({ title, message, confirmLabel, onConfirm, onCancel }: MindmapConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const onConfirmRef = useRef(onConfirm);
  onConfirmRef.current = onConfirm;

  useEffect(() => {
    confirmRef.current?.focus();
    const handleKeyDown = (e: KeyboardEvent) => {
      // 捕获阶段接管：Esc 取消；Enter 执行当前聚焦的按钮（默认聚焦确认）；其余按键不再传给画布快捷键
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancelRef.current();
      } else if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        if (document.activeElement === cancelRef.current) onCancelRef.current();
        else onConfirmRef.current();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  return createPortal(
    <div
      className="nb-mindmap-confirm-overlay"
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => {
        stopReactPropagation(e);
        if (e.target === e.currentTarget) onCancel();
      }}
      onPointerDown={stopReactPropagation}
      onClick={stopReactPropagation}
    >
      <div className="nb-mindmap-confirm-card">
        <div className="nb-mindmap-confirm-title">
          <AlertTriangle size={16} color="var(--error-500, #ef4444)" />
          <span>{title}</span>
        </div>
        <div className="nb-mindmap-confirm-message">{message}</div>
        <div className="nb-mindmap-confirm-actions">
          <button ref={cancelRef} type="button" className="nb-editor-toolbar-btn" onClick={onCancel} style={{ padding: '4px 14px' }}>
            取消
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="nb-mindmap-danger-btn"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
