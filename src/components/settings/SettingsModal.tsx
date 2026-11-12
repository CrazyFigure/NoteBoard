// NoteBoard 设置中心模态弹窗
// 通用 / 外观 / 排版与字体 / 编辑器 / 文件与保存 / 同步与备份 / 历史记录 / 插件和字体 / 快捷键 / 关于，左栏顶部提供设置搜索
// 页名与搜索索引见 settingsSearchIndex.ts；详见 docs/06-主题与设计规范.md 及 docs/07-UI布局与交互规范.md

import { useState, useEffect, useRef } from 'react';
import { X, Palette, Type, Keyboard, Info, Check, FileText, FileCode, Folder, LayoutTemplate, RefreshCw, ExternalLink, Save, Image as ImageIcon, Cloud, ChevronRight, Monitor, History, PanelTop, UserRound, Users, Globe, RotateCcw, Search, RotateCw } from 'lucide-react';
import { AUTO_SAVE_DELAY_MAX_MS, AUTO_SAVE_DELAY_MIN_MS, DEFAULT_SETTINGS, clampAutoSaveDelayMs, useSettingsStore, useTitleBarButtons } from '../../stores/settingsStore';
import { ConfirmDialog } from '../../features/sync/SyncControls';
import { THEMES } from '../../core/theme/themes';
import { contentWidthToPercent, CONTENT_WIDTH_PERCENT_MAP } from '../../core/theme/applyTheme';
import { FontSelect } from './FontSelect';
import * as ipc from '../../core/ipc/commands';
import { useUpdateStore } from '../../stores/updateStore';
import { APP_VERSION } from '../../core/version';
import { open } from '@tauri-apps/plugin-dialog';
import { showToast } from '../../stores/toastStore';
import { FontPackSettingsCard } from './FontPackSettingsCard';
import { SettingsRange } from './SettingsRange';
import { SettingsSelect } from './SettingsSelect';
import { TabSizeSelect } from './TabSizeSelect';
import { ReleaseNotes } from './ReleaseNotes';
import { UPDATE_CHANNEL_ORDER, UpdateChannelSelector } from './UpdateChannelSelector';
import { AutoCheckUpdateToggle } from './AutoCheckUpdateToggle';
import { RELEASE_CHANNELS } from '../../core/releaseChannel';
import { Tooltip } from '../Tooltip';
import type { ExplorerOpenMode, HtmlOpenMode, TitleBarButtons } from '../../core/ipc/types';
import { IS_MOBILE_UI, IS_WEB } from '../../core/platform';
// 栏目元数据与设置搜索索引
import { SHOW_ACCOUNT, SHOW_SYNC, SUPPORTS_SYSTEM_INTEGRATION, TAB_LABELS, searchSettings, type SettingsSearchEntry, type TabType } from './settingsSearchIndex';
import { GlobalShortcutRecorder } from './GlobalShortcutRecorder';
import { formatShortcut, REPLACE_SHORTCUT } from '../../core/shortcuts';
// 设置窗口已在 App 中按需加载；同步面板及样式随窗口就绪，避免首次切换先显示加载占位。
import { SyncPanel } from '../../features/sync/SyncPanel';
// 插件管理随设置窗口加载，查看器重库仍由已安装包按需提供。
import { PluginsPanel } from '../../features/plugins/PluginsPanel';
// 网页多用户：账号与用户管理面板（原生端与公开部署不显示入口）
import { AccountPanel } from '../../features/account/AccountPanel';
import { UserManagementPanel } from '../../features/account/UserManagementPanel';
import { isAdmin } from '../../features/account/accountState';
// 历史记录设置随设置窗口加载（只含设置表单，不含查看界面）
import { HistorySettingsPanel } from '../../features/versionHistory/HistorySettingsPanel';
import { useLayoutStore } from '../../stores/layoutStore';
import { CreateFormatsSettings } from './CreateFormatsSettings';
import { supportsCompactMode } from '../../features/window/compactMode';
// 本地文件搜索设置（仅桌面端展示）
import { LocalSearchSettingsCard, WebSearchSettingsCard } from '../../features/localSearch/LocalSearchSettings';
import { SUPPORTS_LOCAL_SEARCH } from '../../features/localSearch/localSearchStore';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

// 搜索命中后对目标设置项的高亮时长
const SETTING_FLASH_MS = 1600;

