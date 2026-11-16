// 多维表格状态回归：真实网格交互、后台快捷键隔离、保存基线与纯查看快照。
import React, { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BitableGridView } from '@/features/bitable/BitableGridView';
import type { BitableDocument } from '@/features/bitable/bitableTypes';

// 保留真实网格，同时取得回调以驱动粘贴、字段配置等非布局相关的提交入口。
const harness = vi.hoisted(() => ({ grid: null as ComponentProps<typeof BitableGridView> | null }));
vi.mock('@/features/bitable/BitableGridView', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/bitable/BitableGridView')>();
  return { ...actual, BitableGridView: (props: ComponentProps<typeof BitableGridView>) => {
    harness.grid = props;
    return <actual.BitableGridView {...props} />;
  } };
});
vi.mock('@/features/bitable/BitableGanttView', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/features/bitable/BitableGanttView')>(),
  BitableGanttView: () => <div />,
}));
vi.mock('@/features/plugins/WorkbenchView', () => ({ WorkbenchView: () => <div /> }));
vi.mock('@/components/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/features/export/chartExport', () => ({ exportBlobWithDialog: vi.fn() }));
// 所有写盘仅记录调用和更新内存基线，测试不访问用户文件或原生窗口。
vi.mock('@/core/ipc/commands', () => ({
  writeDocument: vi.fn().mockResolvedValue({ ok: true, mtime: 1, size: 1, error: null }),
  setDocumentDirty: vi.fn().mockResolvedValue(undefined),
  deleteStagedFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'nb-main' }) }));

import { BitableEditor } from '@/features/bitable/BitableEditor';
import { serializeBitableDocument } from '@/features/bitable/bitableConverter';
import { EditorActivityContext } from '@/core/editor/EditorActivityContext';
import { getDocumentRevision, getEditorCapabilities, resetEditorRegistryForTest } from '@/core/editor/editorRegistry';
import { getDocumentHistoryAvailability, clearAllDocumentHistories, applyDocumentContentAsChange, undoDocumentHistory } from '@/features/history/documentHistory';
import { saveViewState, resetSuspensionForTest } from '@/features/session/editorSuspension';
import * as session from '@/features/session/documentSession';
import * as ipc from '@/core/ipc/commands';
import { DEFAULT_SETTINGS, useSettingsStore } from '@/stores/settingsStore';
import { useDocumentStore } from '@/stores/documentStore';
import { useWindowStore } from '@/stores/windowStore';

// 固定的小型文档覆盖非空、空单元格和可调整层级的第二行，无需真实工作记录。
const fixture: BitableDocument = {
  schemaVersion: 1, title: '状态回归',
  columns: [
    { id: 'name', key: 'name', name: '任务', type: 'text', width: 200 },
    { id: 'blank', key: 'blank', name: '备注', type: 'text', width: 120 },
    { id: 'status', key: 'status', name: '状态', type: 'multiSelect', width: 120, options: [{ id: 'todo', label: '待办', color: 'blue' }] },
  ],
  rows: [{ id: 'row_1', name: '已保存任务', blank: null, status: ['todo'] }, { id: 'row_2', name: '第二行', status: [] }],
  views: [
    { id: 'grid', name: '表格', type: 'grid', frozenColumnCount: 0, groupByColumnId: '', sortRules: [] },
    { id: 'kanban', name: '看板', type: 'kanban', groupByColumnId: 'status' },
    { id: 'gantt', name: '甘特图', type: 'gantt' },
    { id: 'workbench', name: '工作台', type: 'workbench' },
  ],
  activeViewId: 'grid',
};
const original = serializeBitableDocument(fixture);
const key = '/diagnostic/tasks.bitable';
const otherKey = '/diagnostic/other.md';
let root: Root;
let host: HTMLDivElement;
let outside: HTMLTextAreaElement;
let active: boolean;

/** 文档与标签小点必须始终与同一保存基线对齐。 */
function expectState(content: string, dirty: boolean): void {
  const doc = useDocumentStore.getState().getDocument(key)!;
  expect(doc.content).toBe(content);
  expect(doc.isDirty).toBe(dirty);
  expect(useWindowStore.getState().getTab(key)?.isDirty).toBe(dirty);
}

/** 只改变可见状态，模拟真实宿主保留后台编辑器的行为。 */
async function renderEditor(nextActive = true): Promise<void> {
  active = nextActive;
  await act(async () => {
    useWindowStore.setState({ activeKey: active ? key : otherKey });
    root.render(<EditorActivityContext.Provider value={active}><BitableEditor docKey={key} /></EditorActivityContext.Provider>);
  });
}

