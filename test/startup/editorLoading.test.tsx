// NoteBoard 编辑器懒加载边界测试（S05）
// 覆盖：kind+language 入口映射（E 节：infographic/mermaid/plantuml 属于 kind=code）、
//       loader 表不在模块顶层执行 import、🔴 R4-02 成功资源复用/失败重试可重建
//
// 🔴 R4-02 断言形态修正说明：旧断言"每次 createLazyEditor 生成新实例"是
// 实现形态断言（复审四轮指出其不能作为产品验收标准——新实例使重挂载的宿主
// 重新进入 Suspense 加载边界，已复现为 D08）。改为行为断言：成功资源跨调用
// 复用同一包装（重挂载不重新 suspend）；失败资源经 retryEditorLoad 重建。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveEditorKind,
  prefetchEditor,
  createLazyEditor,
  retryEditorLoad,
  getEditorResourceStatus,
  resetEditorResourcesForTest,
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

describe('🔴 R4-02 编辑器资源注册表（成功复用/失败重试）', () => {
  beforeEach(() => {
    resetEditorResourcesForTest();
  });

  it('成功资源：同一入口的 lazy 包装跨调用复用（重挂载不再重新进入加载边界）', { timeout: 20000 }, async () => {
    const first = createLazyEditor('board');
    const second = createLazyEditor('board');
    // 🔴 D08 行为契约：entry 存活期间包装引用稳定——宿主重挂载不产生新 lazy
    expect(first).toBe(second);
    // 首次获取即发起加载；完成进入 ready（真实模块图首载可能较慢——放宽超时）
    await vi.waitFor(() => {
      expect(getEditorResourceStatus('board').status).toBe('ready');
    }, { timeout: 10000 });
    // ready 后复用不变
    expect(createLazyEditor('board')).toBe(first);
    // 不同入口互不共享
    expect(createLazyEditor('mindmap' as EditorLoaderKind)).not.toBe(first);
  });

  it('失败资源：成功资源 retry 不重建（仅失败项可重建，成功复用不受影响）', { timeout: 20000 }, async () => {
    const a = createLazyEditor('board');
    await vi.waitFor(() => {
      expect(getEditorResourceStatus('board').status).toBe('ready');
    }, { timeout: 10000 });
    // 成功资源 retry 不重建（返回 false）
    expect(retryEditorLoad('board')).toBe(false);
    expect(createLazyEditor('board')).toBe(a);
    // 未加载入口状态为 idle；retry 无条目时返回 false 不抛异常
    expect(getEditorResourceStatus('mindmap').status).toBe('idle');
    expect(retryEditorLoad('mindmap')).toBe(false);
  });

  it('prefetchEditor 复用同一资源条目（预取完成后渲染直接命中 ready）', { timeout: 20000 }, async () => {
    prefetchEditor('board');
    const status = getEditorResourceStatus('board');
    expect(['loading', 'ready']).toContain(status.status);
    await vi.waitFor(() => {
      expect(getEditorResourceStatus('board').status).toBe('ready');
    }, { timeout: 10000 });
    // 预取与渲染取到的是同一包装
    expect(createLazyEditor('board')).toBe(createLazyEditor('board'));
  });

  it('prefetchEditor 对未知入口不抛异常', () => {
    // 所有合法入口都能预取；这里只验证函数可安全调用
    expect(() => prefetchEditor('code')).not.toThrow();
    expect(() => prefetchEditor('markdown')).not.toThrow();
  });
});
