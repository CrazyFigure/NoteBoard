// NoteBoard 代码块 NodeView
// 语言下拉 + 复制按钮 + 自由编辑 NodeViewContent
// 详见 docs/09-开发路线图.md 7.8

import { useState, useCallback, useRef, useEffect } from 'react';
import { NodeViewWrapper, NodeViewContent, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import CodeBlock from '@tiptap/extension-code-block';
import { Copy, Check, ChevronDown } from 'lucide-react';
import { normalizeLanguage } from './lowlight';

// 语言列表
const LANGUAGES = [
  { value: 'plaintext', label: '纯文本' },
  { value: 'sql', label: 'SQL' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'python', label: 'Python' },
  { value: 'json', label: 'JSON' },
  { value: 'yaml', label: 'YAML' },
  { value: 'xml', label: 'XML' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'bash', label: 'Bash' },
  { value: 'css', label: 'CSS' },
  { value: 'rust', label: 'Rust' },
  { value: 'go', label: 'Go' },
  { value: 'java', label: 'Java' },
  { value: 'c', label: 'C' },
  { value: 'cpp', label: 'C++' },
  { value: 'csharp', label: 'C#' },
  { value: 'shell', label: 'Shell' },
];

function CodeBlockComponent({ node, updateAttributes }: NodeViewProps) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [copied, setCopied] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const language = normalizeLanguage(node.attrs.language || 'plaintext');

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

  const handleLanguageChange = useCallback(
    (lang: string) => {
      updateAttributes({ language: lang });
      setShowDropdown(false);
    },
    [updateAttributes],
  );

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
        overflow: 'hidden',
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
          {showDropdown && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                marginTop: 4,
                background: 'var(--editor-surface)',
                border: '1px solid var(--editor-border)',
                borderRadius: 'var(--radius-sm)',
                boxShadow: 'var(--shadow-md)',
                maxHeight: 220,
                overflowY: 'auto',
                zIndex: 100,
                minWidth: 140,
              }}
            >
              {LANGUAGES.map((lang) => (
                <button
                  key={lang.value}
                  type="button"
                  style={{
                    padding: '6px 12px',
                    cursor: 'pointer',
                    fontSize: 12,
                    color: 'var(--editor-text)',
                    background: lang.value === language ? 'var(--editor-selection)' : 'transparent',
                    border: 'none',
                    width: '100%',
                    textAlign: 'left',
                    display: 'block',
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleLanguageChange(lang.value);
                  }}
                >
                  {lang.label}
                </button>
              ))}
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
