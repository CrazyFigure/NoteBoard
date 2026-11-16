// 导图键盘操作回归：方向键切换选中节点、空格进入编辑、Enter 退出编辑后焦点回到画布，
// 以及节点颜色只作用于选中节点本身。
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/components/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
import { MindmapRenderer } from '@/features/mindmap/MindmapRenderer';
import { getMindmapTheme } from '@/features/mindmap/mindmapTheme';
import type { MindNode } from '@/features/mindmap/mindmapTypes';

const createTree = (): MindNode => ({
  id: 'root', text: '中心', isExpanded: true,
  children: [
    { id: 'a', text: '节点 A', isExpanded: true, children: [{ id: 'a1', text: '子节点', isExpanded: true, children: [] }] },
    { id: 'b', text: '节点 B', isExpanded: true, children: [] },
  ],
});

describe('思维导图键盘操作', () => {
  let host: HTMLDivElement;
  let root: Root;
  const onChange = vi.fn<(tree: MindNode) => void>();

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    onChange.mockClear();
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1024);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(768);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    // jsdom 不做布局：让画布视为可见
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    function Harness() {
      const [tree, setTree] = useState(createTree);
      const theme = getMindmapTheme();
      return <MindmapRenderer root={tree} onChange={(next) => { onChange(next); setTree(next); }}
        zoom={1} onZoomChange={() => {}} layout="right" theme={theme} edgeStyle={theme.edgeStyle}
        maxNodeWidth={300} defaultTextAlign="left" defaultImageFit="original" />;
    }
    await act(async () => root.render(<Harness />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  const nodeEl = (id: string) => host.querySelector(`[data-node-id="${id}"]`) as HTMLElement;
  const selectedIds = () => Array.from(host.querySelectorAll('.nb-mindmap-node[data-selected]')).map((el) => el.getAttribute('data-node-id'));
  const press = async (target: EventTarget, key: string, options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
    await act(async () => { target.dispatchEvent(event); });
    return event;
  };
  const select = async (id: string) => {
    await act(async () => { nodeEl(id).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  };

  it('方向键在父子与同级之间移动选中', async () => {
    await select('a');
    expect((await press(document.body, 'ArrowRight')).defaultPrevented).toBe(true);
    expect(selectedIds()).toEqual(['a1']);
    await press(document.body, 'ArrowLeft');
    expect(selectedIds()).toEqual(['a']);
    await press(document.body, 'ArrowDown');
    expect(selectedIds()).toEqual(['b']);
    await press(document.body, 'ArrowLeft');
    expect(selectedIds()).toEqual(['root']);
  });

  it('焦点在画布外的控件上时不拦截方向键', async () => {
    await select('a');
    const outside = document.createElement('div');
    outside.tabIndex = 0;
    document.body.appendChild(outside);
    outside.focus();
    expect((await press(outside, 'ArrowDown')).defaultPrevented).toBe(false);
    expect(selectedIds()).toEqual(['a']);
    outside.remove();
  });

  it('空格进入编辑，Enter 退出编辑并把焦点交还画布', async () => {
    await select('b');
    expect((await press(document.body, ' ', { code: 'Space' })).defaultPrevented).toBe(true);
    const editor = host.querySelector('[role="textbox"]') as HTMLElement;
    expect(editor).not.toBeNull();
    expect(document.activeElement).toBe(editor);
    await press(editor, 'Enter');
    expect(host.querySelector('[role="textbox"]')).toBeNull();
    expect(selectedIds()).toEqual(['b']);
    expect(document.activeElement).toBe(host.firstElementChild);
    // 焦点回到画布后方向键立即可用
    await press(document.activeElement!, 'ArrowUp');
    expect(selectedIds()).toEqual(['a']);
  });

  it('节点颜色只改选中节点，不影响子节点', async () => {
    await select('a');
    const styleButton = nodeEl('a').querySelector('[aria-label="节点样式"]') as HTMLElement;
    await act(async () => { styleButton.click(); });
    const swatch = document.querySelector('.nb-mindmap-color-swatch[aria-label="浅红"]') as HTMLElement;
    await act(async () => { swatch.click(); });
    const tree = onChange.mock.lastCall![0];
    expect(tree.children[0].fillColor).toBe('#fee2e2');
    expect(tree.children[0].children[0].fillColor).toBeUndefined();
    expect(nodeEl('a').style.background).toContain('254, 226, 226');
    const textSwatch = document.querySelector('.nb-mindmap-color-swatch[aria-label="红色"][data-variant="text"]') as HTMLElement;
    await act(async () => { textSwatch.click(); });
    expect(onChange.mock.lastCall![0].children[0].textColor).toBe('#ef4444');
    expect(onChange.mock.lastCall![0].children[0].fillColor).toBe('#fee2e2');
  });
});
