// NoteBoard 编辑器顶部操作栏与辅助工具单元测试

import { describe, it, expect, beforeEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { handleTransformCase } from '../../src/features/toolbar/textOps';
import {
  handleExpandJson,
  handleMinifyJson,
  handleValidateJson,
  handleFormatXml,
} from '../../src/features/editor-code/jsonOps';
import { useLayoutStore } from '../../src/stores/layoutStore';

// JSDOM 环境下补全 Range 测量接口以支持 CodeMirror 6
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

describe('顶部操作栏与工具单元测试 (Toolbar & Ops)', () => {
  describe('layoutStore 操作栏可见性状态', () => {
    beforeEach(() => {
      useLayoutStore.setState({ editorToolbarVisible: true, boardPresentationMode: false });
    });

    it('默认操作栏处于可见状态', () => {
      expect(useLayoutStore.getState().editorToolbarVisible).toBe(true);
    });

    it('toggleEditorToolbar 应正确切换可见状态', () => {
      useLayoutStore.getState().toggleEditorToolbar();
      expect(useLayoutStore.getState().editorToolbarVisible).toBe(false);

      useLayoutStore.getState().toggleEditorToolbar();
      expect(useLayoutStore.getState().editorToolbarVisible).toBe(true);
    });

    it('setEditorToolbarVisible 应精确设置状态', () => {
      useLayoutStore.getState().setEditorToolbarVisible(false);
      expect(useLayoutStore.getState().editorToolbarVisible).toBe(false);
    });

    it('toLayout 与 restoreFrom 应包含 editorToolbarVisible 持久化', () => {
      useLayoutStore.getState().setEditorToolbarVisible(false);
      const layout = useLayoutStore.getState().toLayout();
      expect(layout.editorToolbarVisible).toBe(false);

      useLayoutStore.getState().restoreFrom({
        explorerVisible: true,
        explorerWidth: 260,
        outlineVisible: true,
        outlineWidth: 200,
        editorToolbarVisible: true,
      });
      expect(useLayoutStore.getState().editorToolbarVisible).toBe(true);
    });

    it('画板全屏演示应为临时布局状态，不参与布局持久化', () => {
      useLayoutStore.getState().setBoardPresentationMode(true);
      expect(useLayoutStore.getState().boardPresentationMode).toBe(true);

      const layout = useLayoutStore.getState().toLayout();
      expect(layout).not.toHaveProperty('boardPresentationMode');

      useLayoutStore.getState().restoreFrom({
        explorerVisible: true,
        explorerWidth: 260,
        outlineVisible: true,
        outlineWidth: 200,
        editorToolbarVisible: true,
      });
      expect(useLayoutStore.getState().boardPresentationMode).toBe(false);
    });
  });

  describe('textOps 文本大小写转换', () => {
    it('选中文本转换为大写', () => {
      const state = EditorState.create({
        doc: 'hello world',
        selection: { anchor: 0, head: 5 },
      });
      const view = new EditorView({ state });

      const ok = handleTransformCase(view, 'upper');
      expect(ok).toBe(true);
      expect(view.state.doc.toString()).toBe('HELLO world');
      view.destroy();
    });

    it('选中文本转换为小写', () => {
      const state = EditorState.create({
        doc: 'HELLO WORLD',
        selection: { anchor: 0, head: 5 },
      });
      const view = new EditorView({ state });

      const ok = handleTransformCase(view, 'lower');
      expect(ok).toBe(true);
      expect(view.state.doc.toString()).toBe('hello WORLD');
      view.destroy();
    });

    it('选中文本转换为词首大写 (Title Case)', () => {
      const state = EditorState.create({
        doc: 'hello beautiful world',
        selection: { anchor: 0, head: 21 },
      });
      const view = new EditorView({ state });

      const ok = handleTransformCase(view, 'title');
      expect(ok).toBe(true);
      expect(view.state.doc.toString()).toBe('Hello Beautiful World');
      view.destroy();
    });

    it('无选区时转换当前整行', () => {
      const state = EditorState.create({
        doc: 'line one\nline two',
        selection: { anchor: 2, head: 2 },
      });
      const view = new EditorView({ state });

      const ok = handleTransformCase(view, 'upper');
      expect(ok).toBe(true);
      expect(view.state.doc.toString()).toBe('LINE ONE\nline two');
      view.destroy();
    });
  });

  describe('jsonOps 显式范围操作', () => {
    it('显式全文展开 (scope: all)', () => {
      const state = EditorState.create({
        doc: '{"a":1,"b":2}',
        selection: { anchor: 0, head: 0 },
      });
      const view = new EditorView({ state });

      const ok = handleExpandJson(view, { scope: 'all', tabSize: 2 });
      expect(ok).toBe(true);
      expect(view.state.doc.toString()).toBe('{\n  "a": 1,\n  "b": 2\n}\n');
      view.destroy();
    });

    it('显式全文压缩 (scope: all)', () => {
      const state = EditorState.create({
        doc: '{\n  "a": 1,\n  "b": 2\n}',
        selection: { anchor: 0, head: 0 },
      });
      const view = new EditorView({ state });

      const ok = handleMinifyJson(view, { scope: 'all' });
      expect(ok).toBe(true);
      expect(view.state.doc.toString()).toBe('{"a":1,"b":2}');
      view.destroy();
    });

    it('显式选区展开与校验 (scope: selection)', () => {
      const state = EditorState.create({
        doc: 'data: {"count":42} end',
        selection: { anchor: 6, head: 18 },
      });
      const view = new EditorView({ state });

      const valid = handleValidateJson(view, { scope: 'selection' });
      expect(valid).toBe(true);

      const ok = handleExpandJson(view, { scope: 'selection', tabSize: 2 });
      expect(ok).toBe(true);
      expect(view.state.doc.toString()).toBe('data: {\n  "count": 42\n} end');
      view.destroy();
    });

    it('无选区时请求 scope: selection 应返回 false 并提示', () => {
      const state = EditorState.create({
        doc: '{"count":42}',
        selection: { anchor: 0, head: 0 },
      });
      const view = new EditorView({ state });

      const ok = handleExpandJson(view, { scope: 'selection' });
      expect(ok).toBe(false);
      view.destroy();
    });

    it('XML 格式化操作 (handleFormatXml)', () => {
      const state = EditorState.create({
        doc: '<root><item id="1">text</item></root>',
        selection: { anchor: 0, head: 0 },
      });
      const view = new EditorView({ state });

      const ok = handleFormatXml(view, { scope: 'all' });
      expect(ok).toBe(true);
      expect(view.state.doc.toString()).toContain('<root>\n');
      view.destroy();
    });
  });

  describe('documentHistory 响应式可用状态', () => {
    it('新文档初始无撤销与重做历史，修改后应实时触发可撤销通知', async () => {
      const {
        initializeDocumentHistory,
        recordDocumentChange,
        getDocumentHistoryAvailability,
        subscribeDocumentHistory,
        clearDocumentHistory,
      } = await import('../../src/features/history/documentHistory');

      const testKey = 'test-doc-history';
      initializeDocumentHistory(testKey, 'initial text', 'code');

      let currentAvail = getDocumentHistoryAvailability(testKey);
      expect(currentAvail.canUndo).toBe(false);
      expect(currentAvail.canRedo).toBe(false);

      const received: { canUndo: boolean; canRedo: boolean }[] = [];
      const unsub = subscribeDocumentHistory((key, avail) => {
        if (key === testKey) received.push(avail);
      });

      // 产生一次编辑修改
      recordDocumentChange(testKey, 'modified text', {
        mode: 'code',
        startsNewGroup: true,
      });

      currentAvail = getDocumentHistoryAvailability(testKey);
      expect(currentAvail.canUndo).toBe(true);
      expect(currentAvail.canRedo).toBe(false);
      expect(received.length).toBeGreaterThan(0);
      expect(received[received.length - 1].canUndo).toBe(true);

      unsub();
      clearDocumentHistory(testKey);
    });
  });

  describe('slashSuggestion 斜杠命令与别名模糊搜索测试', () => {
    it('空 query 检索应返回完整命令池并包含超链接、日期时间与4x4表格', async () => {
      const { slashSuggestion } = await import('../../src/features/editor-md/slashCommand');
      const items = slashSuggestion.items({ query: '' });
      expect(items.length).toBeGreaterThan(15);
      const ids = items.map((i) => i.id);
      expect(ids).toContain('link');
      expect(ids).toContain('date');
      expect(ids).toContain('time');
      expect(ids).toContain('datetime');
      expect(ids).toContain('tableLarge');
    });

    it('输入 link、url、lj、超链接 应精准匹配超链接命令', async () => {
      const { slashSuggestion } = await import('../../src/features/editor-md/slashCommand');
      const byLink = slashSuggestion.items({ query: 'link' });
      expect(byLink.some((i) => i.id === 'link')).toBe(true);

      const byUrl = slashSuggestion.items({ query: 'url' });
      expect(byUrl.some((i) => i.id === 'link')).toBe(true);

      const byLj = slashSuggestion.items({ query: 'lj' });
      expect(byLj.some((i) => i.id === 'link')).toBe(true);

      const byChinese = slashSuggestion.items({ query: '超链接' });
      expect(byChinese[0].id).toBe('link');
    });

    it('输入 rq、riqi、date、time、datetime 应匹配日期时间命令', async () => {
      const { slashSuggestion } = await import('../../src/features/editor-md/slashCommand');
      const byDate = slashSuggestion.items({ query: 'date' });
      expect(byDate.some((i) => i.id === 'date')).toBe(true);

      const byRq = slashSuggestion.items({ query: 'rq' });
      expect(byRq.some((i) => i.id === 'date')).toBe(true);

      const byTime = slashSuggestion.items({ query: 'time' });
      expect(byTime.some((i) => i.id === 'time')).toBe(true);

      const byDateTime = slashSuggestion.items({ query: 'datetime' });
      expect(byDateTime.some((i) => i.id === 'datetime')).toBe(true);
    });

    it('输入 4x4 或 bg4 应匹配宽表格 4x4', async () => {
      const { slashSuggestion } = await import('../../src/features/editor-md/slashCommand');
      const by4x4 = slashSuggestion.items({ query: '4x4' });
      expect(by4x4.some((i) => i.id === 'tableLarge')).toBe(true);

      const byBg4 = slashSuggestion.items({ query: 'bg4' });
      expect(byBg4.some((i) => i.id === 'tableLarge')).toBe(true);
    });
  });
});
