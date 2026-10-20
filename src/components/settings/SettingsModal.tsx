// NoteBoard 设置中心模态弹窗
// 外观主题切换（晨光/琥珀/墨夜/跟随系统） + 排版设置（字体/字号/行高/内容宽度） + 快捷键与关于
// 详见 docs/06-主题与设计规范.md 及 docs/07-UI布局与交互规范.md

import { useState, useEffect, useRef } from 'react';
import { X, Palette, Type, Keyboard, Info, Check, FileText, FileCode, Folder, LayoutTemplate, RefreshCw, ExternalLink, Save, Image as ImageIcon, Cloud, ChevronRight } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';
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
import { Tooltip } from '../Tooltip';
import type { MarkdownNormalizationPolicy } from '../../core/ipc/types';
import { IS_MOBILE_UI, IS_NATIVE_MOBILE, IS_WEB } from '../../core/platform';
import { GlobalShortcutRecorder } from './GlobalShortcutRecorder';
import { formatShortcut } from '../../core/shortcuts';
// 设置窗口已在 App 中按需加载；同步面板及样式随窗口就绪，避免首次切换先显示加载占位。
import { SyncPanel } from '../../features/sync/SyncPanel';
// 插件管理随设置窗口加载，查看器重库仍由已安装包按需提供。
import { PluginsPanel } from '../../features/plugins/PluginsPanel';
import { useLayoutStore } from '../../stores/layoutStore';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type TabType = 'appearance' | 'typography' | 'editor' | 'file' | 'sync' | 'plugins' | 'shortcuts' | 'about';

