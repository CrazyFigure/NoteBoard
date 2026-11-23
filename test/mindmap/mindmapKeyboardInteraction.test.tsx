// 导图键盘操作回归：方向键切换选中节点、空格进入编辑、Enter 退出编辑后焦点回到画布，
// 以及节点颜色只作用于选中节点本身。
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/components/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
import { MindmapRenderer } from '@/features/mindmap/MindmapRenderer';
import { getMindmapTheme } from '@/features/mindmap/mindmapTheme';
import type { MindNode } from '@/features/mindmap/mindmapTypes';
import { installTabNavigationGuard } from '@/core/tabNavigationGuard';

// 包含真实入口安装的全局守卫，覆盖画布已聚焦时 Tab 被提前消费的冲突。
installTabNavigationGuard();

const createTree = (): MindNode => ({
  id: 'root', text: '中心', isExpanded: true,
  children: [
    {
      id: 'a', text: '节点 A', isExpanded: true,
      // 多个子节点：折叠后整图排版会发生位移
      children: ['a1', 'a2', 'a3', 'a4', 'a5'].map((id) => ({ id, text: `子节点 ${id}`, isExpanded: true, children: [] })),
    },
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
    // 进入与当前节点同一水平线上的中间子节点
    expect(selectedIds()).toEqual(['a3']);
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

  it.each(['root', 'b'])('选中 %s 后 Tab 创建并选中子节点，连续 Tab 不进入编辑', async (id) => {
    await select(id);
    const canvas = host.firstElementChild as HTMLElement;
    expect((await press(canvas, 'Tab')).defaultPrevented).toBe(true);
    const tree = onChange.mock.lastCall![0];
    const parent = id === 'root' ? tree : tree.children.find((node) => node.id === id)!;
    const child = parent.children.at(-1)!;
    expect(child.text).toBe('');
    expect(selectedIds()).toEqual([child.id]);
    expect(host.querySelector('[role="textbox"]')).toBeNull();
    expect(document.activeElement).toBe(canvas);

    // 保持画布焦点后可连续创建下级节点，空格仍能主动进入新节点编辑。
    await press(canvas, 'Tab');
    const nextTree = onChange.mock.lastCall![0];
    const nextParent = id === 'root' ? nextTree : nextTree.children.find((node) => node.id === id)!;
    const grandchild = nextParent.children.at(-1)!.children[0];
    expect(selectedIds()).toEqual([grandchild.id]);
    expect(host.querySelector('[role="textbox"]')).toBeNull();
    await press(canvas, ' ', { code: 'Space' });
    expect(host.querySelector('[role="textbox"]')).not.toBeNull();
  });

  it('折叠 / 展开节点后该节点在屏幕上的位置不变', async () => {
    const screenPos = (id: string) => {
      const layer = host.querySelector('.nb-mindmap-transform') as HTMLElement;
      const match = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px/.exec(layer.style.transform)!;
      const el = nodeEl(id);
      return { x: Number(match[1]) + parseFloat(el.style.left), y: Number(match[2]) + parseFloat(el.style.top) };
    };
    const before = screenPos('a');
    const layoutBefore = parseFloat(nodeEl('a').style.top);
    const fold = () => nodeEl('a').querySelector('.nb-mindmap-fold-btn') as HTMLElement;
    await act(async () => { fold().click(); });
    expect(onChange.mock.lastCall![0].children[0].isExpanded).toBe(false);
    // 排版坐标确实变了，但屏幕位置保持不变
    expect(parseFloat(nodeEl('a').style.top)).not.toBe(layoutBefore);
    expect(screenPos('a')).toEqual(before);
    await act(async () => { fold().click(); });
    expect(screenPos('a')).toEqual(before);
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

  it('节点悬浮工具栏仅在选中时展示，鼠标悬停其他节点不显示也不干扰原选中菜单', async () => {
    const toolbars = () => host.querySelectorAll('.nb-mindmap-node > .nb-mindmap-node-toolbar');
    const toolbarOn = (id: string) => nodeEl(id).querySelector('.nb-mindmap-node-toolbar') as HTMLElement | null;

    // 初始未选中任何节点时不渲染工具栏；鼠标移动到节点上也不触发显示
    expect(toolbars()).toHaveLength(0);
    await act(async () => {
      nodeEl('a').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      nodeEl('a').dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    });
    expect(toolbars()).toHaveLength(0);

    // 选中节点 a 后仅节点 a 渲染工具栏，鼠标移动到其他节点仍保留原工具栏且其他节点不显示
    await select('a');
    expect(toolbars()).toHaveLength(1);
    expect(toolbarOn('a')?.dataset.selected).toBe('true');
    expect(toolbarOn('b')).toBeNull();
    expect(toolbarOn('root')).toBeNull();

    await act(async () => {
      nodeEl('b').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      nodeEl('b').dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      nodeEl('root').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(toolbars()).toHaveLength(1);
    expect(toolbarOn('a')).not.toBeNull();
    expect(toolbarOn('b')).toBeNull();

    // 多选时仅主选中节点渲染工具栏并展示已选数量
    await act(async () => {
      nodeEl('b').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true, metaKey: true }));
    });
    expect(selectedIds()).toEqual(['a', 'b']);
    expect(toolbars()).toHaveLength(1);
    expect(toolbarOn('b')?.textContent).toContain('已选 2 个');
    expect(toolbarOn('a')).toBeNull();

    // 点击空白画布取消选中后全部节点工具栏隐藏
    const canvas = host.querySelector('.nb-mindmap-canvas') as HTMLElement;
    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    });
    expect(selectedIds()).toEqual([]);
    expect(toolbars()).toHaveLength(0);
  });
});
