// 使用真实 MergeView 验证两侧正文、撤销与选区经过序列化后仍能恢复。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TextDiffView } from '@/features/textdiff/TextDiffView';
import { TooltipProvider } from '@/components/Tooltip';
import { captureTextDiff, restoreTextDiff } from '@/features/textdiff/textDiffTransfer';

vi.mock('@/core/ipc/commands', () => ({}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

let root: Root | null = null;
let host: HTMLDivElement;
const key = 'tool:textdiff:transfer-test';
const createRange = document.createRange.bind(document);

/** 只替换浏览器布局探针，保留 CodeMirror 和 MergeView 的真实事务。 */
async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<TooltipProvider><TextDiffView docKey={key} /></TooltipProvider>));
  return [...host.querySelectorAll<HTMLElement>('.cm-editor')].map((node) => EditorView.findFromDOM(node)!);
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('文本对比工具迁移', () => {
  it('双侧正文、名称、视图选项与历史在目标组件重建后恢复', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    // jsdom 没有文字布局测量；测试只检查文本、历史和逻辑选区，不断言像素位置。
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = createRange();
      range.getClientRects = () => [] as unknown as DOMRectList;
      range.getBoundingClientRect = () => new DOMRect();
      return range;
    });
    const [left, right] = await mount();
    await act(async () => {
      left.dispatch({ changes: { from: 0, insert: '左侧原文' }, selection: { anchor: 2 } });
      right.dispatch({ changes: { from: 0, insert: '右侧原文' }, selection: { anchor: 3 } });
    });
    const snapshot = captureTextDiff(key)!;
    expect(snapshot.a.doc).toBe('左侧原文');
    expect(snapshot.b.doc).toBe('右侧原文');
    snapshot.leftName = 'left.txt';
    snapshot.rightName = 'right.txt';
    snapshot.collapseOn = true;
    snapshot.softWrap = false;
    snapshot.leftWidth = '35%';
    await act(async () => root!.unmount());
    root = null;
    host.remove();
    expect(captureTextDiff(key)).toBeNull();

    // IPC 实际经过 JSON 序列化，不把原组件对象引用当作恢复能力。
    restoreTextDiff(key, JSON.parse(JSON.stringify(snapshot)));
    const [restoredLeft, restoredRight] = await mount();
    expect(restoredLeft.state.doc.toString()).toBe('左侧原文');
    expect(restoredRight.state.doc.toString()).toBe('右侧原文');
    expect(restoredLeft.state.selection.main.anchor).toBe(2);
    expect(restoredRight.state.selection.main.anchor).toBe(3);
    expect(host.textContent).toContain('left.txt');
    expect(host.querySelector<HTMLElement>('.nb-diff-stage')!.style.getPropertyValue('--nb-diff-left')).toBe('35%');
    await act(async () => { expect(undo(restoredLeft)).toBe(true); expect(undo(restoredRight)).toBe(true); });
    expect(restoredLeft.state.doc.toString()).toBe('');
    expect(restoredRight.state.doc.toString()).toBe('');
  });
});