// 托盘与全局快捷键仅原生桌面端可用（网页与移动端没有系统托盘）
const SUPPORTS_SYSTEM_INTEGRATION = !IS_NATIVE_MOBILE && !IS_WEB;

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<TabType>('appearance');
  const settingsTarget = useLayoutStore((state) => state.settingsTarget);
  // 打开入口携带目标，字体按钮与缺少查看器的文件页均能直达安装区域。
  useEffect(() => { if (isOpen && settingsTarget) setActiveTab('plugins'); }, [isOpen, settingsTarget]);
  // 关闭后清除一次性定位，普通设置入口沿用上次查看的栏目。
  useEffect(() => { if (!isOpen && settingsTarget) useLayoutStore.setState({settingsTarget:null}); }, [isOpen, settingsTarget]);
  const { settings, resolvedTheme, setThemeMode, setTypography, setEditor, setFile, setSystem } = useSettingsStore();

  // 使用全局更新状态 Store
  const { checking: checkingUpdate, checkForUpdates } = useUpdateStore();

  // 执行检查更新逻辑（主动检查）
  const handleCheckForUpdates = () => {
    checkForUpdates(false);
  };

  // 在系统默认浏览器打开 GitHub 仓库
  const handleOpenGithub = () => {
    ipc.openExternalUrl('https://github.com/CrazyFigure/NoteBoard').catch((err) => {
      console.error('无法打开 GitHub 链接:', err);
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

  // 设置右侧内容区域的容器引用
  const contentRef = useRef<HTMLDivElement>(null);

  // 切换设置 Tab 栏目或重新打开设置时，重置右侧内容区域的竖向滚动条至顶部
  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = 0;
    }
  }, [activeTab, isOpen]);

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
          {/* 左侧导航栏 */}
          <div
            className="nb-settings-nav"
            style={{
              width: 165,
              borderRight: '1px solid var(--editor-border)',
              background: 'var(--editor-surface)',
              padding: '14px 8px',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              flexShrink: 0,
            }}
          >
            <NavBtn
              active={activeTab === 'appearance'}
              icon={<Palette size={15} />}
              label="外观主题"
              onClick={() => setActiveTab('appearance')}
            />
            <NavBtn
              active={activeTab === 'typography'}
              icon={<Type size={15} />}
              label="排版与字体"
              onClick={() => setActiveTab('typography')}
            />
            <NavBtn
              active={activeTab === 'editor'}
              icon={<FileCode size={15} />}
              label="编辑器"
              onClick={() => setActiveTab('editor')}
            />
            <NavBtn
              active={activeTab === 'file'}
              icon={<Folder size={15} />}
              label="文件与保存"
              onClick={() => setActiveTab('file')}
            />
            <NavBtn
              active={activeTab === 'sync'}
              icon={<Cloud size={15} />}
              label="同步与备份"
              onClick={() => setActiveTab('sync')}
            />
            {/* 移动端没有物理键盘快捷键，隐藏该分组 */}
            <NavBtn active={activeTab === 'plugins'} icon={<LayoutTemplate size={15} />} label="插件" onClick={() => setActiveTab('plugins')} />
            {/* 插件管理在桌面、移动与网页端使用相同入口。 */}
            {!IS_MOBILE_UI && (
              <NavBtn
                active={activeTab === 'shortcuts'}
                icon={<Keyboard size={15} />}
                label="快捷键"
                onClick={() => setActiveTab('shortcuts')}
              />
            )}
            <NavBtn
              active={activeTab === 'about'}
              icon={<Info size={15} />}
              label="关于"
              onClick={() => setActiveTab('about')}
            />
          </div>

          {/* 右侧设置面板 */}
          <div ref={contentRef} className="nb-settings-content" style={{ flex: 1, padding: '24px 30px', overflowY: 'auto' }}>
            {/* 1. 外观主题 */}
            {activeTab === 'appearance' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                <div>
                  <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>主题配色方案</h3>
                  <p style={{ fontSize: 12, color: 'var(--editor-text-muted)', margin: 0 }}>
                    精心设计的经典配色，针对 Markdown 代码块与行内代码深度调优。
                  </p>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
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
              </div>
            )}

            {/* 2. 排版与字体 */}
            {activeTab === 'typography' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                <div>
                  <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>排版参数自定义</h3>
                  <p style={{ fontSize: 12, color: 'var(--editor-text-muted)', margin: 0 }}>
                    独立配置软件界面、Markdown 正文、代码与纯文本以及文件树的排版与版心宽度参数。
                  </p>
                </div>

                {/* 应用字体包独立于安装包，设置页提供下载、修复、导入和删除的长期入口。 */}
                <FontPackSettingsCard onOpen={() => { useLayoutStore.setState({settingsTarget:'fonts'}); setActiveTab('plugins'); }} />

                {/* ── 2.1 软件界面 UI 排版 ── */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 18, padding: '18px 20px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
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
                <div style={{ display: 'flex', flexDirection: 'column', gap: 18, padding: '18px 20px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
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
                    <div style={formRowStyle}>
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
                  <div style={formRowStyle}>
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
                  <div style={formRowStyle}>
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
                <div style={{ display: 'flex', flexDirection: 'column', gap: 18, padding: '18px 20px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
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

                  {/* 代码与纯文本编辑区最大宽度 */}
                  <div style={formRowStyle}>
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

                  {/* 代码文件效果预览 */}
                  <PreviewCollapse>
                    <pre className="nb-typography-code-preview" style={{
                      margin: 0,
                      padding: '10px 14px',
                      background: 'var(--code-block-bg)',
                      border: '1px solid var(--editor-border)',
                      borderRadius: 'var(--radius-sm)',
                      fontFamily: 'var(--mono-font-family)',
                      fontSize: settings.typography.monoFontSize ?? 14,
                      lineHeight: settings.typography.monoLineHeight ?? 1.5,
                      color: 'var(--code-block-text)',
                    }}>
                      <code>{`-- 查询笔记表（中西文代码混排测试）\nSELECT id, title, created_at\nFROM notes\nWHERE status = 'active' -- 仅查询有效笔记;`}</code>
                    </pre>
                  </PreviewCollapse>
                </div>

                {/* ── 2.5 文件树排版（资源管理器） ── */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 18, padding: '18px 20px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
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

            {/* 3. 编辑器配置 */}
            {activeTab === 'editor' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                <div>
                  <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>编辑器与代码设置</h3>
                  <p style={{ fontSize: 12, color: 'var(--editor-text-muted)', margin: 0 }}>
                    配置纯文本、SQL、JSON 等代码编辑器的显示效果及 Markdown 增强选项。
                  </p>
                </div>

                {/* ── 3.1 代码与纯文本展示 ── */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '18px 20px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13 }}>
                    <FileCode size={15} color="var(--accent-strong)" />
                    <span>代码与纯文本展示 (.txt / .sql / .json / .yaml 等)</span>
                  </div>

                  {/* 显示空格（显示为点） */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
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
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
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
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
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
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
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
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
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
                </div>

                {/* ── 3.2 缩进与编辑参数 ── */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '18px 20px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13 }}>
                    <FileText size={15} color="var(--accent-strong)" />
                    <span>缩进与通用选项</span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
                    <div>
                      <div>Tab 缩进宽度</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>每个 Tab 对应的空格数量</div>
                    </div>
                    <input
                      type="number"
                      min="1"
                      max="8"
                      value={settings.editor.tabSize}
                      onChange={(e) => setEditor({ tabSize: parseInt(e.target.value, 10) || 2 })}
                      style={{ ...inputStyle, width: 60, textAlign: 'center' }}
                    />
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
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

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
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

                  {/* 进入可视化模式时，若源码写法会被统一格式调整，按此策略处理（默认每次询问） */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
                    <div>
                      <div>Markdown 格式规范化</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>可视化模式会以统一写法保存源码（如列表符号统一为 -）</div>
                    </div>
                    <SettingsSelect<MarkdownNormalizationPolicy>
                      ariaLabel="Markdown 格式规范化"
                      value={settings.editor.markdownNormalization ?? 'ask'}
                      options={[
                        { value: 'ask', label: '每次询问' },
                        { value: 'always', label: '总是规范化' },
                        { value: 'never', label: '保持源码模式' },
                      ]}
                      onChange={(v) => setEditor({ markdownNormalization: v })}
                    />
                  </div>

                  {/* 可视化模式中代码块 / 折叠块的初始展开状态（仅影响显示，不写入文件） */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
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

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
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
                </div>

                {/* ── 3.3 Markdown 渲染增强 ── */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '18px 20px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--accent-strong)' }}>
                    Markdown 增强功能
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
                    <span>LaTeX 数学公式渲染 (KaTeX)</span>
                    <input
                      type="checkbox"
                      checked={settings.editor.enableMath}
                      onChange={(e) => setEditor({ enableMath: e.target.checked })}
                    />
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
                    <span>Mermaid 图表实时渲染</span>
                    <input
                      type="checkbox"
                      checked={settings.editor.enableMermaid}
                      onChange={(e) => setEditor({ enableMermaid: e.target.checked })}
                    />
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
                    <span>悬浮块把手 (拖拽与菜单)</span>
                    <input
                      type="checkbox"
                      checked={settings.editor.enableBlockHandle}
                      onChange={(e) => setEditor({ enableBlockHandle: e.target.checked })}
                    />
                  </div>
                </div>

                {/* ── 3.4 思维导图 ── */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '18px 20px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--accent-strong)' }}>
                    思维导图
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, padding: '2px 0' }}>
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

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
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

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
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

            {/* 4. 文件与保存设置 */}
            {activeTab === 'file' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                <div>
                  <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>文件与保存设置</h3>
                  <p style={{ fontSize: 12, color: 'var(--editor-text-muted)', margin: 0 }}>
                    按文件类型独立配置自动保存策略，以及本地文件管理选项。
                  </p>
                </div>

                {/* ── 4.1 自动保存设置 ── */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '18px 20px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13 }}>
                      <Save size={15} color="var(--accent-strong)" />
                      <span>自动保存设置 (分类型独立配置)</span>
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>{formatShortcut('默认关闭：使用 Ctrl+S 手动保存，关闭时自动拦截确认')}</span>
                  </div>

                  {/* Markdown 笔记自动保存 */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
                    <div>
                      <div>Markdown 笔记 (.md / .markdown)</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>停止输入 800ms 后自动写入磁盘；未开启时需手动保存</div>
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
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>绘制操作停止 800ms 后自动写入磁盘；未开启时需手动保存</div>
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
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>编辑停止 800ms 后自动写入磁盘；未开启时需手动保存</div>
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
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>绘制操作停止 800ms 后自动写入磁盘；未开启时需手动保存</div>
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
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>编辑停止 800ms 后自动写入磁盘；未开启时需手动保存</div>
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
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>编辑停止 800ms 后自动写入磁盘；未开启时需手动保存</div>
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
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>编辑停止 800ms 后自动写入磁盘；未开启时需手动保存</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.file.autoSaveOther ?? false}
                      onChange={(e) => setFile({ autoSaveOther: e.target.checked })}
                    />
                  </div>
                </div>

                {/* ── 4.2 文件与目录管理 ── */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '18px 20px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13 }}>
                    <Folder size={15} color="var(--accent-strong)" />
                    <span>文件树与会话选项</span>
                  </div>

                  {/* 显示隐藏文件 */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
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

                  {/* 保留最近文件：启动时恢复到 Tab 栏，但当前页面仍停留 Home。 */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
                    <div>
                      <div>保留最近文件</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>默认开启；启动时自动恢复到 Tab 栏，当前页面仍显示 Home</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.file.restoreSession ?? true}
                      onChange={(e) => setFile({ restoreSession: e.target.checked })}
                    />
                  </div>

                  {/* 关闭到托盘：开启后关闭按钮仅隐藏窗口，内容留在内存中，因此不弹未保存确认 */}
                  {SUPPORTS_SYSTEM_INTEGRATION && (
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
                  )}

                  {/* 大文件确认阈值 */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
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
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '18px 20px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
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
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '18px 20px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
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
            {activeTab === 'sync' && <SyncPanel />}
            {activeTab === 'plugins' && <PluginsPanel target={settingsTarget} />}

            {/* 6. 快捷键指南 */}
            {activeTab === 'shortcuts' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                <div>
                  <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>快捷键一览</h3>
                  <p style={{ fontSize: 12, color: 'var(--editor-text-muted)', margin: 0 }}>
                    支持选中文本局部操作或全文操作，兼容 VS Code 与 JetBrains 常用快捷键。
                  </p>
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
                  <ShortcutItem keyCombo="Ctrl + H" label="替换文本" />
                </div>

                {/* 全局与文件操作 */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-strong)', marginBottom: 4 }}>
                    全局与文件操作
                  </div>
                  <ShortcutItem keyCombo="Ctrl + O" label="打开文件" />
                  <ShortcutItem keyCombo="Ctrl + Shift + O" label="打开文件夹" />
                  <ShortcutItem keyCombo="Ctrl + Shift + N" label="新建空窗口" />
                  <ShortcutItem keyCombo="Ctrl + S" label="保存当前文档" />
                  <ShortcutItem keyCombo="Ctrl + Shift + S" label="文档另存为" />
                  <ShortcutItem keyCombo="Ctrl + W" label="关闭当前标签页" />
                  {/* 撤销 / 重做在各编辑器中通用（Markdown、代码、画板、思维导图、多维表格） */}
                  <ShortcutItem keyCombo="Ctrl + Z" label="撤销" />
                  <ShortcutItem keyCombo="Ctrl + Y" label="重做" />
                  {/* 全局唤起：无默认值，由用户录制；与快捷键条目同高，录制按钮占据右侧按键位 */}
                  {SUPPORTS_SYSTEM_INTEGRATION && (
                    <div
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
                </div>

                {/* Markdown 回车类按键（规则实现见 features/editor-md/enterKeyBehavior.ts）；细节放在 tip 中，行内只留要点 */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-strong)', marginBottom: 4 }}>
                    Markdown 回车类按键
                  </div>
                  {/* Enter 与 Shift+Enter 互换开关：与快捷键条目同高，复选框占据右侧按键位 */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                      padding: '8px 12px',
                      background: 'var(--editor-surface)',
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--editor-border)',
                      fontSize: 12,
                    }}
                  >
                    <ShortcutLabel
                      label="Enter 与 Shift + Enter 互换"
                      tip="开启后 Enter 段内换行、Shift + Enter 换段落；代码块、表格、标题与空行不受影响"
                    />
                    <input
                      type="checkbox"
                      checked={settings.editor.swapEnterKeys ?? false}
                      onChange={(e) => setEditor({ swapEnterKeys: e.target.checked })}
                    />
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
                  <ShortcutItem keyCombo="Enter" label="添加同级节点" />
                  <ShortcutItem keyCombo="Delete" label="删除选中节点" />
                  {/* 以下为编辑节点文字时（MindmapTitleEditor） */}
                  <ShortcutItem keyCombo="Shift + Enter / Alt + Enter" label="节点内换行" tip="编辑节点文字时" />
                  <ShortcutItem keyCombo="Ctrl + Enter / Esc" label="完成文字编辑" />
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
            {activeTab === 'about' && (
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
                  版本 v{APP_VERSION} · GPL-3.0 License
                </div>

                {/* 快捷操作：检测更新与 GitHub 仓库 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
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

                  <button
                    type="button"
                    className="nb-btn-secondary"
                    onClick={handleOpenGithub}
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
                    <span>GitHub 仓库</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

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


