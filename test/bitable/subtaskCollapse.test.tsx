// 多维表格子任务默认收起设置回归测试
// 覆盖：表格视图与甘特图视图的默认展开/收起、多层逐级展开、设置热切换同步、新建/降级子任务自动展开父行。

import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { BitableGridView } from '@/features/bitable/BitableGridView';
import { BitableGanttView } from '@/features/bitable/BitableGanttView';
import type { BitableColumn, BitableRow } from '@/features/bitable/bitableTypes';
import { DEFAULT_SETTINGS, useSettingsStore } from '@/stores/settingsStore';

const columns: BitableColumn[] = [
  { id: 'name', key: 'name', name: '任务名称', type: 'text', width: 220 },
  { id: 'start', key: 'start', name: '开始日期', type: 'date', width: 120 },
  { id: 'end', key: 'end', name: '结束日期', type: 'date', width: 120 },
];

function createTreeRows(): BitableRow[] {
  return [
    { id: 'p1', name: '父任务 1', start: '2026-05-01', end: '2026-05-03' },
    { id: 'c1', name: '子任务 1-1', parentId: 'p1', start: '2026-05-01', end: '2026-05-02' },
    { id: 'g1', name: '孙任务 1-1-1', parentId: 'c1', start: '2026-05-02', end: '2026-05-02' },
    { id: 'p2', name: '父任务 2', start: '2026-05-04', end: '2026-05-05' },
  ];
}

function setSubtaskDefaultCollapsed(collapsed: boolean) {
  const next = structuredClone(useSettingsStore.getState().settings);
  next.editor.bitableSubtaskDefaultCollapsed = collapsed;
  useSettingsStore.setState({ settings: next });
}

/** 读取每行任务名称列（第二列 td，第一列为行号）文本 */
function getRowTaskName(tr: HTMLTableRowElement): string {
  const nameCell = tr.querySelectorAll('td')[1];
  const input = nameCell?.querySelector<HTMLInputElement>('input[type="text"]');
  return (input ? input.value : (nameCell?.textContent ?? '')).trim();
}

/** 读取表格或甘特图当前渲染的任务名称列表 */
function getRenderedTaskTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLTableRowElement>('tbody tr')).map(getRowTaskName);
}

/** 查找包含指定任务名称的行元素 */
function findRowByTaskName(container: HTMLElement, taskName: string): HTMLTableRowElement {
  const row = Array.from(container.querySelectorAll<HTMLTableRowElement>('tbody tr')).find(
    (tr) => getRowTaskName(tr) === taskName,
  );
  expect(row).toBeDefined();
  return row!;
}

/** 点击某行第一列的折叠/展开按钮 */
function clickRowCollapseButton(container: HTMLElement, taskName: string) {
  const row = findRowByTaskName(container, taskName);
  const btn = row.querySelector<HTMLButtonElement>('button.nb-bitable-btn-ghost');
  expect(btn).not.toBeNull();
  act(() => {
    btn!.click();
  });
}

