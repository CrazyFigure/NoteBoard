// NoteBoard 顶部标题栏快捷主题切换菜单组件
// 支持快速在「跟随系统 / 晨光 / 琥珀 / 墨夜」之间切换，附带实时色块预览与选中指示

import { useState, useRef, useEffect } from 'react';
import { Palette, Check, Sparkles } from 'lucide-react';
import { Tooltip } from '../Tooltip';
import { useSettingsStore } from '../../stores/settingsStore';
import type { ThemeMode } from '../../core/ipc/types';

// 主题快捷选项定义
interface ThemeOption {
  id: ThemeMode;
  label: string;
  desc: string;
  previewBg: string;
  previewAccent: string;
}

const THEME_OPTIONS: ThemeOption[] = [
  {
    id: 'system',
    label: '跟随系统',
    desc: '自动跟随系统明暗设置',
    previewBg: 'linear-gradient(135deg, #ffffff 50%, #0f172a 50%)',
    previewAccent: '#8b5cf6',
  },
  {
    id: 'chen-guang',
    label: '晨光',
    desc: '清新明亮 · 晨曦蓝调',
    previewBg: '#ffffff',
    previewAccent: '#3b82f6',
  },
  {
    id: 'hu-po',
    label: '琥珀',
    desc: '温暖纸质 · 琥珀赤陶',
    previewBg: '#FAF9F5',
    previewAccent: '#D97757',
  },
  {
    id: 'mo-ye',
    label: '墨夜',
    desc: '夜幕深邃 · 护眼暗色',
    previewBg: '#0f172a',
    previewAccent: '#60a5fa',
  },
];

export function ThemeMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const { settings, setThemeMode } = useSettingsStore();
  const currentMode = settings.appearance.themeMode;

  // 点击外部或按 Esc 键自动关闭浮层
  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  // 选择主题并关闭菜单
  const handleSelectTheme = (mode: ThemeMode) => {
    setThemeMode(mode);
    setIsOpen(false);
  };

  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      {/* 顶部主题快捷按钮 */}
      <Tooltip content="快捷切换主题" disabled={isOpen} side="bottom" sideOffset={6}>
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setIsOpen((prev) => !prev)}
          style={{
            width: 36,
            height: 36,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            background: isOpen ? 'var(--toolbar-hover)' : 'transparent',
            color: isOpen ? 'var(--accent-strong)' : 'var(--editor-text-secondary)',
            cursor: 'pointer',
            flexShrink: 0,
            transition: 'all var(--transition-fast)',
          }}
          onMouseEnter={(e) => {
            if (!isOpen) {
              e.currentTarget.style.background = 'var(--toolbar-hover)';
              e.currentTarget.style.color = 'var(--editor-text)';
              e.currentTarget.style.transform = 'scale(1.05)';
            }
          }}
          onMouseLeave={(e) => {
            if (!isOpen) {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = 'var(--editor-text-secondary)';
              e.currentTarget.style.transform = 'scale(1)';
            }
          }}
          onMouseDown={(e) => {
            e.currentTarget.style.background = 'var(--toolbar-active)';
            e.currentTarget.style.transform = 'scale(0.92)';
          }}
          onMouseUp={(e) => {
            e.currentTarget.style.background = 'var(--toolbar-hover)';
            e.currentTarget.style.transform = 'scale(1.05)';
          }}
          aria-label="快捷切换主题"
        >
          <Palette size={15} />
        </button>
      </Tooltip>

      {/* 快捷主题选择浮层 */}
      {isOpen && (
        <div
          ref={menuRef}
          style={{
            position: 'absolute',
            top: 38,
            right: 0,
            width: 190,
            background: 'var(--editor-surface)',
            border: '1px solid var(--editor-border)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-lg)',
            padding: '6px',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            zIndex: 1000,
            color: 'var(--editor-text)',
            fontSize: 'var(--ui-font-size, 13px)',
            fontFamily: 'var(--ui-font-family, inherit)',
            animation: 'fadeIn 0.15s ease',
          }}
        >
          {/* 浮层小标题 */}
          <div
            style={{
              padding: '6px 8px 4px',
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--editor-text-muted)',
              borderBottom: '1px solid var(--editor-border)',
              marginBottom: 4,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span>快捷选择主题</span>
            <Sparkles size={12} color="var(--accent-strong)" />
          </div>

          {/* 主题列表选项 */}
          {THEME_OPTIONS.map((opt) => {
            const isSelected = currentMode === opt.id;

            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => handleSelectTheme(opt.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '7px 8px',
                  borderRadius: 'var(--radius-sm)',
                  border: 'none',
                  background: isSelected ? 'var(--editor-selection)' : 'transparent',
                  color: isSelected ? 'var(--accent-strong)' : 'var(--editor-text)',
                  cursor: 'pointer',
                  fontSize: 13,
                  textAlign: 'left',
                  transition: 'background var(--transition-fast), color var(--transition-fast)',
                }}
                onMouseEnter={(e) => {
                  if (!isSelected) {
                    e.currentTarget.style.background = 'var(--toolbar-hover)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isSelected) {
                    e.currentTarget.style.background = 'transparent';
                  }
                }}
              >
                {/* 左侧：色块预览 + 主题名称 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {/* 主题预览色块圆点 */}
                  <div
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: '50%',
                      background: opt.previewBg,
                      border: '1px solid var(--editor-border)',
                      boxShadow: `0 0 0 1.5px ${opt.previewAccent}40`,
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ fontWeight: isSelected ? 600 : 400 }}>{opt.label}</span>
                </div>

                {/* 右侧：选中指示 */}
                {isSelected && <Check size={14} strokeWidth={2.5} color="var(--accent-strong)" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
