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
  SystemSettings,
  TitleBarButtons,
  LocalSearchSettings,
  CustomColorKind,
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
import { useFontPackStore } from './fontPackStore';
import { DEFAULT_CREATE_FORMATS } from '../features/welcome/createFormats';

// ── 默认值 ──

/** 标题栏可选按钮默认全部展示 */
export const DEFAULT_TITLE_BAR_BUTTONS: TitleBarButtons = {
  home: true,
  checkUpdate: true,
  theme: true,
  compactMode: true,
};

/** 读取标题栏按钮开关：旧配置缺字段时按默认展示补齐 */
export function useTitleBarButtons(): TitleBarButtons {
  const saved = useSettingsStore((s) => s.settings.layout?.titleBarButtons);
  return { ...DEFAULT_TITLE_BAR_BUTTONS, ...saved };
}

// 自动保存间隔（毫秒）：默认 1 秒，可调范围 0.2 ~ 60 秒
export const AUTO_SAVE_DELAY_DEFAULT_MS = 1000;
export const AUTO_SAVE_DELAY_MIN_MS = 200;
export const AUTO_SAVE_DELAY_MAX_MS = 60_000;

/** 把任意输入规整为合法的自动保存间隔；非法值回到默认 1 秒 */
export function clampAutoSaveDelayMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return AUTO_SAVE_DELAY_DEFAULT_MS;
  return Math.min(AUTO_SAVE_DELAY_MAX_MS, Math.max(AUTO_SAVE_DELAY_MIN_MS, Math.round(value)));
}

/** 编辑器定时器调用：读取当前设置中的自动保存间隔（旧配置缺字段时为 1 秒） */
export function getAutoSaveDelayMs(): number {
  return clampAutoSaveDelayMs(useSettingsStore.getState().settings.file?.autoSaveDelayMs);
}

// 网页适配层复用同一套默认值，避免新部署和桌面端的设置模型逐渐分叉。
export const DEFAULT_SETTINGS: Settings = {
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
    contentParagraphSpacing: 14,
    monoLineHeight: 1.5,
    contentWidth: 'wide',
    monoContentWidth: 'full',
    monoPaddingY: 16,
    monoPaddingX: 24,
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
    enableColumnEdit: true,
    codeBlockDefaultExpanded: true,
    detailsDefaultExpanded: false,
    swapEnterKeys: false,
    mindmapNodeMaxWidth: 280,
    mindmapTextAlign: 'left',
    mindmapImageFit: 'original',
  },
  file: {
    autoSaveMarkdown: false,
    autoSaveBoard: false,
    autoSaveOther: false,
    autoSaveMindmap: false,
    autoSaveDrawio: false,
    autoSaveBitable: false,
    autoSaveDelayMs: AUTO_SAVE_DELAY_DEFAULT_MS,
    forceManualSave: false,
    showHiddenFiles: false,
    restoreSession: true,
    restoreReadingPosition: true,
    imageDirName: 'img',
    largeFileConfirmMb: 50,
    // Rust 不可用时以空值降级；桌面端正常加载后会得到绝对默认路径。
    stagingDirectory: '',
    explorerOpenMode: 'double',
    htmlOpenMode: 'browser',
  },
  layout: {
    statusBarVisible: true,
    uiScale: 100,
    createFormats: {
      primary: [...DEFAULT_CREATE_FORMATS.primary],
      more: [...DEFAULT_CREATE_FORMATS.more],
    },
    titleBarButtons: { ...DEFAULT_TITLE_BAR_BUTTONS },
  },
  system: {
    closeToTray: false,
    showWindowShortcut: '',
    updateChannel: 'github',
    autoCheckUpdate: true,
  },
  localSearch: {
    enabled: false,
    roots: [],
  },
};

/** 每组最多固定的自定义颜色数，避免色板无限变长 */
export const CUSTOM_COLOR_LIMIT = 24;

const EMPTY_COLORS: string[] = [];

/** 读取某一用途下已固定的自定义颜色（旧配置缺字段时为空数组，引用稳定） */
export function useCustomColors(kind: CustomColorKind): string[] {
  return useSettingsStore((s) => s.settings.editor.customColors?.[kind]) ?? EMPTY_COLORS;
}

/** 固定一个自定义颜色：已存在则不重复添加，超出上限时丢弃最早的 */
export function pinCustomColor(kind: CustomColorKind, color: string): void {
  const value = color.toLowerCase();
  const store = useSettingsStore.getState();
  const current = store.settings.editor.customColors ?? {};
  const list = current[kind] ?? [];
  if (list.includes(value)) return;
  const next = [...list, value].slice(-CUSTOM_COLOR_LIMIT);
  void store.setEditor({ customColors: { ...current, [kind]: next } });
}

/** 取消固定一个自定义颜色（不影响已经使用该颜色的内容） */
export function unpinCustomColor(kind: CustomColorKind, color: string): void {
  const value = color.toLowerCase();
  const store = useSettingsStore.getState();
  const current = store.settings.editor.customColors ?? {};
  const list = current[kind] ?? [];
  if (!list.includes(value)) return;
  void store.setEditor({ customColors: { ...current, [kind]: list.filter((c) => c !== value) } });
}

/** 读取本地文件搜索设置：旧配置缺字段时按默认关闭补齐 */
export function useLocalSearchSettings(): LocalSearchSettings {
  const saved = useSettingsStore((s) => s.settings.localSearch);
  return { enabled: saved?.enabled ?? false, roots: saved?.roots ?? [] };
}

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

  // ── 系统集成（托盘 / 全局快捷键）──
  setSystem: (patch: Partial<SystemSettings>) => Promise<void>;

  // ── 本地文件搜索 ──
  setLocalSearch: (patch: Partial<LocalSearchSettings>) => Promise<void>;

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
      // 🔴 R11：设置读取与字体服务完全解耦——不再 Promise.all 等待字体 init；
      // 字体服务由 App 独立启动（fire-and-forget），verifying/激活不阻塞设置与渲染。
      const loaded = await ipc.loadSettings();
      // 字体服务独立启动（失败不影响设置加载）
      void useFontPackStore.getState().init().catch((e) => {
        console.error('字体服务初始化失败:', e);
      });
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
      // 关闭最近窗口恢复功能时同步清理旧快照，重新开启不会意外恢复过期标签。
      if (patch.restoreSession === false) {
        await ipc.clearSession();
      }
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

  setSystem: async (patch) => {
    const current = get().settings;
    const updated: Settings = {
      ...current,
      system: { ...current.system, ...patch },
    };
    set({ settings: updated });
    try {
      await ipc.saveSettings(updated);
    } catch (e) {
      console.error('保存设置失败:', e);
    }
  },

  setLocalSearch: async (patch) => {
    const current = get().settings;
    const updated: Settings = {
      ...current,
      localSearch: { enabled: false, roots: [], ...current.localSearch, ...patch },
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
