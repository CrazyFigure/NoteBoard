// NoteBoard Markdown 内嵌思维导图测试
// 覆盖：围栏解析与序列化、仅导图模式界面、布局/配色持久化、外部同步、全屏编辑、只读守卫、
// 内嵌键盘聚焦隔离、内联纵向滚轮放行、纯文本剪贴板、多维表格占位、工具栏可视化/源码插入。

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Editor } from '@tiptap/core';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/components/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { buildExtensions } from '../../src/features/editor-md/extensions';
import { parseMarkdown, serializeMarkdown } from '../../src/features/editor-md/serialize';
import { createDefaultMindmapCode } from '../../src/features/editor-md/mindmapBlockDefault';
import MdMindmapCanvas from '../../src/features/editor-md/MdMindmapCanvas';
import { MindmapRenderer } from '../../src/features/mindmap/MindmapRenderer';
import { getMindmapTheme } from '../../src/features/mindmap/mindmapTheme';
import type { MindNode } from '../../src/features/mindmap/mindmapTypes';
import { serializeSelectionPlainText } from '../../src/features/editor-md/plainTextClipboard';
import { renderBitableMarkdown } from '../../src/features/bitable/BitableMarkdown';
import { MarkdownToolbar } from '../../src/features/toolbar/MarkdownToolbar';
import { registerMdSourceView, unregisterMdSourceView } from '../../src/features/editor-md/editorInstances';

if (typeof Range !== 'undefined') {
  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  }
  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON: () => {},
      }) as DOMRect;
  }
}

const SAMPLE_TREE: MindNode = {
  id: 'root',
  text: '项目规划',
  isExpanded: true,
  children: [
    { id: 'n1', text: '需求分析', isExpanded: true, children: [] },
    { id: 'n2', text: '架构设计', isExpanded: true, children: [] },
  ],
};

function stubBrowserEnv() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(420);
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(
    () => [{ width: 800, height: 420 } as DOMRect] as unknown as DOMRectList,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
}

