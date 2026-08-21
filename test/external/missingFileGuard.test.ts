// 运行期文件删除保护测试：删除后必须同时标记标签与文档模型，且兼容 Windows 路径大小写。

import { beforeEach, describe, expect, it } from 'vitest';
import { markOpenDocumentDeleted } from '../../src/features/external/missingFileGuard';
import { useDocumentStore } from '../../src/stores/documentStore';
import { useWindowStore, type Tab } from '../../src/stores/windowStore';

describe('markOpenDocumentDeleted', () => {
  const key = 'C:\\Notes\\Plan.md';

  beforeEach(() => {
    useDocumentStore.setState({ documents: new Map() });
    useWindowStore.setState({ tabs: [], activeKey: null, pendingCloseKeys: [], isWindowClosing: false });
    useDocumentStore.getState().upsertFromPayload({
      key,
      displayName: 'Plan.md',
      dirPath: 'C:\\Notes',
      kind: 'markdown',
      language: 'markdown',
      content: '# plan',
      encoding: 'utf8',
      eol: 'lf',
      size: 6,
      mtime: 1,
      readonly: false,
    });
    const tab: Tab = {
      key,
      displayName: 'Plan.md',
      path: key,
      kind: 'markdown',
      language: 'markdown',
      isDirty: false,
      isPreview: false,
      viewMode: 'visual',
      externalStatus: null,
      isDetached: false,
    };
    useWindowStore.getState().openTab(tab);
  });

  it('按大小写不敏感路径标记运行期删除', () => {
    markOpenDocumentDeleted('c:\\notes\\plan.md');
    expect(useWindowStore.getState().getTab(key)?.isDetached).toBe(true);
    expect(useWindowStore.getState().getTab(key)?.externalStatus).toBe('deleted');
    expect(useDocumentStore.getState().getDocument(key)?.externalStatus).toBe('deleted');
  });
});