// 标题栏可隐藏的按钮：检查更新仅桌面端，极窄模式仅桌面端支持时提供
const TITLE_BAR_BUTTON_OPTIONS: { key: keyof TitleBarButtons; label: string; available: () => boolean }[] = [
  { key: 'home', label: '回到主界面', available: () => true },
  { key: 'checkUpdate', label: '检查更新', available: () => !IS_WEB },
  { key: 'theme', label: '切换主题', available: () => true },
  { key: 'compactMode', label: '极窄模式', available: supportsCompactMode },
];

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  // 「通用」位于导航首位，首次打开默认进入；同一会话内再次打开沿用上次查看的栏目
  const [activeTab, setActiveTab] = useState<TabType>('general');
  // 设置搜索：有查询内容时右侧显示匹配结果，选中后跳到对应栏目并高亮该设置项
  const [searchQuery, setSearchQuery] = useState('');
  const [flashTarget, setFlashTarget] = useState<{ id: string; seq: number } | null>(null);
  const searching = searchQuery.trim() !== '';
  const searchResults = searching ? searchSettings(searchQuery) : [];
  // 右侧实际渲染的栏目：显示搜索结果期间不渲染任何栏目
  const shownTab: TabType | null = searching ? null : activeTab;
  const settingsTarget = useLayoutStore((state) => state.settingsTarget);
  // 打开入口携带目标，字体按钮与缺少查看器的文件页均能直达安装区域。
  useEffect(() => {
    if (!isOpen || !settingsTarget) return;
    // 一次性定位优先于搜索结果
    setSearchQuery('');
    // 本地文件搜索面板的「前往设置」定位到通用页
    setActiveTab(settingsTarget === 'history' ? 'history' : settingsTarget === 'localSearch' ? 'general' : 'plugins');
  }, [isOpen, settingsTarget]);
  // 关闭后清除一次性定位，普通设置入口沿用上次查看的栏目。
  useEffect(() => { if (!isOpen && settingsTarget) useLayoutStore.setState({settingsTarget:null}); }, [isOpen, settingsTarget]);
  const { settings, resolvedTheme, setThemeMode, setTypography, setEditor, setFile, setLayout, setSystem } = useSettingsStore();
  const titleBarButtons = useTitleBarButtons();

  // 使用全局更新状态 Store
  const { checking: checkingUpdate, checkForUpdates } = useUpdateStore();

  // 执行检查更新逻辑（主动检查）
  const handleCheckForUpdates = () => {
    checkForUpdates(false);
  };

  // 在系统默认浏览器打开 GitHub / 腾讯云 CNB 仓库
  const handleOpenRepo = (url: string) => {
    ipc.openExternalUrl(url).catch((err) => {
      console.error('无法打开仓库链接:', err);
    });
  };

  /** 从系统目录选择器更新暂存位置，确保写入目标是明确的绝对路径。 */
  const handleChooseStagingDirectory = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === 'string') await setFile({ stagingDirectory: selected });
  };

  /** 默认路径由 Rust 统一计算，避免前端硬编码 Windows 用户目录。 */
  const handleResetStagingDirectory = async () => {
    const defaultDirectory = await ipc.getDefaultStagingDirectory();
    await setFile({ stagingDirectory: defaultDirectory });
  };

  /** 在资源管理器中打开暂存位置，设置错误时给出可见反馈。 */
  const handleOpenStagingDirectory = async () => {
    try {
      await ipc.openStagingDirectory();
    } catch (error) {
      showToast(`无法打开暂存区：${error instanceof Error ? error.message : String(error)}`, 'error', 5000);
    }
  };

  // 「恢复默认」确认框的目标分区，null 表示未打开
  const [resetTarget, setResetTarget] = useState<'typography' | 'editor' | null>(null);
  // 回车键互换已移入编辑器页的 Markdown 分组，恢复默认时随编辑器设置一并重置
  const isTypographyDefault = matchesDefaults(settings.typography, DEFAULT_SETTINGS.typography);
  const isEditorDefault = matchesDefaults(settings.editor, DEFAULT_SETTINGS.editor);

  /** 将确认的分区整体写回默认值 */
  const handleConfirmReset = async () => {
    const target = resetTarget;
    setResetTarget(null);
    if (target === 'typography') await setTypography({ ...DEFAULT_SETTINGS.typography });
    else if (target === 'editor') await setEditor({ ...DEFAULT_SETTINGS.editor });
    if (target) showToast('已恢复默认设置', 'success');
  };

  // 设置右侧内容区域的容器引用
  const contentRef = useRef<HTMLDivElement>(null);

  // 切换设置 Tab 栏目、进出搜索结果或重新打开设置时，重置右侧内容区域的竖向滚动条至顶部
  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = 0;
    }
  }, [activeTab, isOpen, searching]);

  /** 选中搜索结果：清空查询、切换栏目，并在下一帧定位高亮目标设置项 */
  const jumpToSetting = (entry: SettingsSearchEntry) => {
    setSearchQuery('');
    setActiveTab(entry.tab);
    setFlashTarget({ id: entry.id, seq: Date.now() });
  };

  // 定位放到下一帧：先让栏目渲染并完成上面的滚动归零，再滚动到目标（做法同 PluginsPanel）
  useEffect(() => {
    if (!flashTarget) return;
    let element: HTMLElement | null = null;
    let timer: number | undefined;
    const frame = requestAnimationFrame(() => {
      element = contentRef.current?.querySelector<HTMLElement>(`[data-setting-id="${flashTarget.id}"]`) ?? null;
      // 面板中未展示的条目（如未开启时隐藏的分区）只切换栏目
      if (!element) return;
      element.scrollIntoView?.({ block: 'center' });
      element.classList.add('nb-setting-flash');
      timer = window.setTimeout(() => element?.classList.remove('nb-setting-flash'), SETTING_FLASH_MS);
    });
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      element?.classList.remove('nb-setting-flash');
    };
  }, [flashTarget]);

  // 监听 Esc 键快速关闭设置模态弹窗
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  /** 栏目导航按钮：页名取自 TAB_LABELS；点击时退出搜索结果，显示搜索结果期间不高亮任何栏目 */
  const renderNavBtn = (tab: TabType, icon: React.ReactNode) => (
    <NavBtn
      active={!searching && activeTab === tab}
      icon={icon}
      label={TAB_LABELS[tab]}
      onClick={() => { setSearchQuery(''); setActiveTab(tab); }}
    />
  );

  const currentThemeMode = settings.appearance.themeMode;

  return (
    <div
      className="nb-settings-overlay"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 9990,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // 不用 backdrop-filter：全屏毛玻璃会让面板内每一帧滚动都扩大为整窗重绘并重新模糊，
        // WebView2 高 DPI 下滚动明显掉帧；改为略深的纯色遮罩维持层次感
        background: 'rgba(0, 0, 0, 0.5)',
      }}
    >
      <div
        className="nb-settings-panel"
        style={{
          width: 880,
          maxWidth: '92vw',
          height: 660,
          maxHeight: '88vh',
          background: 'var(--editor-bg)',
          border: '1px solid var(--editor-border)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-lg)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          color: 'var(--editor-text)',
          fontFamily: 'var(--ui-font-family)',
          fontSize: 'var(--ui-font-size)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶部标题栏 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 20px',
            borderBottom: '1px solid var(--editor-border)',
            background: 'var(--editor-surface)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <img src="/logo.ico" alt="NoteBoard" width={18} height={18} />
            <span style={{ fontWeight: 600, fontSize: 14 }}>NoteBoard 设置</span>
          </div>
          <Tooltip content="关闭设置" shortcut="Esc" side="bottom" sideOffset={4}>
            <button
              type="button"
              onClick={onClose}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--editor-text-muted)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 4,
                borderRadius: 'var(--radius-sm)',
                transition: 'all var(--transition-fast)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--toolbar-hover)';
                e.currentTarget.style.color = 'var(--editor-text)';
                e.currentTarget.style.transform = 'scale(1.08)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = 'var(--editor-text-muted)';
                e.currentTarget.style.transform = 'scale(1)';
              }}
              onMouseDown={(e) => {
                e.currentTarget.style.background = 'var(--toolbar-active)';
                e.currentTarget.style.transform = 'scale(0.92)';
              }}
              onMouseUp={(e) => {
                e.currentTarget.style.background = 'var(--toolbar-hover)';
                e.currentTarget.style.transform = 'scale(1.08)';
              }}
              aria-label="关闭设置"
            >
              <X size={16} />
            </button>
          </Tooltip>
        </div>

        {/* 主体两栏内容（移动端改为顶部横向导航 + 下方内容） */}
        <div className="nb-settings-body" style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* 左侧栏：顶部设置搜索 + 栏目导航 */}
          <div
            className="nb-settings-sidebar"
            style={{
              width: 165,
              borderRight: '1px solid var(--editor-border)',
              background: 'var(--editor-surface)',
              display: 'flex',
              flexDirection: 'column',
              flexShrink: 0,
              minHeight: 0,
            }}
          >
            <SettingsSearchBox
              value={searchQuery}
              onChange={setSearchQuery}
              onSubmit={() => { if (searchResults[0]) jumpToSetting(searchResults[0]); }}
            />
            <div
              className="nb-settings-nav"
              style={{
                padding: '6px 8px 14px',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
              }}
            >
              {SHOW_ACCOUNT() && (
                <>
                  {renderNavBtn('account', <UserRound size={15} />)}
                  {isAdmin() && renderNavBtn('users', <Users size={15} />)}
                  <div className="nb-settings-nav-divider" style={{ height: 1, background: 'var(--editor-border)', margin: '2px 6px' }} />
                </>
              )}
              {/* 通用：窗口与托盘、启动与会话、搜索、新建入口等跨编辑器的设置；托盘等仅原生桌面端在页内展示 */}
              {renderNavBtn('general', <Monitor size={15} />)}
              {renderNavBtn('appearance', <Palette size={15} />)}
              {renderNavBtn('typography', <Type size={15} />)}
              {renderNavBtn('editor', <FileCode size={15} />)}
              {renderNavBtn('file', <Folder size={15} />)}
              {SHOW_SYNC() && renderNavBtn('sync', <Cloud size={15} />)}
              {renderNavBtn('history', <History size={15} />)}
              {/* 插件管理在桌面、移动与网页端使用相同入口。 */}
              {renderNavBtn('plugins', <LayoutTemplate size={15} />)}
              {/* 移动端没有物理键盘快捷键，隐藏该分组 */}
              {!IS_MOBILE_UI && renderNavBtn('shortcuts', <Keyboard size={15} />)}
              {renderNavBtn('about', <Info size={15} />)}
            </div>
          </div>

          {/* 右侧设置面板 */}
          <div ref={contentRef} className="nb-settings-content" style={{ flex: 1, padding: '24px 30px', overflowY: 'auto' }}>
            {/* 0. 设置搜索结果：有查询内容时替代当前栏目 */}
            {searching && <SettingsSearchResults results={searchResults} onSelect={jumpToSetting} />}

            {/* 1. 外观：主题配色与标题栏按钮，主题卡片继续展示配色说明。 */}
            {shownTab === 'appearance' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                <div>
                  <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>主题配色方案</h3>
                </div>

                <div data-setting-id="theme" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
                  {/* 晨光 */}
                  <ThemeCard
                    title="晨光"
                    desc="清新明亮 · 晨曦蓝调"
                    bg="#ffffff"
                    accent="#3b82f6"
                    codeBg="#f8fafc"
                    codeColor="#1d4ed8"
                    selected={currentThemeMode === 'chen-guang'}
                    onClick={() => setThemeMode('chen-guang')}
                  />
                  {/* 琥珀 */}
                  <ThemeCard
                    title="琥珀"
                    desc="温暖纸质 · 琥珀赤陶"
                    bg="#FAF9F5"
                    accent="#D97757"
                    codeBg="#EFEEE9"
                    codeColor="#C2410C"
                    selected={currentThemeMode === 'hu-po'}
                    onClick={() => setThemeMode('hu-po')}
                  />
                  {/* 墨夜 */}
                  <ThemeCard
                    title="墨夜"
                    desc="墨色沉静 · 纯黑护眼"
                    bg="#111113"
                    accent="#60a5fa"
                    codeBg="#19191c"
                    codeColor="#a5c8fc"
                    selected={currentThemeMode === 'mo-ye'}
                    onClick={() => setThemeMode('mo-ye')}
                  />
                  {/* 跟随系统 */}
                  <ThemeCard
                    title="跟随系统"
                    desc={`当前生效: ${THEMES[resolvedTheme]?.displayName ?? resolvedTheme}`}
                    bg="linear-gradient(135deg, #ffffff 50%, #111113 50%)"
                    accent="#8b5cf6"
                    codeBg="#f1f5f9"
                    codeColor="#475569"
                    selected={currentThemeMode === 'system'}
                    onClick={() => setThemeMode('system')}
                  />
                </div>

                {/* 标题栏按钮：可选入口是否展示（移动端没有标题栏，不展示） */}
                {!IS_MOBILE_UI && (
                <div data-setting-id="titleBarButtons" style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '18px 20px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13 }}>
                    <PanelTop size={15} color="var(--accent-strong)" />
                    <span>标题栏按钮</span>
                  </div>

                  {TITLE_BAR_BUTTON_OPTIONS.filter((option) => option.available()).map((option) => (
                    <div key={option.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
                      <div>{option.label}</div>
                      <input
                        type="checkbox"
                        aria-label={`标题栏显示${option.label}`}
                        checked={titleBarButtons[option.key]}
                        onChange={(e) => setLayout({ titleBarButtons: { ...titleBarButtons, [option.key]: e.target.checked } })}
                      />
                    </div>
                  ))}
                </div>
                )}
              </div>
            )}

            {/* 2. 排版与字体：页级仅保留标题，具体排版规则由设置项说明。 */}
            {shownTab === 'typography' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>排版参数自定义</h3>
                  <ResetDefaultsButton disabled={isTypographyDefault} onClick={() => setResetTarget('typography')} />
                </div>

                {/* 应用字体包独立于安装包，设置页提供下载、修复、导入和删除的长期入口。 */}
                <div data-setting-id="fontPack">
                  <FontPackSettingsCard onOpen={() => { useLayoutStore.setState({settingsTarget:'fonts'}); setActiveTab('plugins'); }} />
                </div>

                {/* ── 2.1 软件界面 UI 排版 ── */}
                <div data-setting-id="uiFont" style={{ display: 'flex', flexDirection: 'column', gap: 18, padding: '18px 20px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13 }}>
                      <LayoutTemplate size={15} color="var(--accent-strong)" />
                      <span>软件界面 UI 排版 (全局界面 / 弹窗 / 提示 / 菜单)</span>
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>作用于标题栏、标签栏、设置中心、状态栏与全局 UI</span>
                  </div>

                  {/* 界面 UI 中西双字体配置 */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                    <div style={formRowStyle}>
                      <label style={labelStyle}>界面西文字体 (英文/数字)</label>
                      <FontSelect
                        value={settings.typography.uiFontFamily ?? ''}
                        filterType="en"
                        placeholder="系统默认西文字体 (如: Segoe UI, Inter)"
                        onChange={(font) => setTypography({ uiFontFamily: font })}
                      />
                    </div>
                    <div style={formRowStyle}>
                      <label style={labelStyle}>界面中文字体 (汉字/全角)</label>
                      <FontSelect
                        value={settings.typography.uiFontFamilyZh ?? ''}
                        filterType="zh"
                        placeholder="系统默认中文字体 (如: Microsoft YaHei UI, 苹方)"
                        onChange={(font) => setTypography({ uiFontFamilyZh: font })}
                      />
                    </div>
                  </div>

                  {/* 界面 UI 字号 */}
                  <div style={formRowStyle}>
                    <label style={labelStyle}>界面 UI 基础字号 ({settings.typography.uiFontSize ?? 13}px)</label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <SettingsRange
                        min="12"
                        max="18"
                        step="1"
                        value={settings.typography.uiFontSize ?? 13}
                        onChange={(e) => setTypography({ uiFontSize: parseInt(e.target.value, 10) })}
                        style={{ flex: 1, cursor: 'pointer' }}
                      />
                      <span style={{ fontSize: 12, color: 'var(--editor-text-muted)', minWidth: 36, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        {settings.typography.uiFontSize ?? 13}px
                      </span>
                    </div>
                  </div>

                  {/* 软件界面 UI 效果预览 */}
                  <PreviewCollapse>
                    <div
                      style={{
                        fontFamily: 'var(--ui-font-family)',
                        fontSize: settings.typography.uiFontSize ?? 13,
                        padding: '12px 16px',
                        background: 'var(--editor-bg)',
                        border: '1px solid var(--editor-border)',
                        borderRadius: 'var(--radius-sm)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 12,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontWeight: 600 }}>NoteBoard 界面</span>
                        <span style={{ fontSize: '0.88em', color: 'var(--editor-text-muted)' }}>提示信息：文档已就绪 (File Ready)</span>
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <span style={{ padding: '3px 8px', background: 'var(--editor-selection)', color: 'var(--accent-strong)', borderRadius: 'var(--radius-sm)', fontSize: '0.88em', fontWeight: 500 }}>
                          Active Tab 标签
                        </span>
                        <span style={{ padding: '3px 8px', background: 'var(--editor-surface)', border: '1px solid var(--editor-border)', borderRadius: 'var(--radius-sm)', fontSize: '0.88em' }}>
                          Action 按钮
                        </span>
                      </div>
                    </div>
                  </PreviewCollapse>
                </div>

                {/* ── 2.2 Markdown 正文排版 ── */}
                <div data-setting-id="contentFont" style={{ display: 'flex', flexDirection: 'column', gap: 18, padding: '18px 20px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13 }}>
                    <FileText size={15} color="var(--accent-strong)" />
                    <span>Markdown 正文排版</span>
                  </div>

                  {/* 正文中西双字体配置 */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                    <div style={formRowStyle}>
                      <label style={labelStyle}>正文西文字体 (英文/数字)</label>
                      <FontSelect
                        value={settings.typography.contentFontFamily}
                        filterType="en"
                        placeholder="系统默认西文字体 (如: Georgia, Inter, Segoe UI)"
                        onChange={(font) => setTypography({ contentFontFamily: font })}
                      />
                    </div>
                    <div style={formRowStyle}>
                      <label style={labelStyle}>正文中文字体 (汉字/全角)</label>
                      <FontSelect
                        value={settings.typography.contentFontFamilyZh ?? ''}
                        filterType="zh"
                        placeholder="系统默认中文字体 (如: 微软雅黑, 霞鹜文楷, 楷体)"
                        onChange={(font) => setTypography({ contentFontFamilyZh: font })}
                      />
                    </div>
                  </div>

                  {/* 正文字号与行高 */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                    <div style={formRowStyle}>
                      <label style={labelStyle}>正文字号 ({settings.typography.contentFontSize}px)</label>
                      <SettingsRange
                        min="12"
                        max="26"
                        step="1"
                        value={settings.typography.contentFontSize}
                        onChange={(e) => setTypography({ contentFontSize: parseInt(e.target.value, 10) })}
                        style={{ width: '100%' }}
                      />
                    </div>
                    <div data-setting-id="contentLineHeight" style={formRowStyle}>
                      <label style={labelStyle}>正文行高 ({settings.typography.contentLineHeight})</label>
                      <SettingsRange
                        min="1.3"
                        max="2.4"
                        step="0.1"
                        value={settings.typography.contentLineHeight}
                        onChange={(e) => setTypography({ contentLineHeight: parseFloat(e.target.value) })}
                        style={{ width: '100%' }}
                      />
                    </div>
                  </div>

                  {/* 正文段落间距：相邻段落（Enter 换段落）之间的空白高度；段内换行（Shift + Enter）不受影响 */}
                  <div data-setting-id="paragraphSpacing" style={formRowStyle}>
                    <label style={labelStyle}>正文段落间距 ({settings.typography.contentParagraphSpacing ?? 14}px)</label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <SettingsRange
                        min="0"
                        max="32"
                        step="1"
                        value={settings.typography.contentParagraphSpacing ?? 14}
                        onChange={(e) => setTypography({ contentParagraphSpacing: parseInt(e.target.value, 10) })}
                        style={{ flex: 1, cursor: 'pointer' }}
                      />
                      <span style={{ fontSize: 12, color: 'var(--editor-text-muted)', minWidth: 36, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        {settings.typography.contentParagraphSpacing ?? 14}px
                      </span>
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>
                      相邻段落之间的空白（Enter 换段落）；段内换行（Shift + Enter）没有段落间距
                    </span>
                  </div>

                  {/* Markdown 编辑区最大宽度 */}
                  <div data-setting-id="contentWidth" style={formRowStyle}>
                    <label style={labelStyle}>Markdown 编辑区最大宽度 (默认宽屏 92%)</label>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
                      {/* 预设档位按钮 */}
                      <div style={{ display: 'flex', gap: 10 }}>
                        {(['narrow', 'standard', 'wide', 'full'] as const).map((w) => {
                          const labels: Record<string, string> = {
                            narrow: '窄 (65%)',
                            standard: '标准 (80%)',
                            wide: '宽屏 (92%)',
                            full: '全宽 (100%)',
                          };
                          const currentMdWidth = settings.typography.contentWidth ?? 'wide';
                          const isSelected =
                            currentMdWidth === w ||
                            contentWidthToPercent(currentMdWidth) === CONTENT_WIDTH_PERCENT_MAP[w];
                          return (
                            <button
                              key={w}
                              type="button"
                              onClick={() => setTypography({ contentWidth: w })}
                              style={{
                                flex: 1,
                                padding: '7px 10px',
                                fontSize: 12,
                                borderRadius: 'var(--radius-sm)',
                                border: isSelected ? '1px solid var(--accent-strong)' : '1px solid var(--editor-border)',
                                background: isSelected ? 'var(--editor-selection)' : 'var(--editor-bg)',
                                color: 'var(--editor-text)',
                                cursor: 'pointer',
                                transition: 'all var(--transition-fast)',
                              }}
                              onMouseEnter={(e) => {
                                if (!isSelected) {
                                  e.currentTarget.style.background = 'var(--toolbar-hover)';
                                  e.currentTarget.style.borderColor = 'var(--editor-border-focus)';
                                }
                                e.currentTarget.style.transform = 'translateY(-1px)';
                              }}
                              onMouseLeave={(e) => {
                                if (!isSelected) {
                                  e.currentTarget.style.background = 'var(--editor-bg)';
                                  e.currentTarget.style.borderColor = 'var(--editor-border)';
                                }
                                e.currentTarget.style.transform = 'translateY(0)';
                              }}
                              onMouseDown={(e) => {
                                e.currentTarget.style.transform = 'translateY(0) scale(0.96)';
                              }}
                              onMouseUp={(e) => {
                                e.currentTarget.style.transform = 'translateY(-1px)';
                              }}
                            >
                              {labels[w]}
                            </button>
                          );
                        })}
                      </div>

                      {/* 滑动条自定义宽度调节 */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6 }}>
                        <SettingsRange
                          min="40"
                          max="100"
                          step="1"
                          value={contentWidthToPercent(settings.typography.contentWidth ?? 'wide')}
                          onChange={(e) => {
                            const val = `${e.target.value}%`;
                            setTypography({ contentWidth: val });
                          }}
                          style={{ flex: 1, cursor: 'pointer' }}
                        />
                        <span style={{ fontSize: 12, color: 'var(--editor-text-muted)', minWidth: 42, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                          {contentWidthToPercent(settings.typography.contentWidth ?? 'wide')}%
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Markdown 正文效果预览 */}
                  <PreviewCollapse>
                    <div
                      style={{
                        fontFamily: 'var(--content-font-family)',
                        fontSize: settings.typography.contentFontSize,
                        lineHeight: settings.typography.contentLineHeight,
                      }}
                    >
                      <p style={{ margin: 0 }}>
                        这是中英文正文排版效果（Typography Test: Quick Brown Fox 123），包含 <strong>加粗文本 Bold</strong>、<em>斜体 Italic</em> 与 <code style={{
                          background: 'var(--code-inline-bg)',
                          color: 'var(--code-inline-text)',
                          padding: '2px 6px',
                          borderRadius: 'var(--radius-sm)',
                          fontFamily: 'var(--mono-font-family)',
                          fontSize: '0.88em',
                          border: '1px solid var(--editor-border)',
                        }}>const note = "NoteBoard 2026";</code> 行内代码。
                      </p>
                      {/* 第二段：体现段落间距设置 */}
                      <p style={{ margin: `${settings.typography.contentParagraphSpacing ?? 14}px 0 0` }}>
                        这是第二个段落，与上一段之间的空白即「正文段落间距」。
                      </p>
                    </div>
                  </PreviewCollapse>
                </div>

                {/* ── 2.3 代码与纯文本排版 ── */}
                <div data-setting-id="monoFont" style={{ display: 'flex', flexDirection: 'column', gap: 18, padding: '18px 20px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13 }}>
                      <FileCode size={15} color="var(--accent-strong)" />
                      <span>代码与纯文本排版 (.sql / .txt / .json / 代码块)</span>
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>支持 Ctrl + 滚轮 快速缩放</span>
                  </div>

                  {/* 代码等宽中西双字体配置 */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                    <div style={formRowStyle}>
                      <label style={labelStyle}>代码西文等宽字体</label>
                      <FontSelect
                        value={settings.typography.monoFontFamily}
                        placeholder="Consolas, Cascadia Code, JetBrains Mono"
                        filterType="mono"
                        isMonospaceOnly={true}
                        onChange={(font) => setTypography({ monoFontFamily: font })}
                      />
                    </div>
                    <div style={formRowStyle}>
                      <label style={labelStyle}>代码中文等宽/中文字体</label>
                      <FontSelect
                        value={settings.typography.monoFontFamilyZh ?? ''}
                        placeholder="Microsoft YaHei UI, 微软雅黑, 等宽中文"
                        filterType="zh"
                        onChange={(font) => setTypography({ monoFontFamilyZh: font })}
                      />
                    </div>
                  </div>

                  {/* 代码字号与行高 */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                    <div style={formRowStyle}>
                      <label style={labelStyle}>代码字号 ({settings.typography.monoFontSize ?? 14}px)</label>
                      <SettingsRange
                        min="10"
                        max="24"
                        step="1"
                        value={settings.typography.monoFontSize ?? 14}
                        onChange={(e) => setTypography({ monoFontSize: parseInt(e.target.value, 10) })}
                        style={{ width: '100%' }}
                      />
                    </div>
                    <div style={formRowStyle}>
                      <label style={labelStyle}>代码行高 ({settings.typography.monoLineHeight ?? 1.5})</label>
                      <SettingsRange
                        min="1.2"
                        max="2.2"
                        step="0.1"
                        value={settings.typography.monoLineHeight ?? 1.5}
                        onChange={(e) => setTypography({ monoLineHeight: parseFloat(e.target.value) })}
                        style={{ width: '100%' }}
                      />
                    </div>
                  </div>

                  {/* 代码 / 纯文本 / MD 源码编辑区边距：文本与顶部、行号槽、右侧之间的留白 */}
                  <div data-setting-id="monoPadding" style={formRowStyle}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                      <div style={formRowStyle}>
                        <label style={labelStyle}>编辑区上下边距 ({settings.typography.monoPaddingY ?? 16}px)</label>
                        <SettingsRange
                          min="0"
                          max="48"
                          step="2"
                          value={settings.typography.monoPaddingY ?? 16}
                          onChange={(e) => setTypography({ monoPaddingY: parseInt(e.target.value, 10) })}
                          style={{ width: '100%' }}
                        />
                      </div>
                      <div style={formRowStyle}>
                        <label style={labelStyle}>编辑区左右边距 ({settings.typography.monoPaddingX ?? 24}px)</label>
                        <SettingsRange
                          min="0"
                          max="48"
                          step="2"
                          value={settings.typography.monoPaddingX ?? 24}
                          onChange={(e) => setTypography({ monoPaddingX: parseInt(e.target.value, 10) })}
                          style={{ width: '100%' }}
                        />
                      </div>
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>
                      同时作用于 MD 源码模式（行号侧取一半）
                    </span>
                  </div>

                  {/* 代码与纯文本编辑区最大宽度 */}
                  <div data-setting-id="monoWidth" style={formRowStyle}>
                    <label style={labelStyle}>代码 / 纯文本 / MD 源码编辑区最大宽度 (默认全宽 100%)</label>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
                      {/* 预设档位按钮 */}
                      <div style={{ display: 'flex', gap: 10 }}>
                        {(['narrow', 'standard', 'wide', 'full'] as const).map((w) => {
                          const labels: Record<string, string> = {
                            narrow: '窄 (65%)',
                            standard: '标准 (80%)',
                            wide: '宽屏 (92%)',
                            full: '全宽 (100%)',
                          };
                          const currentMonoWidth = settings.typography.monoContentWidth ?? 'full';
                          const isSelected =
                            currentMonoWidth === w ||
                            contentWidthToPercent(currentMonoWidth) === CONTENT_WIDTH_PERCENT_MAP[w];
                          return (
                            <button
                              key={w}
                              type="button"
                              onClick={() => setTypography({ monoContentWidth: w })}
                              style={{
                                flex: 1,
                                padding: '7px 10px',
                                fontSize: 12,
                                borderRadius: 'var(--radius-sm)',
                                border: isSelected ? '1px solid var(--accent-strong)' : '1px solid var(--editor-border)',
                                background: isSelected ? 'var(--editor-selection)' : 'var(--editor-bg)',
                                color: 'var(--editor-text)',
                                cursor: 'pointer',
                                transition: 'all var(--transition-fast)',
                              }}
                              onMouseEnter={(e) => {
                                if (!isSelected) {
                                  e.currentTarget.style.background = 'var(--toolbar-hover)';
                                  e.currentTarget.style.borderColor = 'var(--editor-border-focus)';
                                }
                                e.currentTarget.style.transform = 'translateY(-1px)';
                              }}
                              onMouseLeave={(e) => {
                                if (!isSelected) {
                                  e.currentTarget.style.background = 'var(--editor-bg)';
                                  e.currentTarget.style.borderColor = 'var(--editor-border)';
                                }
                                e.currentTarget.style.transform = 'translateY(0)';
                              }}
                              onMouseDown={(e) => {
                                e.currentTarget.style.transform = 'translateY(0) scale(0.96)';
                              }}
                              onMouseUp={(e) => {
                                e.currentTarget.style.transform = 'translateY(-1px)';
                              }}
                            >
                              {labels[w]}
                            </button>
                          );
                        })}
                      </div>

                      {/* 滑动条自定义宽度调节 */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6 }}>
                        <SettingsRange
                          min="40"
                          max="100"
                          step="1"
                          value={contentWidthToPercent(settings.typography.monoContentWidth ?? 'full')}
                          onChange={(e) => {
                            const val = `${e.target.value}%`;
                            setTypography({ monoContentWidth: val });
                          }}
                          style={{ flex: 1, cursor: 'pointer' }}
                        />
                        <span style={{ fontSize: 12, color: 'var(--editor-text-muted)', minWidth: 42, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                          {contentWidthToPercent(settings.typography.monoContentWidth ?? 'full')}%
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* 代码文件效果预览：模拟编辑区（行号槽 + 正文），体现字体、行高与编辑区边距 */}
                  <PreviewCollapse>
                    <div style={{
                      display: 'flex',
                      background: 'var(--editor-bg)',
                      border: '1px solid var(--editor-border)',
                      borderRadius: 'var(--radius-sm)',
                      overflow: 'hidden',
                      fontFamily: 'var(--mono-font-family)',
                      fontSize: settings.typography.monoFontSize ?? 14,
                      lineHeight: settings.typography.monoLineHeight ?? 1.5,
                    }}>
                      {/* 行号槽：上下边距与正文一致，保证行号与文本行对齐 */}
                      <div aria-hidden style={{
                        padding: `${settings.typography.monoPaddingY ?? 16}px 8px ${settings.typography.monoPaddingY ?? 16}px 12px`,
                        background: 'var(--cm-gutter-bg)',
                        color: 'var(--cm-gutter-text)',
                        borderRight: '1px solid var(--editor-border)',
                        textAlign: 'right',
                        userSelect: 'none',
                        flexShrink: 0,
                      }}>
                        {[1, 2, 3, 4].map((n) => <div key={n}>{n}</div>)}
                      </div>
                      <pre className="nb-typography-code-preview" style={{
                        flex: 1,
                        minWidth: 0,
                        margin: 0,
                        padding: `${settings.typography.monoPaddingY ?? 16}px ${settings.typography.monoPaddingX ?? 24}px`,
                        overflowX: 'auto',
                        font: 'inherit',
                        color: 'var(--editor-text)',
                      }}>
                        <code>{`-- 查询笔记表（中西文代码混排测试）\nSELECT id, title, created_at\nFROM notes\nWHERE status = 'active' -- 仅查询有效笔记;`}</code>
                      </pre>
                    </div>
                  </PreviewCollapse>
                </div>

                {/* ── 2.5 文件树排版（资源管理器） ── */}
                <div data-setting-id="explorerFont" style={{ display: 'flex', flexDirection: 'column', gap: 18, padding: '18px 20px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13 }}>
                      <Folder size={15} color="var(--accent-strong)" />
                      <span>文件树排版 (左侧资源管理器)</span>
                    </div>
                  </div>

                  {/* 文件树中西双字体配置 */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                    <div style={formRowStyle}>
                      <label style={labelStyle}>文件树西文字体</label>
                      <FontSelect
                        value={settings.typography.explorerFontFamily ?? ''}
                        filterType="en"
                        placeholder="系统界面默认 (如: Segoe UI, Arial)"
                        onChange={(font) => setTypography({ explorerFontFamily: font })}
                      />
                    </div>
                    <div style={formRowStyle}>
                      <label style={labelStyle}>文件树中文字体</label>
                      <FontSelect
                        value={settings.typography.explorerFontFamilyZh ?? ''}
                        filterType="zh"
                        placeholder="系统界面默认 (如: Microsoft YaHei UI, 苹方)"
                        onChange={(font) => setTypography({ explorerFontFamilyZh: font })}
                      />
                    </div>
                  </div>

                  {/* 文件树字号与行高 */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                    <div style={formRowStyle}>
                      <label style={labelStyle}>文件树字号 ({settings.typography.explorerFontSize ?? 13}px)</label>
                      <SettingsRange
                        min="11"
                        max="18"
                        step="1"
                        value={settings.typography.explorerFontSize ?? 13}
                        onChange={(e) => setTypography({ explorerFontSize: parseInt(e.target.value, 10) })}
                        style={{ width: '100%' }}
                      />
                    </div>
                    <div style={formRowStyle}>
                      <label style={labelStyle}>目录条目行高 ({settings.typography.explorerLineHeight ?? 24}px)</label>
                      <SettingsRange
                        min="20"
                        max="36"
                        step="1"
                        value={settings.typography.explorerLineHeight ?? 24}
                        onChange={(e) => setTypography({ explorerLineHeight: parseInt(e.target.value, 10) })}
                        style={{ width: '100%' }}
                      />
                    </div>
                  </div>

                  {/* 文件树条目效果预览 */}
                  <PreviewCollapse>
                    <div
                      style={{
                        background: 'var(--explorer-bg)',
                        border: '1px solid var(--editor-border)',
                        borderRadius: 'var(--radius-sm)',
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          height: settings.typography.explorerLineHeight ?? 24,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          paddingLeft: 12,
                          paddingRight: 8,
                          background: 'var(--explorer-active)',
                          borderLeft: '2px solid var(--accent-strong)',
                          color: 'var(--explorer-text)',
                          fontSize: settings.typography.explorerFontSize ?? 13,
                          fontFamily: 'var(--explorer-font-family)',
                        }}
                      >
                        <FileText size={14} color="var(--editor-accent)" />
                        <span>01_快速入门指南 (Guide.md)</span>
                      </div>
                      <div
                        style={{
                          height: settings.typography.explorerLineHeight ?? 24,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          paddingLeft: 12,
                          paddingRight: 8,
                          color: 'var(--explorer-text)',
                          fontSize: settings.typography.explorerFontSize ?? 13,
                          fontFamily: 'var(--explorer-font-family)',
                        }}
                      >
                        <FileCode size={14} color="var(--editor-accent)" />
                        <span>query_report.sql</span>
                      </div>
                    </div>
                  </PreviewCollapse>
                </div>
              </div>
            )}

            {/* 3. 编辑器配置：页级仅保留标题，具体编辑行为由设置项说明。 */}
            {shownTab === 'editor' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>编辑器与代码设置</h3>
                  <ResetDefaultsButton disabled={isEditorDefault} onClick={() => setResetTarget('editor')} />
                </div>

                {/* ── 3.1 代码与纯文本：显示项与缩进 ── */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '18px 20px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13 }}>
                    <FileCode size={15} color="var(--accent-strong)" />
                    <span>代码与纯文本 (.txt / .sql / .json / .yaml 等)</span>
                  </div>

                  {/* 显示空格（显示为点） */}
                  <div data-setting-id="showWhitespace" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
                    <div>
                      <div>显示空格（点）</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>将文本中的空格显示为轻柔圆点标记，制表符显示为箭头</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.editor.showWhitespace ?? false}
                      onChange={(e) => setEditor({ showWhitespace: e.target.checked })}
                    />
                  </div>

                  {/* 显示换行符（↵） */}
                  <div data-setting-id="showLineEndings" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
                    <div>
                      <div>显示换行符号 (↵)</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>在各行末尾显示 ↵ 换行指示符号</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.editor.showLineEndings ?? false}
                      onChange={(e) => setEditor({ showLineEndings: e.target.checked })}
                    />
                  </div>

                  {/* 显示行号 */}
                  <div data-setting-id="showLineNumbers" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
                    <div>
                      <div>显示行号</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>在左侧边栏展示代码行号及活动行高亮</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.editor.showLineNumbers}
                      onChange={(e) => setEditor({ showLineNumbers: e.target.checked })}
                    />
                  </div>

                  {/* 软换行 */}
                  <div data-setting-id="softWrap" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
                    <div>
                      <div>软换行 (自动折行)</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>超出编辑器可视宽度时自动折行，避免横向滚动</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.editor.softWrap}
                      onChange={(e) => setEditor({ softWrap: e.target.checked })}
                    />
                  </div>

                  {/* 缩进导线 */}
                  <div data-setting-id="indentGuides" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
                    <div>
                      <div>缩进参考导线</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>在代码层级之间显示垂直虚线导线</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.editor.showIndentGuides}
                      onChange={(e) => setEditor({ showIndentGuides: e.target.checked })}
                    />
                  </div>

                  {/* 列编辑模式：关闭时已进入的编辑器立即退出 */}
                  <div data-setting-id="columnEdit" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
                    <div>
                      <div>列编辑模式</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>{formatShortcut('Alt')} + 拖动或中键拖动，多行同时编辑</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.editor.enableColumnEdit !== false}
                      onChange={(e) => setEditor({ enableColumnEdit: e.target.checked })}
                    />
                  </div>

                  {/* 缩进参数：作用于代码、纯文本与 Markdown 源码 */}
                  <div data-setting-id="tabSize" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
                    <div>
                      <div>Tab 缩进宽度</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>每个 Tab 对应的空格数量</div>
                    </div>
                    {/* 常用宽度使用下拉选择，旧配置中的其他宽度保留为自定义项。 */}
                    <TabSizeSelect
                      value={settings.editor.tabSize}
                      onChange={(tabSize) => setEditor({ tabSize })}
                    />
                  </div>

                  <div data-setting-id="insertSpaces" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
                    <div>
                      <div>空格代替 Tab</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>按下 Tab 键时插入对应数量的空格</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.editor.insertSpaces}
                      onChange={(e) => setEditor({ insertSpaces: e.target.checked })}
                    />
                  </div>
                </div>

                {/* ── 3.2 Markdown：视图、展开状态、大纲、复制、回车与渲染增强 ── */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '18px 20px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13 }}>
                    <FileText size={15} color="var(--accent-strong)" />
                    <span>Markdown</span>
                  </div>

                  <div data-setting-id="defaultViewMode" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
                    <div>
                      <div>Markdown 默认视图模式</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>新打开 Markdown 文档时的初始模式</div>
                    </div>
                    <SettingsSelect
                      ariaLabel="Markdown 默认视图模式"
                      value={settings.editor.defaultViewMode}
                      options={[
                        { value: 'visual', label: '可视化模式' },
                        { value: 'source', label: '源码模式' },
                      ]}
                      onChange={(v) => setEditor({ defaultViewMode: v })}
                    />
                  </div>

                  {/* 可视化模式中代码块 / 折叠块的初始展开状态（仅影响显示，不写入文件） */}
                  <div data-setting-id="codeBlockExpanded" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
                    <div>
                      <div>代码块默认展开</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>关闭后可视化模式中的代码块默认收起，只显示语言与行数</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.editor.codeBlockDefaultExpanded ?? true}
                      onChange={(e) => setEditor({ codeBlockDefaultExpanded: e.target.checked })}
                    />
                  </div>

                  <div data-setting-id="detailsExpanded" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
                    <div>
                      <div>折叠块默认展开</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>{'<details> 折叠块的初始状态；源码带 open 属性的始终展开'}</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.editor.detailsDefaultExpanded ?? false}
                      onChange={(e) => setEditor({ detailsDefaultExpanded: e.target.checked })}
                    />
                  </div>

                  {/* 大纲位置：右侧栏（默认）/ 编辑区内左侧 / 编辑区内右侧；一个下拉同时写入位置与靠边两个字段 */}
                  <div data-setting-id="outlinePosition" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
                    <div>
                      <div>Markdown 大纲位置</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>编辑区内目录固定显示，沉浸阅读时同样可用</div>
                    </div>
                    <SettingsSelect
                      ariaLabel="Markdown 大纲位置"
                      value={
                        settings.editor.outlinePosition !== 'inline'
                          ? 'sidebar'
                          : settings.editor.outlineInlineSide === 'right' ? 'inline-right' : 'inline-left'
                      }
                      options={[
                        { value: 'sidebar', label: '右侧栏' },
                        { value: 'inline-left', label: '编辑区内左侧' },
                        { value: 'inline-right', label: '编辑区内右侧' },
                      ]}
                      onChange={(v) => setEditor(
                        v === 'sidebar'
                          ? { outlinePosition: 'sidebar' }
                          : { outlinePosition: 'inline', outlineInlineSide: v === 'inline-right' ? 'right' : 'left' },
                      )}
                    />
                  </div>

                  {/* Ctrl+C 的复制格式（实现见 features/editor-md/markdownClipboard.ts）；Ctrl+Shift+C 复制为另一种格式 */}
                  <div data-setting-id="copyFormat" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
                    <div>
                      <div>Markdown 复制格式</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>
                        {formatShortcut('可视化模式 Ctrl+C 的复制格式，Ctrl+Shift+C 复制为另一种')}
                      </div>
                    </div>
                    <SettingsSelect
                      ariaLabel="Markdown 复制格式"
                      value={settings.editor.copyFormat === 'plain' ? 'plain' : 'markdown'}
                      options={[
                        { value: 'markdown', label: '带格式' },
                        { value: 'plain', label: '纯文本' },
                      ]}
                      onChange={(v) => setEditor({ copyFormat: v })}
                    />
                  </div>

                  {/* Enter 与 Shift+Enter 互换（规则实现见 features/editor-md/enterKeyBehavior.ts）；快捷键页的回车类按键随此设置显示 */}
                  <div data-setting-id="swapEnterKeys" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
                    <div>
                      <div>Enter 与 Shift + Enter 互换</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>开启后 Enter 段内换行、Shift + Enter 换段落；代码块、表格、标题与空行不受影响</div>
                    </div>
                    <input
                      type="checkbox"
                      aria-label="Enter 与 Shift + Enter 互换"
                      checked={settings.editor.swapEnterKeys ?? false}
                      onChange={(e) => setEditor({ swapEnterKeys: e.target.checked })}
                    />
                  </div>

                  {/* ── Markdown 渲染增强 ── */}
                  <div data-setting-id="enableMath" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
                    <span>LaTeX 数学公式渲染 (KaTeX)</span>
                    <input
                      type="checkbox"
                      checked={settings.editor.enableMath}
                      onChange={(e) => setEditor({ enableMath: e.target.checked })}
                    />
                  </div>

                  <div data-setting-id="enableMermaid" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
                    <span>Mermaid 图表实时渲染</span>
                    <input
                      type="checkbox"
                      checked={settings.editor.enableMermaid}
                      onChange={(e) => setEditor({ enableMermaid: e.target.checked })}
                    />
                  </div>

                  <div data-setting-id="blockHandle" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
                    <span>悬浮块把手 (拖拽与菜单)</span>
                    <input
                      type="checkbox"
                      checked={settings.editor.enableBlockHandle}
                      onChange={(e) => setEditor({ enableBlockHandle: e.target.checked })}
                    />
                  </div>
                </div>

                {/* ── 3.3 思维导图 ── */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '18px 20px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--accent-strong)' }}>
                    思维导图
                  </div>

                  <div data-setting-id="mindmapWidth" style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, padding: '2px 0' }}>
                    <div>
                      <div>节点默认宽度</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>超出后自动换行；手动拉伸的节点不受影响</div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <SettingsRange
                        min="160"
                        max="600"
                        step="10"
                        value={settings.editor.mindmapNodeMaxWidth ?? 280}
                        onChange={(e) => setEditor({ mindmapNodeMaxWidth: parseInt(e.target.value, 10) })}
                        style={{ flex: 1, cursor: 'pointer' }}
                      />
                      <span style={{ fontSize: 12, color: 'var(--editor-text-muted)', minWidth: 44, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        {settings.editor.mindmapNodeMaxWidth ?? 280}px
                      </span>
                    </div>
                  </div>

                  <div data-setting-id="mindmapAlign" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
                    <div>
                      <div>节点文字对齐</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>节点可在「节点样式」中单独设置</div>
                    </div>
                    <SettingsSelect
                      ariaLabel="节点文字对齐"
                      value={settings.editor.mindmapTextAlign ?? 'left'}
                      options={[
                        { value: 'left', label: '左对齐' },
                        { value: 'center', label: '居中' },
                      ]}
                      onChange={(v) => setEditor({ mindmapTextAlign: v })}
                    />
                  </div>

                  <div data-setting-id="mindmapImage" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
                    <div>
                      <div>节点图片显示</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>原始比例完整显示；宽度填充为固定高度裁切</div>
                    </div>
                    <SettingsSelect
                      ariaLabel="节点图片显示"
                      value={settings.editor.mindmapImageFit ?? 'original'}
                      options={[
                        { value: 'original', label: '原始比例' },
                        { value: 'fill', label: '宽度填充' },
                      ]}
                      onChange={(v) => setEditor({ mindmapImageFit: v })}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* 4. 文件与保存设置：页级仅保留标题，保留保存策略等操作提示。 */}
            {shownTab === 'file' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                <div>
                  <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>文件与保存设置</h3>
                </div>

                {/* ── 4.1 自动保存设置 ── */}
                <div data-setting-id="autoSave" style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '18px 20px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13 }}>
                      <Save size={15} color="var(--accent-strong)" />
                      <span>自动保存设置 (分类型独立配置)</span>
                    </div>
                  </div>

                  {/* 自动保存间隔：所有类型共用，停止编辑达到该时长后写盘 */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
                    <div>保存间隔 (秒)</div>
                    <AutoSaveDelayInput
                      valueMs={clampAutoSaveDelayMs(settings.file.autoSaveDelayMs)}
                      onCommit={(ms) => setFile({ autoSaveDelayMs: ms })}
                    />
                  </div>

                  {/* Markdown 笔记自动保存 */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
                    <div>
                      <div>Markdown 笔记 (.md / .markdown)</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.file.autoSaveMarkdown ?? false}
                      onChange={(e) => setFile({ autoSaveMarkdown: e.target.checked })}
                    />
                  </div>

                  {/* 自由画板自动保存：新建画板默认 .excalidraw，.board / .canvas 同为 Excalidraw 场景 */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
                    <div>
                      <div>自由画板 (.excalidraw / .board / .canvas)</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.file.autoSaveBoard ?? false}
                      onChange={(e) => setFile({ autoSaveBoard: e.target.checked })}
                    />
                  </div>

                  {/* 思维导图自动保存（.xmind 打开时转换为未保存副本，另存后才参与自动保存） */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
                    <div>
                      <div>思维导图 (.mindmap / .mm)</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.file.autoSaveMindmap ?? false}
                      onChange={(e) => setFile({ autoSaveMindmap: e.target.checked })}
                    />
                  </div>

                  {/* Draw.io 图表自动保存 */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
                    <div>
                      <div>Draw.io 图表 (.drawio / .dio)</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.file.autoSaveDrawio ?? false}
                      onChange={(e) => setFile({ autoSaveDrawio: e.target.checked })}
                    />
                  </div>

                  {/* 多维表格自动保存 */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
                    <div>
                      <div>多维表格 (.bitable / .table)</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.file.autoSaveBitable ?? false}
                      onChange={(e) => setFile({ autoSaveBitable: e.target.checked })}
                    />
                  </div>

                  {/* 信息图自动保存：未单独设置过时沿用「代码与文本」开关 */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
                    <div>
                      <div>信息图 (.infographic / .ig)</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.file.autoSaveInfographic ?? settings.file.autoSaveOther ?? false}
                      onChange={(e) => setFile({ autoSaveInfographic: e.target.checked })}
                    />
                  </div>

                  {/* 代码与文本自动保存 */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
                    <div>
                      <div>代码与文本 (.txt / .sql / .json / .yaml 等)</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.file.autoSaveOther ?? false}
                      onChange={(e) => setFile({ autoSaveOther: e.target.checked })}
                    />
                  </div>
                </div>

                {/* ── 4.2 文件树与打开：隐藏文件、打开方式与大文件提示 ── */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '18px 20px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13 }}>
                    <Folder size={15} color="var(--accent-strong)" />
                    <span>文件树与打开</span>
                  </div>

                  {/* 显示隐藏文件 */}
                  <div data-setting-id="showHiddenFiles" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
                    <div>
                      <div>显示隐藏文件 / 文件夹</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>在左侧文件树中显示以点（.）开头的隐藏文件或系统文件</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.file.showHiddenFiles ?? false}
                      onChange={(e) => setFile({ showHiddenFiles: e.target.checked })}
                    />
                  </div>

                  {/* 资源管理器：文件树中打开文件的方式（默认双击） */}
                  <div data-setting-id="explorerOpenMode" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
                    <div>
                      <div>打开文件的方式</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>在左侧文件树中打开文件</div>
                    </div>
                    <SettingsSelect<ExplorerOpenMode>
                      ariaLabel="打开文件的方式"
                      value={settings.file.explorerOpenMode ?? 'double'}
                      options={[
                        { value: 'double', label: '双击打开' },
                        { value: 'single', label: '单击打开' },
                      ]}
                      onChange={(v) => setFile({ explorerOpenMode: v })}
                    />
                  </div>

                  {/* 大文件确认阈值 */}
                  <div data-setting-id="largeFile" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
                    <div>
                      <div>大文件打开确认阈值 (MB)</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>超过此大小的文件在打开前将弹出性能提示</div>
                    </div>
                    <input
                      type="number"
                      min="1"
                      max="100"
                      value={settings.file.largeFileConfirmMb ?? 50}
                      onChange={(e) => setFile({ largeFileConfirmMb: parseInt(e.target.value, 10) || 50 })}
                      style={{ ...inputStyle, width: 60, textAlign: 'center' }}
                    />
                  </div>
                </div>

                {/* ── 4.3 暂存目录设置 ── */}
                <div data-setting-id="staging" style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '18px 20px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13, color: 'var(--editor-text)' }}>
                    <Folder size={15} color="var(--accent-strong)" />
                    <span>未保存文件暂存区</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>
                    新建文件和有修改的文件会另存为“时间-序号-文件名”。编辑期间持续覆盖同一副本，正常保存后自动清理；暂存关闭或异常退出时保留。
                  </div>
                  <Tooltip content={settings.file.stagingDirectory ?? ''} disabled={!settings.file.stagingDirectory} side="top" sideOffset={4}>
                    <input
                      type="text"
                      readOnly
                      value={settings.file.stagingDirectory ?? ''}
                      style={{ ...inputStyle, width: '100%', maxWidth: 'none', padding: '6px 10px' }}
                    />
                  </Tooltip>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {/* 移动端系统目录选择器返回 content:// 地址且没有资源管理器，仅保留恢复默认 */}
                    {!IS_MOBILE_UI && (
                      <button type="button" className="nb-btn-secondary" onClick={handleChooseStagingDirectory}>选择位置</button>
                    )}
                    <button type="button" className="nb-btn-secondary" onClick={handleResetStagingDirectory}>恢复默认</button>
                    {!IS_MOBILE_UI && (
                      <button type="button" className="nb-btn-secondary" onClick={handleOpenStagingDirectory}>在资源管理器中打开</button>
                    )}
                  </div>
                </div>

                {/* ── 4.4 图片目录设置 ── */}
                <div data-setting-id="imageDir" style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '18px 20px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13, color: 'var(--editor-text)' }}>
                    <ImageIcon size={15} color="var(--accent-strong)" />
                    <span>图片目录设置</span>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--editor-text)' }}>图片目录名称</div>
                    <div style={{ fontSize: 11, color: 'var(--editor-text-muted)', marginBottom: 2 }}>
                      插入或粘贴本地图片时，自动在当前 Markdown 文档所在目录同一层创建的子文件夹名称（默认 <code>img</code>）
                    </div>
                    <input
                      type="text"
                      value={settings.file.imageDirName ?? 'img'}
                      onChange={(e) => setFile({ imageDirName: e.target.value })}
                      placeholder="img"
                      style={{ ...inputStyle, width: '100%', maxWidth: 280, padding: '6px 10px' }}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* 5. 同步与备份：与其他页签一样直接渲染，配置未就绪的提示由面板自身处理。 */}
            {/* 账号、用户管理与插件页整体作为搜索定位目标，外包一层承载 data-setting-id */}
            {shownTab === 'account' && <div data-setting-id="account"><AccountPanel /></div>}
            {shownTab === 'users' && isAdmin() && <div data-setting-id="users"><UserManagementPanel /></div>}
            {shownTab === 'sync' && SHOW_SYNC() && <SyncPanel />}
            {shownTab === 'history' && <HistorySettingsPanel />}
            {shownTab === 'plugins' && <div data-setting-id="plugins"><PluginsPanel target={settingsTarget} /></div>}

            {/* 通用：页级仅保留标题；启动与会话、新建入口各端通用，托盘与 HTML 链接仅原生桌面端展示。 */}
            {shownTab === 'general' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                <div>
                  <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>通用设置</h3>
                </div>

                {SUPPORTS_SYSTEM_INTEGRATION && (
                <div data-setting-id="closeToTray" style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '18px 20px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13 }}>
                    <Monitor size={15} color="var(--accent-strong)" />
                    <span>窗口与托盘</span>
                  </div>

                  {/* 关闭到托盘：开启后关闭按钮仅隐藏窗口，内容留在内存中，因此不弹未保存确认 */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
                    <div>
                      <div>关闭按钮最小化到托盘</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>关闭时隐藏到托盘，不弹保存确认；从托盘菜单退出</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.system.closeToTray ?? false}
                      onChange={(e) => setSystem({ closeToTray: e.target.checked })}
                    />
                  </div>
                </div>
                )}

                {/* 启动与会话：启动时恢复上次打开的文件标签；阅读位置各端通用，与是否恢复标签独立，两者默认开启。 */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '18px 20px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13 }}>
                    <RotateCw size={15} color="var(--accent-strong)" />
                    <span>启动与会话</span>
                  </div>

                  {/* 保留最近文件：启动时恢复到 Tab 栏，但当前页面仍停留 Home。 */}
                  <div data-setting-id="restoreSession" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
                    <div>
                      <div>保留最近文件</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>默认开启；启动时自动恢复到 Tab 栏，当前页面仍显示 Home</div>
                    </div>
                    <input
                      type="checkbox"
                      aria-label="保留最近文件"
                      checked={settings.file.restoreSession ?? true}
                      onChange={(e) => setFile({ restoreSession: e.target.checked })}
                    />
                  </div>

                  <div data-setting-id="restoreReadingPosition" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
                    <div>
                      <div>重新打开时恢复上次阅读位置</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>恢复滚动位置、选区与 Markdown 视图模式</div>
                    </div>
                    <input
                      type="checkbox"
                      aria-label="重新打开时恢复上次阅读位置"
                      checked={settings.file.restoreReadingPosition ?? true}
                      onChange={(e) => setFile({ restoreReadingPosition: e.target.checked })}
                    />
                  </div>
                </div>

                {/* 本地文件搜索：开关与索引位置（文件夹 / 整个磁盘，可添加多个）；网页端为管理员开关的全局搜索 */}
                {SUPPORTS_LOCAL_SEARCH && !IS_MOBILE_UI && (
                  <div data-setting-id="localSearch">
                    {IS_WEB ? <WebSearchSettingsCard /> : <LocalSearchSettingsCard />}
                  </div>
                )}

                {/* 新建入口：主页与「+」菜单中哪些格式直接展示、哪些收进更多 */}
                <div data-setting-id="createFormats" style={{ padding: '18px 20px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
                  <CreateFormatsSettings />
                </div>

                {/* HTML 链接：笔记等文档中点击本地 HTML 链接时交给系统浏览器还是在本软件中分屏预览
                    （仅桌面端；资源管理器、拖入等入口始终在本软件打开，网页端与移动端始终应用内预览） */}
                {SUPPORTS_SYSTEM_INTEGRATION && (
                <div data-setting-id="htmlOpenMode" style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '18px 20px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13 }}>
                    <Globe size={15} color="var(--accent-strong)" />
                    <span>HTML 链接</span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
                    <div>
                      <div>打开方式</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>点击文档中的本地 HTML 链接</div>
                    </div>
                    <SettingsSelect<HtmlOpenMode>
                      ariaLabel="HTML 链接打开方式"
                      value={settings.file.htmlOpenMode ?? 'browser'}
                      options={[
                        { value: 'browser', label: '系统浏览器' },
                        { value: 'app', label: '本软件' },
                      ]}
                      onChange={(v) => setFile({ htmlOpenMode: v })}
                    />
                  </div>
                </div>
                )}
              </div>
            )}

            {/* 6. 快捷键指南：页级仅保留标题，具体操作说明保留在快捷键条目中。 */}
            {shownTab === 'shortcuts' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                <div data-setting-id="shortcutList">
                  <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>快捷键一览</h3>
                </div>

                {/* JSON 与代码快捷操作 */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-strong)', marginBottom: 4 }}>
                    JSON 与纯文本快捷处理 (.json / .txt / 源码模式)
                  </div>
                  <ShortcutItem keyCombo="Shift + Alt + F / Ctrl + Alt + L" label="JSON 展开 / 格式化（支持选区 / 全文）" />
                  <ShortcutItem keyCombo="Shift + Alt + M / Ctrl + Alt + M" label="JSON 压缩为单行（支持选区 / 全文）" />
                  <ShortcutItem keyCombo="Shift + Alt + V / Ctrl + Alt + V" label="JSON 格式校验与错误定位（支持选区 / 全文）" />
                </div>

                {/* 代码与纯文本编辑器快捷操作 */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-strong)', marginBottom: 4 }}>
                    代码与纯文本编辑器 (.json / .txt / .sql 等)
                  </div>
                  <ShortcutItem keyCombo="Ctrl + 滚轮" label="实时缩放编辑器字号" />
                </div>

                {/* 查找与替换 */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-strong)', marginBottom: 4 }}>
                    查找与替换
                  </div>
                  <ShortcutItem keyCombo="Ctrl + F" label="查找文本" />
                  {/* Mac 上 Cmd+H 被系统「隐藏应用」占用，只列出 Cmd+R */}
                  <ShortcutItem keyCombo={REPLACE_SHORTCUT === 'Ctrl+R' ? 'Ctrl + R' : 'Ctrl + H / Ctrl + R'} label="替换文本" />
                </div>

                {/* 全局与文件操作 */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-strong)', marginBottom: 4 }}>
                    全局与文件操作
                  </div>
                  <ShortcutItem keyCombo="Ctrl + O" label="打开文件" />
                  <ShortcutItem keyCombo="Ctrl + Shift + O" label="打开文件夹" />
                  <ShortcutItem keyCombo="Ctrl + Shift + N" label="新建空窗口" />
                  {SUPPORTS_LOCAL_SEARCH && <ShortcutItem keyCombo="Ctrl + Shift + F" label={IS_WEB ? '全局搜索' : '本地文件搜索'} tip={IS_WEB ? '搜索文件名与内容，需管理员在 设置 → 通用 中开启' : '搜索文件名与内容，需先在 设置 → 通用 中开启'} />}
                  <ShortcutItem keyCombo="Ctrl + S" label="保存当前文档" />
                  <ShortcutItem keyCombo="Ctrl + Shift + S" label="文档另存为" />
                  <ShortcutItem keyCombo="Ctrl + W" label="关闭当前标签页" />
                  {/* 撤销 / 重做在各编辑器中通用（Markdown、代码、画板、思维导图、多维表格） */}
                  <ShortcutItem keyCombo="Ctrl + Z" label="撤销" />
                  <ShortcutItem keyCombo="Ctrl + Y" label="重做" />
                  {/* 全局唤起：无默认值，由用户录制；与快捷键条目同高，录制按钮占据右侧按键位 */}
                  {SUPPORTS_SYSTEM_INTEGRATION && (
                    <div
                      data-setting-id="globalShortcut"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 12,
                        padding: '6px 12px',
                        background: 'var(--editor-surface)',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--editor-border)',
                        fontSize: 12,
                      }}
                    >
                      <ShortcutLabel label="全局唤起窗口" tip="任意程序中唤起最近使用的窗口，含托盘中的窗口" />
                      <GlobalShortcutRecorder />
                    </div>
                  )}
                </div>

                {/* Markdown 编辑 */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-strong)', marginBottom: 4 }}>
                    Markdown 编辑
                  </div>
                  <ShortcutItem keyCombo="/" label="Markdown 中触发斜杠快捷插入" />
                  <ShortcutItem keyCombo="Ctrl + /" label="切换可视化 / 源码模式" />
                  {/* 复制格式随编辑器页「Markdown 复制格式」设置互换 */}
                  <ShortcutItem
                    keyCombo="Ctrl + Shift + C"
                    label={settings.editor.copyFormat === 'plain' ? '带格式复制' : '纯文本复制'}
                    tip={formatShortcut('Ctrl + C 按「Markdown 复制格式」设置复制，此快捷键复制为另一种')}
                  />

                </div>

                {/* Markdown 回车类按键（规则实现见 features/editor-md/enterKeyBehavior.ts）；细节放在 tip 中，行内只留要点 */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {/* Enter 与 Shift+Enter 互换开关位于编辑器页的 Markdown 分组，此处按键随设置显示 */}
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 4 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-strong)' }}>
                      Markdown 回车类按键
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>可在 编辑器 中互换 Enter 与 Shift + Enter</span>
                  </div>
                  <ShortcutItem
                    keyCombo={settings.editor.swapEnterKeys ? 'Shift + Enter' : 'Enter'}
                    label="换段落"
                    tip="新建段落或列表新项，源码中以空行分隔；在空行上再按一次，跳出列表、引用、提示块、高亮块、折叠块"
                  />
                  <ShortcutItem
                    keyCombo={settings.editor.swapEnterKeys ? 'Enter' : 'Shift + Enter'}
                    label="段内换行"
                    tip="不新建段落、没有段落间距，源码中为行尾两个空格；标题中与空行上等同换段落"
                  />
                  <ShortcutItem
                    keyCombo="Ctrl + Enter"
                    label="跳出到下方新段落"
                    tip="在所在的代码块、表格、列表、引用、提示块、高亮块、折叠块、分栏下方新建段落；普通段落则在其下方新建，不拆分当前内容"
                  />
                  <ShortcutItem keyCombo="Alt + Enter" label="无作用" />
                  <ShortcutItem
                    keyCombo="Enter / Shift + Enter"
                    label="代码块、表格内换行"
                    tip="代码块末尾连按三次 Enter 跳出；表格单元格内的换行保存为 <br>"
                  />
                  <ShortcutItem keyCombo="Enter" label="折叠块标题进入正文" />
                  <ShortcutItem
                    keyCombo="Ctrl + Enter / Esc"
                    label="源码编辑框完成 / 取消"
                    tip="公式、Mermaid、信息图、HTML 块的源码编辑框；行内公式按 Enter 即完成"
                  />
                  <ShortcutItem keyCombo="Ctrl + Enter / Esc" label="多维表格长文本保存 / 取消" />
                </div>

                {/* 思维导图：导图模式在上、大纲模式在下，同一模式内相近的按键相邻
                    （实现见 features/mindmap：MindmapRenderer / MindmapTitleEditor / OutlinerEditor） */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-strong)', marginBottom: 4 }}>
                    思维导图
                  </div>
                  <div style={shortcutSubheadingStyle}>导图模式</div>
                  <ShortcutItem keyCombo="Tab" label="添加子节点" />
                  <ShortcutItem keyCombo="Enter" label="添加同级节点" tip="选中节点且未编辑文字时；根节点会添加子节点" />
                  <ShortcutItem keyCombo="Ctrl + 单击" label="多选节点" tip="拖动其中一个可一起移动，Delete 批量删除" />
                  <ShortcutItem keyCombo="Delete" label="删除选中节点" />
                  {/* 以下为编辑节点文字时（MindmapTitleEditor） */}
                  <ShortcutItem keyCombo="Shift + Enter / Alt + Enter" label="节点内换行" tip="编辑节点文字时" />
                  <ShortcutItem keyCombo="Enter / Ctrl + Enter / Esc" label="完成文字编辑" tip="完成后选中当前节点，再按 Enter 添加节点" />
                  <ShortcutItem keyCombo="Ctrl + V" label="粘贴图片为节点图片" tip="编辑节点文字时粘贴，已有图片则替换" />
                  <ShortcutItem keyCombo="Ctrl + Enter" label="完成备注编辑" />
                  <div style={{ ...shortcutSubheadingStyle, marginTop: 8 }}>大纲模式</div>
                  <ShortcutItem keyCombo="Enter" label="添加同级要点" />
                  <ShortcutItem keyCombo="Shift + Enter" label="添加备注" />
                  <ShortcutItem keyCombo="Tab" label="降级" />
                  <ShortcutItem keyCombo="Shift + Tab" label="升级" />
                </div>
              </div>
            )}

            {/* 4. 关于 */}
            {shownTab === 'about' && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 18, padding: '24px 0' }}>
                <img src="/logo.ico" alt="NoteBoard Logo" width={56} height={56} />
                <div>
                  <h2 style={{ fontSize: 18, fontWeight: 600, margin: '4px 0' }}>NoteBoard</h2>
                  <span style={{ fontSize: 12, color: 'var(--editor-text-muted)' }}>Windows 优雅桌面笔记 + 自由画板</span>
                </div>
                <p style={{ fontSize: 12, color: 'var(--editor-text-secondary)', maxWidth: 420, lineHeight: 1.6, margin: '4px 0' }}>
                  采用 Rust Tauri v2 原生高性能底座与 TipTap / CodeMirror 6 / Excalidraw 多核驱动。
                </p>
                <div style={{ fontSize: 12, color: 'var(--editor-text-muted)' }}>
                  版本 v{APP_VERSION} · AGPL-3.0 License
                </div>

                {/* 快捷操作：检测更新与 GitHub / 腾讯云 CNB 仓库 */}
                <div data-setting-id="checkUpdate" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 12, marginTop: 8 }}>
                  <button
                    type="button"
                    className="nb-btn-secondary"
                    disabled={checkingUpdate}
                    onClick={handleCheckForUpdates}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '8px 18px',
                      fontSize: 13,
                      fontWeight: 500,
                      borderRadius: 8,
                      border: '1px solid var(--control-border)',
                      background: 'var(--editor-surface)',
                      color: 'var(--accent-strong)',
                      cursor: checkingUpdate ? 'not-allowed' : 'pointer',
                      boxShadow: 'var(--shadow-sm)',
                      transition: 'all var(--transition-fast)',
                    }}
                    onMouseEnter={(e) => {
                      if (!checkingUpdate) {
                        e.currentTarget.style.background = 'var(--toolbar-hover)';
                        e.currentTarget.style.borderColor = 'var(--editor-border-focus)';
                        e.currentTarget.style.transform = 'translateY(-1px)';
                        e.currentTarget.style.boxShadow = 'var(--shadow-md)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!checkingUpdate) {
                        e.currentTarget.style.background = 'var(--editor-surface)';
                        e.currentTarget.style.borderColor = 'var(--control-border)';
                        e.currentTarget.style.transform = 'translateY(0)';
                        e.currentTarget.style.boxShadow = 'var(--shadow-sm)';
                      }
                    }}
                    onMouseDown={(e) => {
                      if (!checkingUpdate) {
                        e.currentTarget.style.background = 'var(--toolbar-active)';
                        e.currentTarget.style.transform = 'translateY(0) scale(0.97)';
                        e.currentTarget.style.boxShadow = 'var(--shadow-sm)';
                      }
                    }}
                    onMouseUp={(e) => {
                      if (!checkingUpdate) {
                        e.currentTarget.style.background = 'var(--toolbar-hover)';
                        e.currentTarget.style.transform = 'translateY(-1px)';
                        e.currentTarget.style.boxShadow = 'var(--shadow-md)';
                      }
                    }}
                  >
                    <RefreshCw size={15} className={checkingUpdate ? 'spin' : ''} style={checkingUpdate ? { animation: 'spin 1s linear infinite' } : undefined} />
                    <span>{checkingUpdate ? '正在检查' : '检测更新'}</span>
                  </button>

                  {UPDATE_CHANNEL_ORDER.map((id) => (
                  <Tooltip key={id} content={RELEASE_CHANNELS[id].repoUrl} side="top" sideOffset={4}>
                  <button
                    type="button"
                    className="nb-btn-secondary"
                    onClick={() => handleOpenRepo(RELEASE_CHANNELS[id].repoUrl)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '8px 18px',
                      fontSize: 13,
                      fontWeight: 500,
                      borderRadius: 8,
                      border: '1px solid var(--control-border)',
                      background: 'var(--editor-surface)',
                      color: 'var(--editor-text)',
                      cursor: 'pointer',
                      boxShadow: 'var(--shadow-sm)',
                      transition: 'all var(--transition-fast)',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'var(--toolbar-hover)';
                      e.currentTarget.style.borderColor = 'var(--editor-border-focus)';
                      e.currentTarget.style.transform = 'translateY(-1px)';
                      e.currentTarget.style.boxShadow = 'var(--shadow-md)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'var(--editor-surface)';
                      e.currentTarget.style.borderColor = 'var(--control-border)';
                      e.currentTarget.style.transform = 'translateY(0)';
                      e.currentTarget.style.boxShadow = 'var(--shadow-sm)';
                    }}
                    onMouseDown={(e) => {
                      e.currentTarget.style.background = 'var(--toolbar-active)';
                      e.currentTarget.style.transform = 'translateY(0) scale(0.97)';
                      e.currentTarget.style.boxShadow = 'var(--shadow-sm)';
                    }}
                    onMouseUp={(e) => {
                      e.currentTarget.style.background = 'var(--toolbar-hover)';
                      e.currentTarget.style.transform = 'translateY(-1px)';
                      e.currentTarget.style.boxShadow = 'var(--shadow-md)';
                    }}
                  >
                    <ExternalLink size={15} />
                    <span>{RELEASE_CHANNELS[id].label} 仓库</span>
                  </button>
                  </Tooltip>
                  ))}
                </div>

                {/* 自动检查更新：启动及每 5 分钟静默检查，默认开启；网页版由部署者更新，不显示 */}
                {!IS_WEB && <AutoCheckUpdateToggle />}

                {/* 更新渠道：检测更新、安装包、字体与插件的下载来源 */}
                <UpdateChannelSelector />

                {/* 最近版本更新日志，默认收起 */}
                <ReleaseNotes />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 恢复默认二次确认：仅重置当前页的设置项 */}
      <ConfirmDialog
        open={resetTarget !== null}
        title="恢复默认设置"
        confirmLabel="恢复默认"
        onConfirm={() => void handleConfirmReset()}
        onClose={() => setResetTarget(null)}
      >
        <div>{resetTarget === 'typography' ? '「排版与字体」' : '「编辑器」'}页的设置将恢复为默认值。</div>
      </ConfirmDialog>
    </div>
  );
}

function NavBtn({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '9px 12px',
        border: 'none',
        borderRadius: 'var(--radius-sm)',
        background: active ? 'var(--editor-selection)' : 'transparent',
        color: active ? 'var(--accent-strong)' : 'var(--editor-text)',
        fontWeight: active ? 600 : 400,
        fontSize: 13,
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'all var(--transition-fast)',
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'var(--toolbar-hover)';
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'transparent';
        }
        e.currentTarget.style.transform = 'scale(1)';
      }}
      onMouseDown={(e) => {
        e.currentTarget.style.transform = 'scale(0.97)';
      }}
      onMouseUp={(e) => {
        e.currentTarget.style.transform = 'scale(1)';
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

/** 左栏顶部的设置搜索框：Enter 跳到第一条结果；有内容时 Esc 只清空查询，不关闭设置 */
function SettingsSearchBox({ value, onChange, onSubmit }: { value: string; onChange: (value: string) => void; onSubmit: () => void }) {
  return (
    <div className="nb-settings-search">
      <Search size={14} className="nb-settings-search-icon" aria-hidden />
      <input
        type="text"
        value={value}
        placeholder="搜索设置"
        aria-label="搜索设置"
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // 输入法组字期间的回车用于上屏，不触发跳转
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            onSubmit();
          } else if (e.key === 'Escape' && value) {
            // 阻止冒泡关闭设置弹窗，仅清空查询
            e.stopPropagation();
            onChange('');
          }
        }}
      />
      {value && (
        <Tooltip content="清空搜索" side="bottom" sideOffset={4}>
          <button type="button" className="nb-settings-search-clear" aria-label="清空搜索" onClick={() => onChange('')}>
            <X size={12} />
          </button>
        </Tooltip>
      )}
    </div>
  );
}