describe('Markdown 内嵌思维导图', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    stubBrowserEnv();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('JSON 与 Markdown 大纲两种 ```mindmap 围栏均往返解析且原文保留', () => {
    const editor = new Editor({ element: null, extensions: buildExtensions('mindmap-roundtrip'), content: '' });
    try {
      const jsonCode = createDefaultMindmapCode('中心主题');
      const jsonDoc = `# 导图测试\n\n\`\`\`mindmap\n${jsonCode}\n\`\`\`\n\n结束`;
      expect(parseMarkdown(editor, jsonDoc)).toBe(true);
      expect(editor.getJSON().content?.some((n) => n.type === 'mindmapBlock')).toBe(true);
      expect(serializeMarkdown(editor)).toBe(jsonDoc);

      const outlineDoc = '```mindmap\n# 中心主题\n\n- 分支 A\n- 分支 B\n```';
      expect(parseMarkdown(editor, outlineDoc)).toBe(true);
      expect(editor.getJSON().content?.some((n) => n.type === 'mindmapBlock')).toBe(true);
      expect(serializeMarkdown(editor)).toBe(outlineDoc);
    } finally {
      editor.destroy();
    }
  });

  it('MdMindmapCanvas 仅显示导图模式（无大纲模式按钮），切换布局/配色实时回写 code', async () => {
    const editor = new Editor({ element: null, extensions: buildExtensions('mindmap-canvas'), content: '' });
    const onChangeCode = vi.fn();
    const initialCode = createDefaultMindmapCode('初始主题');

    try {
      await act(async () => {
        root.render(
          <MdMindmapCanvas
            code={initialCode}
            docKey=""
            editor={editor}
            readOnly={false}
            onChangeCode={onChangeCode}
          />,
        );
      });

      expect(host.textContent).toContain('思维导图');
      expect(host.textContent).not.toContain('大纲模式');
      expect(host.textContent).toContain('初始主题');

      // 打开布局菜单并切换到「向下组织图」
      const layoutTrigger = Array.from(host.querySelectorAll('.nb-mindmap-style-trigger'))[0] as HTMLElement;
      await act(async () => layoutTrigger.click());
      const treeCard = Array.from(host.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('向下组织图'),
      ) as HTMLButtonElement;
      expect(treeCard).toBeDefined();
      await act(async () => treeCard.click());

      expect(onChangeCode).toHaveBeenCalledTimes(1);
      const savedAfterLayout = JSON.parse(onChangeCode.mock.calls[0][0]) as { layout?: string; theme?: string };
      expect(savedAfterLayout.layout).toBe('tree');

      // 打开配色菜单并切换到「深海」
      const themeTrigger = Array.from(host.querySelectorAll('.nb-mindmap-style-trigger'))[1] as HTMLElement;
      await act(async () => themeTrigger.click());
      const oceanItem = Array.from(host.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('深海'),
      ) as HTMLButtonElement;
      expect(oceanItem).toBeDefined();
      await act(async () => oceanItem.click());

      expect(onChangeCode).toHaveBeenCalledTimes(2);
      const savedAfterTheme = JSON.parse(onChangeCode.mock.calls[1][0]) as { layout?: string; theme?: string };
      expect(savedAfterTheme.layout).toBe('tree');
      expect(savedAfterTheme.theme).toBe('ocean');
    } finally {
      editor.destroy();
    }
  });

  it('外部 code 变更（撤销/重做）同步更新树与外观', async () => {
    const editor = new Editor({ element: null, extensions: buildExtensions('mindmap-sync'), content: '' });
    const firstCode = createDefaultMindmapCode('版本一');
    const secondCode = JSON.stringify({
      version: 1,
      root: { id: 'root', text: '版本二', isExpanded: true, children: [] },
      layout: 'balanced',
      theme: 'forest',
    });

    try {
      await act(async () => {
        root.render(
          <MdMindmapCanvas
            code={firstCode}
            docKey=""
            editor={editor}
            readOnly={false}
            onChangeCode={() => {}}
          />,
        );
      });
      expect(host.textContent).toContain('版本一');

      await act(async () => {
        root.render(
          <MdMindmapCanvas
            code={secondCode}
            docKey=""
            editor={editor}
            readOnly={false}
            onChangeCode={() => {}}
          />,
        );
      });
      expect(host.textContent).toContain('版本二');
    } finally {
      editor.destroy();
    }
  });

  it('全屏编辑通过 Portal 渲染唯一活跃画布并支持 Esc 退出', async () => {
    const editor = new Editor({ element: null, extensions: buildExtensions('mindmap-fs'), content: '' });
    const code = createDefaultMindmapCode('全屏主题');

    try {
      await act(async () => {
        root.render(
          <MdMindmapCanvas
            code={code}
            docKey=""
            editor={editor}
            readOnly={false}
            onChangeCode={() => {}}
          />,
        );
      });

      const fsBtn = host.querySelector<HTMLButtonElement>('button[aria-label="全屏编辑"]')!;
      await act(async () => fsBtn.click());

      const fsLayer = document.body.querySelector('.nb-md-mindmap-fullscreen');
      expect(fsLayer).not.toBeNull();
      expect(host.textContent).toContain('正在全屏编辑思维导图');
      // 全局同时只有唯一一个活跃导图渲染图层
      expect(document.body.querySelectorAll('.nb-mindmap-transform')).toHaveLength(1);

      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      });
      expect(document.body.querySelector('.nb-md-mindmap-fullscreen')).toBeNull();
      expect(host.querySelectorAll('.nb-mindmap-transform')).toHaveLength(1);
    } finally {
      editor.destroy();
    }
  });

  it('只读模式下隐藏编辑类控件并阻止双击或键盘修改', async () => {
    const editor = new Editor({ element: null, extensions: buildExtensions('mindmap-ro'), content: '' });
    const onChangeCode = vi.fn();
    const code = createDefaultMindmapCode('只读主题');

    try {
      await act(async () => {
        root.render(
          <MdMindmapCanvas
            code={code}
            docKey=""
            editor={editor}
            readOnly={true}
            onChangeCode={onChangeCode}
          />,
        );
      });

      expect(host.querySelector('button[aria-label="撤销"]')).toBeNull();
      expect(host.querySelector('.nb-md-mindmap-resize-handle')).toBeNull();
      expect(host.querySelector('.nb-mindmap-node-toolbar')).toBeNull();
      expect(host.querySelector('.nb-node-add-btn')).toBeNull();
      expect(host.textContent).not.toContain('概要');

      // 选中节点后按 Tab / Delete / 双击均不得触发修改
      const branch = Array.from(host.querySelectorAll<HTMLElement>('.nb-mindmap-node')).find((el) =>
        el.textContent?.includes('主要分支 1'),
      )!;
      await act(async () => branch.click());
      await act(async () => {
        branch.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
      });
      expect(host.querySelector('.nb-mindmap-title-editor')).toBeNull();
      expect(onChangeCode).not.toHaveBeenCalled();
    } finally {
      editor.destroy();
    }
  });

  it('embedded 模式：仅焦点所在导图响应快捷键，普通纵向滚轮放行页面滚动', async () => {
    const theme = getMindmapTheme('classic');
    const onChangeA = vi.fn();
    const onChangeB = vi.fn();
    const externalInput = document.createElement('div');
    externalInput.tabIndex = 0;
    document.body.appendChild(externalInput);

    try {
      await act(async () => {
        root.render(
          <div>
            <div data-testid="block-a" style={{ width: 800, height: 320 }}>
              <MindmapRenderer
                root={SAMPLE_TREE}
                onChange={onChangeA}
                zoom={1}
                onZoomChange={() => {}}
                layout="right"
                theme={theme}
                edgeStyle={theme.edgeStyle}
                maxNodeWidth={300}
                defaultTextAlign="left"
                defaultImageFit="original"
                embedded={true}
              />
            </div>
            <div data-testid="block-b" style={{ width: 800, height: 320 }}>
              <MindmapRenderer
                root={SAMPLE_TREE}
                onChange={onChangeB}
                zoom={1}
                onZoomChange={() => {}}
                layout="right"
                theme={theme}
                edgeStyle={theme.edgeStyle}
                maxNodeWidth={300}
                defaultTextAlign="left"
                defaultImageFit="original"
                embedded={true}
              />
            </div>
          </div>,
        );
      });

      const blockA = host.querySelector('[data-testid="block-a"]')!;
      const blockB = host.querySelector('[data-testid="block-b"]')!;
      const nodeInA = blockA.querySelector<HTMLElement>('[data-node-id="n1"]')!;
      const nodeInB = blockB.querySelector<HTMLElement>('[data-node-id="n1"]')!;

      // 点击选中块 A 和块 B 的节点，但随后把焦点移出到外部输入区
      await act(async () => nodeInB.click());
      await act(async () => nodeInA.click());
      await act(async () => externalInput.focus());

      const outsideTab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      await act(async () => window.dispatchEvent(outsideTab));
      expect(onChangeA).not.toHaveBeenCalled();
      expect(onChangeB).not.toHaveBeenCalled();

      // 把焦点切回块 A 内部再按 Tab：只有块 A 响应新增节点
      await act(async () => nodeInA.click());
      const insideTab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      await act(async () => window.dispatchEvent(insideTab));
      expect(onChangeA).toHaveBeenCalledTimes(1);
      expect(onChangeB).not.toHaveBeenCalled();

      // 滚轮测试：普通纵向滚轮不调用 preventDefault()，Ctrl+滚轮调用 preventDefault()
      const canvasA = blockA.firstElementChild as HTMLElement;
      const normalWheel = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
      canvasA.dispatchEvent(normalWheel);
      expect(normalWheel.defaultPrevented).toBe(false);

      const zoomWheel = new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true });
      canvasA.dispatchEvent(zoomWheel);
      expect(zoomWheel.defaultPrevented).toBe(true);
    } finally {
      externalInput.remove();
    }
  });

  it('纯文本复制与多维表格占位均正确处理 mindmapBlock / mindmap 围栏', () => {
    const editor = new Editor({ element: null, extensions: buildExtensions('mindmap-clip'), content: '' });
    try {
      const jsonCode = JSON.stringify({ version: 1, root: SAMPLE_TREE });
      editor.commands.setContent({
        type: 'doc',
        content: [{ type: 'mindmapBlock', attrs: { code: jsonCode } }],
      });
      editor.commands.selectAll();
      expect(serializeSelectionPlainText(editor)).toBe('项目规划\n  需求分析\n  架构设计');

      editor.commands.setContent({
        type: 'doc',
        content: [{ type: 'mindmapBlock', attrs: { code: '# 自定义大纲\n- 子项' } }],
      });
      editor.commands.selectAll();
      expect(serializeSelectionPlainText(editor)).toBe('# 自定义大纲\n- 子项');
    } finally {
      editor.destroy();
    }

    const html = renderBitableMarkdown('```mindmap\n# 中心主题\n```');
    expect(html).toContain('思维导图');
  });

  it('MarkdownToolbar 在可视化与源码模式下均可插入思维导图', async () => {
    const clickInsertMindmap = async () => {
      const insertBtn = Array.from(host.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('插入'),
      )!;
      expect(insertBtn).toBeDefined();
      await act(async () => insertBtn.click());
      const mathEntry = Array.from(host.querySelectorAll<HTMLElement>('.nb-toolbar-dropdown-item')).find((el) =>
        el.textContent?.includes('公式与图表'),
      )!;
      expect(mathEntry).toBeDefined();
      await act(async () => mathEntry.click());
      const mindmapEntry = Array.from(host.querySelectorAll<HTMLElement>('.nb-toolbar-dropdown-item')).find(
        (el) => el.textContent?.trim() === '思维导图',
      )!;
      expect(mindmapEntry).toBeDefined();
      await act(async () => mindmapEntry.click());
    };

    // 1. 可视化模式插入
    const editor = new Editor({ element: null, extensions: buildExtensions('mindmap-tb-v'), content: '<p></p>' });
    try {
      await act(async () => {
        root.render(<MarkdownToolbar docKey="mindmap-tb-v" editor={editor} viewMode="visual" />);
      });
      await clickInsertMindmap();
      expect(editor.getJSON().content?.some((n) => n.type === 'mindmapBlock')).toBe(true);
    } finally {
      editor.destroy();
    }

    // 2. 源码模式插入 ```mindmap 围栏
    const sourceKey = 'mindmap-tb-s';
    const view = new EditorView({ state: EditorState.create({ doc: '' }) });
    registerMdSourceView(sourceKey, view);
    try {
      await act(async () => {
        root.render(<MarkdownToolbar docKey={sourceKey} editor={null} viewMode="source" />);
      });
      await clickInsertMindmap();
      expect(view.state.doc.toString()).toContain('```mindmap\n');
    } finally {
      unregisterMdSourceView(sourceKey);
      view.destroy();
    }
  });
});
