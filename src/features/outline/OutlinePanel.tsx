
// NoteBoard 大纲面板
// 24px 行、缩进 min(level-1,5)*12+8、字号阶梯、当前项高亮
// 搜索过滤、h2/h3 折叠、双击就地重命名
// 顶部可切换到「反链」：列出链接到当前文档的其它笔记
// 详见 docs/09-开发路线图.md 9.2-9.10

import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react';
import { ChevronRight } from 'lucide-react';
import type { Editor } from '@tiptap/core';
import { Tooltip } from '../../components/Tooltip';
import { useWindowStore } from '../../stores/windowStore';
import { useHeadings, type HeadingItem } from './useHeadings';
import { jumpToSourceHeading, renameSourceHeading, useMdSourceView, useSourceHeadings } from './useSourceHeadings';
import type { SourceHeadingItem } from './sourceHeadings';

interface OutlinePanelProps {
  editor: Editor | null;
  /** 当前文档：源码模式（含不挂载可视化内核的大文档）据此从源码视图提取大纲 */
  docKey?: string | null;
}

// 反向链接面板按需加载：大纲随首屏装载，扫描笔记的代码只在切到「反向链接」时下载
const BacklinksPanel = lazy(() => import('../wikilink/BacklinksPanel').then((module) => ({ default: module.BacklinksPanel })));

type OutlineTab = 'outline' | 'backlinks';

/** 本次运行中最后选择的分页：切换文档、收起再展开时保持 */
let lastOutlineTab: OutlineTab = 'outline';

/** 字号阶梯 */
function getFontSize(level: number): number {
  const sizes = [15, 14, 13, 12, 12, 12];
  return sizes[Math.min(level - 1, 5)];
}

/** 缩进 */
function getIndent(level: number): number {
  return Math.min(level - 1, 5) * 12 + 8;
}

