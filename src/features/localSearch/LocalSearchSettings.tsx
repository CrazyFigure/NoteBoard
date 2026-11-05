// NoteBoard 设置 → 全局：本地文件搜索
// 开关从关到开时，若尚未添加任何位置且设置了同步文件夹，默认索引同步文件夹；
// 位置可任意添加多个文件夹或整个磁盘，也可逐个移除。

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { open } from '@tauri-apps/plugin-dialog';
import { Check, ChevronDown, Folder, FolderPlus, HardDrive, Search, X } from 'lucide-react';
import * as ipc from '../../core/ipc/commands';
import type { LocalSearchDrive } from '../../core/ipc/types';
import { TARGET_PLATFORM, USES_WINDOWS_PATHS } from '../../core/platform';
import { formatShortcut } from '../../core/shortcuts';
import { useLocalSearchSettings, useSettingsStore } from '../../stores/settingsStore';
import { useSyncStore } from '../../stores/syncStore';
import { showToast } from '../../stores/toastStore';
import { Tooltip } from '../../components/Tooltip';
import { canManageInstance } from '../account/accountState';
import { useLocalSearchStore } from './localSearchStore';
import './localSearch.css';

/** 路径比较键：Windows 忽略大小写与分隔符差异，并去掉末尾分隔符（盘符根除外） */
function rootKey(path: string): string {
  let p = path.trim();
  if (USES_WINDOWS_PATHS) p = p.replace(/\//g, '\\').toLowerCase();
  if (p.length > 3 && /[\\/]$/.test(p)) p = p.slice(0, -1);
  return p;
}

/** 合并新位置：保持原有顺序，忽略重复 */
export function mergeRoots(current: string[], added: string[]): string[] {
  const result = [...current];
  for (const path of added) {
    if (path.trim() && !result.some((r) => rootKey(r) === rootKey(path))) result.push(path.trim());
  }
  return result;
}

/** 当前的同步文件夹（同步配置尚未加载时先加载） */
async function currentSyncRoot(): Promise<string> {
  const store = useSyncStore.getState();
  if (!store.config) {
    try {
      await store.init();
    } catch {
      // 读取同步配置失败时视为未设置
    }
  }
  return useSyncStore.getState().config?.sync.rootDir?.trim() ?? '';
}

/** 磁盘根路径识别（用于显示磁盘图标） */
function isDriveRoot(path: string): boolean {
  return /^[a-zA-Z]:[\\/]?$/.test(path) || path === '/' || /^\/Volumes\/[^/]+\/?$/.test(path);
}

export function LocalSearchSettingsCard() {
  const { enabled, roots } = useLocalSearchSettings();
  const setLocalSearch = useSettingsStore((s) => s.setLocalSearch);
  const syncRoot = useSyncStore((s) => s.config?.sync.rootDir?.trim() ?? '');

  /** 开关：首次开启且没有任何位置时，默认索引同步文件夹 */
  const handleToggle = async (on: boolean) => {
    if (on && roots.length === 0) {
      const sync = await currentSyncRoot();
      await setLocalSearch({ enabled: true, roots: sync ? [sync] : [] });
      return;
    }
    await setLocalSearch({ enabled: on });
  };

  const handleAddFolders = async () => {
    const picked = TARGET_PLATFORM === 'linux'
      ? await ipc.openLinuxPathDialog(true)
      : await open({ directory: true, multiple: true });
    const list = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (list.length === 0) return;
    await setLocalSearch({ roots: mergeRoots(roots, list) });
  };

  const handleAddDrive = async (drive: LocalSearchDrive) => {
    await setLocalSearch({ roots: mergeRoots(roots, [drive.path]) });
  };

  const handleRemove = async (path: string) => {
    await setLocalSearch({ roots: roots.filter((r) => r !== path) });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '18px 20px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13 }}>
            <Search size={15} color="var(--accent-strong)" />
            <span>本地文件搜索</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--editor-text-muted)', marginTop: 4 }}>
            {formatShortcut('Ctrl + Shift + F')} 搜索文件名与内容
          </div>
        </div>
        <input
          type="checkbox"
          aria-label="本地文件搜索"
          checked={enabled}
          onChange={(e) => void handleToggle(e.target.checked)}
        />
      </div>

      {enabled && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 12.5, fontWeight: 500 }}>索引位置</div>
            <div className="nb-ls-settings-roots">
              {roots.length === 0 ? (
                <div className="nb-ls-settings-empty">尚未添加位置</div>
              ) : (
                roots.map((path) => (
                  <div key={path} className="nb-ls-settings-root">
                    {isDriveRoot(path)
                      ? <HardDrive size={15} color="var(--editor-text-muted)" style={{ flexShrink: 0 }} />
                      : <Folder size={15} color="#f59e0b" style={{ flexShrink: 0 }} />}
                    <Tooltip content={path} side="top" sideOffset={4}>
                      <span className="nb-ls-settings-root-path">{path}</span>
                    </Tooltip>
                    {syncRoot && rootKey(syncRoot) === rootKey(path) && <span className="nb-ls-settings-tag">同步文件夹</span>}
                    <Tooltip content="移除" side="top" sideOffset={4}>
                      <button type="button" className="nb-ls-icon-btn" aria-label={`移除 ${path}`} onClick={() => void handleRemove(path)}>
                        <X size={14} />
                      </button>
                    </Tooltip>
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="nb-ls-settings-actions">
            <button type="button" className="nb-btn-secondary" onClick={() => void handleAddFolders()}>
              <FolderPlus size={14} />
              添加文件夹
            </button>
            <DriveMenu added={roots} onPick={(d) => void handleAddDrive(d)} />
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 网页端：全局搜索由管理员开启，索引所有用户的笔记；每人只能搜到自己有权查看的内容。
 * 普通用户只读显示当前状态。
 */
export function WebSearchSettingsCard() {
  const available = useLocalSearchStore((s) => s.webAvailable);
  const enabled = useLocalSearchStore((s) => s.webEnabled);
  const [saving, setSaving] = useState(false);
  const manageable = canManageInstance();

  const handleToggle = async (on: boolean) => {
    setSaving(true);
    try {
      const result = await ipc.setWebSearchEnabled(on);
      useLocalSearchStore.getState().setWebState({ enabled: result });
    } catch (error) {
      showToast(`设置失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const hint = !available
    ? '当前部署未包含搜索服务'
    : manageable
      ? '索引所有用户的笔记，每人只能搜到有权查看的内容'
      : '由管理员开启或关闭';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '18px 20px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13 }}>
            <Search size={15} color="var(--accent-strong)" />
            <span>全局搜索</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--editor-text-muted)', marginTop: 4 }}>
            {formatShortcut('Ctrl + Shift + F')} 搜索文件名与内容 · {hint}
          </div>
        </div>
        <input
          type="checkbox"
          aria-label="全局搜索"
          checked={enabled}
          disabled={!available || !manageable || saving}
          onChange={(e) => void handleToggle(e.target.checked)}
        />
      </div>
    </div>
  );
}

/** 「添加磁盘」下拉：打开时读取磁盘列表，已添加的磁盘打勾且不可重复添加 */
function DriveMenu({ added, onPick }: { added: string[]; onPick: (drive: LocalSearchDrive) => void }) {
  const [open, setOpen] = useState(false);
  const [drives, setDrives] = useState<LocalSearchDrive[] | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({ left: rect.left, top: rect.bottom + 4 });
    setOpen(true);
    ipc.localSearchDrives().then(setDrives, (error) => {
      setDrives([]);
      showToast(`无法读取磁盘列表：${error instanceof Error ? error.message : String(error)}`, 'error');
    });
  };

  // 下方空间不足时向上展开
  useLayoutEffect(() => {
    if (!open || !position) return;
    const trigger = triggerRef.current?.getBoundingClientRect();
    const menu = menuRef.current?.getBoundingClientRect();
    if (!trigger || !menu) return;
    if (menu.bottom > window.innerHeight && trigger.top > window.innerHeight - trigger.bottom) {
      setPosition({ left: trigger.left, top: trigger.top - 4 - menu.height });
    }
  }, [open, position, drives]);

  // 点击外部、滚动或按 Esc 收起
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node && (!!menuRef.current?.contains(target) || !!triggerRef.current?.contains(target));
    const onPointer = (e: PointerEvent) => { if (!inside(e.target)) setOpen(false); };
    const onScroll = (e: Event) => { if (!inside(e.target)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 只收起菜单，不关闭设置弹窗
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <>
      <button ref={triggerRef} type="button" className="nb-btn-secondary" aria-expanded={open} onClick={toggle}>
        <HardDrive size={14} />
        添加磁盘
        <ChevronDown size={13} />
      </button>
      {open && position && createPortal(
        <div ref={menuRef} role="menu" className="nb-settings-select-menu" style={{ left: position.left, top: position.top, minWidth: 180 }}>
          {drives === null ? (
            <div className="nb-ls-settings-empty">读取中</div>
          ) : drives.length === 0 ? (
            <div className="nb-ls-settings-empty">没有可添加的磁盘</div>
          ) : (
            drives.map((drive) => {
              const isAdded = added.some((r) => rootKey(r) === rootKey(drive.path));
              return (
                <div
                  key={drive.path}
                  role="menuitem"
                  aria-disabled={isAdded}
                  className={`nb-settings-select-option nb-ls-drive-option${isAdded ? ' is-selected' : ''}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    if (isAdded) return;
                    setOpen(false);
                    onPick(drive);
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <HardDrive size={14} color="var(--editor-text-muted)" />
                    {drive.label}
                  </span>
                  {isAdded && <Check size={14} className="nb-settings-select-check" />}
                </div>
              );
            })
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
