// NoteBoard 设置中心模态弹窗
// 外观主题切换（晨光/琥珀/墨夜/跟随系统） + 排版设置（字体/字号/行高/内容宽度） + 快捷键与关于
// 详见 docs/06-主题与设计规范.md 及 docs/07-UI布局与交互规范.md

import { useState } from 'react';
import { X, Palette, Type, Keyboard, Info, Check, FileText, FileCode, Folder } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';
import { THEMES } from '../../core/theme/themes';
import { FontSelect } from './FontSelect';
import type { ThemeId, ThemeMode, ContentWidth } from '../../core/ipc/types';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type TabType = 'appearance' | 'typography' | 'editor' | 'shortcuts' | 'about';

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<TabType>('appearance');
  const { settings, resolvedTheme, setThemeMode, setTypography, setEditor } = useSettingsStore();

  if (!isOpen) return null;

  const currentThemeMode = settings.appearance.themeMode;

  return (
    <div
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
        background: 'rgba(0, 0, 0, 0.45)',
        backdropFilter: 'blur(4px)',
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 640,
          maxWidth: '90vw',
          maxHeight: '85vh',
          background: 'var(--editor-bg)',
          border: '1px solid var(--editor-border)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-lg)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          color: 'var(--editor-text)',
          fontFamily: 'var(--content-font-family)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶部标题栏 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 18px',
            borderBottom: '1px solid var(--editor-border)',
            background: 'var(--editor-surface)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <img src="/logo.ico" alt="NoteBoard" width={18} height={18} />
            <span style={{ fontWeight: 600, fontSize: 14 }}>NoteBoard 设置</span>
          </div>
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
              padding: 4,
              borderRadius: 'var(--radius-sm)',
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* 主体两栏内容 */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* 左侧导航栏 */}
          <div
            style={{
              width: 140,
              borderRight: '1px solid var(--editor-border)',
              background: 'var(--editor-surface)',
              padding: '12px 6px',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
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
              active={activeTab === 'shortcuts'}
              icon={<Keyboard size={15} />}
              label="快捷键"
              onClick={() => setActiveTab('shortcuts')}
            />
            <NavBtn
              active={activeTab === 'about'}
              icon={<Info size={15} />}
              label="关于"
              onClick={() => setActiveTab('about')}
            />
          </div>

          {/* 右侧设置面板 */}
          <div style={{ flex: 1, padding: '20px 24px', overflowY: 'auto' }}>
            {/* 1. 外观主题 */}
            {activeTab === 'appearance' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div>
                  <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>主题配色方案</h3>
                  <p style={{ fontSize: 12, color: 'var(--editor-text-muted)', margin: 0 }}>
                    支持 TMD_Type-Markdown 经典配色，针对 Markdown 代码块与行内代码深度调优。
                  </p>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
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
                    desc="夜幕深邃 · 护眼暗色"
                    bg="#0f172a"
                    accent="#60a5fa"
                    codeBg="#1e293b"
                    codeColor="#93c5fd"
                    selected={currentThemeMode === 'mo-ye'}
                    onClick={() => setThemeMode('mo-ye')}
                  />
                  {/* 跟随系统 */}
                  <ThemeCard
                    title="跟随系统"
                    desc={`当前生效: ${THEMES[resolvedTheme]?.displayName ?? resolvedTheme}`}
                    bg="linear-gradient(135deg, #ffffff 50%, #0f172a 50%)"
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
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                <div>
                  <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>排版参数自定义</h3>
                  <p style={{ fontSize: 12, color: 'var(--editor-text-muted)', margin: 0 }}>
                    独立配置 Markdown 文档、代码/纯文本以及文件树的排版参数。
                  </p>
                </div>

                {/* ── 2.1 Markdown 正文排版 ── */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '12px 14px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13 }}>
                    <FileText size={15} color="var(--accent-strong)" />
                    <span>Markdown 正文排版</span>
                  </div>

                  {/* 正文字体 */}
                  <div style={formRowStyle}>
                    <label style={labelStyle}>正文字体</label>
                    <FontSelect
                      value={settings.typography.contentFontFamily}
                      placeholder="系统默认 (如: Microsoft YaHei UI, Segoe UI)"
                      onChange={(font) => setTypography({ contentFontFamily: font })}
                    />
                  </div>

                  {/* 正文字号与行高 */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div style={formRowStyle}>
                      <label style={labelStyle}>正文字号 ({settings.typography.contentFontSize}px)</label>
                      <input
                        type="range"
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
                      <input
                        type="range"
                        min="1.3"
                        max="2.4"
                        step="0.1"
                        value={settings.typography.contentLineHeight}
                        onChange={(e) => setTypography({ contentLineHeight: parseFloat(e.target.value) })}
                        style={{ width: '100%' }}
                      />
                    </div>
                  </div>

                  {/* 编辑区宽度 */}
                  <div style={formRowStyle}>
                    <label style={labelStyle}>编辑区域宽度</label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {(['narrow', 'standard', 'wide', 'full'] as ContentWidth[]).map((w) => {
                        const labels: Record<ContentWidth, string> = {
                          narrow: '窄 (65%)',
                          standard: '标准 (80%)',
                          wide: '宽屏 (92%)',
                          full: '全宽 (100%)',
                        };
                        return (
                          <button
                            key={w}
                            type="button"
                            onClick={() => setTypography({ contentWidth: w })}
                            style={{
                              flex: 1,
                              padding: '6px 8px',
                              fontSize: 12,
                              borderRadius: 'var(--radius-sm)',
                              border: settings.typography.contentWidth === w ? '1px solid var(--accent-strong)' : '1px solid var(--editor-border)',
                              background: settings.typography.contentWidth === w ? 'var(--editor-selection)' : 'var(--editor-bg)',
                              color: 'var(--editor-text)',
                              cursor: 'pointer',
                            }}
                          >
                            {labels[w]}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* ── 2.2 代码与纯文本排版 ── */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '12px 14px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13 }}>
                      <FileCode size={15} color="var(--accent-strong)" />
                      <span>代码与纯文本排版 (.sql / .txt / .json / 代码块)</span>
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>支持 Ctrl + 滚轮 快速缩放</span>
                  </div>

                  {/* 代码等宽字体 */}
                  <div style={formRowStyle}>
                    <label style={labelStyle}>代码等宽字体</label>
                    <FontSelect
                      value={settings.typography.monoFontFamily}
                      placeholder="Consolas, Cascadia Code, monospace"
                      isMonospaceOnly={true}
                      onChange={(font) => setTypography({ monoFontFamily: font })}
                    />
                  </div>

                  {/* 代码字号与行高 */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div style={formRowStyle}>
                      <label style={labelStyle}>代码字号 ({settings.typography.monoFontSize ?? 14}px)</label>
                      <input
                        type="range"
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
                      <input
                        type="range"
                        min="1.2"
                        max="2.2"
                        step="0.1"
                        value={settings.typography.monoLineHeight ?? 1.5}
                        onChange={(e) => setTypography({ monoLineHeight: parseFloat(e.target.value) })}
                        style={{ width: '100%' }}
                      />
                    </div>
                  </div>
                </div>

                {/* ── 2.3 文件树排版（资源管理器） ── */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '12px 14px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13 }}>
                      <Folder size={15} color="var(--accent-strong)" />
                      <span>文件树排版 (左侧资源管理器)</span>
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>支持 Ctrl + 滚轮 快速缩放</span>
                  </div>

                  {/* 文件树字体 */}
                  <div style={formRowStyle}>
                    <label style={labelStyle}>文件树字体</label>
                    <FontSelect
                      value={settings.typography.explorerFontFamily ?? ''}
                      placeholder="系统界面默认 (如: Microsoft YaHei UI, Segoe UI)"
                      onChange={(font) => setTypography({ explorerFontFamily: font })}
                    />
                  </div>

                  {/* 文件树字号与行高 */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div style={formRowStyle}>
                      <label style={labelStyle}>文件树字号 ({settings.typography.explorerFontSize ?? 13}px)</label>
                      <input
                        type="range"
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
                      <input
                        type="range"
                        min="20"
                        max="36"
                        step="1"
                        value={settings.typography.explorerLineHeight ?? 24}
                        onChange={(e) => setTypography({ explorerLineHeight: parseInt(e.target.value, 10) })}
                        style={{ width: '100%' }}
                      />
                    </div>
                  </div>
                </div>

                {/* ── 2.4 实时排版效果预览 ── */}
                <div>
                  <label style={{ ...labelStyle, marginBottom: 6, display: 'block' }}>实时排版预览</label>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 12,
                      padding: '14px 18px',
                      background: 'var(--editor-surface)',
                      border: '1px solid var(--editor-border)',
                      borderRadius: 'var(--radius-md)',
                    }}
                  >
                    {/* Markdown 正文预览 */}
                    <div
                      style={{
                        fontFamily: settings.typography.contentFontFamily || 'var(--content-font-family)',
                        fontSize: settings.typography.contentFontSize,
                        lineHeight: settings.typography.contentLineHeight,
                      }}
                    >
                      <p style={{ margin: '0 0 4px', fontWeight: 600, fontSize: '0.9em', color: 'var(--editor-text-muted)' }}>
                        Markdown 正文效果：
                      </p>
                      <p style={{ margin: 0 }}>
                        这是正文排版效果，展示<strong>加粗</strong>、<em>斜体</em>与 <code style={{
                          background: 'var(--code-inline-bg)',
                          color: 'var(--code-inline-text)',
                          padding: '2px 6px',
                          borderRadius: 'var(--radius-sm)',
                          fontFamily: settings.typography.monoFontFamily || 'var(--mono-font-family)',
                          fontSize: '0.88em',
                          border: '1px solid var(--editor-border)',
                        }}>const note = "NoteBoard";</code> 行内代码。
                      </p>
                    </div>

                    {/* 代码文件预览 */}
                    <div>
                      <p style={{ margin: '0 0 4px', fontWeight: 600, fontSize: 12, color: 'var(--editor-text-muted)' }}>
                        SQL / 代码 / 纯文本效果：
                      </p>
                      <pre style={{
                        margin: 0,
                        padding: '8px 12px',
                        background: 'var(--code-block-bg)',
                        border: '1px solid var(--editor-border)',
                        borderRadius: 'var(--radius-sm)',
                        fontFamily: settings.typography.monoFontFamily || 'var(--mono-font-family)',
                        fontSize: settings.typography.monoFontSize ?? 14,
                        lineHeight: settings.typography.monoLineHeight ?? 1.5,
                        color: 'var(--code-block-text)',
                      }}>
                        <code>{`SELECT id, title, created_at\nFROM notes\nWHERE status = 'active';`}</code>
                      </pre>
                    </div>

                    {/* 文件树条目预览 */}
                    <div>
                      <p style={{ margin: '0 0 4px', fontWeight: 600, fontSize: 12, color: 'var(--editor-text-muted)' }}>
                        文件树目录条目效果：
                      </p>
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
                            fontFamily: settings.typography.explorerFontFamily || 'inherit',
                          }}
                        >
                          <FileText size={14} color="var(--editor-accent)" />
                          <span>快速入门指南.md</span>
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
                            fontFamily: settings.typography.explorerFontFamily || 'inherit',
                          }}
                        >
                          <FileCode size={14} color="var(--editor-accent)" />
                          <span>query_report.sql</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* 3. 编辑器配置 */}
            {activeTab === 'editor' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div>
                  <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>编辑器与代码设置</h3>
                  <p style={{ fontSize: 12, color: 'var(--editor-text-muted)', margin: 0 }}>
                    配置纯文本、SQL、JSON 等代码编辑器的显示效果及 Markdown 增强选项。
                  </p>
                </div>

                {/* ── 3.1 代码与纯文本展示 ── */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '12px 14px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13 }}>
                    <FileCode size={15} color="var(--accent-strong)" />
                    <span>代码与纯文本展示 (.txt / .sql / .json / .yaml 等)</span>
                  </div>

                  {/* 显示空格（显示为点） */}
                  <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, cursor: 'pointer' }}>
                    <div>
                      <div>显示空格（点）</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>将文本中的空格显示为轻柔圆点标记，制表符显示为箭头</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.editor.showWhitespace ?? false}
                      onChange={(e) => setEditor({ showWhitespace: e.target.checked })}
                    />
                  </label>

                  {/* 显示换行符（↵） */}
                  <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, cursor: 'pointer' }}>
                    <div>
                      <div>显示换行符号 (↵)</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>在各行末尾显示 ↵ 换行指示符号</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.editor.showLineEndings ?? false}
                      onChange={(e) => setEditor({ showLineEndings: e.target.checked })}
                    />
                  </label>

                  {/* 显示行号 */}
                  <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, cursor: 'pointer' }}>
                    <div>
                      <div>显示行号</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>在左侧边栏展示代码行号及活动行高亮</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.editor.showLineNumbers}
                      onChange={(e) => setEditor({ showLineNumbers: e.target.checked })}
                    />
                  </label>

                  {/* 软换行 */}
                  <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, cursor: 'pointer' }}>
                    <div>
                      <div>软换行 (自动折行)</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>超出编辑器可视宽度时自动折行，避免横向滚动</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.editor.softWrap}
                      onChange={(e) => setEditor({ softWrap: e.target.checked })}
                    />
                  </label>

                  {/* 缩进导线 */}
                  <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, cursor: 'pointer' }}>
                    <div>
                      <div>缩进参考导线</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>在代码层级之间显示垂直虚线导线</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.editor.showIndentGuides}
                      onChange={(e) => setEditor({ showIndentGuides: e.target.checked })}
                    />
                  </label>
                </div>

                {/* ── 3.2 缩进与编辑参数 ── */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '12px 14px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13 }}>
                    <FileText size={15} color="var(--accent-strong)" />
                    <span>缩进与通用选项</span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13 }}>
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

                  <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, cursor: 'pointer' }}>
                    <div>
                      <div>空格代替 Tab</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>按下 Tab 键时插入对应数量的空格</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.editor.insertSpaces}
                      onChange={(e) => setEditor({ insertSpaces: e.target.checked })}
                    />
                  </label>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13 }}>
                    <div>
                      <div>Markdown 默认视图模式</div>
                      <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>新打开 Markdown 文档时的初始模式</div>
                    </div>
                    <select
                      value={settings.editor.defaultViewMode}
                      onChange={(e) => setEditor({ defaultViewMode: e.target.value as 'visual' | 'source' })}
                      style={{ ...inputStyle, width: 110 }}
                    >
                      <option value="visual">可视化模式</option>
                      <option value="source">源码模式</option>
                    </select>
                  </div>
                </div>

                {/* ── 3.3 Markdown 渲染增强 ── */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '12px 14px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--accent-strong)' }}>
                    Markdown 增强功能
                  </div>

                  <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, cursor: 'pointer' }}>
                    <span>LaTeX 数学公式渲染 (KaTeX)</span>
                    <input
                      type="checkbox"
                      checked={settings.editor.enableMath}
                      onChange={(e) => setEditor({ enableMath: e.target.checked })}
                    />
                  </label>

                  <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, cursor: 'pointer' }}>
                    <span>Mermaid 图表实时渲染</span>
                    <input
                      type="checkbox"
                      checked={settings.editor.enableMermaid}
                      onChange={(e) => setEditor({ enableMermaid: e.target.checked })}
                    />
                  </label>

                  <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, cursor: 'pointer' }}>
                    <span>悬浮块把手 (拖拽与菜单)</span>
                    <input
                      type="checkbox"
                      checked={settings.editor.enableBlockHandle}
                      onChange={(e) => setEditor({ enableBlockHandle: e.target.checked })}
                    />
                  </label>
                </div>
              </div>
            )}

            {/* 4. 快捷键指南 */}
            {activeTab === 'shortcuts' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div>
                  <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>快捷键一览</h3>
                  <p style={{ fontSize: 12, color: 'var(--editor-text-muted)', margin: 0 }}>
                    支持选中文本局部操作或全文操作，兼容 VS Code 与 JetBrains 常用快捷键。
                  </p>
                </div>

                {/* JSON 与代码快捷操作 */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-strong)', marginBottom: 2 }}>
                    JSON 与纯文本快捷处理 (.json / .txt / 源码模式)
                  </div>
                  <ShortcutItem keyCombo="Shift + Alt + F / Ctrl + Alt + L" label="JSON 展开 / 格式化（支持选区 / 全文）" />
                  <ShortcutItem keyCombo="Shift + Alt + M / Ctrl + Alt + M" label="JSON 压缩为单行（支持选区 / 全文）" />
                  <ShortcutItem keyCombo="Shift + Alt + V / Ctrl + Alt + V" label="JSON 格式校验与错误定位（支持选区 / 全文）" />
                </div>

                {/* 查找与替换 */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-strong)', marginBottom: 2 }}>
                    查找与替换
                  </div>
                  <ShortcutItem keyCombo="Ctrl + F" label="查找文本" />
                  <ShortcutItem keyCombo="Ctrl + H" label="替换文本" />
                </div>

                {/* 全局与文件操作 */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-strong)', marginBottom: 2 }}>
                    全局与文件操作
                  </div>
                  <ShortcutItem keyCombo="Ctrl + O" label="打开文件" />
                  <ShortcutItem keyCombo="Ctrl + K, Ctrl + O" label="打开文件夹" />
                  <ShortcutItem keyCombo="Ctrl + N" label="新建 Markdown 笔记" />
                  <ShortcutItem keyCombo="Ctrl + Shift + N" label="新建空窗口" />
                  <ShortcutItem keyCombo="Ctrl + S" label="保存当前文档" />
                  <ShortcutItem keyCombo="Ctrl + Shift + S" label="文档另存为" />
                  <ShortcutItem keyCombo="Ctrl + W" label="关闭当前标签页" />
                  <ShortcutItem keyCombo="Ctrl + ," label="打开设置中心" />
                </div>

                {/* Markdown 与编辑 */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-strong)', marginBottom: 2 }}>
                    Markdown 与排版
                  </div>
                  <ShortcutItem keyCombo="Ctrl + /" label="切换 Markdown 可视化 / 源码模式" />
                  <ShortcutItem keyCombo="/" label="Markdown 中触发斜杠快捷插入" />
                  <ShortcutItem keyCombo="Ctrl + 滚轮" label="实时缩放编辑器代码字号 / 文件树字号" />
                </div>
              </div>
            )}

            {/* 4. 关于 */}
            {activeTab === 'about' && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 12, padding: '16px 0' }}>
                <img src="/logo.ico" alt="NoteBoard Logo" width={56} height={56} />
                <div>
                  <h2 style={{ fontSize: 18, fontWeight: 600, margin: '4px 0' }}>NoteBoard</h2>
                  <span style={{ fontSize: 12, color: 'var(--editor-text-muted)' }}>Windows 优雅桌面笔记 + 自由画板</span>
                </div>
                <p style={{ fontSize: 12, color: 'var(--editor-text-secondary)', maxWidth: 360, lineHeight: 1.6, margin: '8px 0' }}>
                  参考 note-gen 编辑交互与 TMD_Type-Markdown 美学配色，采用 Rust Tauri v2 原生高性能底座与 TipTap / CodeMirror 6 / Excalidraw 双核驱动。
                </p>
                <div style={{ fontSize: 11, color: 'var(--editor-text-muted)', marginTop: 8 }}>
                  版本 v0.1.0 · GPL-3.0 License
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
        padding: '8px 10px',
        border: 'none',
        borderRadius: 'var(--radius-sm)',
        background: active ? 'var(--editor-selection)' : 'transparent',
        color: active ? 'var(--accent-strong)' : 'var(--editor-text)',
        fontWeight: active ? 600 : 400,
        fontSize: 12,
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'background var(--transition-fast)',
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
        padding: '12px',
        borderRadius: 'var(--radius-md)',
        border: selected ? '2px solid var(--accent-strong)' : '1px solid var(--editor-border)',
        background: 'var(--editor-surface)',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        transition: 'border-color var(--transition-fast)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{title}</span>
        {selected && <Check size={14} color="var(--accent-strong)" />}
      </div>
      <span style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>{desc}</span>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
        <div style={{ width: 22, height: 22, borderRadius: '50%', background: bg, border: '1px solid var(--editor-border)' }} title="背景色" />
        <div style={{ width: 22, height: 22, borderRadius: '50%', background: accent }} title="强调色" />
        <div style={{ width: 22, height: 22, borderRadius: '50%', background: codeBg, border: '1px solid var(--editor-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: codeColor, fontSize: 9, fontWeight: 'bold' }} title="代码块色">
          &lt;&gt;
        </div>
      </div>
    </div>
  );
}

function ShortcutItem({ keyCombo, label }: { keyCombo: string; label: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '6px 10px',
        background: 'var(--editor-surface)',
        borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--editor-border)',
        fontSize: 12,
      }}
    >
      <span style={{ color: 'var(--editor-text)' }}>{label}</span>
      <kbd
        style={{
          padding: '2px 6px',
          background: 'var(--editor-bg)',
          border: '1px solid var(--editor-border)',
          borderRadius: 3,
          fontFamily: 'var(--mono-font-family)',
          fontSize: 11,
          color: 'var(--editor-text-secondary)',
        }}
      >
        {keyCombo}
      </kbd>
    </div>
  );
}

const formRowStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
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
