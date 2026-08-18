// NoteBoard 代码块 NodeView
// 语言选择（带模糊搜索与键盘导航） + 复制按钮 + 自由编辑 NodeViewContent
// 详见 docs/09-开发路线图.md 7.8

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { NodeViewWrapper, NodeViewContent, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import CodeBlock from '@tiptap/extension-code-block';
import { Copy, Check, ChevronDown, Search, X } from 'lucide-react';
import { normalizeLanguage } from './lowlight';

/** 语言配置结构定义 */
interface LanguageItem {
  value: string;
  label: string;
  aliases: string[];
}

/** 支持的代码语言完整列表及检索别名 */
const LANGUAGES: LanguageItem[] = [
  { value: 'plaintext', label: '纯文本', aliases: ['text', 'txt', 'plain', 'chunwenben', 'wb'] },
  { value: 'javascript', label: 'JavaScript', aliases: ['js', 'jsx', 'node', 'react'] },
  { value: 'typescript', label: 'TypeScript', aliases: ['ts', 'tsx'] },
  { value: 'python', label: 'Python', aliases: ['py', 'python3', 'py3'] },
  { value: 'java', label: 'Java', aliases: ['jvm'] },
  { value: 'c', label: 'C', aliases: ['clang'] },
  { value: 'cpp', label: 'C++', aliases: ['c++', 'cplusplus', 'cc'] },
  { value: 'csharp', label: 'C#', aliases: ['c#', 'cs', 'dotnet', '.net'] },
  { value: 'go', label: 'Go', aliases: ['golang'] },
  { value: 'rust', label: 'Rust', aliases: ['rs', 'cargo'] },
  { value: 'sql', label: 'SQL', aliases: ['mysql', 'postgres', 'sqlite', 'oracle'] },
  { value: 'json', label: 'JSON', aliases: [] },
  { value: 'yaml', label: 'YAML', aliases: ['yml'] },
  { value: 'xml', label: 'XML', aliases: ['html', 'xhtml', 'svg'] },
  { value: 'markdown', label: 'Markdown', aliases: ['md'] },
  { value: 'bash', label: 'Bash', aliases: ['sh', 'shell', 'zsh', 'terminal'] },
  { value: 'css', label: 'CSS', aliases: ['scss', 'less', 'style'] },
  { value: 'shell', label: 'Shell', aliases: ['sh', 'bash', 'zsh'] },
];

function CodeBlockComponent({ node, updateAttributes }: NodeViewProps) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [copied, setCopied] = useState(false);

  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const language = normalizeLanguage(node.attrs.language || 'plaintext');

  // 当打开下拉面板时重置搜索词与焦点
  useEffect(() => {
    if (showDropdown) {
      setSearchQuery('');
      setSelectedIndex(0);
      // 延迟微任务聚焦，避免与点击触发冲突
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 30);
    }
  }, [showDropdown]);

  // 点击外部关闭下拉
  useEffect(() => {
    if (!showDropdown) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showDropdown]);

  // 语言搜索与模糊匹配过滤
  const filteredLanguages = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return LANGUAGES;

    return LANGUAGES.filter((item) => {
      const matchLabel = item.label.toLowerCase().includes(q);
      const matchValue = item.value.toLowerCase().includes(q);
      const matchAlias = item.aliases.some((a) => a.toLowerCase().includes(q));
      return matchLabel || matchValue || matchAlias;
    }).sort((a, b) => {
      // 精确或前缀匹配优先
      const aStarts = a.value.startsWith(q) || a.label.toLowerCase().startsWith(q) || a.aliases.some((al) => al.startsWith(q));
      const bStarts = b.value.startsWith(q) || b.label.toLowerCase().startsWith(q) || b.aliases.some((al) => al.startsWith(q));
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;
      return 0;
    });
  }, [searchQuery]);

  // 切换目标语言
  const handleLanguageChange = useCallback(
    (lang: string) => {
      updateAttributes({ language: lang });
      setShowDropdown(false);
    },
    [updateAttributes],
  );

  // 搜索框键盘上下选择与回车确认
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (filteredLanguages.length > 0 ? (prev + 1) % filteredLanguages.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (filteredLanguages.length > 0 ? (prev - 1 + filteredLanguages.length) % filteredLanguages.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filteredLanguages[selectedIndex]) {
        handleLanguageChange(filteredLanguages[selectedIndex].value);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setShowDropdown(false);
    }
  };

  // 滚动聚焦当前选中项
  useEffect(() => {
    if (showDropdown && listRef.current) {
      const activeEl = listRef.current.children[selectedIndex] as HTMLElement | undefined;
      if (activeEl) {
        activeEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [selectedIndex, showDropdown]);

  // 复制代码内容
  const handleCopy = useCallback(() => {
    const text = node.textContent || '';
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [node]);

  return (
    <NodeViewWrapper
      style={{
        position: 'relative',
        margin: '16px 0',
        borderRadius: 'var(--radius-md)',
        // 允许下拉浮层自由溢出，不受代码块自身低高度裁剪限制
        overflow: 'visible',
        border: '1px solid var(--editor-border)',
        background: 'var(--code-block-bg)',
      }}
    >
      {/* 代码块顶部工具条 */}
      <div
        contentEditable={false}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '4px 10px',
          background: 'var(--editor-surface)',
          borderBottom: '1px solid var(--editor-border)',
          borderTopLeftRadius: 'calc(var(--radius-md) - 1px)',
          borderTopRightRadius: 'calc(var(--radius-md) - 1px)',
          fontSize: 12,
          color: 'var(--editor-text-muted)',
          userSelect: 'none',
        }}
      >
        {/* 语言选择下拉 */}
        <div
          ref={dropdownRef}
          style={{
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            cursor: 'pointer',
            padding: '2px 6px',
            borderRadius: 'var(--radius-sm)',
            transition: 'background var(--transition-fast)',
          }}
          onClick={() => setShowDropdown(!showDropdown)}
        >
          <span style={{ fontWeight: 500, color: 'var(--editor-text)' }}>
            {LANGUAGES.find((l) => l.value === language)?.label ?? language}
          </span>
          <ChevronDown size={12} />

          {/* 独立语言检索与选择浮层（不受代码块高度限制） */}
          {showDropdown && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                marginTop: 6,
                background: 'var(--editor-surface, #ffffff)',
                border: '1px solid var(--editor-border, rgba(0,0,0,0.12))',
                borderRadius: 8,
                boxShadow: '0 10px 30px -4px rgba(0, 0, 0, 0.18), 0 3px 8px -2px rgba(0, 0, 0, 0.08)',
                width: 210,
                zIndex: 10000,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* 模糊搜索输入栏 */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 8px',
                  borderBottom: '1px solid var(--editor-border, rgba(0,0,0,0.08))',
                  background: 'var(--editor-bg, rgba(0,0,0,0.02))',
                }}
              >
                <Search size={13} style={{ opacity: 0.5, flexShrink: 0 }} />
                <input
                  ref={searchInputRef}
                  type="text"
                  placeholder="搜索语言 (如 js, py, ts)..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setSelectedIndex(0);
                  }}
                  onKeyDown={handleKeyDown}
                  style={{
                    border: 'none',
                    outline: 'none',
                    background: 'transparent',
                    fontSize: 12,
                    color: 'var(--editor-text, #1e293b)',
                    width: '100%',
                  }}
                />
                {searchQuery && (
                  <button
                    type="button"
                    style={{
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                      padding: 2,
                      display: 'flex',
                      alignItems: 'center',
                      color: 'var(--editor-text-muted, #94a3b8)',
                    }}
                    onClick={() => {
                      setSearchQuery('');
                      searchInputRef.current?.focus();
                    }}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>

              {/* 语言选项列表 */}
              <div
                ref={listRef}
                style={{
                  maxHeight: 220,
                  overflowY: 'auto',
                  padding: '4px',
                }}
              >
                {filteredLanguages.length === 0 ? (
                  <div
                    style={{
                      padding: '12px 8px',
                      fontSize: 12,
                      textAlign: 'center',
                      color: 'var(--editor-text-muted, #94a3b8)',
                    }}
                  >
                    未找到匹配语言
                  </div>
                ) : (
                  filteredLanguages.map((lang, idx) => {
                    const isSelected = lang.value === language;
                    const isHovered = idx === selectedIndex;
                    return (
                      <button
                        key={lang.value}
                        type="button"
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '6px 10px',
                          cursor: 'pointer',
                          fontSize: 12,
                          color: 'var(--editor-text, #1e293b)',
                          background: isHovered
                            ? 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))'
                            : isSelected
                              ? 'var(--editor-bg, rgba(0,0,0,0.04))'
                              : 'transparent',
                          border: 'none',
                          borderRadius: 5,
                          width: '100%',
                          textAlign: 'left',
                          marginBottom: 1,
                        }}
                        onMouseEnter={() => setSelectedIndex(idx)}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleLanguageChange(lang.value);
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontWeight: isSelected ? 600 : 400 }}>{lang.label}</span>
                          <span style={{ fontSize: 10, color: 'var(--editor-text-muted, #94a3b8)' }}>
                            {lang.value}
                          </span>
                        </div>
                        {isSelected && <Check size={13} color="var(--accent-500, #3b82f6)" />}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>

        {/* 复制按钮 */}
        <button
          type="button"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: copied ? 'var(--success-600)' : 'var(--editor-text-muted)',
            fontSize: 12,
            padding: '2px 6px',
            borderRadius: 'var(--radius-sm)',
            transition: 'color var(--transition-fast)',
          }}
          onClick={handleCopy}
          title="复制代码内容"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
      </div>

      {/* 代码内容区域（TipTap 可直接输入） */}
      <pre
        style={{
          margin: 0,
          padding: '12px 16px',
          overflowX: 'auto',
          borderBottomLeftRadius: 'calc(var(--radius-md) - 1px)',
          borderBottomRightRadius: 'calc(var(--radius-md) - 1px)',
          fontSize: 'var(--mono-font-size)',
          fontFamily: 'var(--mono-font-family)',
          lineHeight: 1.5,
          background: 'transparent',
          border: 'none',
        }}
      >
        <NodeViewContent as={"code" as any} className={`language-${language}`} />
      </pre>
    </NodeViewWrapper>
  );
}

// 导出扩展：基于 @tiptap/extension-code-block + ReactNodeViewRenderer
export const CodeBlockView = CodeBlock.extend({
  addOptions() {
    const parent = (this.parent?.() ?? {}) as Record<string, unknown>;
    return {
      ...parent,
      lowlight: null,
    } as unknown as ReturnType<NonNullable<typeof this.parent>>;
  },

  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockComponent);
  },
});

