// NoteBoard 编辑器能力注册表单元测试（S03）
// 覆盖：注册/查询/dispose 代际保护、revision 递增与清理

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerEditorCapabilities,
  getEditorCapabilities,
  bumpDocumentRevision,
  getDocumentRevision,
  clearDocumentRevision,
  resetEditorRegistryForTest,
} from '@/core/editor/editorRegistry';
import type { EditorCapabilities } from '@/core/editor/editorTypes';

/** 构造最小能力对象（仅填注册表用到的字段） */
function makeCaps(docKey: string, instanceId: string, content = ''): EditorCapabilities {
  return {
    docKey,
    instanceId,
    getRevision: () => getDocumentRevision(docKey),
    flush: async () => ({ docKey, instanceId, revision: getDocumentRevision(docKey), content }),
    focus: () => {},
    getSelectedText: () => '',
    canSuspend: () => false,
  };
}

describe('editorRegistry 能力注册表', () => {
  beforeEach(() => {
    resetEditorRegistryForTest();
  });

  it('注册后可按键查询，未注册返回 null', () => {
    expect(getEditorCapabilities('k1')).toBeNull();
    const dispose = registerEditorCapabilities(makeCaps('k1', 'i1'));
    expect(getEditorCapabilities('k1')?.instanceId).toBe('i1');
    dispose();
    expect(getEditorCapabilities('k1')).toBeNull();
  });

  it('dispose 代际保护：旧实例的 disposer 无权删除新实例', () => {
    const disposeA = registerEditorCapabilities(makeCaps('k1', 'i-1'));
    const disposeB = registerEditorCapabilities(makeCaps('k1', 'i-2'));
    // 旧实例清理：注册表已是 i-2，不删除
    disposeA();
    expect(getEditorCapabilities('k1')?.instanceId).toBe('i-2');
    // 新实例清理：正常删除
    disposeB();
    expect(getEditorCapabilities('k1')).toBeNull();
  });

  it('revision 单调递增且清理后归零', () => {
    expect(getDocumentRevision('k1')).toBe(0);
    bumpDocumentRevision('k1');
    bumpDocumentRevision('k1');
    expect(getDocumentRevision('k1')).toBe(2);
    // 重挂载（重新注册）不重置版本
    const dispose = registerEditorCapabilities(makeCaps('k1', 'i-2'));
    dispose();
    expect(getDocumentRevision('k1')).toBe(2);
    // 文档最终关闭才清理
    clearDocumentRevision('k1');
    expect(getDocumentRevision('k1')).toBe(0);
  });

  it('不同 docKey 的注册与版本互不影响', () => {
    registerEditorCapabilities(makeCaps('k1', 'i1'));
    registerEditorCapabilities(makeCaps('k2', 'i2'));
    bumpDocumentRevision('k2');
    expect(getDocumentRevision('k1')).toBe(0);
    expect(getDocumentRevision('k2')).toBe(1);
    expect(getEditorCapabilities('k1')?.docKey).toBe('k1');
    expect(getEditorCapabilities('k2')?.docKey).toBe('k2');
  });
});
