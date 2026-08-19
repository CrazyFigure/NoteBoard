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

  // 处理特定物理按键码（如 Slash/NumpadDivide，防止输入法等环境干扰导致 e.key 非预期）
  if (e.code === 'Slash' || e.code === 'NumpadDivide') {
    parts.push('/');
  } else {
    parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
  }
  return parts.join('+');
}

/** 判定是否为应屏蔽的浏览器默认系统/导航/刷新快捷键 */
export function shouldPreventBrowserDefault(e: KeyboardEvent): boolean {
  const key = e.key;
  const ctrlOrMeta = e.ctrlKey || e.metaKey;

  // 1. 刷新类: F5, Ctrl+R, Ctrl+Shift+R, Ctrl+F5
  if (key === 'F5' || (ctrlOrMeta && (key === 'r' || key === 'R'))) {
    return true;
  }

  // 2. 开发者工具与源码: F12, Ctrl+U, Ctrl+Shift+I/J/C
  if (
    key === 'F12' ||
    (ctrlOrMeta && (key === 'u' || key === 'U')) ||
    (ctrlOrMeta && e.shiftKey && ['I', 'i', 'J', 'j', 'C', 'c'].includes(key))
  ) {
    return true;
  }

  // 3. 浏览器查找与搜索: Ctrl+F, F3, Shift+F3, Ctrl+G, Ctrl+Shift+G
  if (
    key === 'F3' ||
    (ctrlOrMeta && (key === 'f' || key === 'F' || key === 'g' || key === 'G'))
  ) {
    return true;
  }

  // 4. 浏览器其他外壳功能: Ctrl+P(打印), Ctrl+H(历史), Ctrl+J(下载), Ctrl+D(收藏), Ctrl+T(新建标签), Ctrl+Shift+T, Ctrl+W(关闭网页), Ctrl+S(保存网页), Ctrl+O(打开本地网页)
  if (
    ctrlOrMeta &&
    ['p', 'P', 'h', 'H', 'j', 'J', 'd', 'D', 't', 'T', 'w', 'W', 's', 'S', 'o', 'O'].includes(key)
  ) {
    return true;
  }

  // 5. 辅助与光标浏览: F7
  if (key === 'F7') {
    return true;
  }

  // 6. 浏览器后退/前进导航: Alt+Left, Alt+Right
  if (e.altKey && (key === 'ArrowLeft' || key === 'ArrowRight')) {
    return true;
  }

  // 7. 非输入区域的 Backspace 键导致页面后退
  if (key === 'Backspace') {
    const target = e.target as HTMLElement | null;
    const isEditable =
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable ||
        Boolean(target.closest('.cm-editor')) ||
        Boolean(target.closest('.ProseMirror')));
    if (!isEditable) {
      return true;
    }
  }

  return false;
}

/** 初始化全局键盘监听 */
export function initShortcuts(): () => void {
  const handler = (e: KeyboardEvent) => {
    // 优先阻止浏览器默认行为
    if (shouldPreventBrowserDefault(e)) {
      e.preventDefault();
    }

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
