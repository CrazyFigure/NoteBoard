// NoteBoard 大纲面板
// 24px 行、缩进 min(level-1,5)*12+8、字号阶梯、当前项高亮
// 搜索过滤、h2/h3 折叠、双击就地重命名
// 详见 docs/09-开发路线图.md 9.2-9.10

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { Editor } from '@tiptap/core';
import { useHeadings, type HeadingItem } from './useHeadings';

interface OutlinePanelProps {
  editor: Editor | null;
}

/** 字号阶梯 */
function getFontSize(level: number): number {
  const sizes = [15, 14, 13, 12, 12, 12];
  return sizes[Math.min(level - 1, 5)];
}

/** 缩进 */
function getIndent(level: number): number {
  return Math.min(level - 1, 5) * 12 + 8;
}

export function OutlinePanel({ editor }: OutlinePanelProps) {
  const { headings, activeId, setActiveId } = useHeadings(editor);
  const [searchQuery, setSearchQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // 搜索过滤
  const filteredHeadings = useMemo(() => {
    if (!searchQuery.trim()) return headings;
    const q = searchQuery.toLowerCase().trim();
    return headings.filter((h) => h.text.toLowerCase().includes(q));
  }, [headings, searchQuery]);

  // 点击跳转
  const handleHeadingClick = useCallback(
    (heading: HeadingItem) => {
      if (!editor) return;
      const { pos, level } = heading;
      const docSize = editor.state.doc.content.size;
      const targetPos = Math.min(pos + 1, docSize);

      editor.commands.focus();
      editor.commands.setTextSelection(targetPos);

      // 滚动到位置
      requestAnimationFrame(() => {
        try {
          const dom = editor.view.nodeDOM(pos);
          if (dom instanceof HTMLElement) {
            dom.scrollIntoView({ behavior: 'smooth', block: 'start' });
          } else {
            editor.commands.scrollIntoView();
          }
        } catch {
          editor.commands.scrollIntoView();
        }
      });

      setActiveId(heading.id);
    },
    [editor, setActiveId],
  );

  // 双击编辑
  const handleDoubleClick = useCallback(
    (heading: HeadingItem) => {
      setEditingId(heading.id);
      setEditValue(heading.text);
    },
    [],
  );

  // 提交重命名
  const handleRename = useCallback(
    (heading: HeadingItem) => {
      if (!editor || !editValue.trim()) {
        setEditingId(null);
        return;
      }

      const tr = editor.state.tr;
      const { pos, level } = heading;
      const node = editor.state.doc.nodeAt(pos);
      if (!node) {
        setEditingId(null);
        return;
      }

      // 替换文本内容
      const textNode = editor.state.schema.text(editValue);
      tr.replaceWith(pos + 1, pos + 1 + node.content.size, textNode);
      editor.view.dispatch(tr);

      setEditingId(null);
    },
    [editor, editValue],
  );

  // 滚动联动：编辑区滚动 → 大纲当前项跟随
  useEffect(() => {
    if (!editor) return;

    const scrollContainer = editor.view.dom.parentElement;
    if (!scrollContainer) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const handleScroll = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        // 取 offsetTop <= scrollTop + 40 的最后一个
        const scrollTop = scrollContainer.scrollTop;
        let lastVisible: HeadingItem | null = null;

        for (const h of headings) {
          const dom = editor.view.nodeDOM(h.pos);
          if (dom instanceof HTMLElement) {
            if (dom.offsetTop <= scrollTop + 40) {
              lastVisible = h;
            }
          }
        }

        if (lastVisible) {
          setActiveId(lastVisible.id);
        }
      }, 50);
    };

    scrollContainer.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      scrollContainer.removeEventListener('scroll', handleScroll);
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [editor, headings, setActiveId]);

  // 大纲面板自身跟随当前项滚动
  useEffect(() => {
    if (!activeId || !scrollContainerRef.current) return;

    const activeEl = listRef.current?.querySelector(`[data-heading-id="${activeId}"]`);
    if (activeEl instanceof HTMLElement) {
      activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [activeId]);

  // 折叠/展开
  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // 计算被折叠的标题
  const isCollapsed = useCallback(
    (heading: HeadingItem, allHeadings: HeadingItem[]): boolean => {
      // 如果有父级被折叠，则也被折叠
      let currentLevel = heading.level;
      for (let i = allHeadings.indexOf(heading) - 1; i >= 0; i--) {
        const prev = allHeadings[i];
        if (prev.level < heading.level) {
          // 这是一个父级标题
          if (collapsed.has(prev.id)) return true;
          // 递归检查
          if (isCollapsed(prev, allHeadings)) return true;
        }
      }
      return false;
    },
    [collapsed],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--outline-bg)' }}>
      {/* 大纲标题栏 */}
      <div
        style={{
          height: 28,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 10px',
          borderBottom: '1px solid var(--editor-border)',
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--editor-text)' }}>
          文档大纲
        </span>
        <span style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>
          {headings.length} 项
        </span>
      </div>

      {/* 搜索框 */}
      {headings.length > 0 && (
        <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--editor-border)', flexShrink: 0 }}>
          <input
            type="text"
            placeholder="搜索大纲标题…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              width: '100%',
              padding: '4px 8px',
              fontSize: 12,
              border: '1px solid var(--editor-border)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--editor-surface)',
              color: 'var(--editor-text)',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>
      )}

      {/* 标题列表 */}
      {headings.length === 0 ? (
        <div
          style={{
            padding: '24px 16px',
            fontSize: 12,
            color: 'var(--editor-text-muted)',
            textAlign: 'center',
            lineHeight: 1.6,
          }}
        >
          暂无标题节点<br />
          使用 # 或快捷键添加标题
        </div>
      ) : (
        <div
          ref={scrollContainerRef}
          style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}
        >
        <div ref={listRef}>
          {filteredHeadings.map((h) => {
            const isHidden = isCollapsed(h, filteredHeadings);
            if (isHidden) return null;

            const isActive = h.id === activeId;
            const isEditing = h.id === editingId;
            const hasChildren = filteredHeadings.some(
              (other) => other !== h && other.pos > h.pos && other.level > h.level,
            );
            const isCollapsedItem = collapsed.has(h.id);

            return (
              <div
                key={h.id}
                data-heading-id={h.id}
                onClick={() => handleHeadingClick(h)}
                onDoubleClick={() => handleDoubleClick(h)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  height: 24,
                  paddingLeft: getIndent(h.level),
                  paddingRight: 8,
                  cursor: 'pointer',
                  fontSize: getFontSize(h.level),
                  color: isActive ? 'var(--editor-accent)' : 'var(--editor-text)',
                  fontWeight: isActive ? 600 : 400,
                  background: isActive ? 'var(--editor-selection-background)' : 'transparent',
                  borderLeft: isActive ? '2px solid var(--editor-accent)' : '2px solid transparent',
                  userSelect: 'none',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={h.text}
              >
                {/* 折叠按钮 */}
                {hasChildren ? (
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleCollapse(h.id);
                    }}
                    style={{
                      display: 'inline-flex',
                      width: 16,
                      height: 16,
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                      fontSize: 10,
                      opacity: 0.6,
                      transition: 'transform 150ms ease',
                      transform: isCollapsedItem ? 'rotate(-90deg)' : 'rotate(0deg)',
                    }}
                  >
                    ▼
                  </span>
                ) : (
                  <span style={{ width: 16, flexShrink: 0 }} />
                )}

                {/* 标题文本 / 编辑输入 */}
                {isEditing ? (
                  <input
                    ref={editInputRef}
                    type="text"
                    value={editValue}
                    autoFocus
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={() => handleRename(h)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleRename(h);
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        setEditingId(null);
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    style={{
                      flex: 1,
                      padding: '2px 4px',
                      fontSize: getFontSize(h.level),
                      border: '1px solid var(--editor-accent)',
                      borderRadius: 2,
                      background: 'var(--editor-surface)',
                      color: 'var(--editor-text)',
                      outline: 'none',
                    }}
                  />
                ) : (
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {h.text}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
      )}
    </div>
  );
}
