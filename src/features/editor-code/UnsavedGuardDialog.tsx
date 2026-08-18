// NoteBoard 关闭拦截对话框
// 单文件 + 批量
// 详见 docs/09-开发路线图.md 4.12

import { useState, useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useWindowStore, type Tab } from '../../stores/windowStore';

// ── 类型 ──

export interface UnsavedGuardDialogProps {
  /** 待关闭的脏 tab 列表 */
  dirtyTabs: Tab[];
  /** 确认保存并关闭 */
  onSave: (keys: string[]) => Promise<void>;
  /** 不保存直接关闭 */
  onDiscard: (keys: string[]) => void;
  /** 取消 */
  onCancel: () => void;
  /** 是否可见 */
  visible: boolean;
}

// ── 对话框组件 ──

export function UnsavedGuardDialog({
  dirtyTabs,
  onSave,
  onDiscard,
  onCancel,
  visible,
}: UnsavedGuardDialogProps) {
  const [saving, setSaving] = useState(false);

  if (!visible || dirtyTabs.length === 0) return null;

  const isBatch = dirtyTabs.length > 1;

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(dirtyTabs.map((t) => t.key));
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    onDiscard(dirtyTabs.map((t) => t.key));
  };

  const overlayStyle: React.CSSProperties = {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0,0,0,0.4)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  };

  const dialogStyle: React.CSSProperties = {
    background: 'var(--editor-surface)',
    border: '1px solid var(--editor-border)',
    borderRadius: 'var(--radius-lg)',
    padding: 24,
    minWidth: 420,
    maxWidth: 500,
    boxShadow: 'var(--shadow-lg)',
    color: 'var(--editor-text)',
    fontFamily: 'var(--content-font-family)',
  };

  const buttonBase: React.CSSProperties = {
    padding: '8px 16px',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--editor-border)',
    cursor: 'pointer',
    fontSize: 13,
    transition: 'background var(--transition-fast)',
  };

  return (
    <div style={overlayStyle} role="dialog" aria-modal="true">
      <div style={dialogStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <AlertTriangle size={24} color="var(--warning-600)" />
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--editor-heading)' }}>
            {isBatch
              ? `${dirtyTabs.length} 个文件未保存`
              : `"${dirtyTabs[0].displayName}" 未保存`}
          </h2>
        </div>

        <p style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--editor-text-secondary)' }}>
          {isBatch
            ? '以下文件有未保存的修改，保存后再关闭？'
            : '此文件有未保存的修改，保存后再关闭？'}
        </p>

        {isBatch && (
          <ul style={{ margin: '0 0 16px', paddingLeft: 20, fontSize: 13, color: 'var(--editor-text-muted)' }}>
            {dirtyTabs.map((t) => (
              <li key={t.key} style={{ padding: '2px 0' }}>{t.displayName}</li>
            ))}
          </ul>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button
            onClick={onCancel}
            style={{
              ...buttonBase,
              background: 'transparent',
              color: 'var(--editor-text-secondary)',
            }}
          >
            取消
          </button>
          <button
            onClick={handleDiscard}
            style={{
              ...buttonBase,
              background: 'transparent',
              color: 'var(--editor-text-secondary)',
            }}
          >
            不保存
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              ...buttonBase,
              background: 'var(--accent-strong)',
              color: '#ffffff',
              border: '1px solid var(--accent-strong)',
              opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Hook：检查关闭拦截 ──

export function useUnsavedGuard() {
  const tabs = useWindowStore((s) => s.tabs);
  const closeTab = useWindowStore((s) => s.closeTab);

  const [pendingClose, setPendingClose] = useState<string[]>([]);

  const requestClose = (keys: string[]) => {
    const dirty = tabs.filter((t) => keys.includes(t.key) && t.isDirty);
    if (dirty.length === 0) {
      // 全部干净，直接关
      keys.forEach((k) => closeTab(k));
    } else {
      // 有脏 tab，弹拦截框
      setPendingClose(keys);
    }
  };

  const cancelClose = () => setPendingClose([]);

  const confirmSaveAndClose = async (keys: string[]) => {
    // 逐个保存
    for (const key of keys) {
      const { saveDocument } = await import('./orchestration/saveDocument');
      await saveDocument(key);
    }
    // 关闭
    keys.forEach((k) => closeTab(k));
    setPendingClose([]);
  };

  const discardAndClose = (keys: string[]) => {
    keys.forEach((k) => closeTab(k));
    setPendingClose([]);
  };

  const dirtyPendingTabs = tabs.filter(
    (t) => pendingClose.includes(t.key) && t.isDirty,
  );

  return {
    pendingClose,
    dirtyPendingTabs,
    requestClose,
    cancelClose,
    confirmSaveAndClose,
    discardAndClose,
  };
}
