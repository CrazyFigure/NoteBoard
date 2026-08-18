// NoteBoard 快捷键框架
// 注册表 + 作用域（编辑器聚焦 vs 全局）+ Ctrl+B 冲突解决
// 详见 docs/07-UI布局与交互规范.md §9

type ShortcutScope = 'global' | 'editor' | 'explorer' | 'outline';

interface ShortcutEntry {
  /** 如 'Ctrl+S'、'Ctrl+K Ctrl+O'（chord） */
  key: string;
  action: () => void;
  scope: ShortcutScope;
  /** 描述（用于设置界面只读列表） */
  description: string;
  /** 是否阻止默认行为 */
  preventDefault?: boolean;
}

const registry: ShortcutEntry[] = [];
let activeScope: ShortcutScope = 'global';

/** 设置当前快捷键作用域（编辑器聚焦时切换为 'editor'） */
export function setShortcutScope(scope: ShortcutScope): void {
  activeScope = scope;
}

/** 注册快捷键 */
export function registerShortcut(entry: ShortcutEntry): () => void {
  registry.push(entry);
  return () => {
    const idx = registry.indexOf(entry);
    if (idx >= 0) registry.splice(idx, 1);
  };
}

/** 将 KeyboardEvent 转换为快捷键字符串 */
function eventToKey(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  if (e.metaKey) parts.push('Meta');
  parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
  return parts.join('+');
}

/** 初始化全局键盘监听 */
export function initShortcuts(): () => void {
  const handler = (e: KeyboardEvent) => {
    const key = eventToKey(e);
    // 按作用域优先级查找：当前作用域 > global
    const entries = registry.filter(
      (entry) => entry.key === key && (entry.scope === activeScope || entry.scope === 'global'),
    );
    // 作用域优先：editor/explorer/outline > global
    const scoped = entries.find((entry) => entry.scope === activeScope);
    const global = entries.find((entry) => entry.scope === 'global');
    const match = scoped ?? global;
    if (match) {
      if (match.preventDefault !== false) e.preventDefault();
      match.action();
    }
  };

  window.addEventListener('keydown', handler, true);
  return () => window.removeEventListener('keydown', handler, true);
}

/** 获取全部已注册的快捷键（用于设置界面只读列表） */
export function getRegisteredShortcuts(): readonly ShortcutEntry[] {
  return registry;
}