/** 设置搜索结果：每行「页名 › 分区」+ 设置项，点击跳转到对应栏目并高亮 */
function SettingsSearchResults({ results, onSelect }: { results: SettingsSearchEntry[]; onSelect: (entry: SettingsSearchEntry) => void }) {
  return (
    <div className="nb-settings-search-results">
      <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 8px' }}>搜索结果</h3>
      {results.length === 0 ? (
        <div className="nb-settings-search-empty">没有匹配的设置</div>
      ) : (
        results.map((entry) => (
          <button key={entry.id} type="button" className="nb-settings-search-result" onClick={() => onSelect(entry)}>
            <span className="nb-settings-search-result-label">{entry.label}</span>
            <span className="nb-settings-search-result-path">
              {/* 分区名与页名相同时只显示一次 */}
              {entry.section === TAB_LABELS[entry.tab] ? TAB_LABELS[entry.tab] : `${TAB_LABELS[entry.tab]} › ${entry.section}`}
            </span>
          </button>
        ))
      )}
    </div>
  );
}

function ThemeCard({
  title,
  desc,
  bg,
  accent,
  codeBg,
  codeColor,
  selected,
  onClick,
}: {
  title: string;
  desc: string;
  bg: string;
  accent: string;
  codeBg: string;
  codeColor: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: '14px 16px',
        borderRadius: 'var(--radius-md)',
        border: selected ? '2px solid var(--accent-strong)' : '1px solid var(--editor-border)',
        background: 'var(--editor-surface)',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        boxShadow: selected ? 'var(--shadow-sm)' : 'none',
        transition: 'all var(--transition-fast)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = selected ? 'var(--accent-strong)' : 'var(--editor-border-focus)';
        e.currentTarget.style.transform = 'translateY(-2px)';
        e.currentTarget.style.boxShadow = 'var(--shadow-md)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = selected ? 'var(--accent-strong)' : 'var(--editor-border)';
        e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.boxShadow = selected ? 'var(--shadow-sm)' : 'none';
      }}
      onMouseDown={(e) => {
        e.currentTarget.style.transform = 'translateY(0) scale(0.98)';
        e.currentTarget.style.boxShadow = 'var(--shadow-sm)';
      }}
      onMouseUp={(e) => {
        e.currentTarget.style.transform = 'translateY(-2px)';
        e.currentTarget.style.boxShadow = 'var(--shadow-md)';
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{title}</span>
        {selected && <Check size={14} color="var(--accent-strong)" />}
      </div>
      <span style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>{desc}</span>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
        <Tooltip content="背景色" side="top" sideOffset={4}>
          <div style={{ width: 22, height: 22, borderRadius: '50%', background: bg, border: '1px solid var(--editor-border)', cursor: 'default' }} />
        </Tooltip>
        <Tooltip content="强调色" side="top" sideOffset={4}>
          <div style={{ width: 22, height: 22, borderRadius: '50%', background: accent, border: '1px solid transparent', cursor: 'default' }} />
        </Tooltip>
        <Tooltip content="代码块色" side="top" sideOffset={4}>
          <div style={{ width: 22, height: 22, borderRadius: '50%', background: codeBg, border: '1px solid var(--editor-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: codeColor, fontSize: 9, fontWeight: 'bold', cursor: 'default' }}>
            &lt;&gt;
          </div>
        </Tooltip>
      </div>
    </div>
  );
}

/** 快捷键条目说明文字；有 tip 时在文字后附信息图标，悬停查看详细说明 */
function ShortcutLabel({ label, tip }: { label: string; tip?: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--editor-text)' }}>
      {label}
      {tip && (
        <Tooltip content={<span style={{ display: 'block', maxWidth: 320, lineHeight: 1.6 }}>{tip}</span>} side="top" sideOffset={4}>
          <span
            className="nb-shortcut-tip"
            style={{ display: 'inline-flex', color: 'var(--editor-text-muted)', cursor: 'help', transition: 'color var(--transition-fast)' }}
            aria-label={tip}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--accent-strong)')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--editor-text-muted)')}
          >
            <Info size={13} />
          </span>
        </Tooltip>
      )}
    </span>
  );
}

