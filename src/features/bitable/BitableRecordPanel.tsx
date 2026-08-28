// NoteBoard 多维表格记录详情侧边栏 (Record Panel)
// 以「收集单」形式逐字段编辑一条记录，区别于紧凑的表格单元格形态：
// 文本多行输入、日期直选、勾选为开关、进度为滑块，单选/多选中点击即选择。

import React from 'react';
import type { BitableColumn, BitableRow, ColumnOptionAction } from './bitableTypes';
import { BitableCellEditor } from './BitableCellEditor';
import { getFieldTypeMeta } from './BitableFieldMeta';
import { X, Trash2 } from 'lucide-react';

interface RecordPanelProps {
  row: BitableRow;
  columns: BitableColumn[];
  /** 该行的层级信息，用于在标题区展示父子关系 */
  parentTitle?: string;
  onUpdateRow: (rowId: string, columnId: string, value: unknown) => void;
  onManageColumnOption?: (colId: string, action: ColumnOptionAction) => void;
  onDeleteRow?: (rowId: string) => void;
  onClose: () => void;
}

/** 取记录的主标题：优先第一个文本字段，其次任意有值的字段 */
function resolveRecordTitle(row: BitableRow, columns: BitableColumn[]): string {
  const textCol = columns.find((c) => c.type === 'text');
  if (textCol) {
    const val = row[textCol.id];
    if (val !== undefined && val !== null && String(val).trim() !== '') return String(val);
  }
  for (const col of columns) {
    const val = row[col.id];
    if (val !== undefined && val !== null && String(val).trim() !== '') return String(val);
  }
  return '未命名记录';
}

export function BitableRecordPanel({
  row,
  columns,
  parentTitle,
  onUpdateRow,
  onManageColumnOption,
  onDeleteRow,
  onClose,
}: RecordPanelProps) {
  const title = resolveRecordTitle(row, columns);

  return (
    <div
      // 阻断事件冒泡：避免点击侧边栏时误触发表格的选区清空
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: 360,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--editor-surface, #ffffff)',
        borderLeft: '1px solid var(--editor-border, #e2e8f0)',
        boxShadow: '-8px 0 24px rgba(15, 23, 42, 0.08)',
        zIndex: 40,
        fontSize: 13,
      }}
    >
      {/* 面板头部：记录标题与关闭 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 8,
          padding: '12px 14px',
          borderBottom: '1px solid var(--editor-border, #e2e8f0)',
          flexShrink: 0,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 11, color: 'var(--editor-text-muted, #94a3b8)', marginBottom: 2 }}>
            记录详情
          </div>
          <div
            title={title}
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: 'var(--editor-text, #1e293b)',
              lineHeight: 1.4,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {title}
          </div>
          {parentTitle && (
            <div style={{ fontSize: 11, color: 'var(--editor-text-muted, #94a3b8)', marginTop: 2 }}>
              子任务 · 上级：{parentTitle}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          title="关闭详情"
          style={{
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            padding: 3,
            borderRadius: 4,
            color: 'var(--editor-text-muted, #64748b)',
            display: 'flex',
            flexShrink: 0,
          }}
        >
          <X size={15} />
        </button>
      </div>

      {/* 字段表单：逐字段纵向排列的收集单 */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '6px 14px 16px' }}>
        {columns.map((col) => {
          const meta = getFieldTypeMeta(col.type);
          return (
            <div
              key={col.id}
              style={{
                padding: '10px 0',
                borderBottom: '1px solid var(--editor-border, #f1f5f9)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  marginBottom: 6,
                  color: 'var(--editor-text-muted, #64748b)',
                }}
              >
                {meta.icon}
                <span style={{ fontSize: 12, fontWeight: 600 }}>{col.name}</span>
                <span style={{ fontSize: 10, opacity: 0.75 }}>{meta.label}</span>
              </div>

              <BitableCellEditor
                column={col}
                value={row[col.id]}
                variant="form"
                onChange={(newVal) => onUpdateRow(row.id, col.id, newVal)}
                onManageColumnOption={onManageColumnOption}
              />
            </div>
          );
        })}

        {columns.length === 0 && (
          <div style={{ padding: '20px 0', fontSize: 12, color: 'var(--editor-text-muted, #94a3b8)' }}>
            该表格还没有任何字段
          </div>
        )}
      </div>

      {/* 面板底部：删除记录 */}
      {onDeleteRow && (
        <div
          style={{
            padding: '10px 14px',
            borderTop: '1px solid var(--editor-border, #e2e8f0)',
            display: 'flex',
            justifyContent: 'flex-end',
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            onClick={() => {
              onDeleteRow(row.id);
              onClose();
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              padding: '5px 10px',
              borderRadius: 6,
              border: '1px solid var(--editor-border, #e2e8f0)',
              background: 'transparent',
              color: '#ef4444',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            <Trash2 size={12} />
            <span>删除该记录</span>
          </button>
        </div>
      )}
    </div>
  );
}
