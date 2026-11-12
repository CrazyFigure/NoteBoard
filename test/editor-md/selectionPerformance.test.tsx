// 大选区性能：React 提交不再遍历编辑器正文追踪选区；切走标签时释放编辑器内的原生选区

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import {
  bypassReactSelectionTracking,
  ReactSelectionTrackingBypass,
  releaseNativeSelectionWithin,
} from '../../src/features/editor-md/selectionPerformance';

/**
 * jsdom 未实现 contentEditable 属性：按浏览器语义在原型上补一个访问器
 * （读取 contenteditable 属性映射为 "true" / "false" / "plaintext-only" / "inherit"）。
 */
function installContentEditablePolyfill(): () => void {
  const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'contentEditable');
  Object.defineProperty(HTMLElement.prototype, 'contentEditable', {
    configurable: true,
    get(this: HTMLElement) {
      const value = this.getAttribute('contenteditable');
      if (value === '' || value?.toLowerCase() === 'true') return 'true';
      if (value?.toLowerCase() === 'false') return 'false';
      if (value?.toLowerCase() === 'plaintext-only') return 'plaintext-only';
      return 'inherit';
    },
    set(this: HTMLElement, value: string) {
      if (value === 'inherit') this.removeAttribute('contenteditable');
      else this.setAttribute('contenteditable', value);
    },
  });
  return () => {
    if (previous) Object.defineProperty(HTMLElement.prototype, 'contentEditable', previous);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).contentEditable;
  };
}

let restorePolyfill: () => void = () => {};
beforeAll(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  restorePolyfill = installContentEditablePolyfill();
});
afterAll(() => restorePolyfill());

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('bypassReactSelectionTracking', () => {
  it('可编辑时读取值不再是 "true"，赋值仍切换 contenteditable 属性，撤销后恢复原生行为', () => {
    const element = document.createElement('div');
    element.setAttribute('contenteditable', 'true');
    const restore = bypassReactSelectionTracking(element);

    expect(element.contentEditable).not.toBe('true');
    expect(element.getAttribute('contenteditable')).toBe('true');

    element.contentEditable = 'false';
    expect(element.getAttribute('contenteditable')).toBe('false');
    expect(element.contentEditable).toBe('false');

    element.contentEditable = 'true';
    expect(element.getAttribute('contenteditable')).toBe('true');

    restore();
    expect(element.contentEditable).toBe('true');
  });

  it('只影响目标元素实例，不改动其它可编辑元素', () => {
    const target = document.createElement('div');
    const other = document.createElement('div');
    target.setAttribute('contenteditable', 'true');
    other.setAttribute('contenteditable', 'true');
    bypassReactSelectionTracking(target);
    expect(other.contentEditable).toBe('true');
  });
});

describe('ReactSelectionTrackingBypass 扩展', () => {
  /** 挂载一个编辑器并让其获得焦点（完整扩展集依赖布局信息，jsdom 中只挂载基础节点与本扩展） */
  function mountFocusedEditor(): Editor {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const content = Array.from({ length: 50 }, (_, index) => `<p>第 ${index + 1} 段正文</p>`).join('');
    const editor = new Editor({ element: host, extensions: [StarterKit, ReactSelectionTrackingBypass], content });
    // jsdom 只允许带 tabindex 的元素获得焦点；浏览器中 contenteditable 本身即可聚焦
    editor.view.dom.tabIndex = 0;
    editor.view.dom.focus();
    return editor;
  }

  /** 在独立的 React 根上做一次提交，返回提交期间 getSelection 被调用的次数 */
  function countSelectionReadsDuringCommit(): number {
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root!: Root;
    act(() => {
      root = createRoot(container);
      root.render(<span>初始</span>);
    });
    const spy = vi.spyOn(window, 'getSelection');
    act(() => root.render(<span>更新</span>));
    const calls = spy.mock.calls.length;
    spy.mockRestore();
    act(() => root.unmount());
    return calls;
  }

  it('Markdown 可视化编辑器的扩展装配中已注册', () => {
    expect(buildExtensions('selection-performance-test').some((extension) => extension.name === ReactSelectionTrackingBypass.name)).toBe(true);
  });

  it('编辑器获得焦点时，任意 React 提交都不再读取选区计算字符偏移', () => {
    const editor = mountFocusedEditor();
    expect(document.activeElement).toBe(editor.view.dom);
    expect(editor.view.dom.getAttribute('contenteditable')).toBe('true');
    expect(countSelectionReadsDuringCommit()).toBe(0);
    editor.destroy();
  });

  it('对照：未接管的可编辑根节点获得焦点时 React 每次提交都会读取选区', () => {
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    editable.tabIndex = 0;
    editable.textContent = '正文';
    document.body.appendChild(editable);
    editable.focus();
    expect(countSelectionReadsDuringCommit()).toBeGreaterThan(0);
  });

  it('编辑器销毁后根节点恢复原生 contentEditable', () => {
    const editor = mountFocusedEditor();
    const dom = editor.view.dom;
    expect(dom.contentEditable).not.toBe('true');
    editor.destroy();
    expect(Object.prototype.hasOwnProperty.call(dom, 'contentEditable')).toBe(false);
  });
});

describe('releaseNativeSelectionWithin', () => {
  /** 构造编辑器容器与外部节点，并在给定范围内设置原生选区 */
  function setup() {
    const editorRoot = document.createElement('div');
    editorRoot.innerHTML = '<p>第一段</p><p>第二段</p>';
    const outside = document.createElement('p');
    outside.textContent = '外部内容';
    document.body.append(editorRoot, outside);
    const select = (startNode: Node, startOffset: number, endNode: Node, endOffset: number) => {
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      selection.addRange(range);
    };
    return { editorRoot, outside, select };
  }

  it('清除落在编辑器内的非折叠选区', () => {
    const { editorRoot, select } = setup();
    const [first, second] = Array.from(editorRoot.querySelectorAll('p'));
    select(first.firstChild!, 0, second.firstChild!, 2);
    expect(releaseNativeSelectionWithin(editorRoot)).toBe(true);
    expect(document.getSelection()!.rangeCount).toBe(0);
  });

  it('选区只有一端在编辑器内同样清除', () => {
    const { editorRoot, outside, select } = setup();
    select(editorRoot.querySelector('p')!.firstChild!, 1, outside.firstChild!, 2);
    expect(releaseNativeSelectionWithin(editorRoot)).toBe(true);
    expect(document.getSelection()!.rangeCount).toBe(0);
  });

  it('选区在编辑器外或只是光标时保持不变', () => {
    const { editorRoot, outside, select } = setup();
    select(outside.firstChild!, 0, outside.firstChild!, 2);
    expect(releaseNativeSelectionWithin(editorRoot)).toBe(false);
    expect(document.getSelection()!.rangeCount).toBe(1);

    const text = editorRoot.querySelector('p')!.firstChild!;
    select(text, 1, text, 1);
    expect(releaseNativeSelectionWithin(editorRoot)).toBe(false);
    expect(document.getSelection()!.rangeCount).toBe(1);
  });
});
