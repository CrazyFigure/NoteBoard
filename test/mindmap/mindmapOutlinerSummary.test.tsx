// 大纲模式中的概要主题：作为一行显示在所概括内容之后，其子节点与普通要点一样可编辑、增删、升降级
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/components/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
import { OutlinerEditor } from '@/features/mindmap/OutlinerEditor';
import type { MindNode } from '@/features/mindmap/mindmapTypes';
import { findMindNode, findMindNodeParent } from '@/features/mindmap/mindmapTree';

/** 根 + a（含 a1）、b、c；概要覆盖 a..b，概要主题 st 下挂 t1（含 t11）、t2 */
const createTree = (): MindNode => ({
  id: 'root',
  text: '中心',
  isExpanded: true,
  summaries: [{
    id: 's1',
    startId: 'a',
    endId: 'b',
    topic: {
      id: 'st',
      text: '小结',
      isExpanded: true,
      children: [
        { id: 't1', text: '要点 1', isExpanded: true, children: [{ id: 't11', text: '细节', children: [] }] },
        { id: 't2', text: '要点 2', children: [] },
      ],
    },
  }],
  children: [
    { id: 'a', text: 'A', isExpanded: true, children: [{ id: 'a1', text: 'A1', children: [] }] },
    { id: 'b', text: 'B', children: [] },
    { id: 'c', text: 'C', children: [] },
  ],
});