/** 推进本轮事件末尾的历史合并和代理聚焦，避免依赖真实计时。 */
async function settle(): Promise<void> {
  await act(async () => { vi.advanceTimersByTime(0); });
}

/** 按键从实际目标节点冒泡，覆盖窗口监听而非直接调用撤销函数。 */
async function press(target: EventTarget, init: KeyboardEventInit, consumed = false): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  if (consumed) event.preventDefault();
  await act(async () => { target.dispatchEvent(event); });
  return event;
}

/** 提交一次真实单元格编辑，给撤销、重做和保存竞态建立历史。 */
async function editName(value = '新任务'): Promise<string> {
  await act(async () => { harness.grid!.onUpdateRow('row_1', 'name', value); });
  await settle();
  return useDocumentStore.getState().getDocument(key)!.content!;
}

/** 经过真实保存屏障更新基线，IPC 由测试内存替身承接。 */
async function saveCurrent(): Promise<string> {
  const captured = await getEditorCapabilities(key)!.flush('save');
  await act(async () => { expect(await session.writeDocumentWithBarrier(key, captured!.content!)).toBe(true); });
  return captured!.content!;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(ipc.writeDocument).mockResolvedValue({ ok: true, mtime: 1, size: 1, error: null });
  vi.mocked(ipc.setDocumentDirty).mockResolvedValue(undefined);
  vi.mocked(ipc.deleteStagedFile).mockResolvedValue(undefined);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  resetEditorRegistryForTest();
  resetSuspensionForTest();
  clearAllDocumentHistories();
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, file: { ...DEFAULT_SETTINGS.file, autoSaveBitable: false } } });
  useDocumentStore.setState({ documents: new Map() });
  useWindowStore.setState({ tabs: [], activeKey: null, transferringKeys: [], pendingCloseKeys: [] });
  useDocumentStore.getState().upsertFromPayload({ key, displayName: 'tasks.bitable', dirPath: '/diagnostic', kind: 'bitable', language: 'json', content: original, encoding: 'utf8', eol: 'lf', size: original.length, mtime: 0, readonly: false });
  useWindowStore.getState().openTab({ key, path: key, displayName: 'tasks.bitable', kind: 'bitable', language: 'json', isDirty: false, isPreview: false, viewMode: null, externalStatus: null, isDetached: false });
  host = document.createElement('div');
  outside = document.createElement('textarea');
  document.body.append(host, outside);
  root = createRoot(host);
  await renderEditor();
  await settle();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  outside.remove();
  useDocumentStore.setState({ documents: new Map() });
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('空操作与保存基线', () => {
  it.each(['单元格原值', '空单元格清空', '整列空值清空', '粘贴原值', '字段名称', '选项名称和颜色', '分组配置', '排序配置', '冻结列配置'])('%s不产生脏态、历史或保存任务', async (operation) => {
    const schedule = vi.spyOn(session, 'scheduleAutoSave');
    const grid = harness.grid!;
    await act(async () => {
      switch (operation) {
        case '单元格原值': grid.onUpdateRow('row_1', 'name', fixture.rows[0].name); break;
        case '空单元格清空': grid.onBatchUpdateCells!([{ rowId: 'row_1', colId: 'blank', value: null }]); break;
        case '整列空值清空': grid.onClearColumn!('blank'); break;
        case '粘贴原值': grid.onPasteCells!('row_1', 'name', [['已保存任务']]); break;
        case '字段名称': grid.onUpdateColumn('name', { name: '任务' }); break;
        case '选项名称和颜色': grid.onManageColumnOption!('status', { type: 'update', optionId: 'todo', label: '待办', color: 'blue' }); break;
        case '分组配置': grid.onUpdateGroupByColumnId!(''); break;
        case '排序配置': grid.onUpdateSortRules!([]); break;
        case '冻结列配置': grid.onUpdateFrozenColumnCount!(0); break;
      }
    });
    await settle();
    expectState(original, false);
    expect(getDocumentRevision(key)).toBe(0);
    expect(getDocumentHistoryAvailability(key)).toEqual({ canUndo: false, canRedo: false });
    expect(schedule).not.toHaveBeenCalled();
  });

  it('视图名称双击后原样确认不亮小点', async () => {
    const label = host.querySelector('.nb-bitable-tab span')!;
    await act(async () => { label.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    await press(host.querySelector('.nb-bitable-tab input')!, { key: 'Enter' });
    expectState(original, false);
    expect(getDocumentRevision(key)).toBe(0);
  });

  it.each([{ ctrlKey: true }, { metaKey: true }])('前台撤销回基线清除小点，重做恢复修改：%j', async (modifier) => {
    const changed = await editName();
    const proxy = host.querySelector('[data-bitable-clipboard-proxy]')!;
    await press(proxy, { key: 'z', ...modifier });
    expectState(original, false);
    await press(proxy, { key: 'z', shiftKey: true, ...modifier });
    expectState(changed, true);
    expect(getDocumentRevision(key)).toBe(3);
  });

  it('保存写入期间的新编辑仍保留，成功后不会误清小点', async () => {
    const first = await editName('先保存的任务');
    let finishWrite!: (value: Awaited<ReturnType<typeof ipc.writeDocument>>) => void;
    vi.mocked(ipc.writeDocument).mockImplementationOnce(() => new Promise((resolve) => { finishWrite = resolve; }));
    let saving!: Promise<boolean>;
    await act(async () => { saving = session.writeDocumentWithBarrier(key, first); await Promise.resolve(); });
    const latest = await editName('写盘期间的新任务');
    await act(async () => { finishWrite({ ok: true, mtime: 2, size: first.length, error: null }); expect(await saving).toBe(true); });
    expectState(latest, true);
    expect(useDocumentStore.getState().getDocument(key)?.baselineContent).toBe(first);
  });

  it('自动保存后撤销回已保存内容会清除小点', async () => {
    const saved = await editName('自动保存的任务');
    await act(async () => {
      const doc = useDocumentStore.getState().getDocument(key)!;
      useDocumentStore.setState({ documents: new Map([[key, { ...doc, savePolicy: 'auto' }]]) });
      await session.queuedAutoSave(key, saved);
    });
    expectState(saved, false);
    await editName('后续编辑');
    await press(document.body, { key: 'z', ctrlKey: true });
    expectState(saved, false);
  });
});

describe('后台标签隔离', () => {
  it.each([
    { key: 'z', ctrlKey: true }, { key: 'y', ctrlKey: true }, { key: 'z', ctrlKey: true, shiftKey: true },
    { key: 'z', metaKey: true }, { key: 'y', metaKey: true }, { key: 'z', metaKey: true, shiftKey: true },
  ])('另一个文件中的快捷键不改动后台表格：%j', async (shortcut) => {
    await editName();
    // 为重做入口保留可重做历史，为撤销入口保留已保存但可撤销的历史。
    if (shortcut.key === 'y' || shortcut.shiftKey) await act(async () => { undoDocumentHistory(key); });
    const saved = await saveCurrent();
    await renderEditor(false);
    outside.focus();
    const revision = getDocumentRevision(key);
    const event = await press(outside, shortcut);
    expectState(saved, false);
    expect(getDocumentRevision(key)).toBe(revision);
    expect(event.defaultPrevented).toBe(false);
  });

  it.each(['Delete', 'Backspace', 'Tab', 'a', 'ArrowDown'])('其它区域的%s不处理后台保留选区', async (pressedKey) => {
    const cell = host.querySelector('td[data-cell-row-idx="1"][data-cell-col-idx="0"]')!;
    await act(async () => { cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); });
    await settle();
    await renderEditor(false);
    outside.focus(); outside.blur();
    const event = await press(document.body, { key: pressedKey, ctrlKey: pressedKey === 'a' });
    expectState(original, false);
    expect(event.defaultPrevented).toBe(false);
  });

  it('后台代理残留焦点的剪切和粘贴不提交正文', async () => {
    const cell = host.querySelector('td[data-cell-row-idx="0"][data-cell-col-idx="0"]')!;
    await act(async () => { cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); });
    await settle();
    await renderEditor(false);
    const proxy = host.querySelector('[data-bitable-clipboard-proxy]')!;
    const getData = vi.fn(() => '不能写入后台');
    for (const type of ['cut', 'paste']) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { getData, setData: vi.fn() } });
      await act(async () => { proxy.dispatchEvent(event); });
      expect(event.defaultPrevented).toBe(false);
    }
    expect(getData).not.toHaveBeenCalled();
    expectState(original, false);
  });

  it('切后台前排队的聚焦不抢走前台文件焦点，切回后仍能编辑', async () => {
    const cell = host.querySelector('td[data-cell-row-idx="0"][data-cell-col-idx="0"]')!;
    await act(async () => { cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); });
    await renderEditor(false);
    const foreground = document.createElement('button');
    document.body.appendChild(foreground);
    foreground.focus();
    try {
      await settle();
      expect(document.activeElement).toBe(foreground);
      await renderEditor(true);
      await settle();
      expect(document.activeElement).toBe(host.querySelector('[data-bitable-clipboard-proxy]'));
      await press(document.activeElement!, { key: 'Delete' });
      expect(useDocumentStore.getState().getDocument(key)?.isDirty).toBe(true);
    } finally { foreground.remove(); }
  });

  it('已消费的快捷键和表内文本输入保留自身撤销，不触发表格历史', async () => {
    const changed = await editName();
    await press(document.body, { key: 'z', ctrlKey: true }, true);
    const search = host.querySelector('input')!;
    await press(search, { key: 'z', ctrlKey: true });
    expectState(changed, true);
  });

  it('前台代理的方向键仍移动选区，删除只作用于移动后的单元格', async () => {
    const cell = host.querySelector('td[data-cell-row-idx="0"][data-cell-col-idx="0"]')!;
    await act(async () => { cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); });
    await settle();
    const proxy = host.querySelector('[data-bitable-clipboard-proxy]')!;
    await press(proxy, { key: 'ArrowDown' });
    await press(proxy, { key: 'Delete' });
    const current = JSON.parse(useDocumentStore.getState().getDocument(key)!.content!) as BitableDocument;
    expect(current.rows[0].name).toBe(fixture.rows[0].name);
    expect(current.rows[1].name).toBeNull();
    expect(useWindowStore.getState().getTab(key)?.isDirty).toBe(true);
  });

  it.each([{ ctrlKey: true }, { metaKey: true }])('前台全选和粘贴仍能正常写入：%j', async (modifier) => {
    const proxy = host.querySelector('[data-bitable-clipboard-proxy]')!;
    await press(proxy, { key: 'a', ...modifier });
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => '粘贴任务\t备注\t待办' } });
    await act(async () => { proxy.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    const current = JSON.parse(useDocumentStore.getState().getDocument(key)!.content!) as BitableDocument;
    expect(current.rows[0]).toMatchObject({ name: '粘贴任务', blank: '备注', status: ['todo'] });
    expect(useWindowStore.getState().getTab(key)?.isDirty).toBe(true);
  });
});

