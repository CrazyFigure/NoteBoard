// NoteBoard settingsStore
// 跨窗口同步的唯一 store
// 详见 docs/05-ADR/ADR-010-状态管理与跨窗口同步.md §1/§8

import { create } from 'zustand';
import type {
  Settings,
  ThemeId,
  ThemeMode,
  TypographySettings,
  EditorSettings,
  FileSettings,
  LayoutSettings,
} from '../core/ipc/types';
import * as ipc from '../core/ipc/commands';
import { onSettingsChanged } from '../core/ipc/events';
import {
  resolveTheme,
  applyTheme,
  applyTypography,
  startSystemThemeListener,
  stopSystemThemeListener,
} from '../core/theme/applyTheme';

// ── 默认值 ──

const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 1,
  revision: 0,
  appearance: {
    themeMode: 'system',
    systemLightTheme: 'chen-guang',
    systemDarkTheme: 'mo-ye',
  },
  typography: {
    contentFontFamily: '',
    contentFontFamilyZh: '',
    monoFontFamily: 'JetBrains Mono',
    monoFontFamilyZh: 'Maple Mono Normal NF CN',
    contentFontSize: 16,
    monoFontSize: 14,
    contentLineHeight: 1.7,
    monoLineHeight: 1.5,
    contentWidth: 'wide',
    monoContentWidth: 'full',
    explorerFontFamily: '',
    explorerFontFamilyZh: '',
    explorerFontSize: 13,
    explorerLineHeight: 24,
    uiFontFamily: '',
    uiFontFamilyZh: '',
    uiFontSize: 13,
  },
  editor: {
    defaultViewMode: 'visual',
    softWrap: true,
    showLineNumbers: true,
    showIndentGuides: true,
    tabSize: 2,
    insertSpaces: true,
    enableMath: true,
    enableMermaid: true,
    enableAlerts: true,
    enableBlockHandle: true,
    showWhitespace: false,
    showLineEndings: false,
  },
  file: {
    autoSaveMarkdown: false,
    autoSaveBoard: false,
    autoSaveOther: false,
    forceManualSave: false,
    showHiddenFiles: false,
    restoreSession: true,
    imageDirName: 'img',
    largeFileConfirmMb: 50,
  },
  layout: {
    statusBarVisible: true,
    uiScale: 100,
  },
};

// ── Store 类型 ──

interface SettingsStore {
  /** 全量设置（从 Rust 加载） */
  settings: Settings;
  /** 当前已解析的主题 ID（system → 实际值） */
  resolvedTheme: ThemeId;
  /** 是否已初始化 */
  initialized: boolean;

  // ── 初始化 ──
  init: () => Promise<void>;

  // ── 主题 ──
  setThemeMode: (mode: ThemeMode) => Promise<void>;
  setSystemLightTheme: (theme: ThemeId) => Promise<void>;
  setSystemDarkTheme: (theme: ThemeId) => Promise<void>;

  // ── 排版 ──
  setTypography: (patch: Partial<TypographySettings>) => Promise<void>;

  // ── 编辑器 ──
  setEditor: (patch: Partial<EditorSettings>) => Promise<void>;

  // ── 文件 ──
  setFile: (patch: Partial<FileSettings>) => Promise<void>;

  // ── 布局 ──
  setLayout: (patch: Partial<LayoutSettings>) => Promise<void>;

  // ── 内部：从广播更新 ──
  _applyRemoteUpdate: (s: Settings) => void;
}

// ── 辅助：解析主题并应用 ──

function resolveAndApply(s: Settings): ThemeId {
  const resolved = resolveTheme(
    s.appearance.themeMode,
    s.appearance.systemLightTheme,
    s.appearance.systemDarkTheme,
  );
  applyTheme(resolved);
  applyTypography(s.typography);
  return resolved;
}

