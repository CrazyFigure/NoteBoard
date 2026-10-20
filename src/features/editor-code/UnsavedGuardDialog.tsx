// NoteBoard 关闭拦截对话框
// 单文件 + 批量
// 详见 docs/09-开发路线图.md 4.12

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Archive, Save } from 'lucide-react';
import { useWindowStore, type Tab } from '../../stores/windowStore';
import { Tooltip } from '../../components/Tooltip';

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
  const panelRef = useRef<HTMLDivElement>(null);
  // 快捷键处理器只注册一次，通过 ref 读取最新的回调与忙碌状态
  const actionsRef = useRef({ save: () => {}, stash: () => {}, discard: () => {}, cancel: onCancel, busy: false });

  const open = visible && dirtyTabs.length > 0;

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      // 捕获阶段接管：弹窗打开期间按键不再传给编辑器（避免 N/S 写入正文）
      e.stopPropagation();
      if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      const actions = actionsRef.current;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (key !== 'Escape' && key !== 'Enter' && key !== 'n' && key !== 's') return;
      e.preventDefault();
      // 长按重复与保存/暂存进行中均不重复触发
      if (e.repeat || actions.busy) return;
      if (key === 'Escape') actions.cancel();
      else if (key === 'n') actions.discard();
      else if (key === 's') actions.stash();
      else {
        // Enter：焦点在弹窗内某个按钮上时执行该按钮，否则默认保存
        const active = document.activeElement;
        if (active instanceof HTMLButtonElement && panelRef.current?.contains(active)) active.click();
        else actions.save();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [open]);

  if (!open) return null;

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

  actionsRef.current = {
    save: () => void handleSave(),
    stash: () => void handleStash(),
    discard: handleDiscard,
    cancel: onCancel,
    busy: saving || staging,
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
    // 桌面保持 460px 起始宽度；窄屏（手机）按视口收缩，避免横向溢出
    minWidth: 'min(460px, calc(100vw - 32px))',
    maxWidth: 'min(560px, calc(100vw - 32px))',
    boxSizing: 'border-box',
    boxShadow: 'var(--shadow-lg)',
    color: 'var(--editor-text)',
    fontFamily: 'var(--content-font-family)',
  };

  return (
    <div style={overlayStyle} role="dialog" aria-modal="true">
      <div ref={panelRef} style={dialogStyle}>
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

        {/* 窄屏（手机）下由样式改为两行两列均衡排列 */}
        <div className="nb-guard-actions" style={{ display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8, marginTop: 20 }}>
          {/* 取消操作：取消关闭拦截并停留在当前页面 */}
          <Tooltip content="继续编辑" shortcut="Esc" side="top">
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
          </Tooltip>

          {/* 危险操作：不保存直接放弃未保存修改并关闭 */}
          <Tooltip content="放弃修改并关闭" shortcut="N" side="top">
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
          </Tooltip>

          {/* 柔和次级特色操作：另存到暂存区保护现场 */}
          <Tooltip content="存入暂存区并关闭" shortcut="S" side="top">
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
          </Tooltip>

          {/* 核心主操作：突出显示保存按钮 */}
          <Tooltip content="保存到原位置并关闭" shortcut="Enter" side="top">
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
          </Tooltip>
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
