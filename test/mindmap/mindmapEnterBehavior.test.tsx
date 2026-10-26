// 导图回车回归：编辑态只确认文字，选中态才新增节点，并覆盖软键盘与输入法事件差异。
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/components/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
import { MindmapRenderer } from '@/features/mindmap/MindmapRenderer';
import { getMindmapTheme } from '@/features/mindmap/mindmapTheme';
import type { MindNode } from '@/features/mindmap/mindmapTypes';

/** 每次使用独立树，验证确认文字和新增节点不会相互覆盖。 */
const createTree = (): MindNode => ({
  id: 'root', text: '中心', isExpanded: true,
  children: [
    { id: 'a', text: '节点 A', isExpanded: true, children: [] },
    { id: 'b', text: '节点 B', isExpanded: true, children: [] },
  ],
});

describe('思维导图节点回车', () => {
  let host: HTMLDivElement;
  let root: Root;
  const onChange = vi.fn<(tree: MindNode) => void>();

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    onChange.mockClear();
    // jsdom 不提供实际视口和 2D 画布，固定视口以免节点被裁剪，并跳过无关的缩略图绘制。
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1024);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(768);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    // 使用真实父级状态更新，保证后续 Enter 读取的是确认后的树和选中状态。
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

  /** 按真实双击顺序先选中再编辑，返回当前标题输入框。 */
  const editNode = async (id = 'a') => {
    const node = host.querySelector(`[data-node-id="${id}"]`)!;
    await act(async () => {
      node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    return host.querySelector('[role="textbox"]') as HTMLElement;
  };

  /** 模拟硬件键盘按下，保留取消状态以核对事件是否由编辑框接管。 */
  const pressKey = async (target: EventTarget, options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options });
    await act(async () => { target.dispatchEvent(event); });
    return event;
  };

  /** 编辑内容通过 input 同步草稿，避免仅修改 DOM 而绕过实际保存路径。 */
  const inputText = (editor: HTMLElement, text: string) => {
    editor.textContent = text;
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  };

  const latestTree = () => onChange.mock.lastCall![0];

  it.each(['a', 'root'])('编辑 %s 时首次 Enter 只确认，再次 Enter 才新增节点', async (id) => {
    const editor = await editNode(id);
    await act(async () => inputText(editor, '修改后的文字'));
    const firstEnter = await pressKey(editor);
    expect(firstEnter.defaultPrevented).toBe(true);
    expect(host.querySelector('[role="textbox"]')).toBeNull();
    expect(host.querySelectorAll('.nb-mindmap-node')).toHaveLength(3);
    expect(id === 'root' ? latestTree().text : latestTree().children[0].text).toBe('修改后的文字');

    // 按住同一次 Enter 的自动重复不能创建节点，松开后再次按下才执行新增。
    await pressKey(document.body, { repeat: true });
    expect(host.querySelectorAll('.nb-mindmap-node')).toHaveLength(3);
    await pressKey(document.body);
    expect(host.querySelectorAll('.nb-mindmap-node')).toHaveLength(4);
    expect(latestTree().children).toHaveLength(3);
    expect(host.querySelector('[role="textbox"]')).not.toBeNull();
    if (id === 'a') expect(latestTree().children.map((node) => node.text)).toEqual(['修改后的文字', '', '节点 B']);
  });

  it.each([{ ctrlKey: true }, { metaKey: true }])('保留 Ctrl / Cmd + Enter 确认：%j', async (modifiers) => {
    const editor = await editNode();
    await pressKey(editor, modifiers);
    expect(host.querySelector('[role="textbox"]')).toBeNull();
    expect(host.querySelectorAll('.nb-mindmap-node')).toHaveLength(3);
  });

  it.each(['insertParagraph', 'insertLineBreak'])('软键盘仅发送 %s 时也确认并选中节点', async (inputType) => {
    const editor = await editNode();
    const event = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType });
    await act(async () => {
      // 移动端上屏和确认可能紧邻发生，必须保存最新草稿。
      inputText(editor, '手机输入的文字');
      editor.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(latestTree().children[0].text).toBe('手机输入的文字');
    expect(host.querySelector('[role="textbox"]')).toBeNull();
    expect(host.querySelectorAll('.nb-mindmap-node')).toHaveLength(3);
    await pressKey(document.body);
    expect(latestTree().children).toHaveLength(3);
  });

  it('组字期间的 Enter 与软键盘换行意图只交给输入法上屏', async () => {
    const editor = await editNode();
    await act(async () => { editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
    expect((await pressKey(editor)).defaultPrevented).toBe(false);
    const event = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertParagraph' });
    await act(async () => { editor.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
    expect(host.querySelector('[role="textbox"]')).toBe(editor);
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => { editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); });
    await pressKey(editor);
    expect(host.querySelector('[role="textbox"]')).toBeNull();
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])('保留各端输入法确认键：%j', async (options) => {
    const editor = await editNode();
    expect((await pressKey(editor, options)).defaultPrevented).toBe(false);
    expect(host.querySelector('[role="textbox"]')).toBe(editor);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('软键盘通过 isComposing 标记组字时不提前退出', async () => {
    const editor = await editNode();
    const event = new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, inputType: 'insertLineBreak', isComposing: true,
    });
    await act(async () => { editor.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
    expect(host.querySelector('[role="textbox"]')).toBe(editor);
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([{ shiftKey: true }, { altKey: true }])('保留 Shift / Alt(Option) + Enter 节点内换行：%j', async (modifiers) => {
    const editor = await editNode();
    await pressKey(editor, modifiers);
    expect(editor.textContent).toBe('节点 A\n');
    expect(host.querySelector('[role="textbox"]')).toBe(editor);
    expect(onChange).not.toHaveBeenCalled();
    await pressKey(editor);
    expect(latestTree().children[0].text).toBe('节点 A');
    expect(host.querySelectorAll('.nb-mindmap-node')).toHaveLength(3);
  });

  it('保留编辑时 Tab 提交文字并新建子节点', async () => {
    const editor = await editNode();
    await act(async () => inputText(editor, '父节点文字'));
    await pressKey(editor, { key: 'Tab' });
    expect(latestTree().children[0].text).toBe('父节点文字');
    expect(latestTree().children[0].children).toHaveLength(1);
    expect(host.querySelector('[role="textbox"]')).not.toBeNull();
  });

  it('普通 beforeinput 文本输入仍由浏览器处理', async () => {
    const editor = await editNode();
    const event = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: '字' });
    await act(async () => { editor.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
    expect(host.querySelector('[role="textbox"]')).toBe(editor);
    expect(onChange).not.toHaveBeenCalled();
  });
});