describe('大纲模式编辑概要主题', () => {
  let host: HTMLDivElement;
  let root: Root;
  const onChange = vi.fn<(tree: MindNode) => void>();

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    onChange.mockClear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    function Harness() {
      const [tree, setTree] = useState(createTree);
      return <OutlinerEditor root={tree} onChange={(next) => { onChange(next); setTree(next); }} />;
    }
    await act(async () => root.render(<Harness />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  const titles = () => [...host.querySelectorAll<HTMLInputElement>('input.nb-outliner-title')].map((input) => input.value);
  const inputOf = (text: string) => [...host.querySelectorAll<HTMLInputElement>('input.nb-outliner-title')].find((input) => input.value === text)!;
  const rowOf = (text: string) => inputOf(text).closest('.nb-outliner-row') as HTMLElement;
  const press = async (input: HTMLInputElement, key: string, init: KeyboardEventInit = {}) => {
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })); });
  };
  /** 通过原生 setter 改值并派发 input，走 React 受控输入的真实路径 */
  const type = async (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const latest = () => onChange.mock.lastCall![0];
  /** 确认框 Portal 到 body，按文字找按钮 */
  const confirmButton = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find((b) => b.textContent?.trim() === label)!;
  const topicOf = (tree: MindNode) => tree.summaries![0].topic;

  it('概要主题排在所概括内容（含子树）之后，子节点逐层缩进显示', () => {
    expect(titles()).toEqual(['中心', 'A', 'A1', 'B', '小结', '要点 1', '细节', '要点 2', 'C']);
    expect(rowOf('小结').querySelector('.nb-outliner-summary-tag')?.textContent).toBe('概要 2 项');
    // 概要主题与被概括的 B 同级缩进，没有拖拽把手
    const indent = (text: string) => (rowOf(text).firstElementChild!.nextElementSibling ?? rowOf(text).firstElementChild) as HTMLElement;
    expect(indent('小结').style.paddingLeft).toBe(indent('B').style.paddingLeft);
    expect(rowOf('小结').querySelector('.nb-drag-handle')).toBeNull();
    expect(rowOf('要点 1').querySelector('.nb-drag-handle')).toBeTruthy();
  });

  it('可直接改写概要主题与其子节点的文字', async () => {
    await type(inputOf('小结'), '阶段小结');
    expect(topicOf(latest()).text).toBe('阶段小结');
    await type(inputOf('细节'), '更多细节');
    expect(findMindNode(latest(), 't11')?.text).toBe('更多细节');
  });

  it('概要主题上按 Enter 新增第一个子要点；子要点上按 Enter 新增同级', async () => {
    await press(inputOf('小结'), 'Enter');
    expect(topicOf(latest()).children.map((n) => n.text)).toEqual(['', '要点 1', '要点 2']);
    await press(inputOf('要点 1'), 'Enter');
    expect(topicOf(latest()).children.map((n) => n.text)).toEqual(['', '要点 1', '', '要点 2']);
    // 主树不受影响
    expect(latest().children.map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('概要子树内 Tab 降级、Shift+Tab 升级；概要主题的直接子要点不能再升级', async () => {
    await press(inputOf('要点 2'), 'Tab');
    expect(findMindNodeParent(latest(), 't2')?.parent.id).toBe('t1');
    await press(inputOf('细节'), 'Tab', { shiftKey: true });
    expect(topicOf(latest()).children.map((n) => n.id)).toEqual(['t1', 't11']);
    const before = latest();
    await press(inputOf('要点 1'), 'Tab', { shiftKey: true });
    expect(latest()).toBe(before);
    // 概要主题本身 Tab / Shift+Tab 不移动
    await press(inputOf('小结'), 'Tab');
    await press(inputOf('小结'), 'Tab', { shiftKey: true });
    expect(latest()).toBe(before);
  });

  it('空白子要点按 Backspace 删除；空白且无子要点的概要主题按 Backspace 删除概要', async () => {
    await type(inputOf('要点 2'), '');
    await press(host.querySelectorAll<HTMLInputElement>('input.nb-outliner-title')[7], 'Backspace');
    expect(topicOf(latest()).children.map((n) => n.id)).toEqual(['t1']);
    // 有子要点时 Backspace 不删除概要
    await type(inputOf('小结'), '');
    const topicInput = host.querySelectorAll<HTMLInputElement>('input.nb-outliner-title')[4];
    await press(topicInput, 'Backspace');
    expect(latest().summaries).toHaveLength(1);
  });

  it('删除按钮移除整个概要；折叠概要主题时隐藏其子要点', async () => {
    await act(async () => { (rowOf('小结').querySelector('button[aria-label="收起"], button svg.lucide-chevron-down')?.closest('button') as HTMLButtonElement).click(); });
    expect(titles()).toEqual(['中心', 'A', 'A1', 'B', '小结', 'C']);
    await act(async () => { (rowOf('小结').querySelector('button[aria-label="删除此概要"]') as HTMLButtonElement).click(); });
    // 概要下还有子要点，先二次确认
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('3 个子要点');
    await act(async () => { confirmButton('删除').click(); });
    expect(latest().summaries).toBeUndefined();
    expect(titles()).toEqual(['中心', 'A', 'A1', 'B', 'C']);
  });

  it('删除按钮可删除有文字的要点；无子要点直接删除，有子要点先确认，取消则不变', async () => {
    const deleteButtonOf = (text: string) => rowOf(text).querySelector('button[aria-label="删除此要点及子要点"]') as HTMLButtonElement;
    await act(async () => { deleteButtonOf('C').click(); });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(latest().children.map((n) => n.id)).toEqual(['a', 'b']);

    onChange.mockClear();
    await act(async () => { deleteButtonOf('A').click(); });
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('1 个子要点');
    await act(async () => { confirmButton('取消').click(); });
    expect(onChange).not.toHaveBeenCalled();
    expect(titles()).toContain('A1');

    await act(async () => { deleteButtonOf('A').click(); });
    await act(async () => { confirmButton('删除').click(); });
    expect(latest().children.map((n) => n.id)).toEqual(['b']);
    // 概要的一端仍在，概要保留
    expect(latest().summaries).toHaveLength(1);

    // 概要覆盖的节点全部删除后，概要随之清理
    await act(async () => { deleteButtonOf('B').click(); });
    expect(latest().children).toEqual([]);
    expect(latest().summaries).toBeUndefined();
  });

  it('概要子树内的要点也可用删除按钮删除', async () => {
    await act(async () => { (rowOf('要点 2').querySelector('button[aria-label="删除此要点及子要点"]') as HTMLButtonElement).click(); });
    expect(topicOf(latest()).children.map((n) => n.id)).toEqual(['t1']);
  });
});
