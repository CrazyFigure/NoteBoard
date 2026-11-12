// NoteBoard 编辑区内目录测试
// 验证按设置挂载、侧边留白随展开 / 收起与左右切换变化、卸载时撤销留白，以及右侧栏隐藏「文档大纲」页签

import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/Tooltip';
import { InlineOutline } from '@/features/outline/InlineOutline';
import { OutlinePanel } from '@/features/outline/OutlinePanel';
import { DEFAULT_SETTINGS, useSettingsStore } from '@/stores/settingsStore';
import { useLayoutStore } from '@/stores/layoutStore';

function setOutlineSettings(outlinePosition: 'sidebar' | 'inline', outlineInlineSide: 'left' | 'right' = 'left') {
  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS, editor: { ...DEFAULT_SETTINGS.editor, outlinePosition, outlineInlineSide } },
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  useLayoutStore.setState({ compactMode: false });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setOutlineSettings('sidebar');
});

/** 模拟编辑器根节点：目录挂在它内部，留白加在它上面（首次挂载即生效，不依赖父组件 ref） */
function renderInline() {
  const hostRef = createRef<HTMLDivElement>();
  function Host() {
    return (
      <TooltipProvider>
        <div ref={hostRef}>
          <InlineOutline editor={null} docKey="C:\\notes\\a.md" active reading={false} />
        </div>
      </TooltipProvider>
    );
  }
  act(() => root.render(<Host />));
  return hostRef;
}

describe('InlineOutline', () => {
  it('大纲位置为右侧栏时不渲染、不加留白', () => {
    setOutlineSettings('sidebar');
    const hostRef = renderInline();
    expect(container.querySelector('.nb-inline-outline')).toBeNull();
    expect(hostRef.current!.style.paddingLeft).toBe('');
  });

  it('编辑区内默认展开，点击开关收起并记住状态', () => {
    setOutlineSettings('inline');
    const hostRef = renderInline();
    const panel = container.querySelector('.nb-inline-outline')!;
    expect(panel.getAttribute('data-expanded')).toBe('true');
    expect(hostRef.current!.style.paddingLeft).toBe('240px');
    expect(container.textContent).toContain('暂无标题');

    const toggle = container.querySelector<HTMLButtonElement>('.nb-inline-outline-toggle')!;
    expect(toggle.getAttribute('aria-label')).toBe('收起目录');
    act(() => toggle.click());

    expect(panel.getAttribute('data-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('展开目录');
    expect(hostRef.current!.style.paddingLeft).toBe('48px');
    // 收起后列表不可聚焦、不响应指针
    expect(container.querySelector('.nb-inline-outline-list')!.hasAttribute('inert')).toBe(true);
    expect(localStorage.getItem('nb.inlineOutline.expanded')).toBe('0');
  });

  it('切到右侧时留白换边，关闭设置后撤销留白', () => {
    setOutlineSettings('inline', 'left');
    const hostRef = renderInline();
    act(() => setOutlineSettings('inline', 'right'));
    expect(container.querySelector('.nb-inline-outline')!.getAttribute('data-side')).toBe('right');
    expect(hostRef.current!.style.paddingRight).toBe('240px');
    expect(hostRef.current!.style.paddingLeft).toBe('');

    act(() => setOutlineSettings('sidebar'));
    expect(container.querySelector('.nb-inline-outline')).toBeNull();
    expect(hostRef.current!.style.paddingRight).toBe('');
  });

  it('极窄模式下不显示目录', () => {
    setOutlineSettings('inline');
    useLayoutStore.setState({ compactMode: true });
    const hostRef = renderInline();
    expect(container.querySelector('.nb-inline-outline')).toBeNull();
    expect(hostRef.current!.style.paddingLeft).toBe('');
  });
});

describe('OutlinePanel 与大纲位置', () => {
  const tabLabels = () => Array.from(container.querySelectorAll('.nb-outline-tab')).map((tab) => tab.textContent);

  it('右侧栏模式保留「文档大纲」页签', () => {
    setOutlineSettings('sidebar');
    act(() => root.render(<OutlinePanel editor={null} docKey={null} />));
    expect(tabLabels()).toEqual(['文档大纲', '反向链接', '关系图谱']);
  });

  it('编辑区内模式只保留反向链接与关系图谱，并默认选中反向链接', () => {
    setOutlineSettings('inline');
    act(() => root.render(<OutlinePanel editor={null} docKey={null} />));
    expect(tabLabels()).toEqual(['反向链接', '关系图谱']);
    expect(container.querySelector('.nb-outline-tab.is-active')?.textContent).toBe('反向链接');
  });
});
