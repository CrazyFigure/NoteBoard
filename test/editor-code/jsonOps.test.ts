// NoteBoard JSON 核心操作单元测试
// 覆盖校验、压缩、展开纯函数及 CodeMirror 6 选区/全文 Action
// 详见 docs/09-开发路线图.md gate:4

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  validateJsonText,
  minifyJsonText,
  expandJsonText,
  extractJsonErrorPosition,
  handleValidateJson,
  handleMinifyJson,
  handleExpandJson,
} from '../../src/features/editor-code/jsonOps';
import { useToastStore } from '../../src/stores/toastStore';

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

describe('JSON 纯函数测试 (jsonOps)', () => {
  describe('validateJsonText', () => {
    it('合法对象校验应通过', () => {
      const res = validateJsonText('{"name": "NoteBoard", "version": 1}');
      expect(res.valid).toBe(true);
      expect(res.error).toBeUndefined();
    });

    it('合法数组校验应通过', () => {
      const res = validateJsonText('[1, 2, "3", true, null]');
      expect(res.valid).toBe(true);
    });

    it('合法基本类型校验应通过', () => {
      expect(validateJsonText('"hello world"').valid).toBe(true);
      expect(validateJsonText('12345').valid).toBe(true);
      expect(validateJsonText('true').valid).toBe(true);
      expect(validateJsonText('null').valid).toBe(true);
    });

    it('非法 JSON 校验应返回错误及位置', () => {
      const res = validateJsonText('{invalid: 123}');
      expect(res.valid).toBe(false);
      expect(res.error).toBeDefined();
      expect(typeof res.errorPos).toBe('number');
    });

    it('空字符串应返回错误', () => {
      const res = validateJsonText('   ');
      expect(res.valid).toBe(false);
      expect(res.error).toContain('为空');
    });
  });

  describe('minifyJsonText', () => {
    it('应将多行格式化 JSON 压缩为单行紧凑字符串', () => {
      const input = `
      {
        "name": "NoteBoard",
        "features": [
          "markdown",
          "board",
          "code"
        ]
      }
      `;
      const result = minifyJsonText(input);
      expect(result).toBe('{"name":"NoteBoard","features":["markdown","board","code"]}');
      expect(result.includes('\n')).toBe(false);
    });

    it('无效 JSON 压缩应抛出异常', () => {
      expect(() => minifyJsonText('{"incomplete":')).toThrow();
    });
  });

  describe('expandJsonText', () => {
    it('应将单行 JSON 展开为带缩进的多行格式', () => {
      const input = '{"name":"NoteBoard","active":true}';
      const result = expandJsonText(input, 2);
      expect(result).toBe('{\n  "name": "NoteBoard",\n  "active": true\n}');
    });

    it('支持自定义缩进空格数量', () => {
      const input = '{"tab":4}';
      const result = expandJsonText(input, 4);
      expect(result).toBe('{\n    "tab": 4\n}');
    });

    it('无效 JSON 展开应抛出异常', () => {
      expect(() => expandJsonText('not a json')).toThrow();
    });
  });

  describe('extractJsonErrorPosition', () => {
    it('能从 position 错误信息中提取位置', () => {
      const msg = 'Unexpected token x in JSON at position 15';
      const pos = extractJsonErrorPosition(msg, '01234567890123456789');
      expect(pos).toBe(15);
    });

    it('能从 line/column 错误信息中提取位置', () => {
      const msg = 'Expected double-quoted property name at line 2 column 5';
      const text = '{\n    badKey: 1\n}';
      const pos = extractJsonErrorPosition(msg, text);
      expect(pos).toBeGreaterThan(0);
    });
  });
});

