// NoteBoard 多维表格记录详情侧边栏 (Record Panel)
// 以「收集单」形式逐字段编辑一条记录，区别于紧凑的表格单元格形态：
// 文本多行输入、日期直选、勾选为开关、进度为滑块，单选/多选中点击即选择。
// 侧栏宽度支持手动拖拽，宽度持久化到 localStorage

import React, { useEffect, useRef, useState } from 'react';
import type { BitableColumn, BitableRow, ColumnOptionAction } from './bitableTypes';
import { BitableCellEditor } from './BitableCellEditor';
import { getFieldTypeMeta } from './BitableFieldMeta';
import { previewLongText, resolveLongTextConfig } from './bitableUtils';
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

/** 侧栏宽度的合法区间：太窄放不下字段头，太宽会挤压表格视野 */
const MIN_WIDTH = 280;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 360;
const WIDTH_STORAGE_KEY = 'nb-bitable-record-panel-width';

/** 从 localStorage 读取上次保存的侧栏宽度，缺失或非法时退回默认值 */
function loadStoredWidth(): number {
  try {
    const raw = window.localStorage.getItem(WIDTH_STORAGE_KEY);
    if (!raw) return DEFAULT_WIDTH;
    const num = Number(raw);
    if (Number.isFinite(num) && num >= MIN_WIDTH && num <= MAX_WIDTH) return num;
  } catch {
    // localStorage 可能被隐私模式禁用，回退到默认值
  }
  return DEFAULT_WIDTH;
}

/** 取记录的主标题：优先第一个单行文本字段，其次多行文本，最后退回任意有值的字段 */
function resolveRecordTitle(row: BitableRow, columns: BitableColumn[]): string {
  const textCol = columns.find((c) => c.type === 'text');
  if (textCol) {
    const val = row[textCol.id];
    if (val !== undefined && val !== null && String(val).trim() !== '') return String(val);
  }
  // 多行文本作标题时只取首行，避免整段 Markdown 把面板标题撑爆
  const longTextCol = columns.find((c) => c.type === 'longText');
  if (longTextCol) {
    const val = row[longTextCol.id];
    if (val !== undefined && val !== null && String(val).trim() !== '') {
      return previewLongText(String(val), resolveLongTextConfig(longTextCol)) || '未命名记录';
    }
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

  // 侧栏宽度：初值从 localStorage 读取，拖拽过程中实时更新，拖拽结束落盘
  const [width, setWidth] = useState<number>(() => loadStoredWidth());
  // 拖拽中的 ref：mousemove 频繁触发，避免每次都重新订阅，因此 ref 持有最新值
  const widthRef = useRef(width);
  widthRef.current = width;
  const [resizing, setResizing] = useState(false);
  // 拖拽起点的鼠标 X 与当时的宽度，用于在 mousemove 中换算新的目标宽度
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);

  /** 开始拖拽：记录起点位置和当前宽度，状态置为拖拽中 */
  const handleResizeStart = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setResizing(true);
    startXRef.current = e.clientX;
    startWidthRef.current = widthRef.current;
  };

  /**
   * 拖拽过程：mousemove 时累计与起点的位移，叠到初始宽度上
   * 拖左侧手柄时鼠标向左移动 delta 为正，面板变宽
   */
  useEffect(() => {
    if (!resizing) return undefined;
    const onMove = (e: MouseEvent) => {
      const delta = startXRef.current - e.clientX;
      const next = Math.max(
        MIN_WIDTH,
        Math.min(MAX_WIDTH, startWidthRef.current + delta),
      );
      setWidth(next);
    };
    const onUp = () => {
      setResizing(false);
      // 用 ref 读取拖拽结束时的最新宽度，避免闭包捕获旧值
      try {
        window.localStorage.setItem(WIDTH_STORAGE_KEY, String(widthRef.current));
      } catch {
        // 写入失败（隐私模式、磁盘满）不影响本次拖拽结果
      }
    };
    // 拖拽期间屏蔽文本选择：手柄夹住表格边缘，用户鼠标横移会划到表格表头导致误选
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [resizing]);

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
        width,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--editor-surface, #ffffff)',
        borderLeft: '1px solid var(--editor-border, #e2e8f0)',
        boxShadow: '-8px 0 24px rgba(15, 23, 42, 0.08)',
        zIndex: 40,
        fontSize: 13,
      }}
    >
      {/* 左侧拖拽手柄：5px 透明区，hover 与拖拽中显示蓝色高亮条 */}
      <div
        onMouseDown={handleResizeStart}
        title="拖拽调整侧栏宽度"
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          width: 5,
          cursor: 'col-resize',
          background: resizing ? 'var(--editor-accent, #3b82f6)' : 'transparent',
          zIndex: 1,
        }}
        onMouseEnter={(e) => {
          if (!resizing) e.currentTarget.style.background = 'var(--editor-accent, #3b82f6)';
        }}
        onMouseLeave={(e) => {
          if (!resizing) e.currentTarget.style.background = 'transparent';
        }}
      />

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
          className="nb-bitable-btn-ghost"
          onClick={onClose}
          title="关闭详情"
          style={{
            padding: 3,
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
          // 多行文本在侧边栏标出当前列的显示配置，便于就地理解为何某格只显示一行
          const ltConfig = col.type === 'longText' ? resolveLongTextConfig(col) : null;
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
                {ltConfig && (
                  <span
                    title="该列的显示模式，可在表格列头菜单中修改"
                    style={{
                      marginLeft: 'auto',
                      fontSize: 10,
                      padding: '1px 6px',
                      borderRadius: 4,
                      background: 'var(--editor-bg, #f1f5f9)',
                      color: 'var(--editor-text-muted, #64748b)',
                      flexShrink: 0,
                    }}
                  >
                    {ltConfig.displayMode === 'full' ? '全显示' : '仅首行'}
                    {ltConfig.markdown ? ' · MD' : ''}
                  </span>
                )}
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
            className="nb-bitable-btn-danger"
            onClick={() => {
              onDeleteRow(row.id);
              onClose();
            }}
            style={{
              gap: 5,
              padding: '5px 10px',
              fontSize: 12,
            }}
          >
            <Trash2 size={13} />
            <span>删除该记录</span>
          </button>
        </div>
      )}
    </div>
  );
}
