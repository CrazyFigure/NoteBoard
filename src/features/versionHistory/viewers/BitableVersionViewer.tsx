// NoteBoard 文档历史记录：多维表格可视化差异查看
// 只读表格：新增的行与列绿色、删除的红色删除线（保留在原位置）、修改的单元格同时显示旧值与新值、
// 移动的行蓝色标记；表名与视图的变化列在表格上方。行数很多时只渲染前 MAX_ROWS 行。

import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { parseBitableDocument, getOptionColor } from '../../bitable/bitableConverter';
import { formatCellValue, stripMarkdown } from '../../bitable/bitableUtils';
import type { BitableColumn, BitableDocument } from '../../bitable/bitableTypes';
import { diffBitables, type RowDiff } from '../diff/bitableDiff';
import type { VersionViewerProps } from './viewerTypes';

const TextVersionViewer = lazy(() => import('./TextVersionViewer'));
const MAX_ROWS = 3000;

function parseSafe(text: string): BitableDocument | null {
  try {
    const doc = parseBitableDocument(text);
    return Array.isArray(doc.columns) && Array.isArray(doc.rows) ? doc : null;
  } catch {
    return null;
  }
}

/** 单元格展示：单选 / 多选为彩色标签，其余为文本 */
function CellValue({ column, value }: { column: BitableColumn; value: unknown }) {
  if (column.type === 'select' || column.type === 'multiSelect') {
    const ids = Array.isArray(value) ? value : value ? [value] : [];
    return (
      <span className="nb-bt-chips">
        {ids.map((id) => {
          const opt = column.options?.find((o) => o.id === id);
          if (!opt) return null;
          const color = getOptionColor(opt.color);
          return (
            <span key={String(id)} className="nb-bt-chip" style={{ background: color.bg, color: color.text, borderColor: color.border }}>
              {opt.label}
            </span>
          );
        })}
      </span>
    );
  }
  if (column.type === 'checkbox') return <span>{value ? '☑' : '☐'}</span>;
  // 多行文本按纯文本显示（去掉 Markdown 标记）
  const text = column.type === 'longText' && typeof value === 'string' ? stripMarkdown(value) : formatCellValue(column, value);
  return <span>{text.length > 200 ? `${text.slice(0, 200)}…` : text}</span>;
}

