// NoteBoard 思维导图与大纲节点前置图标选择器
// 提供优先级标记 (1~5)、状态徽标与常用 Emoji 选择，全主题自适应
// 详见 docs/09-开发路线图.md

import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

interface MindmapIconPickerProps {
  currentIcon?: string;
  onSelect: (icon: string | undefined) => void;
  onClose: () => void;
  // 弹窗定位坐标
  position?: { x: number; y: number };
}

const ICON_GROUPS = [
  {
    name: '优先级',
    icons: ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'],
  },
  {
    name: '状态标记',
    icons: ['✅', '❌', '❓', '⏳', '⭐️', '🚩'],
  },
  {
    name: '常用标记',
    icons: ['💡', '🔥', '📌', '🎯', '🚀', '📅', '⚡️', '❤️', '👍', '🎉', '⚠️', '🔍'],
  },
];

export function MindmapIconPicker({
  currentIcon,
  onSelect,
  onClose,
  position,
}: MindmapIconPickerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // 点击外部自动关闭
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleOutsideClick, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const stylePosition: React.CSSProperties = position
    ? {
        position: 'fixed',
        left: Math.max(16, Math.min(window.innerWidth - 240, position.x)),
        top: Math.max(16, Math.min(window.innerHeight - 280, position.y)),
      }
    : {
        position: 'absolute',
        top: '100%',
        left: 0,
        marginTop: 4,
      };

  return (
    <div
      ref={containerRef}
      style={{
        ...stylePosition,
        width: 220,
        background: 'var(--editor-surface, #ffffff)',
        border: '1px solid var(--editor-border, #e2e8f0)',
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.15)',
        padding: '10px 12px',
        zIndex: 99999,
        fontSize: 12,
        color: 'var(--editor-text, #1e293b)',
        userSelect: 'none',
        animation: 'nbFadeIn 0.12s ease-out',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* 顶部操作行：当前状态与清除图标 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
          paddingBottom: 6,
          borderBottom: '1px solid var(--editor-border, #e2e8f0)',
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--editor-text-secondary, #64748b)' }}>
          设置节点图标
        </span>
        {currentIcon && (
          <button
            type="button"
            onClick={() => {
              onSelect(undefined);
              onClose();
            }}
            title="移除当前图标"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 3,
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              fontSize: 11,
              color: 'var(--editor-text-muted, #94a3b8)',
              padding: '2px 4px',
              borderRadius: 4,
              transition: 'color 0.15s ease',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = '#ef4444')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--editor-text-muted, #94a3b8)')}
          >
            <X size={11} />
            <span>清除</span>
          </button>
        )}
      </div>

      {/* 分组渲染图标 */}
      {ICON_GROUPS.map((group) => (
        <div key={group.name} style={{ marginBottom: 8 }}>
          <div
            style={{
              fontSize: 10,
              color: 'var(--editor-text-muted, #94a3b8)',
              marginBottom: 4,
            }}
          >
            {group.name}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4 }}>
            {group.icons.map((icon) => {
              const isSelected = currentIcon === icon;
              return (
                <button
                  key={icon}
                  type="button"
                  onClick={() => {
                    onSelect(icon);
                    onClose();
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: 28,
                    fontSize: 15,
                    border: isSelected
                      ? '1.5px solid var(--editor-accent, #3b82f6)'
                      : '1px solid transparent',
                    borderRadius: 4,
                    background: isSelected
                      ? 'var(--toolbar-active, rgba(59, 130, 246, 0.12))'
                      : 'transparent',
                    cursor: 'pointer',
                    transition: 'all 0.12s ease',
                  }}
                  onMouseEnter={(e) => {
                    if (!isSelected) {
                      e.currentTarget.style.background = 'var(--toolbar-hover, rgba(0, 0, 0, 0.05))';
                      e.currentTarget.style.transform = 'scale(1.15)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isSelected) {
                      e.currentTarget.style.background = 'transparent';
                      e.currentTarget.style.transform = 'scale(1)';
                    }
                  }}
                  onMouseDown={(e) => {
                    e.currentTarget.style.transform = 'scale(0.95)';
                  }}
                  onMouseUp={(e) => {
                    e.currentTarget.style.transform = 'scale(1.15)';
                  }}
                >
                  {icon}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
