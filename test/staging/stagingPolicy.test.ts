// 暂存判定测试：空白未命名文件可直接关闭，其余未保存工作必须受到保护。

import { beforeEach, describe, expect, it } from 'vitest';
import { useDocumentStore } from '../../src/stores/documentStore';
import { useWindowStore, type Tab } from '../../src/stores/windowStore';
import { hasUnsavedWork } from '../../src/features/staging/stagingPolicy';

function openTestDocument(key: string, content: string, isDirty = false): void {
  useDocumentStore.getState().upsertFromPayload({
    key,
    displayName: '未命名.md',
    dirPath: '',
    kind: 'markdown',
    language: 'markdown',
    content,
    encoding: 'utf8',
    eol: 'lf',
    size: content.length,
    mtime: 0,
    readonly: false,
  });
  useDocumentStore.getState().setDirty(key, isDirty);
  const tab: Tab = {
    key,
    displayName: '未命名.md',
    path: key.startsWith('untitled:') ? null : key,
    kind: 'markdown',
    language: 'markdown',
    isDirty,
    isPreview: false,
    viewMode: 'visual',
    externalStatus: null,
    isDetached: false,
  };
  useWindowStore.getState().openTab(tab);
}

describe('hasUnsavedWork', () => {
  beforeEach(() => {
    useDocumentStore.setState({ documents: new Map() });
    useWindowStore.setState({ tabs: [], activeKey: null, pendingCloseKeys: [], isWindowClosing: false });
  });

  it('空白未命名文件无需保存或暂存', () => {
    openTestDocument('untitled:markdown:1', '');
    expect(hasUnsavedWork('untitled:markdown:1')).toBe(false);
  });

  it('带默认内容的未命名文件需要保存或暂存', () => {
    openTestDocument('untitled:json:1', '{\n  "enabled": true\n}');
    expect(hasUnsavedWork('untitled:json:1')).toBe(true);
  });

  it('即使内容只有空格，只要已编辑为脏态也需要保护', () => {
    openTestDocument('untitled:text:1', ' ', true);
    expect(hasUnsavedWork('untitled:text:1')).toBe(true);
  });

  it('未修改的磁盘文件不进入暂存', () => {
    openTestDocument('C:\\notes\\saved.md', 'saved');
    expect(hasUnsavedWork('C:\\notes\\saved.md')).toBe(false);
  });
});
