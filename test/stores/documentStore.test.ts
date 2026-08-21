// NoteBoard 文档保存基线测试
// 验证保存只移动磁盘基线，不会把保存期间继续发生的编辑误标为干净

import { beforeEach, describe, expect, it } from 'vitest';
import { useDocumentStore } from '../../src/stores/documentStore';

const DOCUMENT_KEY = 'C:\\notes\\history.md';

/** 注册一份可编辑的 Markdown 文档，作为每个基线测试的初始状态 */
function openDocument(content: string): void {
  useDocumentStore.getState().upsertFromPayload({
    key: DOCUMENT_KEY,
    displayName: 'history.md',
    dirPath: 'C:\\notes',
    kind: 'markdown',
    language: 'markdown',
    content,
    encoding: 'utf8',
    eol: 'lf',
    size: content.length,
    mtime: 1,
    readonly: false,
  });
}

describe('documentStore 保存基线', () => {
  beforeEach(() => {
    useDocumentStore.getState().clear();
  });

  it('保存当前内容后标记为干净', () => {
    openDocument('保存前');
    useDocumentStore.getState().setContent(DOCUMENT_KEY, '保存后');
    useDocumentStore.getState().updateBaseline(DOCUMENT_KEY, '保存后', 2, 9);

    const doc = useDocumentStore.getState().getDocument(DOCUMENT_KEY);
    expect(doc?.baselineContent).toBe('保存后');
    expect(doc?.isDirty).toBe(false);
  });

  it('写盘期间继续编辑时以实际保存快照为基线并保持脏态', () => {
    openDocument('A');
    // 写盘请求保存 B 后，用户又输入到 C；回调完成时不能把 C 误当成已保存
    useDocumentStore.getState().setContent(DOCUMENT_KEY, 'B');
    useDocumentStore.getState().setContent(DOCUMENT_KEY, 'C');
    useDocumentStore.getState().updateBaseline(DOCUMENT_KEY, 'B', 2, 1);

    const doc = useDocumentStore.getState().getDocument(DOCUMENT_KEY);
    expect(doc?.content).toBe('C');
    expect(doc?.baselineContent).toBe('B');
    expect(doc?.isDirty).toBe(true);
  });

  it('renameDocument 正确迁移文档 key、displayName 和 dirPath', () => {
    openDocument('初始内容');
    const newKey = 'C:\\notes\\new-name.md';
    useDocumentStore.getState().renameDocument(DOCUMENT_KEY, newKey, 'new-name.md', 'C:\\notes');

    expect(useDocumentStore.getState().getDocument(DOCUMENT_KEY)).toBeUndefined();
    const doc = useDocumentStore.getState().getDocument(newKey);
    expect(doc).toBeDefined();
    expect(doc?.key).toBe(newKey);
    expect(doc?.displayName).toBe('new-name.md');
    expect(doc?.dirPath).toBe('C:\\notes');
    expect(doc?.content).toBe('初始内容');
  });

  it('renameDirectory 正确批量更新目录下所有已打开文档路径', () => {
    openDocument('文档1');
    const oldDir = 'C:\\notes';
    const newDir = 'C:\\workspace\\notes';
    useDocumentStore.getState().renameDirectory(oldDir, newDir);

    expect(useDocumentStore.getState().getDocument(DOCUMENT_KEY)).toBeUndefined();
    const newKey = 'C:\\workspace\\notes\\history.md';
    const doc = useDocumentStore.getState().getDocument(newKey);
    expect(doc).toBeDefined();
    expect(doc?.key).toBe(newKey);
    expect(doc?.dirPath).toBe('C:\\workspace\\notes');
  });
});