export default function BitableVersionViewer(props: VersionViewerProps) {
  const { base, target, showChanges, onChangeInfo, navigatorRef } = props;
  const parsed = useMemo(() => {
    const b = parseSafe(target);
    const a = base === null ? null : parseSafe(base);
    if (!b || (base !== null && !a)) return null;
    return diffBitables(a, b);
  }, [base, target]);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(-1);
  const onChangeInfoRef = useRef(onChangeInfo);
  onChangeInfoRef.current = onChangeInfo;

  const columns = useMemo(() => (parsed ? parsed.columns.filter((c) => showChanges || c.kind !== 'del') : []), [parsed, showChanges]);
  const rows = useMemo(() => (parsed ? parsed.rows.filter((r) => showChanges || r.kind !== 'del').slice(0, MAX_ROWS) : []), [parsed, showChanges]);
  // 改动处：有变化的列（定位到表头）+ 有变化的行
  const changes = useMemo(() => {
    if (!parsed || !showChanges) return [] as Array<{ type: 'col' | 'row'; id: string }>;
    return [
      ...columns.filter((c) => c.kind !== 'same').map((c) => ({ type: 'col' as const, id: c.column.id })),
      ...rows.filter((r) => r.kind !== 'same').map((r) => ({ type: 'row' as const, id: r.row.id })),
    ];
  }, [parsed, showChanges, columns, rows]);
  const changesRef = useRef(changes);
  changesRef.current = changes;
  const currentRef = useRef(current);
  currentRef.current = current;

  const focusChange = (index: number) => {
    const change = changesRef.current[index];
    const scroller = scrollerRef.current;
    if (!change || !scroller) return;
    setCurrent(index);
    onChangeInfoRef.current({ count: changesRef.current.length, index });
    const el = scroller.querySelector<HTMLElement>(`[data-${change.type}="${CSS.escape(change.id)}"]`);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    scroller.scrollTo({
      top: Math.max(0, scroller.scrollTop + rect.top - box.top - box.height / 2),
      left: change.type === 'col' ? Math.max(0, scroller.scrollLeft + rect.left - box.left - 80) : scroller.scrollLeft,
      behavior: 'smooth',
    });
  };

  useEffect(() => {
    setCurrent(-1);
    if (changes.length > 0) {
      const frame = requestAnimationFrame(() => focusChange(0));
      return () => cancelAnimationFrame(frame);
    }
    onChangeInfoRef.current({ count: 0, index: -1 });
    return undefined;
  }, [changes]);

  useEffect(() => {
    navigatorRef.current = {
      next: () => focusChange(Math.min(changesRef.current.length - 1, currentRef.current + 1)),
      prev: () => focusChange(Math.max(0, currentRef.current - 1)),
    };
    return () => {
      navigatorRef.current = null;
    };
  }, [navigatorRef]);

  if (!parsed) {
    return (
      <>
        <div className="nb-vh-banner">无法按表格呈现，显示源码对比</div>
        <Suspense fallback={null}>
          <TextVersionViewer {...props} />
        </Suspense>
      </>
    );
  }

  const focused = current >= 0 ? changes[current] : undefined;
  const rowClass = (r: RowDiff) =>
    `nb-bt-row${showChanges && r.kind !== 'same' ? ` is-${r.kind}` : ''}${focused?.type === 'row' && focused.id === r.row.id ? ' is-current' : ''}`;
  const total = parsed.rows.filter((r) => showChanges || r.kind !== 'del').length;

  return (
    <div className="nb-bt-viewer" ref={scrollerRef}>
      {showChanges && parsed.notes.length > 0 && (
        <div className="nb-bt-notes">
          {parsed.notes.map((n) => (
            <span key={n}>{n}</span>
          ))}
        </div>
      )}
      <table className="nb-bt-table">
        <thead>
          <tr>
            <th className="nb-bt-index">#</th>
            {columns.map((c) => (
              <th
                key={c.column.id}
                data-col={c.column.id}
                className={`${showChanges && c.kind !== 'same' ? `is-${c.kind}` : ''}${focused?.type === 'col' && focused.id === c.column.id ? ' is-current' : ''}`}
              >
                {showChanges && c.kind === 'mod' && c.old && c.old.name !== c.column.name ? (
                  <>
                    <span className="nb-bt-old">{c.old.name}</span> <span className="nb-bt-new">{c.column.name}</span>
                  </>
                ) : (
                  c.column.name
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.row.id}:${r.kind}`} data-row={r.row.id} className={rowClass(r)}>
              <td className="nb-bt-index">{i + 1}</td>
              {columns.map((c) => {
                const changed = showChanges && r.changedCells.has(c.column.id);
                // 删除的列只在旧版本的行里有值
                const value = c.kind === 'del' ? (r.old ?? r.row)[c.column.id] : r.row[c.column.id];
                return (
                  <td key={c.column.id} className={`${changed ? 'is-changed' : ''}${showChanges && c.kind === 'del' ? ' is-col-del' : ''}${showChanges && c.kind === 'ins' ? ' is-col-ins' : ''}`}>
                    {changed && r.old && c.old ? (
                      <span className="nb-bt-change">
                        <span className="nb-bt-old">
                          <CellValue column={c.old} value={r.old[c.old.id]} />
                        </span>
                        <span className="nb-bt-new">
                          <CellValue column={c.column} value={value} />
                        </span>
                      </span>
                    ) : (
                      <CellValue column={c.column} value={value} />
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {total > MAX_ROWS && <div className="nb-bt-more">仅显示前 {MAX_ROWS} 行</div>}
    </div>
  );
}
