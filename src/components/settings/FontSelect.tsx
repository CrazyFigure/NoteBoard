// NoteBoard 可搜索系统字体下拉选择组件
// 全局响应式字体缓存共享 + 搜索过滤 + 分类切换（中文/西文/等宽） + 一键恢复默认 + 即时字形预览
// 详见 docs/06-主题与设计规范.md

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { ChevronDown, Search, Loader2, Check, X, RotateCcw } from 'lucide-react';
import { Tooltip } from '../Tooltip';
import * as ipc from '../../core/ipc/commands';
import type { FontFamily } from '../../core/ipc/types';
import {
  getApplicationFontFamilies,
  PACKAGED_FONT_FAMILIES,
  subscribeApplicationFontFamilies,
} from '../../app/fontPack';

export type FontFilterCategory = 'all' | 'zh' | 'en' | 'mono';

interface FontSelectProps {
  value: string;
  onChange: (font: string) => void;
  isMonospaceOnly?: boolean;
  filterType?: FontFilterCategory;
  placeholder?: string;
}

// 字体包元数据只在 FontFace 注册完成后加入下拉框，未下载时不能伪装成可用字体。
const APPLICATION_FONT_METADATA: FontFamily[] = [
  { family: PACKAGED_FONT_FAMILIES[0], isMonospace: true, hasCjk: false },
  { family: PACKAGED_FONT_FAMILIES[1], isMonospace: true, hasCjk: true },
];

/** 将系统字体与当前已注册应用字体去重合并，应用字体置顶便于快速选择。 */
function mergeFonts(systemFonts: FontFamily[], applicationFamilies: readonly string[]): FontFamily[] {
  const map = new Map<string, FontFamily>();
  const active = new Set(applicationFamilies.map((family) => family.toLowerCase()));
  for (const font of APPLICATION_FONT_METADATA) {
    if (active.has(font.family.toLowerCase())) map.set(font.family.toLowerCase(), font);
  }
  for (const f of systemFonts) {
    const key = f.family.toLowerCase();
    if (!map.has(key)) {
      map.set(key, f);
    }
  }
  return Array.from(map.values());
}

// 原始系统字体与合并结果分开缓存，字体包下载/删除后可即时重算而无需重新扫描 Windows。
let cachedSystemFonts: FontFamily[] | null = null;
let cachedFontOptions: FontFamily[] | null = null;
let fontFetchPromise: Promise<FontFamily[]> | null = null;

type FontListener = (fonts: FontFamily[]) => void;
const fontListeners = new Set<FontListener>();

function notifyFontListeners(fonts: FontFamily[]) {
  cachedFontOptions = fonts;
  fontListeners.forEach((fn) => fn(fonts));
}

async function fetchSystemFonts(): Promise<FontFamily[]> {
  if (cachedSystemFonts) {
    return mergeFonts(cachedSystemFonts, getApplicationFontFamilies());
  }
  if (!fontFetchPromise) {
    fontFetchPromise = ipc
      .listSystemFonts()
      .then((fonts) => {
        cachedSystemFonts = fonts;
        const merged = mergeFonts(fonts, getApplicationFontFamilies());
        notifyFontListeners(merged);
        return merged;
      })
      .catch((err) => {
        console.error('加载系统字体失败:', err);
        const fallback = mergeFonts([], getApplicationFontFamilies());
        notifyFontListeners(fallback);
        fontFetchPromise = null;
        return fallback;
      });
  }
  return fontFetchPromise;
}

// 应用字体注册状态变化时只重算合并列表，不触发昂贵的系统字体重新扫描。
subscribeApplicationFontFamilies((families) => {
  notifyFontListeners(mergeFonts(cachedSystemFonts ?? [], families));
});

// 模块加载时自动在后台预加载系统字体
if (typeof window !== 'undefined') {
  fetchSystemFonts();
}