/** 排版分组底部的效果预览：折叠块，默认收起，展开后随本分组参数实时变化 */
/** 分区设置是否与默认值一致：旧配置缺失的可选字段按默认值看待 */
function matchesDefaults<T extends object>(current: Partial<T>, defaults: T): boolean {
  return (Object.keys(defaults) as (keyof T)[]).every((key) => (current[key] ?? defaults[key]) === defaults[key]);
}

/** 设置页标题行右侧的「恢复默认」按钮；已是默认值时禁用 */
function ResetDefaultsButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <Tooltip content={disabled ? '已是默认设置' : '恢复本页默认设置'}>
      {/* 禁用的按钮不响应指针事件，外包一层保证提示仍可显示 */}
      <span style={{ display: 'inline-flex' }}>
        <button
          type="button"
          className="nb-btn-secondary"
          disabled={disabled}
          onClick={onClick}
          style={{ padding: '4px 10px', fontSize: 12 }}
        >
          <RotateCcw size={13} />
          恢复默认
        </button>
      </span>
    </Tooltip>
  );
}

function PreviewCollapse({ children }: { children: React.ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="nb-settings-preview">
      <button
        type="button"
        className="nb-settings-preview-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <ChevronRight size={14} className="nb-settings-preview-chevron" />
        <span>效果预览</span>
      </button>
      {expanded && <div className="nb-settings-preview-body">{children}</div>}
    </div>
  );
}