describe('多维表格子任务默认收起设置', () => {
  let host: HTMLDivElement;
  let root: Root;
  let previousSettings: ReturnType<typeof useSettingsStore.getState>['settings'];

  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    previousSettings = useSettingsStore.getState().settings;
    await act(async () => {
      useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS) });
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    await act(async () => {
      useSettingsStore.setState({ settings: previousSettings });
    });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('开关默认关闭时，表格视图默认展开所有子任务且支持手动收起', async () => {
    const rows = createTreeRows();
    await act(async () => {
      root.render(
        <BitableGridView
          columns={columns}
          rows={rows}
          onUpdateRow={vi.fn()}
          onAddRow={vi.fn()}
          onDeleteRow={vi.fn()}
          onUpdateColumn={vi.fn()}
          onAddColumn={vi.fn()}
          onDeleteColumn={vi.fn()}
        />,
      );
    });

    expect(getRenderedTaskTexts(host)).toEqual(['父任务 1', '子任务 1-1', '孙任务 1-1-1', '父任务 2']);

    clickRowCollapseButton(host, '父任务 1');
    expect(getRenderedTaskTexts(host)).toEqual(['父任务 1', '父任务 2']);
  });

  it('开关开启时，表格视图默认仅显示顶层行并支持逐级展开与动态切换设置', async () => {
    await act(async () => {
      setSubtaskDefaultCollapsed(true);
    });

    const rows = createTreeRows();
    await act(async () => {
      root.render(
        <BitableGridView
          columns={columns}
          rows={rows}
          onUpdateRow={vi.fn()}
          onAddRow={vi.fn()}
          onDeleteRow={vi.fn()}
          onUpdateColumn={vi.fn()}
          onAddColumn={vi.fn()}
          onDeleteColumn={vi.fn()}
        />,
      );
    });

    // 初始仅显示顶层父行
    expect(getRenderedTaskTexts(host)).toEqual(['父任务 1', '父任务 2']);

    // 点击父任务 1 仅展开直接子行（孙任务仍保持默认收起）
    clickRowCollapseButton(host, '父任务 1');
    expect(getRenderedTaskTexts(host)).toEqual(['父任务 1', '子任务 1-1', '父任务 2']);

    // 再点击子任务 1-1 展开孙任务
    clickRowCollapseButton(host, '子任务 1-1');
    expect(getRenderedTaskTexts(host)).toEqual(['父任务 1', '子任务 1-1', '孙任务 1-1-1', '父任务 2']);

    // 设置切回关闭：已挂载表格应立即全部展开
    await act(async () => {
      setSubtaskDefaultCollapsed(false);
    });
    expect(getRenderedTaskTexts(host)).toEqual(['父任务 1', '子任务 1-1', '孙任务 1-1-1', '父任务 2']);

    // 设置再次开启：已挂载表格应立即全部收起（清除先前的手动展开）
    await act(async () => {
      setSubtaskDefaultCollapsed(true);
    });
    expect(getRenderedTaskTexts(host)).toEqual(['父任务 1', '父任务 2']);
  });

  it('甘特图视图同步遵守子任务默认收起开关与动态切换', async () => {
    await act(async () => {
      setSubtaskDefaultCollapsed(true);
    });

    const rows = createTreeRows();
    await act(async () => {
      root.render(
        <BitableGanttView
          columns={columns}
          rows={rows}
          config={{ startColumnId: 'start', endColumnId: 'end', titleColumnId: 'name', leftColumnIds: ['name'] }}
          onUpdateConfig={vi.fn()}
          onUpdateRow={vi.fn()}
          onAddRow={vi.fn()}
          onDeleteRow={vi.fn()}
          onUpdateColumn={vi.fn()}
          onAddColumn={vi.fn()}
          onDeleteColumn={vi.fn()}
        />,
      );
    });

    expect(getRenderedTaskTexts(host)).toEqual(['父任务 1', '父任务 2']);

    clickRowCollapseButton(host, '父任务 1');
    expect(getRenderedTaskTexts(host)).toEqual(['父任务 1', '子任务 1-1', '父任务 2']);

    await act(async () => {
      setSubtaskDefaultCollapsed(false);
    });
    expect(getRenderedTaskTexts(host)).toEqual(['父任务 1', '子任务 1-1', '孙任务 1-1-1', '父任务 2']);
  });

  it('默认收起开启时，添加子任务与降级为子任务会自动展开对应父行', async () => {
    await act(async () => {
      setSubtaskDefaultCollapsed(true);
    });

    function ControlledGrid() {
      const [rows, setRows] = useState<BitableRow[]>([
        { id: 'r1', name: '任务 A' },
        { id: 'r2', name: '任务 B' },
      ]);
      const handleAddSubRow = (parentRowId: string) => {
        setRows((prev) => {
          const idx = prev.findIndex((r) => r.id === parentRowId);
          const next = [...prev];
          next.splice(idx + 1, 0, { id: `sub_${prev.length + 1}`, name: '新增子任务', parentId: parentRowId });
          return next;
        });
      };
      const handleIndentRow = (rowId: string) => {
        setRows((prev) => {
          const idx = prev.findIndex((r) => r.id === rowId);
          if (idx <= 0) return prev;
          const row = prev[idx];
          let parentId: string | undefined;
          for (let i = idx - 1; i >= 0; i -= 1) {
            if ((prev[i].parentId || undefined) === (row.parentId || undefined)) {
              parentId = prev[i].id;
              break;
            }
          }
          if (!parentId) return prev;
          return prev.map((r) => (r.id === rowId ? { ...r, parentId } : r));
        });
      };
      return (
        <BitableGridView
          columns={columns}
          rows={rows}
          onUpdateRow={vi.fn()}
          onAddRow={vi.fn()}
          onAddSubRow={handleAddSubRow}
          onIndentRow={handleIndentRow}
          onDeleteRow={vi.fn()}
          onUpdateColumn={vi.fn()}
          onAddColumn={vi.fn()}
          onDeleteColumn={vi.fn()}
        />
      );
    }

    await act(async () => {
      root.render(<ControlledGrid />);
    });

    // 为任务 A 添加子任务：父行自动展开，新子行立即可见
    const rowA = findRowByTaskName(host, '任务 A');
    const addSubBtn = rowA.querySelector<HTMLButtonElement>('button[aria-label="添加子任务"]')!;
    act(() => {
      addSubBtn.click();
    });
    expect(getRenderedTaskTexts(host)).toEqual(['任务 A', '新增子任务', '任务 B']);

    // 将任务 B 降级为任务 A 的子任务：父行保持展开，任务 B 依然可见
    const rowB = findRowByTaskName(host, '任务 B');
    const indentBtn = rowB.querySelector<HTMLButtonElement>('button[aria-label="降级为子任务"]')!;
    act(() => {
      indentBtn.click();
    });
    expect(getRenderedTaskTexts(host)).toEqual(['任务 A', '新增子任务', '任务 B']);
  });
});