/** 辅助判断是否包含中文字符集 */
function isCjkFont(font: FontFamily): boolean {
  if (font.hasCjk) return true;
  const name = font.family.toLowerCase();
  return (
    /[\u4e00-\u9fff]/.test(font.family) ||
    name.includes('yahei') ||
    name.includes('simsun') ||
    name.includes('simhei') ||
    name.includes('kaiti') ||
    name.includes('fangsong') ||
    name.includes('dengxian') ||
    name.includes('pingfang') ||
    name.includes('noto sans sc') ||
    name.includes('noto serif sc') ||
    name.includes('source han') ||
    name.includes('songti') ||
    name.includes('heiti') ||
    name.includes('lxgw') ||
    name.includes('xiawu') ||
    name.includes('sarasa') ||
    name.includes('maple') ||
    name.includes('wenquanyi') ||
    name.includes('jhenghei') ||
    name.includes('mingliu')
  );
}

/** 辅助判断是否等宽代码字体 */
function isMonoFont(font: FontFamily): boolean {
  if (font.isMonospace) return true;
  const lower = font.family.toLowerCase();
  return (
    lower.includes('mono') ||
    lower.includes('code') ||
    lower.includes('consolas') ||
    lower.includes('courier') ||
    lower.includes('typewriter') ||
    lower.includes('terminal') ||
    lower.includes('fixed') ||
    lower.includes('fira') ||
    lower.includes('jetbrains') ||
    lower.includes('maple') ||
    lower.includes('cascadia')
  );
}