export function OutlinePanel({ editor, docKey = null }: OutlinePanelProps) {
  const viewMode = useWindowStore((s) => (docKey ? s.tabs.find((t) => t.key === docKey)?.viewMode : undefined));
  const sourceView = useMdSourceView(docKey);
  // 源码模式，或可视化内核尚未挂载（源码首开、大文档）时，以源码为大纲数据源
  const sourceMode = Boolean(sourceView) && (viewMode === 'source' || !editor);
  const visualOutline = useHeadings(sourceMode ? null : editor);
  const sourceOutline = useSourceHeadings(sourceMode ? sourceView : null);
  const { headings, activeId, setActiveId } = sourceMode ? sourceOutline : visualOutline;
  const [tab, setTabState] = useState<OutlineTab>(lastOutlineTab);
  const setTab = useCallback((next: OutlineTab) => {
    lastOutlineTab = next;
    setTabState(next);
  }, []);
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

  // 计算每个标题是否含有子标题（在文档顺序中，紧随其后的下一标题 level 更大）
  const hasChildrenMap = useMemo(() => {
    const map = new Map<string, boolean>();
    for (let i = 0; i < headings.length; i++) {
      const current = headings[i];
      const next = headings[i + 1];
      const hasChildren = Boolean(next && next.level > current.level);
      map.set(current.id, hasChildren);
    }
    return map;
  }, [headings]);

  // 计算当前被折叠隐藏的标题 ID 集合（基于直系父祖先的折叠状态进行单调栈判定）
  const hiddenIds = useMemo(() => {
    // 处于搜索状态时展示所有匹配项，不进行折叠隐藏
    if (searchQuery.trim()) {
      return new Set<string>();
    }

    const hidden = new Set<string>();
    // 祖先单调栈：记录各级父祖先节点的 level 以及折叠/隐藏传递状态
    const ancestorStack: { level: number; isHiddenOrCollapsed: boolean }[] = [];

    for (const h of headings) {
      // 弹出栈中同级或更深级别（非当前节点祖先）的节点
      while (ancestorStack.length > 0 && ancestorStack[ancestorStack.length - 1].level >= h.level) {
        ancestorStack.pop();
      }

      // 获取当前节点的最近直接父祖先
      const parentAncestor = ancestorStack.length > 0 ? ancestorStack[ancestorStack.length - 1] : null;
      const isHidden = parentAncestor ? parentAncestor.isHiddenOrCollapsed : false;

      if (isHidden) {
        hidden.add(h.id);
      }

      // 记录当前节点的折叠/隐藏传递状态
      const isSelfCollapsed = collapsed.has(h.id);
      ancestorStack.push({
        level: h.level,
        isHiddenOrCollapsed: isHidden || isSelfCollapsed,
      });
    }

    return hidden;
  }, [headings, collapsed, searchQuery]);

  // 点击跳转
  const handleHeadingClick = useCallback(
    (heading: HeadingItem) => {
      if (sourceMode && sourceView) {
        jumpToSourceHeading(sourceView, heading as SourceHeadingItem);
        setActiveId(heading.id);
        return;
      }
      if (!editor) return;
      const { pos } = heading;
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
    [editor, setActiveId, sourceMode, sourceView],
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
      if (sourceMode && sourceView) {
        if (editValue.trim()) renameSourceHeading(sourceView, heading as SourceHeadingItem, editValue);
        setEditingId(null);
        return;
      }
      if (!editor || !editValue.trim()) {
        setEditingId(null);
        return;
      }

      const tr = editor.state.tr;
      const { pos } = heading;
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
    [editor, editValue, sourceMode, sourceView],
  );

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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--outline-bg)' }}>
      {/* 大纲标题栏仅保留页签，不展示条目数量。 */}
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
        <div className="nb-outline-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'outline'}
            className={`nb-outline-tab${tab === 'outline' ? ' is-active' : ''}`}
            data-sheet-keep=""
            onClick={() => setTab('outline')}
          >
            文档大纲
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'backlinks'}
            className={`nb-outline-tab${tab === 'backlinks' ? ' is-active' : ''}`}
            data-sheet-keep=""
            onClick={() => setTab('backlinks')}
          >
            反向链接
          </button>
        </div>
      </div>

      {tab === 'backlinks' && (
        <Suspense fallback={null}>
          <BacklinksPanel />
        </Suspense>
      )}

      {/* 搜索框 */}
      {tab === 'outline' && headings.length > 0 && (
        <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--editor-border)', flexShrink: 0 }}>
          <input
            type="text"
            placeholder="搜索大纲标题"
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
      {tab !== 'outline' ? null : headings.length === 0 ? (
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
              const isHidden = hiddenIds.has(h.id);
              if (isHidden) return null;

              const isActive = h.id === activeId;
              const isEditing = h.id === editingId;
              const hasChildren = hasChildrenMap.get(h.id) ?? false;
              const isCollapsedItem = collapsed.has(h.id);

              return (
                <Tooltip key={h.id} content={h.text} disabled={isEditing} side="right" sideOffset={6}>
                  <div
                    data-heading-id={h.id}
                    onClick={() => handleHeadingClick(h)}
                    onDoubleClick={() => handleDoubleClick(h)}
                    onMouseEnter={(e) => {
                      if (!isActive) {
                        e.currentTarget.style.background = 'var(--toolbar-hover)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!isActive) {
                        e.currentTarget.style.background = 'transparent';
                      }
                      e.currentTarget.style.transform = 'scale(1)';
                    }}
                    onMouseDown={(e) => {
                      e.currentTarget.style.transform = 'scale(0.985)';
                    }}
                    onMouseUp={(e) => {
                      e.currentTarget.style.transform = 'scale(1)';
                    }}
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
                      transition: 'all var(--transition-fast)',
                    }}
                  >
                    {/* 折叠/展开按钮 */}
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
                          cursor: 'pointer',
                          color: 'var(--editor-text-muted)',
                          transform: isCollapsedItem ? 'none' : 'rotate(90deg)',
                          transition: 'transform var(--transition-fast), color var(--transition-fast)',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.color = 'var(--editor-text)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.color = 'var(--editor-text-muted)';
                        }}
                      >
                        <ChevronRight size={12} strokeWidth={2.2} />
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
                </Tooltip>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