// ── 创建 store ──

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  resolvedTheme: 'chen-guang',
  initialized: false,

  init: async () => {
    if (get().initialized) return;

    try {
      const loaded = await ipc.loadSettings();
      const resolved = resolveAndApply(loaded);
      set({ settings: loaded, resolvedTheme: resolved, initialized: true });

      // 系统主题跟随监听
      startSystemThemeListener(
        () => get().settings.appearance.themeMode === 'system',
        loaded.appearance.systemLightTheme,
        loaded.appearance.systemDarkTheme,
        (newResolved) => set({ resolvedTheme: newResolved }),
      );

      // 跨窗口同步：监听 nb://settings-changed
      onSettingsChanged((remote) => {
        const current = get().settings.revision;
        // revision 去重：只有更大的 revision 才应用
        if (remote.revision > current) {
          get()._applyRemoteUpdate(remote);
        }
      });
    } catch (e) {
      // Rust 不可用时用默认值
      console.error('加载设置失败:', e);
      const resolved = resolveAndApply(DEFAULT_SETTINGS);
      set({ settings: DEFAULT_SETTINGS, resolvedTheme: resolved, initialized: true });
    }
  },

  setThemeMode: async (mode) => {
    const current = get().settings;
    const updated: Settings = {
      ...current,
      appearance: { ...current.appearance, themeMode: mode },
    };
    // 乐观更新
    const resolved = resolveAndApply(updated);
    set({ settings: updated, resolvedTheme: resolved });

    // 重启系统监听（因为 isSystem 回调可能变了）
    stopSystemThemeListener();
    if (mode === 'system') {
      startSystemThemeListener(
        () => get().settings.appearance.themeMode === 'system',
        updated.appearance.systemLightTheme,
        updated.appearance.systemDarkTheme,
        (newResolved) => set({ resolvedTheme: newResolved }),
      );
    }

    // 落盘 + 广播
    try {
      await ipc.saveSettings(updated);
    } catch (e) {
      console.error('保存设置失败:', e);
    }
  },

  setSystemLightTheme: async (theme) => {
    const current = get().settings;
    const updated: Settings = {
      ...current,
      appearance: { ...current.appearance, systemLightTheme: theme },
    };
    const resolved = resolveAndApply(updated);
    set({ settings: updated, resolvedTheme: resolved });
    try {
      await ipc.saveSettings(updated);
    } catch (e) {
      console.error('保存设置失败:', e);
    }
  },

  setSystemDarkTheme: async (theme) => {
    const current = get().settings;
    const updated: Settings = {
      ...current,
      appearance: { ...current.appearance, systemDarkTheme: theme },
    };
    const resolved = resolveAndApply(updated);
    set({ settings: updated, resolvedTheme: resolved });
    try {
      await ipc.saveSettings(updated);
    } catch (e) {
      console.error('保存设置失败:', e);
    }
  },

  setTypography: async (patch) => {
    const current = get().settings;
    const updated: Settings = {
      ...current,
      typography: { ...current.typography, ...patch },
    };
    applyTypography(updated.typography);
    set({ settings: updated });
    try {
      await ipc.saveSettings(updated);
    } catch (e) {
      console.error('保存设置失败:', e);
    }
  },

  setEditor: async (patch) => {
    const current = get().settings;
    const updated: Settings = {
      ...current,
      editor: { ...current.editor, ...patch },
    };
    set({ settings: updated });
    try {
      await ipc.saveSettings(updated);
    } catch (e) {
      console.error('保存设置失败:', e);
    }
  },

  setFile: async (patch) => {
    const current = get().settings;
    const updated: Settings = {
      ...current,
      file: { ...current.file, ...patch },
    };
    set({ settings: updated });
    // 动态同步所有已打开文档的保存策略
    try {
      const { useDocumentStore } = await import('./documentStore');
      useDocumentStore.getState().syncSavePolicies();
    } catch {
      // ignore
    }
    try {
      await ipc.saveSettings(updated);
    } catch (e) {
      console.error('保存设置失败:', e);
    }
  },

  setLayout: async (patch) => {
    const current = get().settings;
    const updated: Settings = {
      ...current,
      layout: { ...current.layout, ...patch },
    };
    set({ settings: updated });
    try {
      await ipc.saveSettings(updated);
    } catch (e) {
      console.error('保存设置失败:', e);
    }
  },

  _applyRemoteUpdate: async (remote) => {
    const resolved = resolveAndApply(remote);
    set({ settings: remote, resolvedTheme: resolved });
    try {
      const { useDocumentStore } = await import('./documentStore');
      useDocumentStore.getState().syncSavePolicies();
    } catch {
      // ignore
    }
  },
}));