function ShortcutItem({ keyCombo, label, tip }: { keyCombo: string; label: string; tip?: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        // 说明文字较长时换行，按键标签保持在右侧不被挤压
        gap: 12,
        padding: '8px 12px',
        background: 'var(--editor-surface)',
        borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--editor-border)',
        fontSize: 12,
      }}
    >
      <ShortcutLabel label={label} tip={tip} />
      <kbd
        style={{
          flexShrink: 0,
          whiteSpace: 'nowrap',
          padding: '2px 6px',
          background: 'var(--editor-bg)',
          border: '1px solid var(--editor-border)',
          borderRadius: 3,
          fontFamily: 'var(--mono-font-family)',
          fontSize: 11,
          color: 'var(--editor-text-secondary)',
        }}
      >
        {formatShortcut(keyCombo)}
      </kbd>
    </div>
  );
}

const formRowStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

/** 快捷键分组内的子标题（如思维导图的导图模式 / 大纲模式） */
const shortcutSubheadingStyle: React.CSSProperties = {
  fontSize: 11.5,
  fontWeight: 500,
  color: 'var(--editor-text-muted)',
  paddingLeft: 2,
};

const labelStyle: React.CSSProperties = {
  fontSize: 12.5,
  fontWeight: 500,
  color: 'var(--editor-text)',
};