describe('纯查看快照', () => {
  it.each(['kanban', 'gantt', 'workbench'])('切换到%s后保存、回收和迁移都保持原正文', async (viewId) => {
    const tab = host.querySelectorAll('.nb-bitable-tab')[fixture.views.findIndex((view) => view.id === viewId)];
    await act(async () => { tab.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    for (const reason of ['save', 'evict', 'transfer'] as const) {
      const captured = await getEditorCapabilities(key)!.flush(reason);
      expect(captured?.content).toBe(original);
      expectState(original, false);
    }
    const viewState = getEditorCapabilities(key)!.captureViewState!();
    expect(viewState).toMatchObject({ activeViewId: viewId });
    await act(async () => { root.unmount(); });
    saveViewState(key, viewState);
    root = createRoot(host);
    await renderEditor();
    expect(host.querySelector('.nb-bitable-tab.is-active')?.textContent).toContain(fixture.views.find((view) => view.id === viewId)!.name);
    expectState(original, false);
  });

  it('解析补齐旧字段配置或不同缩进时，只查看不重写原正文', async () => {
    const schedule = vi.spyOn(session, 'scheduleAutoSave');
    const legacy = JSON.stringify({ ...fixture, columns: [...fixture.columns, { id: 'date', key: 'date', name: '日期', type: 'date' }] });
    await act(async () => { applyDocumentContentAsChange(key, legacy, { externalReload: true }); });
    expect(schedule).not.toHaveBeenCalled();
    await saveCurrent();
    const captured = await getEditorCapabilities(key)!.flush('evict');
    expect(captured?.content).toBe(legacy);
    expectState(legacy, false);
  });

  it('正文未知时不把解析默认值作为可写快照返回', async () => {
    await act(async () => {
      const doc = useDocumentStore.getState().getDocument(key)!;
      useDocumentStore.setState({ documents: new Map([[key, { ...doc, content: null }]]) });
    });
    expect(await getEditorCapabilities(key)!.flush('save')).toBeNull();
    expect(ipc.writeDocument).not.toHaveBeenCalled();
  });
});
