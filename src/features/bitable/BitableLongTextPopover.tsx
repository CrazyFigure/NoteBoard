// NoteBoard 多维表格多行文本的编辑弹层
// 单元格空间不足以承载多行内容，双击后在此弹层中编辑：
// 采用「草稿 + 显式提交」而非实时写入，保证一次编辑只产生一条撤销记录

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BitableColumn, LongTextConfig } from './bitableTypes';
import { BitableRichTextEditor, type RichTextMode } from './BitableRichTextEditor';
import { X, Check } from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';

interface LongTextPopoverProps {
  /** 所属列，用于取字段名与 Markdown 配置 */
  column: BitableColumn;
  /** 该单元格当前的原始值 */
  value: unknown;
  config: LongTextConfig;
  /** 保存草稿 */
  onCommit: (next: string) => void;
  onClose: () => void;
}

const PANEL_WIDTH = 640;

export function BitableLongTextPopover({
  column,
  value,
  config,
  onCommit,
  onClose,
}: LongTextPopoverProps) {
  const initial = value === null || value === undefined ? '' : String(value);
  // 草稿：弹层生命周期内独立维护，关闭时不污染文档
  const [draft, setDraft] = useState(initial);
  const [mode, setMode] = useState<RichTextMode>('rich');
  const panelRef = useRef<HTMLDivElement>(null);
  const closedRef = useRef(false);

  /** 统一收口：无论保存还是取消，都只允许触发一次关闭 */
  const finish = (shouldCommit: boolean) => {
    if (closedRef.current) return;
    closedRef.current = true;
    if (shouldCommit && draft !== initial) onCommit(draft);
    onClose();
  };

  /**
   * 键盘监听需要读到最新的 draft，但又不应随每次输入反复解绑重绑
   * 用 ref 转发 finish，使监听器只绑定一次。
   */
  const finishRef = useRef(finish);
  finishRef.current = finish;

  // Esc 取消、Ctrl/⌘+Enter 保存；键盘事件挂在 document 上以保证浮层内任何位置都生效
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        finishRef.current(false);
        return;
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        finishRef.current(true);
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  return createPortal(
    <div
      // 遮罩：点击遮罩视为放弃修改，语义与「取消」一致，避免误存
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) finish(false);
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100002,
        background: 'rgba(15, 23, 42, 0.28)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        ref={panelRef}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: PANEL_WIDTH,
          maxWidth: '100%',
          maxHeight: 'min(72vh, 640px)',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--editor-surface, #ffffff)',
          border: '1px solid var(--editor-border, #e2e8f0)',
          borderRadius: 10,
          boxShadow: '0 18px 48px rgba(15, 23, 42, 0.22)',
          overflow: 'hidden',
        }}
      >
        {/* 头部：字段名、形态说明与关闭 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            padding: '10px 14px',
            borderBottom: '1px solid var(--editor-border, #e2e8f0)',
            flexShrink: 0,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--editor-text, #1e293b)' }}>
              {column.name}
            </div>
            <div style={{ fontSize: 11, color: 'var(--editor-text-muted, #94a3b8)', marginTop: 1 }}>
              多行文本{config.markdown ? ' · Markdown 富文本' : ''} · Esc 取消 · Ctrl+Enter 保存
            </div>
          </div>
          <Tooltip content="取消编辑" side="bottom" sideOffset={4}>
            <button
              type="button"
              className="nb-bitable-btn-ghost"
              onClick={() => finish(false)}
              aria-label="取消编辑"
              style={{
                padding: 3,
                flexShrink: 0,
              }}
            >
              <X size={15} />
            </button>
          </Tooltip>
        </div>

        {/* 编辑区：Markdown 列走富文本，普通列走纯文本多行输入 */}
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          {config.markdown ? (
            <BitableRichTextEditor
              value={draft}
              onChange={setDraft}
              mode={mode}
              onModeChange={setMode}
              minHeight={220}
            />
          ) : (
            <textarea
              value={draft}
              autoFocus
              placeholder="输入内容，回车换行"
              onChange={(e) => setDraft(e.target.value)}
              style={{
                width: '100%',
                height: 220,
                boxSizing: 'border-box',
                border: 'none',
                outline: 'none',
                resize: 'vertical',
                padding: '10px 12px',
                fontSize: 13,
                lineHeight: 1.6,
                fontFamily: 'inherit',
                background: 'transparent',
                color: 'var(--editor-text, #1e293b)',
              }}
            />
          )}
        </div>

        {/* 底部：显式提交，避免「点外面到底算不算保存」的歧义 */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
            padding: '10px 14px',
            borderTop: '1px solid var(--editor-border, #e2e8f0)',
            background: 'var(--editor-bg, #f8fafc)',
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 11, color: 'var(--editor-text-muted, #94a3b8)' }}>
            {draft === initial ? '未做修改' : '有未保存的修改'}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="nb-bitable-btn-secondary"
              onClick={() => finish(false)}
              style={{ padding: '5px 12px' }}
            >
              取消
            </button>
            <button
              type="button"
              className="nb-bitable-btn-primary"
              onClick={() => finish(true)}
              style={{
                gap: 5,
                padding: '5px 14px',
                fontWeight: 500,
              }}
            >
              <Check size={13} />
              <span>完成</span>
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
