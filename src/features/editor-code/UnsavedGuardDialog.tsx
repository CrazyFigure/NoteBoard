// NoteBoard 关闭拦截对话框
// 单文件 + 批量
// 详见 docs/09-开发路线图.md 4.12

import { useState } from 'react';
import { AlertTriangle, Archive, Save } from 'lucide-react';
import { useWindowStore, type Tab } from '../../stores/windowStore';

// ── 类型 ──

export interface UnsavedGuardDialogProps {
  /** 待关闭的脏 tab 列表 */
  dirtyTabs: Tab[];
  /** 确认保存并关闭 */
  onSave: (keys: string[]) => Promise<void>;
  /** 另存到暂存区并关闭 */
  onStash: (keys: string[]) => Promise<void>;
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
  onStash,
  onDiscard,
  onCancel,
  visible,
}: UnsavedGuardDialogProps) {
  const [saving, setSaving] = useState(false);
  const [staging, setStaging] = useState(false);

  if (!visible || dirtyTabs.length === 0) return null;

  const isBatch = dirtyTabs.length > 1;

  // 执行常规保存并关闭
  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(dirtyTabs.map((t) => t.key));
    } finally {
      setSaving(false);
    }
  };

  // 放弃未保存修改并直接关闭
  const handleDiscard = () => {
    onDiscard(dirtyTabs.map((t) => t.key));
  };

  // 另存到暂存区并关闭
  const handleStash = async () => {
    setStaging(true);
    try {
      await onStash(dirtyTabs.map((t) => t.key));
    } finally {
      setStaging(false);
    }
  };

  const overlayStyle: React.CSSProperties = {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0,0,0,0.45)',
    backdropFilter: 'blur(2px)',
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
    minWidth: 460,
    maxWidth: 560,
    boxShadow: 'var(--shadow-lg)',
    color: 'var(--editor-text)',
    fontFamily: 'var(--content-font-family)',
  };

  return (
    <div style={overlayStyle} role="dialog" aria-modal="true">
      <div style={dialogStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          {/* 警告图标：使用 warning-500 语义变量，在亮色和墨夜深色主题下均清晰明亮 */}
          <AlertTriangle size={24} color="var(--warning-500)" />
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--editor-heading)' }}>
            {isBatch
              ? `${dirtyTabs.length} 个文件未保存`
              : `"${dirtyTabs[0].displayName}" 未保存`}
          </h2>
        </div>

        <p style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--editor-text-secondary)' }}>
          {isBatch
            ? '以下文件有未保存的修改。可保存到原位置，或另存到暂存区后关闭。'
            : '此文件有未保存的修改。可保存到原位置，或另存到暂存区后关闭。'}
        </p>

        {isBatch && (
          <ul style={{ margin: '0 0 16px', paddingLeft: 20, fontSize: 13, color: 'var(--editor-text-muted)' }}>
            {dirtyTabs.map((t) => (
              <li key={t.key} style={{ padding: '2px 0' }}>{t.displayName}</li>
            ))}
          </ul>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          {/* 取消操作：取消关闭拦截并停留在当前页面 */}
          <button
            type="button"
            className="nb-btn-secondary"
            onClick={onCancel}
            disabled={saving || staging}
            style={{
              padding: '6px 14px',
              fontSize: 13,
            }}
          >
            取消
          </button>

          {/* 危险操作：不保存直接放弃未保存修改并关闭 */}
          <button
            type="button"
            className="nb-btn-danger"
            onClick={handleDiscard}
            disabled={saving || staging}
            style={{
              padding: '6px 14px',
              fontSize: 13,
            }}
          >
            不保存
          </button>

          {/* 柔和次级特色操作：另存到暂存区保护现场 */}
          <button
            type="button"
            className="nb-btn-soft"
            onClick={handleStash}
            disabled={saving || staging}
            style={{
              padding: '6px 14px',
              fontSize: 13,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Archive size={14} />
            {staging ? '正在暂存' : '暂存'}
          </button>

          {/* 核心主操作：突出显示保存按钮 */}
          <button
            type="button"
            className="nb-btn-primary"
            onClick={handleSave}
            disabled={saving || staging}
            style={{
              padding: '6px 16px',
              fontSize: 13,
              fontWeight: 500,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Save size={14} />
            {saving ? '正在保存' : '保存'}
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

  // 请求关闭指定的标签页（若有脏 tab 则触发拦截）
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

  // 取消关闭操作
  const cancelClose = () => setPendingClose([]);

  // 逐个保存并关闭
  const confirmSaveAndClose = async (keys: string[]) => {
    for (const key of keys) {
      const { saveDocument } = await import('./orchestration/saveDocument');
      await saveDocument(key);
    }
    keys.forEach((k) => closeTab(k));
    setPendingClose([]);
  };

  // 放弃修改并关闭
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
