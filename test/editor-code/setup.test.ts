// NoteBoard CodeMirror 基础扩展与配置测试
// 验证空格与换行符等热重配 Compartment 及默认扩展行为

import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import {
  createBaseExtensions,
  whitespaceCompartment,
  lineEndingCompartment,
  showLineEndingsExtension,
} from '../../src/features/editor-code/setup';
import { useSettingsStore } from '../../src/stores/settingsStore';

describe('editor-code setup', () => {
  it('默认状态下 createBaseExtensions 正常生成基础扩展', () => {
    const extensions = createBaseExtensions();
    expect(extensions).toBeDefined();
    expect(Array.isArray(extensions)).toBe(true);
    expect(extensions.length).toBeGreaterThan(10);
  });

  it('默认 settingsStore 中的 showWhitespace 与 showLineEndings 为 false', () => {
    const editorSettings = useSettingsStore.getState().settings.editor;
    expect(editorSettings.showWhitespace).toBe(false);
    expect(editorSettings.showLineEndings).toBe(false);
  });

  it('使用 createBaseExtensions 能够成功初始化 EditorState', () => {
    const state = EditorState.create({
      doc: 'SELECT * FROM users;\nWHERE id = 1;',
      extensions: createBaseExtensions({
        showWhitespace: false,
        showLineEndings: false,
      }),
    });
    expect(state.doc.toString()).toBe('SELECT * FROM users;\nWHERE id = 1;');
  });

  it('开启 showWhitespace 与 showLineEndings 时可成功初始化并挂载扩展', () => {
    const state = EditorState.create({
      doc: 'hello world\nsecond line',
      extensions: createBaseExtensions({
        showWhitespace: true,
        showLineEndings: true,
      }),
    });
    expect(state.doc.lines).toBe(2);
  });

  it('showLineEndingsExtension 插件已正确定义', () => {
    expect(showLineEndingsExtension).toBeDefined();
  });

  it('whitespaceCompartment 与 lineEndingCompartment 已正确导出', () => {
    expect(whitespaceCompartment).toBeDefined();
    expect(lineEndingCompartment).toBeDefined();
  });
});
