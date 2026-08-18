// NoteBoard 大文档分段编辑器
// @tanstack/react-virtual + overscan:2 + 同时只有 1 个真 TipTap 实例
// 详见 docs/09-开发路线图.md 11.6-11.8

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useVirtualizer, type Range } from '@tanstack/react-virtual';
import { splitSections, applySectionEdit, extractHeadingsFromSource, type Section } from './sectionDocument';
import { useDocumentStore } from '../../stores/documentStore';

interface SectionedEditorProps {
  docKey: string;
  content: string;
}

export function SectionedEditor({ docKey, content }: SectionedEditorProps) {
  const [sections, setSections] = useState<Section[]>([]);
  const [activeSection, setActiveSection] = useState<number>(0);
  const [fullContent, setFullContent] = useState(content);
  const parentRef = useRef<HTMLDivElement>(null);
  const docStore = useDocumentStore();

  // 初始化分段
  useEffect(() => {
    const split = splitSections(content);
    setSections(split);
    setFullContent(content);
  }, [content]);

  // 活动段编辑后回写
  const handleSectionEdit = useCallback(
    (section: Section, newContent: string) => {
      const result = applySectionEdit(fullContent, section, newContent);
      setFullContent(result.content);

      // 重新分段
      const newSections = splitSections(result.content);
      setSections(newSections);

      // 同步到 store
      docStore.setContent(docKey, result.content);
    },
    [fullContent, docKey, docStore],
  );

  // 虚拟滚动
  const virtualizer = useVirtualizer({
    count: sections.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 200, // 每段估算 200px
    overscan: 2,
    rangeExtractor: useMemo(() => {
      return (range: Range) => {
        const indexes = Array.from({ length: range.endIndex - range.startIndex + 1 }, (_, i) => range.startIndex + i);
        // 保证活动段始终渲染
        if (!indexes.includes(activeSection)) {
          indexes.push(activeSection);
        }
        return indexes;
      };
    }, [activeSection]),
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 分段模式横幅 */}
      <div
        style={{
          padding: '8px 12px',
          background: 'var(--warning-50)',
          borderBottom: '1px solid var(--warning-200)',
          fontSize: 13,
          color: 'var(--editor-text)',
          flexShrink: 0,
        }}
      >
        📄 分段编辑模式：共 {sections.length} 段，当前第 {activeSection + 1} 段。不支持跨段选择与跨段拖块。
      </div>

      {/* 虚拟滚动容器 */}
      <div
        ref={parentRef}
        style={{
          flex: 1,
          overflow: 'auto',
          background: 'var(--cm-background)',
        }}
      >
        <div
          style={{
            height: virtualizer.getTotalSize(),
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const section = sections[virtualRow.index];
            if (!section) return null;

            const isActive = virtualRow.index === activeSection;

            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                  padding: '8px 24px',
                  borderBottom: '1px solid var(--editor-border)',
                  background: isActive ? 'var(--editor-surface)' : 'var(--cm-background)',
                }}
                onClick={() => setActiveSection(virtualRow.index)}
              >
                {/* 段标记 */}
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--editor-text-muted)',
                    marginBottom: 4,
                    userSelect: 'none',
                  }}
                >
                  § {virtualRow.index + 1} / {sections.length}（{section.content.length.toLocaleString()} 字符）
                </div>

                {/* 段内容预览 */}
                <div
                  style={{
                    fontSize: 'var(--content-font-size)',
                    fontFamily: 'var(--mono-font-family)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    color: isActive ? 'var(--editor-text)' : 'var(--editor-text-muted)',
                    opacity: isActive ? 1 : 0.7,
                    minHeight: 40,
                    cursor: 'text',
                  }}
                  contentEditable={isActive}
                  suppressContentEditableWarning
                  onBlur={(e) => {
                    const newContent = e.currentTarget.innerText;
                    if (newContent !== section.content) {
                      handleSectionEdit(section, newContent);
                    }
                  }}
                >
                  {section.content}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** 分段模式下的标题提取（从原文，11.9） */
export function useSectionedHeadings(content: string) {
  const [headings, setHeadings] = useState<{ level: number; text: string; pos: number }[]>([]);

  useEffect(() => {
    const extracted = extractHeadingsFromSource(content);
    setHeadings(extracted);
  }, [content]);

  return headings;
}
