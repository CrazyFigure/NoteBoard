// NoteBoard 多维表格子任务折叠状态 Hook
// 表格视图与甘特图视图共用：展开/收起仅影响界面显示，不写入 .bitable 文件。
// 默认行为由设置中的 bitableSubtaskDefaultCollapsed 控制（默认 false 即展开），
// 设置变化时已打开视图统一切换到新默认值，并清空单行的手动覆盖集合。

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import type { BitableRow } from './bitableTypes';

/** 查找行降级为子任务时的目标父行 ID（与 BitableEditor.handleIndentRow 同口径） */
export function findIndentParentId(rows: BitableRow[], rowId: string): string | undefined {
  const idx = rows.findIndex((r) => r.id === rowId);
  if (idx <= 0) return undefined;
  const targetParentId = rows[idx].parentId || undefined;
  for (let i = idx - 1; i >= 0; i -= 1) {
    const candidate = rows[i];
    if ((candidate.parentId || undefined) === targetParentId) {
      return candidate.id;
    }
  }
  return undefined;
}

/**
 * 管理树形子任务的展开/收起状态。
 * 使用 toggledRowIds 记录相对「默认折叠状态」的手动覆盖项，避免初始化时遍历整表行 ID。
 */
export function useSubtaskCollapse() {
  const defaultCollapsed = useSettingsStore(
    (s) => s.settings.editor.bitableSubtaskDefaultCollapsed ?? false,
  );
  const [toggledRowIds, setToggledRowIds] = useState<Set<string>>(() => new Set());

  // 设置项切换时清空局部覆盖，使已打开的表格/甘特图立即按新默认值展开或收起
  const initialRef = useRef(true);
  useEffect(() => {
    if (initialRef.current) {
      initialRef.current = false;
      return;
    }
    setToggledRowIds(new Set());
  }, [defaultCollapsed]);

  const isRowCollapsed = useCallback(
    (rowId: string) => (defaultCollapsed ? !toggledRowIds.has(rowId) : toggledRowIds.has(rowId)),
    [defaultCollapsed, toggledRowIds],
  );

  const toggleCollapse = useCallback((rowId: string) => {
    setToggledRowIds((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  }, []);

  // 添加子任务或降级为子任务时确保父行展开，避免子行创建/降级后立刻被隐藏
  const ensureExpanded = useCallback(
    (rowId: string) => {
      setToggledRowIds((prev) => {
        if (defaultCollapsed) {
          if (prev.has(rowId)) return prev;
          const next = new Set(prev);
          next.add(rowId);
          return next;
        }
        if (!prev.has(rowId)) return prev;
        const next = new Set(prev);
        next.delete(rowId);
        return next;
      });
    },
    [defaultCollapsed],
  );

  return { isRowCollapsed, toggleCollapse, ensureExpanded };
}
