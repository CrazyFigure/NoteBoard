// NoteBoard 可搜索系统字体下拉选择组件
// 点击懒加载系统字体 + 搜索过滤 + 字体即时视觉预览
// 详见 docs/06-主题与设计规范.md

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { ChevronDown, Search, Loader2, Check } from 'lucide-react';
import * as ipc from '../../core/ipc/commands';
import type { FontFamily } from '../../core/ipc/types';

interface FontSelectProps {
  value: string;
  onChange: (font: string) => void;
  isMonospaceOnly?: boolean;
  placeholder?: string;
}

// 缓存系统字体列表，避免多次重复拉取
let cachedSystemFonts: FontFamily[] | null = null;
let fontFetchPromise: Promise<FontFamily[]> | null = null;

async function fetchSystemFonts(): Promise<FontFamily[]> {
  if (cachedSystemFonts) return cachedSystemFonts;
  if (!fontFetchPromise) {
    fontFetchPromise = ipc.listSystemFonts().then((fonts) => {
      cachedSystemFonts = fonts;
      return fonts;
    });
  }
  return fontFetchPromise;
}

export function FontSelect({
  value,
  onChange,
  isMonospaceOnly = false,
  placeholder = '选择或输入字体…',
}: FontSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [fonts, setFonts] = useState<FontFamily[]>(cachedSystemFonts ?? []);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // 点击外部关闭
  useEffect(() => {
    if (!isOpen) return;
    const handleDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleDown);
    return () => document.removeEventListener('mousedown', handleDown);
  }, [isOpen]);

  // 打开下拉框时按需加载字体
  const handleToggle = async () => {
    const nextOpen = !isOpen;
    setIsOpen(nextOpen);
    if (nextOpen) {
      setSearchQuery('');
      if (!cachedSystemFonts) {
        setLoading(true);
        try {
          const list = await fetchSystemFonts();
          setFonts(list);
        } catch (err) {
          console.error('加载系统字体失败:', err);
        } finally {
          setLoading(false);
        }
      }
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 50);
    }
  };

  // 过滤后的字体列表
  const filteredFonts = useMemo(() => {
    let list = fonts;
    if (isMonospaceOnly) {
      list = list.filter((f) => f.isMonospace);
    }
    if (!searchQuery.trim()) return list;
    const q = searchQuery.toLowerCase().trim();
    return list.filter((f) => f.family.toLowerCase().includes(q));
  }, [fonts, isMonospaceOnly, searchQuery]);

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%' }}>
      {/* 触发输入区 */}
      <div
        onClick={handleToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 10px',
          border: isOpen ? '1px solid var(--accent-strong)' : '1px solid var(--editor-border)',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--editor-surface)',
          color: 'var(--editor-text)',
          fontSize: 12,
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: value ? `${value}, var(--ui-font-family)` : 'inherit',
          }}
        >
          {value || placeholder}
        </span>
        <ChevronDown
          size={14}
          style={{
            flexShrink: 0,
            transform: isOpen ? 'rotate(180deg)' : 'none',
            transition: 'transform var(--transition-fast)',
            color: 'var(--editor-text-muted)',
          }}
        />
      </div>

      {/* 弹出下拉面板 */}
      {isOpen && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            zIndex: 9999,
            background: 'var(--editor-bg)',
            border: '1px solid var(--editor-border)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-lg)',
            maxHeight: 260,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* 搜索框与手动输入 */}
          <div
            style={{
              padding: '6px 8px',
              borderBottom: '1px solid var(--editor-border)',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              background: 'var(--editor-surface)',
            }}
          >
            <Search size={13} color="var(--editor-text-muted)" style={{ flexShrink: 0 }} />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="搜索或自定义字体名称…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && searchQuery.trim()) {
                  onChange(searchQuery.trim());
                  setIsOpen(false);
                }
              }}
              style={{
                flex: 1,
                border: 'none',
                background: 'transparent',
                fontSize: 12,
                color: 'var(--editor-text)',
                outline: 'none',
              }}
            />
          </div>

          {/* 字体列表 */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
            {loading ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  padding: '16px 0',
                  fontSize: 12,
                  color: 'var(--editor-text-muted)',
                }}
              >
                <Loader2 size={14} className="animate-spin" />
                <span>扫描系统字体中…</span>
              </div>
            ) : filteredFonts.length === 0 ? (
              <div style={{ padding: '12px 16px', fontSize: 12, color: 'var(--editor-text-muted)', textAlign: 'center' }}>
                {searchQuery ? (
                  <div>
                    <span>未找到匹配字体</span>
                    <button
                      type="button"
                      onClick={() => {
                        onChange(searchQuery.trim());
                        setIsOpen(false);
                      }}
                      style={{
                        display: 'block',
                        margin: '6px auto 0',
                        padding: '3px 8px',
                        fontSize: 11,
                        borderRadius: 3,
                        border: '1px solid var(--editor-border)',
                        background: 'var(--editor-surface)',
                        color: 'var(--editor-text)',
                        cursor: 'pointer',
                      }}
                    >
                      使用 "{searchQuery.trim()}"
                    </button>
                  </div>
                ) : (
                  '暂无可用字体'
                )}
              </div>
            ) : (
              filteredFonts.map((font) => {
                const isSelected = value === font.family;
                return (
                  <div
                    key={font.family}
                    onClick={() => {
                      onChange(font.family);
                      setIsOpen(false);
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '6px 12px',
                      cursor: 'pointer',
                      fontSize: 13,
                      background: isSelected ? 'var(--editor-selection)' : 'transparent',
                      color: isSelected ? 'var(--accent-strong)' : 'var(--editor-text)',
                    }}
                    onMouseEnter={(e) => {
                      if (!isSelected) e.currentTarget.style.background = 'var(--editor-surface)';
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected) e.currentTarget.style.background = 'transparent';
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, overflow: 'hidden' }}>
                      <span
                        style={{
                          fontFamily: `${font.family}, sans-serif`,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {font.family}
                      </span>
                    </div>
                    {isSelected && <Check size={14} color="var(--accent-strong)" style={{ flexShrink: 0 }} />}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
