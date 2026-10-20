// NoteBoard 全局唤起快捷键录制
// 点击后录制下一次组合键：先由 Rust 注册校验（被占用时提示），成功后再写入设置

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Tooltip } from '../Tooltip';
import { useSettingsStore } from '../../stores/settingsStore';
import { showToast } from '../../stores/toastStore';
import * as ipc from '../../core/ipc/commands';
import { setShortcutsSuspended } from '../../core/shortcuts';
import { formatAccelerator, keyEventToAccelerator } from '../../core/globalShortcut';

/** 先注册再保存：注册失败时保留原快捷键与设置 */
async function applyShortcut(accelerator: string): Promise<void> {
  const store = useSettingsStore.getState();
  try {
    await ipc.setShowWindowShortcut(accelerator);
    await store.setSystem({ showWindowShortcut: accelerator });
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 'error', 5000);
  }
}

export function GlobalShortcutRecorder() {
  const shortcut = useSettingsStore((s) => s.settings.system.showWindowShortcut);
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState('');

  useEffect(() => {
    if (!recording) return;
    setShortcutsSuspended(true);
    const handleKeyDown = (e: KeyboardEvent) => {
      // 窗口捕获阶段截停：不让设置弹窗的 Esc 关闭逻辑与编辑器收到按键
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        setRecording(false);
        return;
      }
      const result = keyEventToAccelerator(e);
      if (result === null) return;
      if (result === 'needs-modifier') {
        setHint('需包含修饰键');
        return;
      }
      setRecording(false);
      void applyShortcut(result);
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      setShortcutsSuspended(false);
      setHint('');
    };
  }, [recording]);

  const label = recording ? hint || '请按下组合键…' : shortcut ? formatAccelerator(shortcut) : '未设置';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
      <Tooltip content={recording ? 'Esc 取消' : '点击录制'} side="top" sideOffset={4}>
        <button
          type="button"
          className="nb-btn-secondary"
          onClick={() => setRecording((v) => !v)}
          onBlur={() => setRecording(false)}
          style={{
            minWidth: 120,
            padding: '2px 10px',
            fontSize: 11,
            fontFamily: 'var(--mono-font-family)',
            color: recording ? 'var(--accent-strong)' : shortcut ? 'var(--editor-text-secondary)' : 'var(--editor-text-muted)',
            borderColor: recording ? 'var(--accent-strong)' : undefined,
          }}
        >
          {label}
        </button>
      </Tooltip>
      {shortcut && !recording && (
        <Tooltip content="清除" side="top" sideOffset={4}>
          <button type="button" className="nb-icon-btn" aria-label="清除快捷键" onClick={() => void applyShortcut('')}>
            <X size={13} />
          </button>
        </Tooltip>
      )}
    </div>
  );
}