describe('EditorView Action 选区与全文交互测试', () => {
  let createdViews: EditorView[] = [];

  beforeEach(() => {
    // 清空 toast
    useToastStore.setState({ toasts: [] });
    createdViews = [];
  });

  afterEach(() => {
    for (const v of createdViews) {
      v.destroy();
    }
  });

  it('无选区时 handleMinifyJson 对全文进行压缩', () => {
    const originalDoc = '{\n  "key": "value"\n}';
    const state = EditorState.create({ doc: originalDoc });
    const view = new EditorView({ state });
    createdViews.push(view);

    const ok = handleMinifyJson(view);
    expect(ok).toBe(true);
    expect(view.state.doc.toString()).toBe('{"key":"value"}');

    const toasts = useToastStore.getState().toasts;
    expect(toasts.some((t) => t.message.includes('压缩成功'))).toBe(true);
  });

  it('无选区时 handleExpandJson 对全文进行展开', () => {
    const originalDoc = '{"key":"value"}';
    const state = EditorState.create({ doc: originalDoc });
    const view = new EditorView({ state });
    createdViews.push(view);

    const ok = handleExpandJson(view);
    expect(ok).toBe(true);
    expect(view.state.doc.toString()).toContain('  "key": "value"');

    const toasts = useToastStore.getState().toasts;
    expect(toasts.some((t) => t.message.includes('展开成功'))).toBe(true);
  });

  it('有选区时 handleMinifyJson 仅压缩选中的 JSON 片段，保留周围文本', () => {
    // 模拟 txt 文件中包含的一段 JSON
    const textBefore = '前置纯文本日志: ';
    const jsonSnippet = '{\n  "status": 200,\n  "msg": "ok"\n}';
    const textAfter = ' 后续说明文本';
    const fullText = textBefore + jsonSnippet + textAfter;

    const from = textBefore.length;
    const to = textBefore.length + jsonSnippet.length;

    const state = EditorState.create({
      doc: fullText,
      selection: { anchor: from, head: to },
    });
    const view = new EditorView({ state });
    createdViews.push(view);

    const ok = handleMinifyJson(view);
    expect(ok).toBe(true);

    const newDoc = view.state.doc.toString();
    expect(newDoc).toBe('前置纯文本日志: {"status":200,"msg":"ok"} 后续说明文本');
    // 验证新选区范围
    expect(view.state.selection.main.from).toBe(from);
    expect(view.state.selection.main.to).toBe(from + '{"status":200,"msg":"ok"}'.length);
  });

  it('有选区时 handleExpandJson 仅展开选中的 JSON 片段，保留周围文本', () => {
    const textBefore = 'txt数据片段:\n';
    const compactJson = '{"a":1,"b":2}';
    const textAfter = '\n结束标记';
    const fullText = textBefore + compactJson + textAfter;

    const from = textBefore.length;
    const to = textBefore.length + compactJson.length;

    const state = EditorState.create({
      doc: fullText,
      selection: { anchor: from, head: to },
    });
    const view = new EditorView({ state });
    createdViews.push(view);

    const ok = handleExpandJson(view);
    expect(ok).toBe(true);

    const newDoc = view.state.doc.toString();
    expect(newDoc.startsWith('txt数据片段:\n{\n  "a": 1,\n  "b": 2\n}')).toBe(true);
    expect(newDoc.endsWith('\n结束标记')).toBe(true);
  });

  it('有选区时 handleValidateJson 仅校验选中区域并在错误时高亮', () => {
    const fullDoc = '合法内容: {"ok": 1}\n错误选区: {bad: 123}\n其他内容';
    const errorPart = '{bad: 123}';
    const from = fullDoc.indexOf(errorPart);
    const to = from + errorPart.length;

    const state = EditorState.create({
      doc: fullDoc,
      selection: { anchor: from, head: to },
    });
    const view = new EditorView({ state });
    createdViews.push(view);

    handleValidateJson(view);
    const toasts = useToastStore.getState().toasts;
    expect(toasts.some((t) => t.type === 'error' && t.message.includes('JSON 校验失败'))).toBe(true);
  });
});