const inputStyle: React.CSSProperties = {
  padding: '6px 10px',
  fontSize: 12,
  border: '1px solid var(--editor-border)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--editor-surface)',
  color: 'var(--editor-text)',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
};

/** 毫秒转为秒的展示文本：1000 → "1"，1500 → "1.5" */
function formatDelaySeconds(ms: number): string {
  return String(Math.round(ms / 100) / 10);
}

/**
 * 自动保存间隔输入框（单位：秒）。
 * 使用 text + inputMode=decimal 而非 type=number：没有右侧微调按钮，滚轮滑过也不会改动数值；
 * 输入过程中不写设置，失焦或回车时规整到 0.2 ~ 60 秒再提交，Esc 放弃修改。
 */
function AutoSaveDelayInput({ valueMs, onCommit }: { valueMs: number; onCommit: (ms: number) => void }) {
  const [text, setText] = useState(() => formatDelaySeconds(valueMs));
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  // Esc 撤销时跳过随后的失焦提交（blur 同步触发，此时 text 仍是旧闭包里的输入值）
  const cancelRef = useRef(false);
  // 外部设置变化（如另一窗口修改）时同步展示，编辑中不打断输入
  useEffect(() => {
    if (!focused) setText(formatDelaySeconds(valueMs));
  }, [valueMs, focused]);

  const commit = () => {
    const seconds = parseFloat(text);
    // 空值 / 非法值回退到当前设置；合法值按 0.1 秒精度规整到可调范围
    const ms = Number.isFinite(seconds)
      ? Math.min(AUTO_SAVE_DELAY_MAX_MS, Math.max(AUTO_SAVE_DELAY_MIN_MS, Math.round(seconds * 10) * 100))
      : valueMs;
    setText(formatDelaySeconds(ms));
    if (ms !== valueMs) onCommit(ms);
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      autoComplete="off"
      aria-label="自动保存间隔（秒）"
      value={text}
      onChange={(e) => {
        // 只保留数字与第一个小数点，小数最多一位
        const raw = e.target.value.replace(/[^\d.]/g, '');
        const [int = '', ...rest] = raw.split('.');
        const next = rest.length > 0 ? `${int.slice(0, 2)}.${rest.join('').slice(0, 1)}` : int.slice(0, 2);
        setText(next);
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        if (cancelRef.current) {
          cancelRef.current = false;
          return;
        }
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          // 阻止冒泡关闭设置弹窗，仅撤销本次输入
          e.stopPropagation();
          cancelRef.current = true;
          setText(formatDelaySeconds(valueMs));
          e.currentTarget.blur();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...inputStyle,
        width: 60,
        textAlign: 'center',
        borderColor: focused ? 'var(--accent-strong)' : hover ? 'var(--editor-text-muted)' : 'var(--editor-border)',
        transition: 'border-color 0.15s',
      }}
    />
  );
}