export function FontSelect({
  value,
  onChange,
  isMonospaceOnly = false,
  filterType,
  placeholder = '选择或输入字体',
}: FontSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [fonts, setFonts] = useState<FontFamily[]>(cachedFontOptions ?? []);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<FontFilterCategory>(
    filterType ?? (isMonospaceOnly ? 'mono' : 'all'),
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // 监听全局字体缓存更新，确保多实例无缝同步数据
  useEffect(() => {
    const handleUpdate: FontListener = (list) => {
      setFonts(list);
    };
    fontListeners.add(handleUpdate);
    if (cachedFontOptions && fonts.length === 0) {
      setFonts(cachedFontOptions);
    }
    return () => {
      fontListeners.delete(handleUpdate);
    };
  }, [fonts.length]);

  // 当外部 filterType 属性变更时同步
  useEffect(() => {
    if (filterType) {
      setActiveCategory(filterType);
    } else if (isMonospaceOnly) {
      setActiveCategory('mono');
    }
  }, [filterType, isMonospaceOnly]);

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
      setActiveCategory(filterType ?? (isMonospaceOnly ? 'mono' : 'all'));
      if (cachedSystemFonts) {
        setFonts(mergeFonts(cachedSystemFonts, getApplicationFontFamilies()));
      } else {
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

    // 分类过滤
    if (activeCategory === 'mono') {
      list = list.filter((f) => isMonoFont(f));
    } else if (activeCategory === 'zh') {
      list = list.filter((f) => isCjkFont(f));
    } else if (activeCategory === 'en') {
      list = list.filter((f) => !isCjkFont(f));
    }

    if (!searchQuery.trim()) return list;
    const q = searchQuery.toLowerCase().trim();
    const matched = list.filter((f) => f.family.toLowerCase().includes(q));
    // 若在当前分类下搜不到，自动扩大搜索到全量字体
    if (matched.length === 0 && activeCategory !== 'all') {
      return fonts.filter((f) => f.family.toLowerCase().includes(q));
    }
    return matched;
  }, [fonts, activeCategory, searchQuery]);

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
          color: value ? 'var(--editor-text)' : 'var(--editor-text-muted)',
          fontSize: 'var(--ui-font-size, 13px)',
          cursor: 'pointer',
          userSelect: 'none',
          gap: 6,
          transition: 'border-color var(--transition-fast)',
        }}
      >
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: value ? `"${value}", var(--ui-font-family)` : 'inherit',
            flex: 1,
            color: value ? 'var(--editor-text)' : 'var(--editor-text-muted)',
          }}
        >
          {value || placeholder}
        </span>

        {/* 若已有选定值，显示清除重置按钮 */}
        {value ? (
          <Tooltip content="恢复系统默认" side="top" sideOffset={4}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onChange('');
              }}
              style={{
                border: 'none',
                background: 'transparent',
                padding: 2,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--editor-text-muted)',
                borderRadius: 3,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = 'var(--editor-text)';
                e.currentTarget.style.background = 'var(--toolbar-hover)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = 'var(--editor-text-muted)';
                e.currentTarget.style.background = 'transparent';
              }}
              aria-label="恢复系统默认"
            >
              <X size={13} />
            </button>
          </Tooltip>
        ) : null}

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
            maxHeight: 280,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* 顶部搜索框 */}
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
              placeholder="搜索或直接输入字体名称"
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

          {/* 分类快捷标签栏 */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '4px 8px',
              borderBottom: '1px solid var(--editor-border)',
              background: 'var(--editor-bg)',
              fontSize: 11,
            }}
          >
            {(
              [
                { key: 'all', label: '全部' },
                { key: 'zh', label: '中文字体' },
                { key: 'en', label: '西文字体' },
                { key: 'mono', label: '等宽代码' },
              ] as const
            ).map((cat) => {
              const active = activeCategory === cat.key;
              return (
                <button
                  key={cat.key}
                  type="button"
                  onClick={() => setActiveCategory(cat.key)}
                  style={{
                    border: 'none',
                    borderRadius: 3,
                    padding: '2px 7px',
                    cursor: 'pointer',
                    fontSize: 11,
                    background: active ? 'var(--editor-selection)' : 'transparent',
                    color: active ? 'var(--accent-strong)' : 'var(--editor-text-muted)',
                    fontWeight: active ? 600 : 400,
                    transition: 'all var(--transition-fast)',
                  }}
                >
                  {cat.label}
                </button>
              );
            })}
          </div>

          {/* 字体列表 */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
            {/* 系统默认选项 */}
            <div
              onClick={() => {
                onChange('');
                setIsOpen(false);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '6px 12px',
                cursor: 'pointer',
                fontSize: 12,
                background: !value ? 'var(--editor-selection)' : 'transparent',
                color: !value ? 'var(--accent-strong)' : 'var(--editor-text)',
                borderBottom: '1px dashed var(--editor-border)',
              }}
              onMouseEnter={(e) => {
                if (value) e.currentTarget.style.background = 'var(--editor-surface)';
              }}
              onMouseLeave={(e) => {
                if (value) e.currentTarget.style.background = 'transparent';
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <RotateCcw size={12} color="var(--editor-text-muted)" />
                <span style={{ fontWeight: 500 }}>系统默认 (跟随系统)</span>
              </div>
              {!value && <Check size={14} color="var(--accent-strong)" style={{ flexShrink: 0 }} />}
            </div>

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
                <span>扫描系统字体中</span>
              </div>
            ) : filteredFonts.length === 0 ? (
              <div style={{ padding: '12px 16px', fontSize: 12, color: 'var(--editor-text-muted)', textAlign: 'center' }}>
                {searchQuery ? (
                  <div>
                    <span>未找到匹配字体</span>
                    <button
                      type="button"
                      className="nb-btn-secondary"
                      onClick={() => {
                        onChange(searchQuery.trim());
                        setIsOpen(false);
                      }}
                      style={{
                        display: 'block',
                        margin: '6px auto 0',
                        padding: '4px 10px',
                        fontSize: 11,
                      }}
                    >
                      使用 "{searchQuery.trim()}"
                    </button>
                  </div>
                ) : (
                  '该分类下暂无可用字体'
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
                      <span
                        style={{
                          fontFamily: `"${font.family}", sans-serif`,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontSize: 13,
                        }}
                      >
                        {font.family}
                      </span>
                      {/* 当前 WebView 已注册的应用字体专属徽标 */}
                      {getApplicationFontFamilies().some((family) => family.toLowerCase() === font.family.toLowerCase()) && (
                        <span
                          style={{
                            fontSize: 10,
                            padding: '1px 4px',
                            borderRadius: 2,
                            background: 'var(--accent-muted, rgba(99, 102, 241, 0.15))',
                            color: 'var(--accent-strong, #6366f1)',
                            flexShrink: 0,
                            fontWeight: 500,
                          }}
                        >
                          应用字体
                        </span>
                      )}
                      {font.isMonospace && (
                        <span
                          style={{
                            fontSize: 10,
                            padding: '1px 4px',
                            borderRadius: 2,
                            background: 'var(--code-inline-bg)',
                            color: 'var(--code-inline-text)',
                            flexShrink: 0,
                          }}
                        >
                          等宽
                        </span>
                      )}
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
