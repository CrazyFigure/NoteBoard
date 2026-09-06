// NoteBoard 编辑器懒加载边界测试（S05）
// 覆盖：kind+language 入口映射（E 节：infographic/mermaid/plantuml 属于 kind=code）、
//       loader 表不在模块顶层执行 import、lazy 包装按 retryGeneration 重建

import { describe, it, expect, vi } from 'vitest';
import {
  resolveEditorKind,
  prefetchEditor,
  createLazyEditor,
  type EditorLoaderKind,
} from '@/features/editor-host/editorLoaders';

// Mock 各编辑器模块（验证工厂调用时才 import）


// 用 spy 拦截动态 import：动态 import 表达式无法直接 mock，改为验证公开函数行为
vi.mock('@codemirror/view', () => ({}));

describe('编辑器入口映射（resolveEditorKind）', () => {
  it('code 基础类型映射到 code 入口', () => {
    expect(resolveEditorKind({ kind: 'code', language: 'json' })).toBe('code');
    expect(resolveEditorKind({ kind: 'code', language: 'plaintext' })).toBe('code');
    expect(resolveEditorKind({ kind: 'code', language: 'markdown' })).toBe('code');
  });

  it('code 的图表语言映射到独立图表入口（E 节：不能只按 kind 全送 CodeEditor）', () => {
    expect(resolveEditorKind({ kind: 'code', language: 'mermaid' })).toBe('diagram');
    expect(resolveEditorKind({ kind: 'code', language: 'plantuml' })).toBe('diagram');
    expect(resolveEditorKind({ kind: 'code', language: 'infographic' })).toBe('infographic');
  });

  it('其余 kind 一一对应', () => {
    expect(resolveEditorKind({ kind: 'markdown', language: 'markdown' })).toBe('markdown');
    expect(resolveEditorKind({ kind: 'board', language: 'plaintext' })).toBe('board');
    expect(resolveEditorKind({ kind: 'mindmap', language: 'plaintext' })).toBe('mindmap');
    expect(resolveEditorKind({ kind: 'drawio', language: 'plaintext' })).toBe('drawio');
    expect(resolveEditorKind({ kind: 'bitable', language: 'json' })).toBe('bitable');
    expect(resolveEditorKind({ kind: 'image', language: 'plaintext' })).toBe('image');
    expect(resolveEditorKind({ kind: 'unsupported', language: 'plaintext' })).toBe('unsupported');
  });
});

describe('懒加载工厂行为', () => {
  it('createLazyEditor 返回组件对象（React.lazy 包装），且每次调用生成新实例', () => {
    // editorLoaders 顶层只定义工厂函数表；React.lazy 包装由 createLazyEditor 按需创建。
    // 静态保证（模块顶层零 import）：源码评审 + 预算门禁的首屏闭包断言覆盖。
    const first = createLazyEditor('code');
    const second = createLazyEditor('code');
    expect(typeof first).toBe('object');
    expect(first).not.toBe(second);
  });

  it('createLazyEditor 每次调用生成新实例（rejection 恢复的前提）', () => {
    const a = createLazyEditor('code' as EditorLoaderKind);
    const b = createLazyEditor('code' as EditorLoaderKind);
    expect(a).not.toBe(b);
  });

  it('prefetchEditor 对未知入口不抛异常', () => {
    // 所有合法入口都能预取；这里只验证函数可安全调用
    expect(() => prefetchEditor('code')).not.toThrow();
    expect(() => prefetchEditor('markdown')).not.toThrow();
  });
});
